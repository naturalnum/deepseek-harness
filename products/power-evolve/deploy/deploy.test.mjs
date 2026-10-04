import test from 'node:test'
import assert from 'node:assert/strict'
import { mkdtemp, readFile, rm } from 'node:fs/promises'
import { randomBytes } from 'node:crypto'
import { spawnSync } from 'node:child_process'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { createRequire, syncBuiltinESMExports } from 'node:module'
import { renderProfile, validateRemoteMcpStartup } from './start.mjs'
import { buildManifests, render, validateValues } from './render.mjs'
import { checkCluster, validateBundle, readyValues, validateRemoteMcpMaterials } from './preflight.mjs'
import { remoteMcpCaPath, remoteMcpConfigPath, remoteMcpKeyPath, remoteMcpValues } from './remote-mcp.mjs'
import { officePreviewValues, officePreviewPodVerbs } from './office-preview.mjs'

const require = createRequire(new URL('../application/package.json', import.meta.url))
const yaml = require('js-yaml')
const manifestSchema = yaml.DEFAULT_SCHEMA.extend(new yaml.Type('tag:yaml.org,2002:js', {
  kind: 'scalar', construct: value => value,
}))
const values = JSON.parse(await readFile(new URL('./values.example.json', import.meta.url), 'utf8'))

test('production profiles retain bundle fields and separate Host and Platform authority', async () => {
  const home = await mkdtemp(join(tmpdir(), 'pe-s7d-profile-'))
  try {
    const env = { PE_HOST_PUBLIC_ORIGIN: values.hostPublicOrigin,
      PE_PLATFORM_PUBLIC_ORIGIN: values.platformPublicOrigin,
      PE_PLATFORM_INTERNAL_URL: `http://power-evolve-platform.${values.namespace}.svc.cluster.local:18881`,
      PE_SANDBOX_NAMESPACE: values.runnerNamespace,
      PE_SANDBOX_IMAGE: values.sandboxImage,
      PE_SANDBOX_VOLUME_CLAIM: values.storage.runnerClaim,
      PE_MODEL_URL: values.modelUrl, PE_CONNECTOR_URL: values.connectorUrl }
    for (const role of ['host', 'platform']) {
      const { profile } = await renderProfile(role, env, join(home, role))
      const rows = yaml.load(await readFile(join(profile, 'cordis.patch.yml'), 'utf8'),
        { schema: manifestSchema })
      assert.equal(rows.length, role === 'host' ? 3 : 2)
      assert.equal(rows[0].config.host, '0.0.0.0')
      if (role === 'host') {
        assert.equal(rows[1].config.platformUrl, env.PE_PLATFORM_INTERNAL_URL)
        assert.equal(rows[2].config.origin, values.hostPublicOrigin)
        assert.equal(rows[2].config.platformOrigin, values.platformPublicOrigin)
        assert.equal(JSON.stringify(rows).includes('databaseUrlFile'), false)
      } else {
        const config = rows[1].config
        assert.equal(config.sandboxKubeconfigFile, 'in-cluster')
        assert.equal(config.sandboxNodeRoot, '')
        assert.equal(config.sandboxVolumeClaimName, values.storage.runnerClaim)
        assert.equal(config.workspaceRoot, '/data/workspaces')
        assert.equal(config.skillLibraryRoot, config.sandboxLocalRoot)
        assert.equal(config.skillLibraryRoot, '/data')
        assert.equal(config.preinstalledSkills.length, 9)
        assert.equal(config.modelUrl, values.modelUrl)
        assert.equal(config.remoteMcpConfigFile, '')
      }
    }
    for (const role of ['host', 'platform']) {
      const configured = { ...env, PE_REMOTE_MCP_CONFIG_FILE: remoteMcpConfigPath }
      const { profile } = await renderProfile(role, configured, join(home, `${role}-mcp`))
      const rows = yaml.load(await readFile(join(profile, 'cordis.patch.yml'), 'utf8'), { schema: manifestSchema })
      if (role === 'platform') assert.equal(rows[1].config.remoteMcpConfigFile, configured.PE_REMOTE_MCP_CONFIG_FILE)
      else assert(!JSON.stringify(rows).includes('/remote-mcp/'))
    }
    await assert.rejects(renderProfile('platform', { ...env, PE_REMOTE_MCP_CONFIG_FILE: '/arbitrary/config.json' }, home),
      /Invalid remote MCP deployment configuration path/u)
  } finally { await rm(home, { recursive: true, force: true }) }
})

