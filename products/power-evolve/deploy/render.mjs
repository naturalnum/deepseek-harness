/** Render a reviewable Kubernetes bundle; credentials are referenced, never serialized. */
import { isIP } from 'node:net'
import { readFile, writeFile } from 'node:fs/promises'
import { createRequire } from 'node:module'
import { fileURLToPath } from 'node:url'
import { remoteMcpConfigPath, remoteMcpEgress, remoteMcpSources, remoteMcpValues } from './remote-mcp.mjs'
import { accountBootstrapEnabled, accountBootstrapPath } from './accounts.mjs'
import { connectorRunnerValues, connectorRunnerEnvironment, connectorRunnerManifests } from './connectors.mjs'
import { officePreviewValues, officePreviewManifests, officePreviewSources,
  officePreviewEnvironment, officePreviewPodVerbs } from './office-preview.mjs'

const require = createRequire(new URL('../application/package.json', import.meta.url))
const yaml = require('js-yaml')
const self = fileURLToPath(import.meta.url)
const dnsName = /^[a-z0-9](?:[-a-z0-9]{0,61}[a-z0-9])?$/u
const imageDigest = /^[^\s@]+@sha256:[a-f0-9]{64}$/u
const labels = { 'app.kubernetes.io/part-of': 'power-evolve' }

function named(value, label) {
  if (typeof value !== 'string' || !dnsName.test(value)) throw new Error(`Invalid ${label}`)
  return value
}
function object(value, label) {
  if (!value || typeof value !== 'object' || Array.isArray(value)) throw new Error(`Invalid ${label}`)
  return value
}
function cidrs(value, label, required = true) {
  if (!Array.isArray(value) || required && !value.length) throw new Error(`Invalid ${label}`)
  for (const cidr of value) {
    if (typeof cidr !== 'string') throw new Error(`Invalid ${label}`)
    const [address, prefix, extra] = cidr.split('/')
    const family = isIP(address)
    if (extra !== undefined || !family || !/^\d{1,3}$/u.test(prefix ?? '')
      || Number(prefix) > (family === 4 ? 32 : 128)) throw new Error(`Invalid ${label}`)
  }
  return value
}
function endpoint(value, label, originOnly = false) {
  if (typeof value !== 'string') throw new Error(`Invalid ${label}`)
  const url = new URL(value)
  if (url.protocol !== 'https:' || url.username || url.password || url.hash
    || originOnly && url.origin !== value) throw new Error(`Invalid ${label}`)
  return url
}

export function validateValues(input) {
  const value = object(input, 'deployment values')
  named(value.namespace, 'application namespace')
  named(value.runnerNamespace, 'runner namespace')
  if (value.namespace === value.runnerNamespace) throw new Error('Runner namespace must be separate')
  for (const field of ['appImage', 'sandboxImage']) {
    if (typeof value[field] !== 'string' || !imageDigest.test(value[field])) {
      throw new Error(`${field} must use an immutable sha256 digest`)
    }
  }
  if (value.imagePullSecretName) named(value.imagePullSecretName, 'image pull Secret')
  const host = endpoint(value.hostPublicOrigin, 'Host public Origin', true)
  const platform = endpoint(value.platformPublicOrigin, 'Platform public Origin', true)
  if (host.origin === platform.origin) throw new Error('Host and Platform Origins must differ')
  named(value.ingressClassName, 'Ingress class')
  named(value.ingressNamespace, 'Ingress namespace')
  named(value.tlsSecretName, 'TLS Secret')
  const ingressLabels = object(value.ingressPodLabels, 'Ingress Pod labels')
  if (!Object.keys(ingressLabels).length || Object.values(ingressLabels).some(item => typeof item !== 'string')) {
    throw new Error('Ingress Pod labels are required')
  }
  endpoint(value.modelUrl, 'model URL')
  endpoint(value.connectorUrl, 'connector URL')
  const storage = object(value.storage, 'storage')
  if (typeof storage.nfsServer !== 'string' || !storage.nfsServer
    || typeof storage.nfsPath !== 'string' || !storage.nfsPath.startsWith('/')
    || storage.nfsPath.split('/').includes('..') || !/^\d+(?:Gi|Ti)$/u.test(storage.size)) {
    throw new Error('Shared POSIX NFS source and size are required')
  }
  for (const field of ['platformPv', 'runnerPv', 'platformClaim', 'runnerClaim']) {
    named(storage[field], `storage.${field}`)
  }
  if (storage.platformPv === storage.runnerPv) throw new Error('Each namespace needs a distinct PV binding')
  const network = object(value.network, 'network')
  for (const field of ['postgresCidrs', 'modelCidrs', 'connectorCidrs', 'apiServerCidrs',
    'runnerProxySourceCidrs']) cidrs(network[field], `network.${field}`)
  cidrs(network.sandboxEgressCidrs, 'network.sandboxEgressCidrs', false)
  for (const field of ['postgresPort', 'apiServerPort']) {
    if (!Number.isInteger(network[field]) || network[field] < 1 || network[field] > 65535) {
      throw new Error(`Invalid network.${field}`)
    }
  }
  const secrets = object(value.secrets, 'secrets')
  named(secrets.shared, 'shared Secret')
  named(secrets.platform, 'Platform Secret')
  if (secrets.shared === secrets.platform) throw new Error('Host must not mount Platform credentials')
  remoteMcpValues(value.remoteMcp, secrets.shared)
  accountBootstrapEnabled(value.accounts)
  connectorRunnerValues(value.connectorRunner, value)
  officePreviewValues(value.officePreview, value)
  return value
}

