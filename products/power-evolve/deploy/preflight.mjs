/** Static and read-only cluster checks for the S7d deployment sample. */
import assert from 'node:assert/strict'
import { X509Certificate } from 'node:crypto'
import { spawnSync } from 'node:child_process'
import { readFile } from 'node:fs/promises'
import { createRequire } from 'node:module'
import { fileURLToPath } from 'node:url'
import { isDeepStrictEqual } from 'node:util'
import { buildManifests, validateValues } from './render.mjs'
import { remoteMcpCaPath, remoteMcpConfigPath, remoteMcpKeyPath,
  remoteMcpMountedMetadata, remoteMcpValues } from './remote-mcp.mjs'
import { accountBootstrapEnabled, accountBootstrapPath, accountManagementPath, validateAccountStartup } from './accounts.mjs'

const require = createRequire(new URL('../application/package.json', import.meta.url))
const yaml = require('js-yaml')
const self = fileURLToPath(import.meta.url)
const exampleAddress = /(?:^|\.)(?:example|invalid|test)(?:\.|$)/u

function resource(items, kind, name, namespace) {
  const found = items.filter(item => item.kind === kind && item.metadata?.name === name
    && (item.metadata.namespace ?? null) === (namespace ?? null))
  assert.equal(found.length, 1, `Expected one ${kind} ${namespace ?? ''}/${name}`)
  return found[0]
}
function isDocumentationAddress(value) {
  const ip = value.split('/')[0]
  const parts = ip.split('.').map(Number)
  return parts.length === 4 && (parts[0] === 192 && parts[1] === 0 && parts[2] === 2
    || parts[0] === 198 && parts[1] === 51 && parts[2] === 100
    || parts[0] === 203 && parts[1] === 0 && parts[2] === 113)
}