const mcpValues = () => ({ ...structuredClone(values), remoteMcp: {
  secretName: 'pe-mcp-operator', caConfigMapName: 'pe-mcp-ca', destinations: [
    { origin: 'https://quotes.internal:8443', addresses: ['::ffff:10.70.0.12', '10.70.0.13'], caKey: 'quotes.pem' },
    { origin: 'https://inventory.internal:9443', addresses: ['fd00:70::1'] },
  ],
} })
const resource = (items, kind, name) => items.find(item => item.kind === kind && item.metadata.name === name)

for (const role of ['host', 'platform']) {
  for (const [field, value] of [
    ['hostNetwork', true], ['hostPID', true], ['hostIPC', true],
    ['securityContext', { runAsUser: 0, runAsGroup: 0, seccompProfile: { type: 'Unconfined' } }],
  ]) {
    test('preflight rejects ' + role + ' Pod ' + field + ' isolation drift', () => {
      const items = buildManifests(values)
      resource(items, 'Deployment', 'power-evolve-' + role).spec.template.spec[field] = value
      assert.throws(() => validateBundle(values, items))
    })
  }
}

test('preflight rejects Pod process sharing, runtime changes and Pod security additions or removal', () => {
  for (const role of ['host', 'platform']) {
    for (const edit of [
      spec => { spec.shareProcessNamespace = true },
      spec => { spec.runtimeClassName = 'gvisor' },
      spec => { spec.runtimeClassName = '' },
      spec => { spec.hostUsers = false },
      spec => { spec.os = { name: 'windows' } },
      spec => { delete spec.securityContext },
      spec => { delete spec.securityContext.seccompProfile },
      spec => { spec.securityContext.runAsUser = role === 'host' ? 0 : 10001 },
      spec => { spec.securityContext.runAsGroup = role === 'host' ? 0 : 10001 },
      spec => { spec.securityContext.fsGroup = 0 },
      spec => { spec.securityContext.runAsNonRoot = false },
      spec => { spec.securityContext.sysctls = [{ name: 'net.ipv4.ip_forward', value: '1' }] },
    ]) {
      const items = buildManifests(values)
      edit(resource(items, 'Deployment', 'power-evolve-' + role).spec.template.spec)
      assert.throws(() => validateBundle(values, items))
    }
  }
})

test('preflight accepts explicit false namespace flags and refuses nonboolean defaults', () => {
  const isolated = buildManifests(values)
  for (const role of ['host', 'platform']) {
    const spec = resource(isolated, 'Deployment', 'power-evolve-' + role).spec.template.spec
    for (const field of ['hostNetwork', 'hostPID', 'hostIPC', 'shareProcessNamespace']) spec[field] = false
  }
  assert.equal(validateBundle(values, isolated).resources, 23)
  for (const role of ['host', 'platform']) {
    for (const field of ['hostNetwork', 'hostPID', 'hostIPC', 'shareProcessNamespace']) {
      for (const invalid of [null, 'false', 0]) {
        const items = buildManifests(values)
        resource(items, 'Deployment', 'power-evolve-' + role).spec.template.spec[field] = invalid
        assert.throws(() => validateBundle(values, items))
      }
    }
  }
})

test('Platform can list Sandboxes for backup only through its runner namespace Role', () => {
  const items = buildManifests(values)
  const role = resource(items, 'Role', 'power-evolve-platform-runner')
  const binding = resource(items, 'RoleBinding', 'power-evolve-platform-runner')
  assert.equal(role.metadata.namespace, values.runnerNamespace)
  assert.deepEqual(role.rules, [
    { apiGroups: ['agents.x-k8s.io'], resources: ['sandboxes'], verbs: ['get', 'list', 'create', 'delete'] },
    { apiGroups: [''], resources: ['pods'], verbs: ['get', 'patch'] },
    { apiGroups: [''], resources: ['services', 'secrets'], verbs: ['get', 'create', 'delete'] },
    { apiGroups: [''], resources: ['services/proxy'], verbs: ['get', 'create'] },
  ])
  assert.equal(binding.metadata.namespace, values.runnerNamespace)
  assert.deepEqual(binding.subjects, [{ kind: 'ServiceAccount', name: 'power-evolve-platform',
    namespace: values.namespace }])
  assert.equal(validateBundle(values, items).roleNamespace, values.runnerNamespace)
})

