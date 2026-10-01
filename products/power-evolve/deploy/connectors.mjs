/** Optional Connector Runner placement; private bytes are read only by Platform validation. */
import assert from 'node:assert/strict'
import { isIP } from 'node:net'
import { readFileSync } from 'node:fs'
import { createRequire } from 'node:module'
import { isDeepStrictEqual } from 'node:util'

const require = createRequire(new URL('../application/package.json', import.meta.url))
const yaml = require('js-yaml')
const name = /^[a-z0-9](?:[-a-z0-9]{0,61}[a-z0-9])?$/u
const digest = /^[^\s@]+@sha256:[a-f0-9]{64}$/u
const appLabel = 'app.kubernetes.io/name'
export const connectorListenerName = 'power-evolve-forbidden-listener'
export const connectorRoleName = 'power-evolve-platform-connector'
export const connectorKeyPath = '/run/power-evolve/private/connector-key'
export const sshCredentialKeyPath = '/run/power-evolve/private/ssh-credential-key'
const envFields = ['PE_CONNECTOR_RUNNER_NAMESPACE', 'PE_CONNECTOR_RUNNER_IMAGE',
  'PE_CONNECTOR_RUNNER_PROXY_SOURCE_CIDRS', 'PE_SSH_DESTINATIONS']

function refuse() { throw new Error('Invalid Connector Runner deployment metadata') }
function exact(value, fields) {
  if (!value || typeof value !== 'object' || Array.isArray(value)
    || Object.keys(value).some(key => !fields.includes(key))) refuse()
}

/** Resolve optional placement and literal destinations; the existing SSH parser supports IPv4 only.
 * @param input Optional values block; omission or null disables both process transports.
 * @param values Application and writable runner namespaces to keep separate.
 * @returns Detached metadata without credentials, or null.
 */
export function connectorRunnerValues(input, values = {}) {
  if (input === undefined || input === null) return null
  exact(input, ['namespace', 'image', 'proxySourceCidrs', 'sshDestinations'])
  if (typeof input.namespace !== 'string' || !name.test(input.namespace)
    || [values.namespace, values.runnerNamespace].includes(input.namespace)
    || typeof input.image !== 'string' || !digest.test(input.image)
    || values.imagePullSecretName && !name.test(values.imagePullSecretName)) refuse()
  const cidrs = input.proxySourceCidrs
  if (!Array.isArray(cidrs) || !cidrs.length || new Set(cidrs).size !== cidrs.length
    || cidrs.some(cidr => {
      if (typeof cidr !== 'string') return true
      const [ip, prefix, extra] = cidr.split('/')
      return extra !== undefined || !isIP(ip) || prefix !== (isIP(ip) === 4 ? '32' : '128')
    })) refuse()
  const destinations = input.sshDestinations ?? []
  if (!Array.isArray(destinations) || destinations.length > 32) refuse()
  const seen = new Set()
  for (const item of destinations) {
    exact(item, ['ip', 'port'])
    const key = item.ip + ':' + item.port
    if (typeof item.ip !== 'string' || isIP(item.ip) !== 4
      || !Number.isInteger(item.port) || item.port < 1 || item.port > 65535 || seen.has(key)) refuse()
    seen.add(key)
  }
  return { namespace: input.namespace, image: input.image, proxySourceCidrs: [...cidrs],
    ...(values.imagePullSecretName ? { imagePullSecretName: values.imagePullSecretName } : {}),
    sshDestinations: destinations.map(item => ({ ip: item.ip, port: item.port })) }
}

/** Nonsecret environment consumed only by the Platform deployment entry point. */
export function connectorRunnerEnvironment(selected) {
  return selected === null ? {} : {
    PE_CONNECTOR_RUNNER_NAMESPACE: selected.namespace,
    PE_CONNECTOR_RUNNER_IMAGE: selected.image,
    PE_CONNECTOR_RUNNER_PROXY_SOURCE_CIDRS: selected.proxySourceCidrs.join(','),
    PE_CONNECTOR_IMAGE_PULL_SECRET_NAME: selected.imagePullSecretName ?? '',
    PE_SSH_DESTINATIONS: JSON.stringify(selected.sshDestinations),
  }
}