/** Enforce authority and mount separation even when a manifest is edited after rendering. */
export function validateBundle(values, items) {
  validateValues(values)
  const app = values.namespace, runner = values.runnerNamespace
  const expected = buildManifests(values)
  const host = resource(items, 'Deployment', 'power-evolve-host', app)
  const platform = resource(items, 'Deployment', 'power-evolve-platform', app)
  const hostSpec = host.spec.template.spec, platformSpec = platform.spec.template.spec
  assert.equal(platformSpec.containers[0].readinessProbe?.httpGet?.path, '/health')
  assert.equal(platformSpec.containers[0].livenessProbe?.httpGet?.path, '/live')
  assert.equal(hostSpec.automountServiceAccountToken, false)
  assert.equal(hostSpec.serviceAccountName, 'power-evolve-host')
  assert.equal(platformSpec.serviceAccountName, 'power-evolve-platform')
  assert.equal(platformSpec.automountServiceAccountToken, true)
  assert.equal(hostSpec.volumes.some(item => item.persistentVolumeClaim), false,
    'Host must not mount shared POSIX storage')
  assert.equal(hostSpec.volumes.some(item => item.projected?.sources?.some(source =>
    source.secret?.name === values.secrets.platform)), false, 'Host must not mount Platform Secret')
  assert(isDeepStrictEqual(hostSpec.volumes.find(item => item.name === 'private').projected.sources
    .flatMap(source => source.secret?.items?.map(item => item.key) ?? []), ['worker-token']),
  'Host private projection differs')
  for (const [role, spec] of [['host', hostSpec], ['platform', platformSpec]]) {
    const wanted = resource(expected, 'Deployment', `power-evolve-${role}`, app).spec.template.spec
    assert(isDeepStrictEqual(spec.volumes, wanted.volumes), `${role} volume sources differ from declared projections`)
    assert.equal(spec.containers.length, 1, `${role} has unexpected containers`)
    assert(spec.initContainers === undefined, `${role} has unexpected init containers`)
    assert(spec.ephemeralContainers === undefined, `${role} has unexpected ephemeral containers`)
    for (const field of ['volumeMounts', 'envFrom', 'env', 'command', 'args', 'workingDir', 'securityContext']) {
      assert(isDeepStrictEqual(spec.containers[0][field], wanted.containers[0][field]), `${role} ${field} differs`)
    }
  }
  assert.equal(platformSpec.volumes.find(item => item.name === 'shared-posix')
    .persistentVolumeClaim.claimName, values.storage.platformClaim)
  assert.equal(hostSpec.containers[0].image, platformSpec.containers[0].image)
  assert.equal(hostSpec.containers[0].image, values.appImage)
  const hostConfig = resource(items, 'ConfigMap', 'power-evolve-host-config', app).data
  const platformConfig = resource(items, 'ConfigMap', 'power-evolve-platform-config', app).data
  for (const role of ['host', 'platform']) {
    assert(isDeepStrictEqual(resource(items, 'ConfigMap', `power-evolve-${role}-config`, app).data,
      resource(expected, 'ConfigMap', `power-evolve-${role}-config`, app).data), `${role} configuration differs`)
  }
  assert.equal(hostConfig.PE_HOST_PUBLIC_ORIGIN, values.hostPublicOrigin)
  assert.equal(hostConfig.PE_PLATFORM_PUBLIC_ORIGIN, values.platformPublicOrigin)
  assert.equal(platformConfig.PE_HOST_PUBLIC_ORIGIN, values.hostPublicOrigin)
  assert.equal(platformConfig.PE_PLATFORM_PUBLIC_ORIGIN, values.platformPublicOrigin)
  assert.equal(platformConfig.PE_SANDBOX_VOLUME_CLAIM, values.storage.runnerClaim)
  assert.equal(Object.keys(hostConfig).some(key => /DATABASE|KUBECONFIG|SANDBOX_LOCAL_ROOT/u.test(key)),
    false, 'Host config includes Platform authority')
  const ingress = resource(items, 'Ingress', 'power-evolve-public', app)
  assert.deepEqual(new Set(ingress.spec.tls[0].hosts), new Set([
    new URL(values.hostPublicOrigin).hostname, new URL(values.platformPublicOrigin).hostname]))
  for (const [kind, pv, claim, namespace] of [
    ['platform', values.storage.platformPv, values.storage.platformClaim, app],
    ['runner', values.storage.runnerPv, values.storage.runnerClaim, runner],
  ]) {
    const volume = resource(items, 'PersistentVolume', pv)
    const pvc = resource(items, 'PersistentVolumeClaim', claim, namespace)
    assert.equal(volume.spec.nfs.server, values.storage.nfsServer, `${kind} NFS server differs`)
    assert.equal(volume.spec.nfs.path, values.storage.nfsPath, `${kind} NFS path differs`)
    assert.deepEqual(volume.spec.accessModes, ['ReadWriteMany'])
    assert.equal(volume.spec.persistentVolumeReclaimPolicy, 'Retain')
    assert.equal(pvc.spec.volumeName, pv)
    assert.deepEqual(pvc.spec.accessModes, ['ReadWriteMany'])
  }
  const binding = resource(items, 'RoleBinding', 'power-evolve-platform-runner', runner)
  assert.deepEqual(binding.subjects, [{ kind: 'ServiceAccount', name: 'power-evolve-platform',
    namespace: app }])
  assert.deepEqual(binding.roleRef, { apiGroup: 'rbac.authorization.k8s.io', kind: 'Role',
    name: 'power-evolve-platform-runner' })
  const role = resource(items, 'Role', 'power-evolve-platform-runner', runner)
  assert.equal(items.some(item => item.kind === 'ClusterRole' || item.kind === 'ClusterRoleBinding'), false)
  assert(isDeepStrictEqual(role.rules,
    resource(expected, 'Role', 'power-evolve-platform-runner', runner).rules),
  'Platform runner Role permissions differ')
  assert.equal(resource(items, 'ServiceAccount', 'power-evolve-runner', runner)
    .automountServiceAccountToken, false)
  for (const namespace of [app, runner]) resource(items, 'NetworkPolicy', 'default-deny', namespace)
  resource(items, 'NetworkPolicy', 'allow-host', app)
  resource(items, 'NetworkPolicy', 'allow-platform', app)
  resource(items, 'NetworkPolicy', 'allow-runner', runner)
  const ownedPolicies = list => list.filter(item => item.kind === 'NetworkPolicy'
    && [app, runner].includes(item.metadata?.namespace)).map(item => ({
    name: item.metadata.name, namespace: item.metadata.namespace, spec: item.spec,
  })).sort((a, b) => `${a.namespace}/${a.name}`.localeCompare(`${b.namespace}/${b.name}`))
  assert(isDeepStrictEqual(ownedPolicies(items), ownedPolicies(expected)), 'Deployment NetworkPolicy permissions differ')
  assert.equal(items.some(item => item.kind === 'Secret' && [app, runner].includes(item.metadata?.namespace)), false,
    'Deployment Secrets must remain externally provisioned')
  assert.equal(items.filter(item => item.kind === 'ConfigMap' && item.metadata?.namespace === app).length, 2,
    'Unexpected application ConfigMap')
  return { resources: items.length, namespaces: [app, runner],
    hostOrigin: values.hostPublicOrigin, platformOrigin: values.platformPublicOrigin,
    imagesPinned: true, hostHasPlatformSecret: false, hostHasPvc: false,
    runnerServiceAccountToken: false, roleNamespace: runner }
}