test('preflight rejects missing Sandbox listing, wider permissions and changed RoleBinding scope', () => {
  const edits = [
    (role) => role.rules[0].verbs.splice(1, 1),
    (role) => role.rules[0].verbs.push('watch'),
    (role) => role.rules[1].verbs.push('list'),
    (role) => role.rules[1].verbs.push('create'),
    (role) => role.rules[2].verbs.push('list'),
    (role) => role.rules[0].apiGroups.push('*'),
    (role) => role.rules[0].resources.push('*'),
    (role) => role.rules[0].verbs.push('*'),
    (role) => role.metadata.namespace = values.namespace,
    (role, binding) => binding.metadata.namespace = values.namespace,
    (role, binding) => binding.subjects[0].namespace = values.runnerNamespace,
    (role, binding) => binding.roleRef.kind = 'ClusterRole',
    (role, binding) => binding.roleRef.name = 'broader-role',
  ]
  for (const edit of edits) {
    const items = buildManifests(values)
    edit(resource(items, 'Role', 'power-evolve-platform-runner'),
      resource(items, 'RoleBinding', 'power-evolve-platform-runner'))
    assert.throws(() => validateBundle(values, items))
  }
})

test('cluster readiness accepts normal RBAC denials and rejects missing, excessive or unobservable permission', async t => {
  if (spawnSync('openssl', ['version']).status !== 0) { t.skip('OpenSSL is unavailable'); return }
  const temporary = await mkdtemp(join(tmpdir(), 'pe-deploy-rbac-'))
  t.after(() => rm(temporary, { recursive: true, force: true }))
  const certificatePath = join(temporary, 'tls.crt')
  const generated = spawnSync('openssl', ['req', '-x509', '-newkey', 'rsa:2048', '-nodes',
    '-keyout', join(temporary, 'tls.key'), '-out', certificatePath, '-days', '1', '-subj', '/CN=host.qa.internal',
    '-addext', 'subjectAltName=DNS:host.qa.internal,DNS:platform.qa.internal'], { encoding: 'utf8', timeout: 10000 })
  assert.equal(generated.status, 0, generated.stderr)
  const configured = { ...structuredClone(values), imagePullSecretName: '',
    hostPublicOrigin: 'https://host.qa.internal', platformPublicOrigin: 'https://platform.qa.internal',
    modelUrl: 'https://model.qa.internal/v1/messages', connectorUrl: 'https://connector.qa.internal/v1' }
  configured.appImage = `registry.internal/app@sha256:${'0123456789abcdef'.repeat(4)}`
  configured.sandboxImage = `registry.internal/runner@sha256:${'abcdef0123456789'.repeat(4)}`
  configured.storage.nfsServer = '10.70.0.10'
  for (const key of ['postgresCidrs', 'modelCidrs', 'connectorCidrs', 'runnerProxySourceCidrs']) {
    configured.network[key] = ['10.70.0.20/32']
  }
  const encode = text => Buffer.from(text).toString('base64')
  const platformSecret = { data: Object.fromEntries(['model-key', 'connector-key', 'runner-key', 'users.json']
    .map(key => [key, encode('private-fixture')])) }
  platformSecret.data['database-url'] = encode('postgresql://fixture:fixture@db.qa.internal/fixture?sslmode=verify-full')
  platformSecret.data['account-management.json'] = encode(JSON.stringify({ maxUsers: 100,
    models: [{ id: 'fixture-model', label: 'Fixture', maxTokens: 128 }],
    initialSettings: { model: 'fixture-model', maxTokens: 64 } }))
  const tlsSecret = { type: 'kubernetes.io/tls', data: {
    'tls.crt': encode(await readFile(certificatePath, 'utf8')), 'tls.key': encode('private-fixture') } }
  const app = configured.namespace, runner = configured.runnerNamespace
  const subject = `${app}:power-evolve-platform`
  const key = (namespace, verb, resourceName) => `${namespace}|${subject}|${verb}|${resourceName}`
  const permissions = new Set([
    key(runner, 'list', 'sandboxes.agents.x-k8s.io'), key(runner, 'create', 'sandboxes.agents.x-k8s.io'),
    key(runner, 'delete', 'sandboxes.agents.x-k8s.io'), key(runner, 'patch', 'pods'), key(runner, 'get', 'services/proxy'),
  ])
  let invalidReply
  let listenerHealthy = true
  let nodes = [1, 2].map(() => ({ status: { conditions: [{ type: 'Ready', status: 'True' }] } }))
  const proxyReads = []
  const subprocess = require('node:child_process')
  t.mock.method(subprocess, 'spawnSync', (program, args) => {
    assert.equal(program, 'kubectl')
    const namespace = args.includes('-n') ? args[args.indexOf('-n') + 1] : null
    if (args.includes('--raw')) {
      proxyReads.push(args)
      return { status: 0, stdout: JSON.stringify({ healthy: listenerHealthy }), stderr: '' }
    }
    const canIndex = args.indexOf('can-i')
    if (canIndex >= 0) {
      if (invalidReply) return invalidReply
      const account = args.find(value => value.startsWith('--as=system:serviceaccount:')).slice('--as=system:serviceaccount:'.length)
      const resourceType = args[canIndex + 2]
      assert.equal(resourceType.includes('/'), false, 'auth can-i TYPE/NAME does not query a subresource')
      const subresource = args.find(value => value.startsWith('--subresource='))
      if (subresource) assert.equal(resourceType, subresource === '--subresource=proxy' ? 'services' : 'pods')
      const resourceName = subresource ? `${resourceType}/${subresource.slice('--subresource='.length)}` : resourceType
      const allowed = permissions.has(`${namespace}|${account}|${args[canIndex + 1]}|${resourceName}`)
      return { status: allowed ? 0 : 1, stdout: allowed ? 'yes\n' : 'no\n', stderr: '' }
    }
    const index = args.indexOf('get'), kind = args[index + 1], name = args[index + 2]
    let object = {}
    if (kind === 'nodes') object = { items: nodes }
    else if (configured.connectorRunner && namespace === configured.connectorRunner.namespace
      && ['deployment', 'service', 'serviceaccount', 'role', 'rolebinding', 'networkpolicy'].includes(kind)) {
      object = structuredClone(buildManifests(configured).find(item => item.kind.toLowerCase() === kind
        && item.metadata.name === name && item.metadata.namespace === namespace))
      if (kind === 'service') object.spec.clusterIP = '10.43.12.10'
      if (kind === 'deployment') {
        object.metadata.generation = 1
        object.status = { availableReplicas: 1, observedGeneration: 1 }
        object.spec.template.spec.containers[0].ports[0].protocol = 'TCP'
      }
      if (kind === 'networkpolicy') {
        if (!object.spec.ingress.length) delete object.spec.ingress
        if (!object.spec.egress.length) delete object.spec.egress
      }
    } else if (kind === 'deployment') object = { status: { availableReplicas: 1 } }
    else if (kind === 'configmap') object = buildManifests(configured).find(item => item.kind === 'ConfigMap'
      && item.metadata.name === name && item.metadata.namespace === namespace)
    else if (kind === 'secret') object = name === configured.secrets.platform ? platformSecret
      : name === configured.tlsSecretName ? tlsSecret : { data: { 'worker-token': encode('private-fixture') } }
    else if (kind === 'pvc') object = { status: { phase: 'Bound' }, spec: {
      volumeName: namespace === app ? configured.storage.platformPv : configured.storage.runnerPv } }
    else if (kind === 'pv') object = { spec: { nfs: { server: configured.storage.nfsServer, path: configured.storage.nfsPath } } }
    return { status: 0, stdout: JSON.stringify(object), stderr: '' }
  })
  syncBuiltinESMExports()
  t.after(() => { t.mock.restoreAll(); syncBuiltinESMExports() })
  assert.equal((await checkCluster(configured, 'fixture')).namespaceRbacChecked, true)
  permissions.delete(key(runner, 'list', 'sandboxes.agents.x-k8s.io'))
  await assert.rejects(checkCluster(configured, 'fixture'), /Platform lacks list sandboxes/u)
  permissions.add(key(runner, 'list', 'sandboxes.agents.x-k8s.io'))
  permissions.delete(key(runner, 'get', 'services/proxy'))
  await assert.rejects(checkCluster(configured, 'fixture'), /Platform lacks get services\/proxy/u)
  permissions.add(key(runner, 'get', 'services/proxy'))
  for (const [namespace, verb, resourceName] of [[runner, 'list', 'pods'], [runner, 'create', 'pods'],
    [runner, 'list', 'secrets'], [app, 'list', 'sandboxes.agents.x-k8s.io']]) {
    permissions.add(key(namespace, verb, resourceName))
    await assert.rejects(checkCluster(configured, 'fixture'), /has unexpected/u)
    permissions.delete(key(namespace, verb, resourceName))
  }
  for (const reply of [{ status: 1, stdout: '', stderr: 'unavailable fixture' },
    { status: 0, stdout: 'unknown', stderr: '' }, { status: 1, stdout: 'yes', stderr: '' }]) {
    invalidReply = reply
    await assert.rejects(checkCluster(configured, 'fixture'), /failed|Invalid namespace RBAC observation/u)
  }
  invalidReply = undefined
  configured.connectorRunner = { namespace: 'pe-fixture-connectors',
    image: 'registry.internal/connector@sha256:' + 'ab012345'.repeat(8),
    proxySourceCidrs: ['10.42.0.1/32'], sshDestinations: [{ ip: '10.70.0.11', port: 2222 }] }
  platformSecret.data['connector-key'] = encode('private-control-key-'.repeat(3))
  platformSecret.data['ssh-credential-key'] = encode(randomBytes(32).toString('base64url'))
  const connectorRole = buildManifests(configured).find(item => item.kind === 'Role'
    && item.metadata.namespace === configured.connectorRunner.namespace)
  for (const rule of connectorRole.rules) for (const resource of rule.resources) for (const verb of rule.verbs) {
    permissions.add(key(configured.connectorRunner.namespace, verb,
      resource + (rule.apiGroups[0] ? '.' + rule.apiGroups[0] : '')))
  }
  const report = await checkCluster(configured, 'fixture')
  assert.equal(report.sshConfigured, true)
  assert.equal(report.connectorControlHealthVerified, true)
  assert.equal(report.connectorNetworkEnforcementVerified, false)
  assert.equal(proxyReads.length, 1)
  assert(proxyReads[0].includes('--as=system:serviceaccount:' + subject))
  assert(proxyReads[0].includes('/api/v1/namespaces/pe-fixture-connectors/services/http:power-evolve-forbidden-listener:8080/proxy/health'))
  permissions.add(key(runner, 'create', 'pods'))
  await assert.rejects(checkCluster(configured, 'fixture'), /unexpected connector create pods/u)
  permissions.delete(key(runner, 'create', 'pods'))
  listenerHealthy = false
  await assert.rejects(checkCluster(configured, 'fixture'), /control health failed/u)
  listenerHealthy = true
  const credential = platformSecret.data['ssh-credential-key']
  delete platformSecret.data['ssh-credential-key']
  await assert.rejects(checkCluster(configured, 'fixture'), /Invalid Connector Runner deployment materials/u)
  platformSecret.data['ssh-credential-key'] = credential
  const office = JSON.parse(await readFile(new URL('../platform/office-preview.example.json', import.meta.url), 'utf8'))
  for (const field of ['namespace', 'volumeClaimName', 'volumeSubPath', 'localRoot']) delete office[field]
  configured.officePreview = { ...office, configMapName: 'pe-office-preview', imageAccess: 'preloaded',
    image: 'registry.internal/preview@sha256:' + 'abcdef0123456789'.repeat(4),
    fontPolicyDigest: '0123456789abcdef'.repeat(4) }
  nodes = [1, 2].map(() => ({ status: { conditions: [{ type: 'Ready', status: 'True' }],
    images: [{ names: [configured.officePreview.image] }] } }))
  for (const verb of officePreviewPodVerbs(officePreviewValues(configured.officePreview, configured))) {
    permissions.add(key(runner, verb, 'pods'))
  }
  const officeReport = await checkCluster(configured, 'fixture')
  assert.equal(officeReport.officePreviewReady, true)
  assert.equal(officeReport.officePreviewPreloadedImageVerified, true)
  assert.equal(officeReport.officePreviewPreloadedNodes, 2)
  for (const namespace of [app, 'kube-system']) {
    permissions.add(key(namespace, 'create', 'pods'))
    await assert.rejects(checkCluster(configured, 'fixture'), /unexpected connector create pods/u)
    permissions.delete(key(namespace, 'create', 'pods'))
  }
  permissions.delete(key(runner, 'delete', 'pods'))
  await assert.rejects(checkCluster(configured, 'fixture'), /Platform lacks Office preview delete pods/u)
  permissions.add(key(runner, 'delete', 'pods'))
  nodes[1].status.images = []
  await assert.rejects(checkCluster(configured, 'fixture'), /exact immutable Office preview image reference/u)
  nodes = nodes.slice(0, 1)
  await assert.rejects(checkCluster(configured, 'fixture'), /At least two Ready nodes/u)
})