/** Validate all-or-none environment before profile creation; key paths are fixed projections. */
export function connectorRunnerFromEnvironment(env) {
  if (envFields.every(field => !env[field])) {
    if (env.PE_CONNECTOR_IMAGE_PULL_SECRET_NAME) refuse()
    return null
  }
  if (envFields.some(field => !env[field])) refuse()
  let destinations
  try { destinations = JSON.parse(env.PE_SSH_DESTINATIONS) } catch { refuse() }
  return connectorRunnerValues({
    namespace: env.PE_CONNECTOR_RUNNER_NAMESPACE, image: env.PE_CONNECTOR_RUNNER_IMAGE,
    proxySourceCidrs: env.PE_CONNECTOR_RUNNER_PROXY_SOURCE_CIDRS.split(','),
    sshDestinations: destinations,
  }, { namespace: env.PE_APPLICATION_NAMESPACE, runnerNamespace: env.PE_SANDBOX_NAMESPACE,
    imagePullSecretName: env.PE_CONNECTOR_IMAGE_PULL_SECRET_NAME })
}

/** Map directly to existing Application fields; no arbitrary kubeconfig or secret paths. */
export function connectorRunnerProfile(selected) {
  return {
    sshRunnerKubeconfigFile: selected === null ? '' : 'in-cluster',
    sshRunnerNamespace: selected?.namespace ?? '',
    sshRunnerImage: selected?.image ?? '',
    sshRunnerRuntimeClass: 'gvisor',
    sshRunnerIngressCidrs: selected?.proxySourceCidrs.join(',') ?? '',
    ...(selected === null ? {} : { sshRunnerImagePullSecretName: selected.imagePullSecretName ?? '' }),
    sshDestinationAllowlist: (selected?.sshDestinations ?? []).map(item => item.ip + ':' + item.port).join(','),
    sshCredentialKeyFile: selected?.sshDestinations.length ? sshCredentialKeyPath : '',
  }
}

/** Use real constructors to check key encoding, allowlist and Runner grammar without I/O. */
export async function validateConnectorMaterials(selected, controlKey, sshKey = '') {
  if (selected === null) return { connectorRunnerReady: false, sshConfigured: false }
  try {
    const { SshConnectionService } = await import('../application/lib/platform/ssh.js')
    const { SshRunnerOrchestrator } = await import('../application/lib/platform/ssh-runner.js')
    const { StdioRunnerOrchestrator } = await import('../application/lib/platform/stdio-runner.js')
    const config = { namespace: selected.namespace, image: selected.image, runtimeClassName: 'gvisor',
      ...(selected.imagePullSecretName ? { imagePullSecretName: selected.imagePullSecretName } : {}),
      controlKey: controlKey.trim(), readyTimeoutMs: 30000, platformIngressCidrs: selected.proxySourceCidrs,
      forbiddenProbe: { ip: '127.0.0.1', port: 8080 }, proveForbiddenListener: async () => false }
    new SshRunnerOrchestrator(undefined, config)
    new StdioRunnerOrchestrator(undefined, config)
    const profile = connectorRunnerProfile(selected)
    const ssh = new SshConnectionService(undefined, sshKey, profile.sshDestinationAllowlist)
    assert.equal(ssh.available, selected.sshDestinations.length > 0)
    return { connectorRunnerReady: true, sshConfigured: ssh.available }
  } catch { throw new Error('Invalid Connector Runner deployment materials') }
}

/** Fixed path reads happen before profile writes or child launch; disabled mode reads nothing. */
export async function validateConnectorStartup(env, readText) {
  const selected = connectorRunnerFromEnvironment(env)
  if (selected === null) return
  try {
    await validateConnectorMaterials(selected, await readText(connectorKeyPath),
      selected.sshDestinations.length ? await readText(sshCredentialKeyPath) : '')
  } catch { throw new Error('Invalid Connector Runner deployment materials') }
}