function metadata(name, namespace, extra = {}) {
  return { name, ...(namespace ? { namespace } : {}), labels: { ...labels, ...extra } }
}
function sa(name, namespace, pullSecret) {
  return { apiVersion: 'v1', kind: 'ServiceAccount', metadata: metadata(name, namespace),
    automountServiceAccountToken: false,
    ...(pullSecret ? { imagePullSecrets: [{ name: pullSecret }] } : {}) }
}
function peerCidrs(values) { return values.map(cidr => ({ ipBlock: { cidr } })) }
function egressCidrs(values, port) {
  return { to: peerCidrs(values), ports: [{ protocol: 'TCP', port }] }
}
function dnsEgress() {
  return { to: [{ namespaceSelector: { matchLabels: { 'kubernetes.io/metadata.name': 'kube-system' } },
    podSelector: { matchLabels: { 'k8s-app': 'kube-dns' } } }],
  ports: [{ protocol: 'UDP', port: 53 }, { protocol: 'TCP', port: 53 }] }
}
function networkPolicy(name, namespace, selector, ingress, egress) {
  return { apiVersion: 'networking.k8s.io/v1', kind: 'NetworkPolicy',
    metadata: metadata(name, namespace), spec: { podSelector: { matchLabels: selector },
      policyTypes: ['Ingress', 'Egress'], ingress, egress } }
}
function secretVolume(values, role) {
  const sources = [{ secret: { name: values.secrets.shared,
    items: [{ key: 'worker-token', path: 'worker-token' }] } }]
  if (role === 'platform') sources.push({ secret: { name: values.secrets.platform,
    items: ['database-url', 'model-key', 'connector-key', 'runner-key', 'users.json', 'account-management.json',
      ...(connectorRunnerValues(values.connectorRunner, values)?.sshDestinations.length ? ['ssh-credential-key'] : []),
      ...(accountBootstrapEnabled(values.accounts) ? ['account-bootstrap.json'] : [])]
      .map(key => ({ key, path: key })) } })
  if (role === 'platform') sources.push(...remoteMcpSources(remoteMcpValues(values.remoteMcp, values.secrets.shared)))
  sources.push(...officePreviewSources(officePreviewValues(values.officePreview, values), role))
  return { name: 'private', projected: { defaultMode: 0o440, sources } }
}
function deployment(values, role) {
  const host = role === 'host', name = `power-evolve-${role}`
  const port = host ? 18880 : 18881
  const podLabels = { ...labels, 'app.kubernetes.io/name': name }
  const volumes = [secretVolume(values, role), { name: 'profile-state', emptyDir: {} },
    { name: 'tmp', emptyDir: { sizeLimit: '256Mi' } },
    ...(!host ? [{ name: 'shared-posix', persistentVolumeClaim: {
      claimName: values.storage.platformClaim } }] : [])]
  const volumeMounts = [{ name: 'private', mountPath: '/run/power-evolve/private', readOnly: true },
    { name: 'profile-state', mountPath: '/var/lib/dsh' }, { name: 'tmp', mountPath: '/tmp' },
    ...(!host ? [{ name: 'shared-posix', mountPath: '/data' }] : [])]
  const resources = host ? { requests: { cpu: '250m', memory: '512Mi' },
    limits: { cpu: '2', memory: '2Gi' } } : { requests: { cpu: '500m', memory: '1Gi' },
    limits: { cpu: '4', memory: '4Gi' } }
  return { apiVersion: 'apps/v1', kind: 'Deployment', metadata: metadata(name, values.namespace),
    spec: { replicas: 2, selector: { matchLabels: { 'app.kubernetes.io/name': name } },
      strategy: { type: 'RollingUpdate', rollingUpdate: { maxUnavailable: 0, maxSurge: 1 } },
      template: { metadata: { labels: podLabels }, spec: {
        serviceAccountName: name, automountServiceAccountToken: !host,
        terminationGracePeriodSeconds: 45,
        topologySpreadConstraints: [{ maxSkew: 1, topologyKey: 'kubernetes.io/hostname',
          whenUnsatisfiable: 'ScheduleAnyway', labelSelector: { matchLabels: {
            'app.kubernetes.io/name': name } } }],
        securityContext: host
          ? { runAsNonRoot: true, runAsUser: 10001, runAsGroup: 10001, fsGroup: 10001,
            seccompProfile: { type: 'RuntimeDefault' } }
          : { runAsUser: 0, runAsGroup: 0, seccompProfile: { type: 'RuntimeDefault' } },
        containers: [{ name: 'dsh', image: values.appImage, imagePullPolicy: 'IfNotPresent',
          command: ['node', 'products/power-evolve/deploy/start.mjs', role],
          workingDir: '/opt/power-evolve',
          envFrom: [{ configMapRef: { name: `power-evolve-${role}-config` } }],
          ports: [{ name: 'http', containerPort: port }],
          startupProbe: { httpGet: { path: '/health', port: 'http' },
            failureThreshold: 30, periodSeconds: 2 },
          readinessProbe: { httpGet: { path: '/health', port: 'http' },
            periodSeconds: 3, timeoutSeconds: 2 },
          livenessProbe: { httpGet: { path: host ? '/health' : '/live', port: 'http' },
            periodSeconds: 10, timeoutSeconds: 2 },
          resources,
          securityContext: { allowPrivilegeEscalation: false, readOnlyRootFilesystem: true,
            capabilities: { drop: ['ALL'], ...(!host ? { add: ['CHOWN', 'DAC_OVERRIDE', 'FOWNER'] } : {}) } },
          volumeMounts,
        }], volumes,
      } } } }
}
function service(values, role) {
  const name = `power-evolve-${role}`, port = role === 'host' ? 18880 : 18881
  return { apiVersion: 'v1', kind: 'Service', metadata: metadata(name, values.namespace),
    spec: { type: 'ClusterIP', selector: { 'app.kubernetes.io/name': name },
      ports: [{ name: 'http', port, targetPort: 'http', protocol: 'TCP' }] } }
}
function staticVolume(name, claim, namespace, storage) {
  const pv = { apiVersion: 'v1', kind: 'PersistentVolume', metadata: metadata(name),
    spec: { capacity: { storage: storage.size }, volumeMode: 'Filesystem',
      accessModes: ['ReadWriteMany'], persistentVolumeReclaimPolicy: 'Retain',
      storageClassName: '', claimRef: { namespace, name: claim },
      nfs: { server: storage.nfsServer, path: storage.nfsPath },
      mountOptions: ['hard', 'nfsvers=4.1'] } }
  const pvc = { apiVersion: 'v1', kind: 'PersistentVolumeClaim', metadata: metadata(claim, namespace),
    spec: { accessModes: ['ReadWriteMany'], storageClassName: '', volumeName: name,
      volumeMode: 'Filesystem', resources: { requests: { storage: storage.size } } } }
  return [pv, pvc]
}