test('optional MCP deployment projects only private Platform files and pairs each IP with its own origin port', () => {
  const configured = mcpValues(), items = buildManifests(configured)
  assert.equal(validateBundle(configured, items).resources, 23)
  const host = resource(items, 'Deployment', 'power-evolve-host').spec.template.spec
  const platform = resource(items, 'Deployment', 'power-evolve-platform').spec.template.spec
  assert.deepEqual(host.volumes, resource(buildManifests(values), 'Deployment', 'power-evolve-host').spec.template.spec.volumes)
  const privateVolume = platform.volumes.find(item => item.name === 'private')
  assert.equal(privateVolume.projected.defaultMode, 0o440)
  assert.deepEqual(privateVolume.projected.sources.slice(2), [
    { secret: { name: 'pe-mcp-operator', items: [
      { key: 'remote-mcp.json', path: 'remote-mcp/config.json' }, { key: 'remote-mcp-key', path: 'remote-mcp/credential-key' },
    ] } },
    { configMap: { name: 'pe-mcp-ca', items: [{ key: 'quotes.pem', path: 'remote-mcp/ca/quotes.pem' }] } },
  ])
  assert.equal(platform.containers[0].volumeMounts.find(item => item.name === 'private').readOnly, true)
  assert.equal(resource(items, 'ConfigMap', 'power-evolve-platform-config').data.PE_REMOTE_MCP_CONFIG_FILE, remoteMcpConfigPath)
  assert.equal(resource(items, 'ConfigMap', 'power-evolve-host-config').data.PE_REMOTE_MCP_CONFIG_FILE, undefined)
  assert.deepEqual(resource(items, 'NetworkPolicy', 'allow-platform').spec.egress.slice(-2), [
    { to: [{ ipBlock: { cidr: 'fd00:70::1/128' } }], ports: [{ protocol: 'TCP', port: 9443 }] },
    { to: [{ ipBlock: { cidr: '10.70.0.12/32' } }, { ipBlock: { cidr: '10.70.0.13/32' } }],
      ports: [{ protocol: 'TCP', port: 8443 }] },
  ])
  for (const name of ['allow-host', 'allow-runner', 'default-deny']) {
    assert.deepEqual(resource(items, 'NetworkPolicy', name).spec, resource(buildManifests(values), 'NetworkPolicy', name).spec)
  }
  assert.equal(items.some(item => item.kind === 'Secret'), false)
  const deny = { ...structuredClone(values), remoteMcp: { secretName: 'pe-mcp-operator', destinations: [] } }
  assert.deepEqual(resource(buildManifests(deny), 'NetworkPolicy', 'allow-platform').spec,
    resource(buildManifests(values), 'NetworkPolicy', 'allow-platform').spec)
  const http = { ...structuredClone(values), remoteMcp: { secretName: 'pe-mcp-operator', destinations: [
    { origin: 'http://allowed.internal', addresses: ['10.70.0.12'], allowHttp: true },
  ] } }
  assert.equal(resource(buildManifests(http), 'NetworkPolicy', 'allow-platform').spec.egress.at(-1).ports[0].port, 80)
})