/** Namespace-scoped resources and a real forbidden listener from the existing image-owned template. */
export function connectorRunnerManifests(values, selected) {
  if (selected === null) return []
  const ns = selected.namespace
  const metadata = resource => ({ name: resource, namespace: ns,
    labels: { 'app.kubernetes.io/part-of': 'power-evolve' } })
  const listener = yaml.loadAll(readFileSync(new URL('../connector-runner/deploy/forbidden-listener.yaml',
    import.meta.url), 'utf8'))
  for (const item of listener) item.metadata.namespace = ns
  const pod = listener[0].spec.template.spec
  pod.serviceAccountName = 'default'
  pod.containers[0].image = selected.image
  const role = { apiVersion: 'rbac.authorization.k8s.io/v1', kind: 'Role',
    metadata: metadata(connectorRoleName), rules: [
      { apiGroups: [''], resources: ['pods', 'services', 'secrets'], verbs: ['get', 'create', 'delete'] },
      { apiGroups: [''], resources: ['services/proxy'], verbs: ['get', 'create'] },
      { apiGroups: ['networking.k8s.io'], resources: ['networkpolicies'], verbs: ['get', 'create', 'delete'] },
    ] }
  return [
    { apiVersion: 'v1', kind: 'Namespace', metadata: { name: ns,
      labels: { 'app.kubernetes.io/part-of': 'power-evolve', 'app.kubernetes.io/component': 'connector-runner' } } },
    // Runtime Pods omit serviceAccountName. Admission copies this SA's pull references into each Pod.
    { apiVersion: 'v1', kind: 'ServiceAccount', metadata: metadata('default'),
      automountServiceAccountToken: false,
      ...(values.imagePullSecretName ? { imagePullSecrets: [{ name: values.imagePullSecretName }] } : {}) },
    role,
    { apiVersion: 'rbac.authorization.k8s.io/v1', kind: 'RoleBinding',
      metadata: metadata(connectorRoleName),
      subjects: [{ kind: 'ServiceAccount', name: 'power-evolve-platform', namespace: values.namespace }],
      roleRef: { apiGroup: 'rbac.authorization.k8s.io', kind: 'Role', name: connectorRoleName } },
    { apiVersion: 'networking.k8s.io/v1', kind: 'NetworkPolicy',
      metadata: metadata('default-deny'),
      spec: { podSelector: {}, policyTypes: ['Ingress', 'Egress'], ingress: [], egress: [] } },
    { apiVersion: 'networking.k8s.io/v1', kind: 'NetworkPolicy',
      metadata: metadata('allow-forbidden-listener-control'),
      spec: { podSelector: { matchLabels: { [appLabel]: connectorListenerName } },
        policyTypes: ['Ingress', 'Egress'], egress: [],
        ingress: [{ from: selected.proxySourceCidrs.map(cidr => ({ ipBlock: { cidr } })),
          ports: [{ protocol: 'TCP', port: 8080 }] }] } },
    ...listener,
  ]
}

/** Compare every connector resource and reject authority added anywhere in the rendered bundle. */
export function validateConnectorBundle(values, items) {
  const selected = connectorRunnerValues(values.connectorRunner, values)
  if (selected === null) return
  const expected = connectorRunnerManifests(values, selected)
  const actual = items.filter(item => item.metadata?.namespace === selected.namespace
    || item.kind === 'Namespace' && item.metadata.name === selected.namespace)
  assert(isDeepStrictEqual(actual, expected), 'Connector Runner deployment resources differ')
}

/** Verify live control path and exact allow/deny observations; no workload creation or credentials returned.
 * @param selected Validated connector metadata.
 * @param values Deployment resource names.
 * @param io Read-only resource, impersonated RBAC and impersonated Service-proxy adapters.
 * @returns Live listener and scoped-authorization observations only.
 */