function kubectl(context, args) {
  const result = spawnSync('kubectl', ['--context', context, ...args], { encoding: 'utf8',
    timeout: 30_000, maxBuffer: 2 * 1024 * 1024 })
  if (result.status !== 0) throw new Error(`kubectl ${args.slice(0, 3).join(' ')} failed: ${(result.stderr || result.stdout).slice(-500)}`)
  return result.stdout.trim()
}
const get = (context, namespace, kind, name) => JSON.parse(kubectl(context,
  [...(namespace ? ['-n', namespace] : []), 'get', kind, name, '-o', 'json']))
function can(context, namespace, subject, verb, resourceName) {
  return kubectl(context, ['-n', namespace, 'auth', 'can-i', verb, resourceName,
    `--as=system:serviceaccount:${subject}`]) === 'yes'
}
function secretBytes(secret, key) {
  const encoded = secret.data?.[key]
  if (!encoded || typeof encoded !== 'string') throw new Error(`Missing Secret key ${key}`)
  const bytes = Buffer.from(encoded, 'base64')
  if (!bytes.length) throw new Error(`Empty Secret key ${key}`)
  return bytes
}

/** Check provisioned dependencies without printing credential values or mutating the cluster. */
export function readyValues(values) {
  validateValues(values)
  for (const field of ['hostPublicOrigin', 'platformPublicOrigin', 'modelUrl', 'connectorUrl']) {
    if (exampleAddress.test(new URL(values[field]).hostname)) throw new Error(`Replace example ${field}`)
  }
  for (const field of ['appImage', 'sandboxImage']) {
    if (/^([0-9a-f])\1{63}$/u.test(values[field].split('@sha256:')[1])) {
      throw new Error(`Replace example ${field} digest`)
    }
  }
  if (isDocumentationAddress(values.storage.nfsServer)
    || Object.values(values.network).some(item => Array.isArray(item)
      && item.some(value => isDocumentationAddress(value)))) {
    throw new Error('Replace documentation network addresses')
  }
  const remote = remoteMcpValues(values.remoteMcp, values.secrets.shared)
  if (remote?.destinations.some(item => exampleAddress.test(new URL(item.origin).hostname)
    || item.addresses.some(isDocumentationAddress))) throw new Error('Replace documentation MCP destinations')
}

/** Validate only the declared MCP Secret/CA entries with the Platform's real parser and a closed text reader.
 * @param values Validated deployment values; omission leaves MCP disabled.
 * @param getObject Read-only lookup scoped by the caller to this deployment's application namespace.
 * @returns A material-free readiness flag; errors never include JSON, filenames, credentials or CA bytes.
 */