test('MCP values reject broad destinations, arbitrary mounts, ambiguous paths and shared Host credentials', () => {
  const valid = mcpValues().remoteMcp
  const badDestinations = [
    { origin: 'http://plain.internal' }, { origin: 'https://quotes.internal/path' },
    { origin: 'https://quotes.internal?token=secret-fixture' }, { origin: 'https://user:secret@quotes.internal' },
    { origin: 'https://*.internal' }, { origin: 'https://quotes.internal:0' },
    { addresses: [] }, { addresses: ['0.0.0.0/0'] }, { addresses: ['::/0'] }, { addresses: ['localhost'] },
    { addresses: ['fe80::1%eth0'] }, { addresses: ['127.0.0.1', '::ffff:127.0.0.1'] },
    { caKey: '../secret.pem' }, { allowHttp: 'true' }, { ports: [443, 8443] },
  ]
  const attempts = [null, { ...valid, secretName: values.secrets.shared }, { ...valid, secretName: '../secret' },
    { ...valid, volumeMounts: [{ mountPath: '/arbitrary' }] }, { ...valid, caConfigMapName: undefined },
    { ...valid, destinations: [...valid.destinations, valid.destinations[0]] },
    ...badDestinations.map(change => ({ ...valid, destinations: [{ ...valid.destinations[0], ...change }] })),
  ]
  for (const remoteMcp of attempts) assert.throws(() => validateValues({ ...values, remoteMcp }),
    { message: 'Invalid remote MCP deployment metadata' })
})