export async function checkConnectorCluster(selected, values, io) {
  if (selected === null) return {}
  const ns = selected.namespace, subject = values.namespace + ':power-evolve-platform'
  const expected = connectorRunnerManifests(values, selected)
  for (const kind of ['Role', 'RoleBinding', 'ServiceAccount', 'NetworkPolicy']) {
    for (const wanted of expected.filter(item => item.kind === kind)) {
      const actual = await io.get(ns, kind.toLowerCase(), wanted.metadata.name)
      for (const field of ['rules', 'roleRef', 'subjects', 'spec', 'automountServiceAccountToken', 'imagePullSecrets']) {
        let observed = actual[field]
        if (kind === 'NetworkPolicy' && field === 'spec') {
          observed = { ...observed, ingress: observed?.ingress ?? [], egress: observed?.egress ?? [] }
        }
        assert(isDeepStrictEqual(observed, wanted[field]), 'Connector Runner ' + kind + ' differs')
      }
    }
  }
  for (const [resource, verbs] of [['pods', ['get', 'create', 'delete']], ['services', ['get', 'create', 'delete']],
    ['secrets', ['get', 'create', 'delete']], ['services/proxy', ['get', 'create']],
    ['networkpolicies.networking.k8s.io', ['get', 'create', 'delete']]]) {
    for (const verb of verbs) assert(await io.can(ns, subject, verb, resource), 'Platform lacks connector ' + verb + ' ' + resource)
  }
  for (const [namespace, account, verb, resource] of [
    ...['pods', 'secrets', 'networkpolicies.networking.k8s.io'].flatMap(resource =>
      ['list', 'watch'].map(verb => [ns, subject, verb, resource])),
    [ns, subject, 'create', 'deployments.apps'], [ns, subject, 'create', 'rolebindings.rbac.authorization.k8s.io'],
    [ns, subject, 'get', 'pods/exec'], [ns, subject, 'create', 'pods/exec'],
    ...[values.namespace, values.runnerNamespace, 'kube-system'].map(namespace => [namespace, subject, 'create', 'pods']),
    ...[values.namespace + ':power-evolve-host', ns + ':default', values.runnerNamespace + ':power-evolve-runner']
      .flatMap(account => ['pods', 'secrets', 'services/proxy'].map(resource => [ns, account, 'get', resource])),
  ]) assert.equal(await io.can(namespace, account, verb, resource), false,
    account + ' has unexpected connector ' + verb + ' ' + resource)
  if (values.imagePullSecretName) await io.get(ns, 'secret', values.imagePullSecretName)
  const service = await io.get(ns, 'service', connectorListenerName)
  assert.equal(service.spec?.type, 'ClusterIP')
  assert(isIP(service.spec.clusterIP), 'Forbidden listener has no cluster IP')
  assert.deepEqual(service.spec.selector, { [appLabel]: connectorListenerName })
  assert.deepEqual(service.spec.ports, [{ name: 'http', protocol: 'TCP', port: 8080, targetPort: 'http' }])
  const deployment = await io.get(ns, 'deployment', connectorListenerName)
  assert((deployment.status?.availableReplicas ?? 0) >= 1
    && deployment.status?.observedGeneration >= deployment.metadata?.generation, 'Forbidden listener is not Ready')
  const wanted = expected.find(item => item.kind === 'Deployment')
  assert.deepEqual(deployment.spec.selector, wanted.spec.selector)
  assert.deepEqual(deployment.spec.template.metadata.labels, wanted.spec.template.metadata.labels)
  const spec = deployment.spec.template.spec
  assert.equal(spec.containers.length, 1)
  for (const field of ['name', 'image', 'imagePullPolicy', 'command', 'args', 'securityContext']) {
    assert.deepEqual(spec.containers[0][field], wanted.spec.template.spec.containers[0][field],
      'Forbidden listener container differs')
  }
  const ports = container => container.ports?.map(port => ({ protocol: 'TCP', ...port }))
  assert.deepEqual(ports(spec.containers[0]), ports(wanted.spec.template.spec.containers[0]))
  assert.equal(spec.volumes, undefined)
  assert.deepEqual(spec.securityContext, wanted.spec.template.spec.securityContext)
  assert.equal(spec.runtimeClassName, 'gvisor')
  assert.equal(spec.automountServiceAccountToken, false)
  assert.equal(spec.serviceAccountName, 'default')
  const health = await io.proxy(ns, subject, connectorListenerName)
  assert.equal(health?.healthy, true, 'Forbidden listener control health failed')
  return { connectorNamespaceRbacChecked: true, connectorListenerReady: true,
    connectorControlHealthVerified: true, connectorNetworkEnforcementVerified: false }
}