export async function validateRemoteMcpMaterials(values, getObject) {
  try {
    const remote = remoteMcpValues(values.remoteMcp, values.secrets.shared)
    if (remote === null) return { remoteMcpReady: false }
    const secret = await getObject('secret', remote.secretName)
    const body = secretBytes(secret, 'remote-mcp.json').toString('utf8')
    const metadata = remoteMcpMountedMetadata(JSON.parse(body))
    if (!isDeepStrictEqual(metadata.destinations, remote.destinations)) throw new Error('Destination mismatch')
    const files = new Map([[remoteMcpConfigPath, body],
      [remoteMcpKeyPath, secretBytes(secret, 'remote-mcp-key').toString('utf8')]])
    if (remote.caConfigMapName) {
      const ca = await getObject('configmap', remote.caConfigMapName)
      for (const destination of remote.destinations) if (destination.caKey !== undefined) {
        const pem = ca.data?.[destination.caKey]
        if (typeof pem !== 'string' || !pem.length) throw new Error('Missing CA')
        files.set(remoteMcpCaPath(destination.caKey), pem)
      }
    }
    const { loadMcpPlatformConfig } = await import('../application/lib/platform/mcp-platform-config.js')
    await loadMcpPlatformConfig(remoteMcpConfigPath, async filename => {
      if (!files.has(filename)) throw new Error('Unprojected file')
      return files.get(filename)
    })
    return { remoteMcpReady: true }
  } catch { throw new Error('Invalid remote MCP deployment materials') }
}

/** Validate only the declared Platform account files; the result contains no secret material.
 * @param values Deployment values selecting the optional bootstrap projection.
 * @param platformSecret The already-selected Platform Secret, without any resource enumeration.
 * @returns Configuration readiness without private bytes.
 */
export async function validateAccountMaterials(values, platformSecret) {
  try {
    const bootstrap = accountBootstrapEnabled(values.accounts)
    const files = new Map([[accountManagementPath, secretBytes(platformSecret, 'account-management.json').toString('utf8')]])
    if (bootstrap) files.set(accountBootstrapPath, secretBytes(platformSecret, 'account-bootstrap.json').toString('utf8'))
    await validateAccountStartup(bootstrap ? accountBootstrapPath : '', async path => {
      if (!files.has(path)) throw new Error('Unprojected file')
      return files.get(path)
    })
    return { accountConfigurationReady: true, accountBootstrapConfigured: bootstrap }
  } catch { throw new Error('Invalid account deployment materials') }
}

/** Inspect declared dependencies without deploying resources or enumerating MCP Secrets.
 * @param values Deployment values with explicit resource names.
 * @param context Selected kubectl context.
 * @returns Readiness observations without credential material.
 */