test('preflight rejects edited mounts, environments, inline secrets and widened policies without exposing material', () => {
  const configured = mcpValues()
  const secretText = 'sensitive-fixture-must-not-appear'
  const edits = [
    items => resource(items, 'Deployment', 'power-evolve-host').spec.template.spec.volumes.push({
      name: 'mcp', secret: { secretName: configured.remoteMcp.secretName } }),
    items => resource(items, 'Deployment', 'power-evolve-host').spec.template.spec.volumes[0].projected.sources.push({
      secret: { name: configured.remoteMcp.secretName, items: [{ key: 'remote-mcp-key', path: 'credential-key' }] } }),
    items => resource(items, 'Deployment', 'power-evolve-host').spec.template.spec.volumes[0].projected.sources[0]
      .secret.items[0].key = secretText,
    items => resource(items, 'Deployment', 'power-evolve-host').spec.template.spec.containers[0].env = [{
      name: 'PRIVATE', value: secretText }],
    items => resource(items, 'Deployment', 'power-evolve-host').spec.template.spec.containers[0].envFrom.push({
      secretRef: { name: configured.remoteMcp.secretName } }),
    items => resource(items, 'Deployment', 'power-evolve-platform').spec.template.spec.containers[0].command = ['node', 'bypass.js'],
    items => resource(items, 'ConfigMap', 'power-evolve-host-config').data.PE_REMOTE_MCP_CONFIG_FILE = remoteMcpConfigPath,
    items => resource(items, 'Deployment', 'power-evolve-platform').spec.template.spec.volumes[0].projected.defaultMode = 0o777,
    items => resource(items, 'Deployment', 'power-evolve-platform').spec.template.spec.volumes[0].projected.sources.at(-1)
      .configMap.items[0].path = 'outside/ca.pem',
    items => resource(items, 'Deployment', 'power-evolve-platform').spec.template.spec.containers[0].volumeMounts[0].readOnly = false,
    items => resource(items, 'ConfigMap', 'power-evolve-platform-config').data.PE_REMOTE_MCP_CONFIG_FILE = '/outside/private.json',
    items => resource(items, 'NetworkPolicy', 'allow-platform').spec.egress.push({ to: [{ ipBlock: { cidr: '0.0.0.0/0' } }] }),
    items => resource(items, 'NetworkPolicy', 'allow-host').spec.egress.push({}),
    items => resource(items, 'NetworkPolicy', 'default-deny').spec.egress.push({}),
    items => items.push({ apiVersion: 'networking.k8s.io/v1', kind: 'NetworkPolicy', metadata: {
      name: 'extra-allow', namespace: values.namespace }, spec: { podSelector: {}, egress: [{}], policyTypes: ['Egress'] } }),
    items => items.push({ kind: 'Secret', metadata: { name: 'inline', namespace: values.namespace }, stringData: { key: secretText } }),
  ]
  for (const edit of edits) {
    const items = buildManifests(configured); edit(items)
    assert.throws(() => validateBundle(configured, items), error => {
      assert.equal(error.message.includes(secretText), false)
      return true
    })
  }
})