export function buildManifests(input) {
  const values = validateValues(input)
  const remoteMcp = remoteMcpValues(values.remoteMcp, values.secrets.shared)
  const connectors = connectorRunnerValues(values.connectorRunner, values)
  const officePreview = officePreviewValues(values.officePreview, values)
  const app = values.namespace, runner = values.runnerNamespace, storage = values.storage
  const hostLabels = { 'app.kubernetes.io/name': 'power-evolve-host' }
  const platformLabels = { 'app.kubernetes.io/name': 'power-evolve-platform' }
  const runnerLabels = { 'app.kubernetes.io/name': 'power-evolve-sandbox' }
  const ingressPeer = { namespaceSelector: { matchLabels: {
    'kubernetes.io/metadata.name': values.ingressNamespace } },
  podSelector: { matchLabels: values.ingressPodLabels } }
  const [appPv, appPvc] = staticVolume(storage.platformPv, storage.platformClaim, app, storage)
  const [runnerPv, runnerPvc] = staticVolume(storage.runnerPv, storage.runnerClaim, runner, storage)
  const hostConfig = { PE_HOST_PUBLIC_ORIGIN: values.hostPublicOrigin,
    PE_PLATFORM_PUBLIC_ORIGIN: values.platformPublicOrigin,
    ...officePreviewEnvironment(officePreview, 'host'),
    PE_PLATFORM_INTERNAL_URL: `http://power-evolve-platform.${app}.svc.cluster.local:18881`,
    PE_PRIVATE_DIR: '/run/power-evolve/private', DSH_HOME: '/var/lib/dsh',
    PE_NATIVE_WEB_DIST: '/opt/power-evolve/products/power-evolve/cloud-web/dist' }
  const platformConfig = { PE_HOST_PUBLIC_ORIGIN: values.hostPublicOrigin,
    PE_PLATFORM_PUBLIC_ORIGIN: values.platformPublicOrigin,
    PE_MODEL_URL: values.modelUrl, PE_CONNECTOR_URL: values.connectorUrl,
    PE_SANDBOX_NAMESPACE: runner, PE_SANDBOX_IMAGE: values.sandboxImage,
    PE_SANDBOX_VOLUME_CLAIM: storage.runnerClaim,
    ...officePreviewEnvironment(officePreview, 'platform'),
    ...connectorRunnerEnvironment(connectors),
    ...(connectors === null ? {} : { PE_APPLICATION_NAMESPACE: app }),
    ...(remoteMcp === null ? {} : { PE_REMOTE_MCP_CONFIG_FILE: remoteMcpConfigPath }),
    ...(accountBootstrapEnabled(values.accounts) ? { PE_ACCOUNT_BOOTSTRAP_FILE: accountBootstrapPath } : {}),
    PE_PRIVATE_DIR: '/run/power-evolve/private', DSH_HOME: '/var/lib/dsh' }
  const configMap = (name, data) => ({ apiVersion: 'v1', kind: 'ConfigMap',
    metadata: metadata(name, app), data })
  const role = { apiVersion: 'rbac.authorization.k8s.io/v1', kind: 'Role',
    metadata: metadata('power-evolve-platform-runner', runner), rules: [
      { apiGroups: ['agents.x-k8s.io'], resources: ['sandboxes'], verbs: ['get', 'list', 'create', 'delete'] },
      { apiGroups: [''], resources: ['pods'], verbs: officePreviewPodVerbs(officePreview) },
      { apiGroups: [''], resources: ['services', 'secrets'], verbs: ['get', 'create', 'delete'] },
      { apiGroups: [''], resources: ['services/proxy'], verbs: ['get', 'create'] },
    ] }
  const binding = { apiVersion: 'rbac.authorization.k8s.io/v1', kind: 'RoleBinding',
    metadata: metadata('power-evolve-platform-runner', runner),
    subjects: [{ kind: 'ServiceAccount', name: 'power-evolve-platform', namespace: app }],
    roleRef: { apiGroup: 'rbac.authorization.k8s.io', kind: 'Role',
      name: 'power-evolve-platform-runner' } }
  const ingress = { apiVersion: 'networking.k8s.io/v1', kind: 'Ingress',
    metadata: metadata('power-evolve-public', app), spec: {
      ingressClassName: values.ingressClassName,
      tls: [{ hosts: [new URL(values.hostPublicOrigin).hostname,
        new URL(values.platformPublicOrigin).hostname], secretName: values.tlsSecretName }],
      rules: [['host', values.hostPublicOrigin], ['platform', values.platformPublicOrigin]]
        .map(([role, origin]) => ({ host: new URL(origin).hostname, http: { paths: [{
          path: '/', pathType: 'Prefix', backend: { service: {
            name: `power-evolve-${role}`, port: { name: 'http' } } },
        }] } })),
    } }
  return [
    { apiVersion: 'v1', kind: 'Namespace', metadata: metadata(app) },
    { apiVersion: 'v1', kind: 'Namespace', metadata: metadata(runner) },
    appPv, runnerPv, appPvc, runnerPvc,
    sa('power-evolve-host', app, values.imagePullSecretName),
    sa('power-evolve-platform', app, values.imagePullSecretName),
    sa('power-evolve-runner', runner, values.imagePullSecretName),
    role, binding,
    configMap('power-evolve-host-config', hostConfig),
    configMap('power-evolve-platform-config', platformConfig),
    ...officePreviewManifests(values, officePreview),
    deployment(values, 'host'), deployment(values, 'platform'),
    service(values, 'host'), service(values, 'platform'), ingress,
    networkPolicy('default-deny', app, {}, [], []),
    networkPolicy('default-deny', runner, {}, [], []),
    networkPolicy('allow-host', app, hostLabels,
      [{ from: [ingressPeer], ports: [{ protocol: 'TCP', port: 18880 }] }],
      [dnsEgress(), { to: [{ podSelector: { matchLabels: platformLabels } }],
        ports: [{ protocol: 'TCP', port: 18881 }] }]),
    networkPolicy('allow-platform', app, platformLabels,
      [{ from: [ingressPeer, { podSelector: { matchLabels: hostLabels } }],
        ports: [{ protocol: 'TCP', port: 18881 }] }],
      [dnsEgress(), egressCidrs(values.network.postgresCidrs, values.network.postgresPort),
        egressCidrs(values.network.modelCidrs, Number(new URL(values.modelUrl).port || 443)),
        egressCidrs(values.network.connectorCidrs, Number(new URL(values.connectorUrl).port || 443)),
        egressCidrs(values.network.apiServerCidrs, values.network.apiServerPort), ...remoteMcpEgress(remoteMcp)]),
    networkPolicy('allow-runner', runner, runnerLabels,
      [{ from: peerCidrs(values.network.runnerProxySourceCidrs),
        ports: [{ protocol: 'TCP', port: 8080 }] }],
      [dnsEgress(), ...(!values.network.sandboxEgressCidrs.length ? []
        : [egressCidrs(values.network.sandboxEgressCidrs, 443)])]),
    ...connectorRunnerManifests(values, connectors),
  ]
}

export function render(input, phase = 'all') {
  if (!['all', 'foundation', 'workloads'].includes(phase)) throw new Error('Choose all, foundation, or workloads')
  const workload = new Set(['Deployment', 'Service', 'Ingress'])
  return buildManifests(input).filter(item => phase === 'all'
    || (phase === 'workloads') === (workload.has(item.kind)
      && item.metadata.namespace !== input.connectorRunner?.namespace)).map(item => yaml.dump(item,
    { noRefs: true, lineWidth: 120 })).join('---\n')
}

if (process.argv[1] === self) {
  const [valuesPath, outputPath, phase = 'all'] = process.argv.slice(2)
  if (!valuesPath || !outputPath) throw new Error('Use render.mjs <values.json> <output.yaml> [all|foundation|workloads]')
  const values = JSON.parse(await readFile(valuesPath, 'utf8'))
  const body = render(values, phase)
  await writeFile(outputPath, body, { mode: 0o600 })
  console.log(`Rendered ${body.split('---\n').length} ${phase} Kubernetes resources`)
}