export async function checkCluster(values, context) {
  readyValues(values)
  const app = values.namespace, runner = values.runnerNamespace
  const nodes = JSON.parse(kubectl(context, ['get', 'nodes', '-o', 'json'])).items
  assert(nodes.filter(node => node.status.conditions?.some(condition => condition.type === 'Ready'
    && condition.status === 'True')).length >= 2, 'At least two Ready nodes are required')
  get(context, null, 'crd', 'sandboxes.agents.x-k8s.io')
  get(context, null, 'runtimeclass', 'gvisor')
  const controller = get(context, 'agent-sandbox-system', 'deployment', 'agent-sandbox-controller')
  assert((controller.status?.availableReplicas ?? 0) >= 1, 'Agent Sandbox controller is unavailable')
  const shared = get(context, app, 'secret', values.secrets.shared)
  secretBytes(shared, 'worker-token')
  const platform = get(context, app, 'secret', values.secrets.platform)
  const databaseUrl = new URL(secretBytes(platform, 'database-url').toString('utf8').trim())
  if (!['postgresql:', 'postgres:'].includes(databaseUrl.protocol)
    || !databaseUrl.hostname || databaseUrl.hostname === 'localhost'
    || databaseUrl.hostname.endsWith('.svc.cluster.local')
    || databaseUrl.searchParams.get('sslmode') !== 'verify-full') {
    throw new Error('External PostgreSQL URL must use TLS verify-full')
  }
  for (const key of ['model-key', 'connector-key', 'runner-key', 'users.json']) secretBytes(platform, key)
  const accounts = await validateAccountMaterials(values, platform)
  const remoteMcp = await validateRemoteMcpMaterials(values, (kind, name) => get(context, app, kind, name))
  if (values.imagePullSecretName) {
    get(context, app, 'secret', values.imagePullSecretName)
    get(context, runner, 'secret', values.imagePullSecretName)
  }
  const tls = get(context, app, 'secret', values.tlsSecretName)
  assert.equal(tls.type, 'kubernetes.io/tls')
  const certificate = new X509Certificate(secretBytes(tls, 'tls.crt'))
  const names = certificate.subjectAltName.split(',').map(value => value.trim())
  for (const origin of [values.hostPublicOrigin, values.platformPublicOrigin]) {
    assert(names.includes(`DNS:${new URL(origin).hostname}`), 'TLS certificate SAN does not cover both public Origins')
  }
  assert(new Date(certificate.validTo).getTime() > Date.now(), 'TLS certificate has expired')
  secretBytes(tls, 'tls.key')
  for (const [namespace, claimName, pvName] of [[app, values.storage.platformClaim, values.storage.platformPv],
    [runner, values.storage.runnerClaim, values.storage.runnerPv]]) {
    const claim = get(context, namespace, 'pvc', claimName)
    const pv = get(context, null, 'pv', pvName)
    assert.equal(claim.status?.phase, 'Bound', `${namespace} PVC is not Bound`)
    assert.equal(claim.spec.volumeName, pvName)
    assert.equal(pv.spec.nfs?.server, values.storage.nfsServer)
    assert.equal(pv.spec.nfs?.path, values.storage.nfsPath)
  }
  const platformSubject = `${app}:power-evolve-platform`
  for (const [verb, resourceName] of [['list', 'sandboxes.agents.x-k8s.io'],
    ['create', 'sandboxes.agents.x-k8s.io'],
    ['delete', 'sandboxes.agents.x-k8s.io'], ['patch', 'pods'], ['get', 'services/proxy']]) {
    assert(can(context, runner, platformSubject, verb, resourceName), `Platform lacks ${verb} ${resourceName}`)
  }
  for (const [namespace, subject, verb, resourceName] of [
    [runner, platformSubject, 'list', 'secrets'],
    [runner, platformSubject, 'watch', 'sandboxes.agents.x-k8s.io'],
    [runner, platformSubject, 'list', 'pods'],
    [runner, platformSubject, 'create', 'pods'],
    [app, platformSubject, 'list', 'sandboxes.agents.x-k8s.io'],
    [app, platformSubject, 'get', 'secrets'],
    [runner, `${app}:power-evolve-host`, 'get', 'secrets'],
    [runner, `${app}:power-evolve-host`, 'list', 'sandboxes.agents.x-k8s.io'],
    [runner, `${runner}:power-evolve-runner`, 'get', 'pods'],
    [runner, `${runner}:power-evolve-runner`, 'list', 'sandboxes.agents.x-k8s.io'],
  ]) assert.equal(can(context, namespace, subject, verb, resourceName), false,
    `${subject} has unexpected ${verb} ${resourceName} in ${namespace}`)
  return { ...remoteMcp, ...accounts, readyNodes: nodes.length, controllerReady: true, secretsPresent: true,
    tlsCoversPublicOrigins: true, sharedPvcBound: true, namespaceRbacChecked: true,
    crossMachineStorageVerified: false, ingressStreamingVerified: false,
    networkPolicyEnforcementVerified: false }
}

if (process.argv[1] === self) {
  const [valuesPath, manifestPath, ...flags] = process.argv.slice(2)
  if (!valuesPath || !manifestPath) throw new Error('Use preflight.mjs <values.json> <manifest.yaml> [--context NAME] [--ready]')
  const values = JSON.parse(await readFile(valuesPath, 'utf8'))
  const manifest = await readFile(manifestPath, 'utf8')
  const items = yaml.loadAll(manifest).filter(Boolean)
  const report = validateBundle(values, items)
  assert.deepEqual(items.length, buildManifests(values).length)
  const contextIndex = flags.indexOf('--context')
  const context = contextIndex >= 0 ? flags[contextIndex + 1] : null
  if (context) {
    kubectl(context, ['apply', '--dry-run=client', '-f', manifestPath])
  }
  if (flags.includes('--ready')) {
    if (!context) throw new Error('--ready requires --context')
    Object.assign(report, await checkCluster(values, context))
  }
  console.log(JSON.stringify(report, null, 2))
}