test('MCP readiness reuses the real config parser with only named Secret and CA lookups', async t => {
  if (spawnSync('openssl', ['version']).status !== 0) { t.skip('OpenSSL is unavailable'); return }
  const temporary = await mkdtemp(join(tmpdir(), 'pe-deploy-mcp-'))
  t.after(() => rm(temporary, { recursive: true, force: true }))
  const keyPath = join(temporary, 'key.pem'), caPath = join(temporary, 'ca.pem'), leafPath = join(temporary, 'leaf.pem')
  const generated = spawnSync('openssl', ['req', '-x509', '-newkey', 'rsa:2048', '-nodes', '-keyout', keyPath,
    '-out', caPath, '-days', '1', '-subj', '/CN=deployment-fixture', '-addext', 'basicConstraints=critical,CA:TRUE'],
  { encoding: 'utf8', timeout: 10000 })
  assert.equal(generated.status, 0, generated.stderr)
  const leaf = spawnSync('openssl', ['req', '-x509', '-key', keyPath, '-out', leafPath, '-days', '1',
    '-subj', '/CN=non-ca-fixture', '-addext', 'basicConstraints=critical,CA:FALSE'], { encoding: 'utf8', timeout: 10000 })
  assert.equal(leaf.status, 0, leaf.stderr)
  const ca = await readFile(caPath, 'utf8'), nonCa = await readFile(leafPath, 'utf8')
  const configured = mcpValues(), remote = remoteMcpValues(configured.remoteMcp, configured.secrets.shared)
  const settings = { ...JSON.parse(await readFile(new URL('../platform/remote-mcp.example.json', import.meta.url), 'utf8')),
    credentialKeyFile: remoteMcpKeyPath, requireOriginException: true,
    internalExceptions: remote.destinations.map(item => ({ origin: item.origin, addresses: item.addresses,
      ...(item.allowHttp ? { allowHttp: true } : {}), ...(item.caKey ? { caFile: remoteMcpCaPath(item.caKey) } : {}) })),
  }
  const encoded = text => Buffer.from(text).toString('base64')
  const secret = { data: { 'remote-mcp.json': encoded(JSON.stringify(settings)),
    'remote-mcp-key': encoded(randomBytes(32).toString('base64url')) } }
  const configMap = { data: { 'quotes.pem': ca, 'unselected.pem': 'secret-fixture' } }
  const reads = []
  const readObject = async (kind, name) => {
    reads.push([kind, name])
    if (kind === 'secret' && name === remote.secretName) return secret
    if (kind === 'configmap' && name === remote.caConfigMapName) return configMap
    throw new Error('Unexpected resource containing secret-fixture')
  }
  assert.deepEqual(await validateRemoteMcpMaterials(values, readObject), { remoteMcpReady: false })
  assert.deepEqual(reads, [])
  assert.deepEqual(await validateRemoteMcpMaterials(configured, readObject), { remoteMcpReady: true })
  assert.deepEqual(reads, [['secret', 'pe-mcp-operator'], ['configmap', 'pe-mcp-ca']])
  const fileReads = [], files = new Map([[remoteMcpConfigPath, JSON.stringify(settings)],
    [remoteMcpKeyPath, Buffer.from(secret.data['remote-mcp-key'], 'base64').toString('utf8')],
    [remoteMcpCaPath('quotes.pem'), ca]])
  const readText = async filename => {
    fileReads.push(filename)
    if (!files.has(filename)) throw new Error('unprovided secret-fixture')
    return files.get(filename)
  }
  await validateRemoteMcpStartup('', readText)
  assert.deepEqual(fileReads, [])
  await validateRemoteMcpStartup(remoteMcpConfigPath, readText)
  assert.deepEqual(fileReads, [remoteMcpConfigPath, remoteMcpKeyPath, remoteMcpCaPath('quotes.pem')])
  await assert.rejects(validateRemoteMcpStartup('/arbitrary/secret-fixture', readText),
    { message: 'Invalid remote MCP deployment configuration' })
  const invalidStartupSettings = [
    { ...settings, requireOriginException: false }, { ...settings, requireOriginException: undefined },
    { ...settings, credentialKeyFile: '/unprojected/secret-fixture' }, { ...settings, pollMs: 0 },
    { ...settings, surprise: 'secret-fixture' },
    { ...settings, internalExceptions: settings.internalExceptions.map(item => ({ ...item, caFile: '/arbitrary/secret-fixture.pem' })) },
  ]
  const mismatchedDestinations = [
    { ...settings, internalExceptions: [] },
    { ...settings, internalExceptions: [{ origin: 'https://other.internal:8443', addresses: ['10.70.0.12'] }] },
    { ...settings, internalExceptions: settings.internalExceptions.map(item => ({ ...item, addresses: ['10.70.0.99'] })) },
    { ...settings, internalExceptions: settings.internalExceptions.map(item => ({ ...item, allowHttp: true })) },
  ]
  for (const changed of [...invalidStartupSettings, ...mismatchedDestinations]) {
    const attempted = { data: { ...secret.data, 'remote-mcp.json': encoded(JSON.stringify(changed)) } }
    await assert.rejects(validateRemoteMcpMaterials(configured, async kind => kind === 'secret' ? attempted : configMap),
      { message: 'Invalid remote MCP deployment materials' })
  }
  for (const changed of invalidStartupSettings) {
    await assert.rejects(validateRemoteMcpStartup(remoteMcpConfigPath, async filename => {
      if (filename === remoteMcpConfigPath) return JSON.stringify(changed)
      return readText(filename)
    }), { message: 'Invalid remote MCP deployment configuration' })
  }
  for (const changed of [{ data: {} }, { data: { ...secret.data, 'remote-mcp-key': '' } },
    { data: { ...secret.data, 'remote-mcp-key': encoded('secret-fixture') } },
    { data: { ...secret.data, 'remote-mcp.json': encoded('{secret-fixture') } }]) {
    await assert.rejects(validateRemoteMcpMaterials(configured, async kind => kind === 'secret' ? changed : configMap),
      { message: 'Invalid remote MCP deployment materials' })
  }
  for (const changed of [{ data: {} }, { data: { 'quotes.pem': 'secret-fixture' } }, { data: { 'quotes.pem': nonCa } }]) {
    await assert.rejects(validateRemoteMcpMaterials(configured, async kind => kind === 'secret' ? secret : changed),
      { message: 'Invalid remote MCP deployment materials' })
  }
})

test('sample bundle is parseable and rejects Host privilege or mount drift', () => {
  const items = buildManifests(values)
  assert.equal(validateBundle(values, items).resources, 23)
  const platform = items.find(item => item.kind === 'Deployment'
    && item.metadata.name === 'power-evolve-platform')
  assert.equal(platform.spec.template.spec.containers[0].readinessProbe.httpGet.path, '/health')
  assert.equal(platform.spec.template.spec.containers[0].livenessProbe.httpGet.path, '/live')
  const foundation = yaml.loadAll(render(values, 'foundation')).filter(Boolean)
  const workloads = yaml.loadAll(render(values, 'workloads')).filter(Boolean)
  assert.equal(foundation.length + workloads.length, items.length)
  assert.equal(foundation.some(item => item.kind === 'Deployment' || item.kind === 'Ingress'), false)
  assert.equal(workloads.some(item => item.kind === 'Deployment'), true)
  const host = items.find(item => item.kind === 'Deployment' && item.metadata.name === 'power-evolve-host')
  host.spec.template.spec.volumes.push({ name: 'forbidden', persistentVolumeClaim: {
    claimName: values.storage.platformClaim } })
  assert.throws(() => validateBundle(values, items), /Host must not mount/u)
  assert.throws(() => readyValues(values), /Replace example/u)
})
