import test from 'node:test'
import assert from 'node:assert/strict'
import { mkdtemp, readFile, rm } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { randomBytes } from 'node:crypto'
import { createRequire } from 'node:module'
import { buildManifests, render, validateValues } from './render.mjs'
import { renderProfile } from './start.mjs'
import { validateBundle, validateConnectorSecret } from './preflight.mjs'
import { connectorRunnerValues, connectorRunnerEnvironment, connectorRunnerFromEnvironment,
  validateConnectorStartup, checkConnectorCluster, connectorRoleName, connectorListenerName,
  connectorKeyPath, sshCredentialKeyPath } from './connectors.mjs'

const require = createRequire(new URL('../application/package.json', import.meta.url))
const yaml = require('js-yaml')
const schema = yaml.DEFAULT_SCHEMA.extend(new yaml.Type('tag:yaml.org,2002:js', {
  kind: 'scalar', construct: value => value,
}))
const baseline = JSON.parse(await readFile(new URL('./values.example.json', import.meta.url), 'utf8'))
const configured = () => ({ ...structuredClone(baseline), connectorRunner: {
  namespace: 'pe-production-connectors',
  image: 'registry.internal/connector@sha256:' + 'abc01234'.repeat(8),
  proxySourceCidrs: ['10.42.0.1/32', 'fd00:42::1/128'],
  sshDestinations: [{ ip: '10.70.0.11', port: 2222 }, { ip: '10.70.0.12', port: 22 }],
} })
const find = (items, kind, name, namespace) => items.find(item => item.kind === kind
  && item.metadata.name === name && item.metadata.namespace === namespace)
const controlKey = 'control-key-'.repeat(4)
const sshKey = randomBytes(32).toString('base64url')
const encode = text => Buffer.from(text).toString('base64')

test('optional connector placement preserves Host/cloud policy and provides the actual default SA pull reference', () => {
  const values = configured(), items = buildManifests(values), app = values.namespace, ns = values.connectorRunner.namespace
  assert.equal(validateBundle(values, items).resources, 31)
  const old = buildManifests(baseline)
  for (const role of ['host', 'platform']) {
    const deployment = find(items, 'Deployment', 'power-evolve-' + role, app)
    const keys = deployment.spec.template.spec.volumes[0].projected.sources.flatMap(source =>
      source.secret?.items?.map(item => item.key) ?? [])
    assert.equal(keys.includes('ssh-credential-key'), role === 'platform')
  }
  assert.deepEqual(find(items, 'Deployment', 'power-evolve-host', app), find(old, 'Deployment', 'power-evolve-host', app))
  assert.deepEqual(find(items, 'ConfigMap', 'power-evolve-host-config', app), find(old, 'ConfigMap', 'power-evolve-host-config', app))
  for (const [kind, name, namespace] of [
    ['NetworkPolicy', 'allow-platform', app], ['NetworkPolicy', 'allow-host', app],
    ['NetworkPolicy', 'allow-runner', values.runnerNamespace],
    ['Role', 'power-evolve-platform-runner', values.runnerNamespace],
  ]) assert.deepEqual(find(items, kind, name, namespace), find(old, kind, name, namespace))
  const sa = find(items, 'ServiceAccount', 'default', ns)
  assert.equal(sa.automountServiceAccountToken, false)
  assert.deepEqual(sa.imagePullSecrets, [{ name: values.imagePullSecretName }])
  const listener = find(items, 'Deployment', connectorListenerName, ns).spec.template.spec
  assert.equal(listener.serviceAccountName, 'default')
  assert.equal(listener.automountServiceAccountToken, false)
  assert.equal(listener.containers[0].image, values.connectorRunner.image)
  assert.equal(listener.volumes, undefined)
  const foundation = yaml.loadAll(render(values, 'foundation'))
  const workloads = yaml.loadAll(render(values, 'workloads'))
  assert(find(foundation, 'Deployment', connectorListenerName, ns))
  assert(find(foundation, 'Service', connectorListenerName, ns))
  assert.equal(workloads.filter(item => item.kind === 'Deployment').length, 2)
  assert.equal(workloads.some(item => item.metadata.namespace === ns), false)
  assert.equal(items.some(item => item.kind === 'Secret'), false)
})

test('connector values refuse broad sources, unsupported IPv6 SSH, mutable images and secret inputs', () => {
  for (const change of [
    x => { x.namespace = baseline.namespace }, x => { x.namespace = baseline.runnerNamespace },
    x => { x.image = 'registry/connector:latest' }, x => { x.proxySourceCidrs = ['10.42.0.0/24'] },
    x => { x.proxySourceCidrs = ['fd00::/64'] }, x => { x.proxySourceCidrs = [] },
    x => { x.proxySourceCidrs.push(x.proxySourceCidrs[0]) },
    x => { x.sshDestinations = [{ ip: 'host.internal', port: 22 }] },
    x => { x.sshDestinations = [{ ip: '::1', port: 22 }] },
    x => { x.sshDestinations = [{ ip: '10.1.2.3', port: 0 }] },
    x => { x.sshDestinations = [{ ip: '10.1.2.3', port: 65536 }] },
    x => { x.sshDestinations.push(x.sshDestinations[0]) },
    x => { x.sshDestinations[0].password = 'private-input' },
    x => { x.sshCredentialKey = 'private-input' },
    x => { x.kubeconfigFile = '/arbitrary/path' },
  ]) {
    const values = configured()
    change(values.connectorRunner)
    assert.throws(() => validateValues(values), /Invalid Connector Runner deployment metadata/)
  }
  const selected = connectorRunnerValues(configured().connectorRunner, configured())
  for (const missing of ['PE_CONNECTOR_RUNNER_NAMESPACE', 'PE_CONNECTOR_RUNNER_IMAGE',
    'PE_CONNECTOR_RUNNER_PROXY_SOURCE_CIDRS', 'PE_SSH_DESTINATIONS']) {
    const env = connectorRunnerEnvironment(selected)
    delete env[missing]
    assert.throws(() => connectorRunnerFromEnvironment(env))
  }
})

test('enabled profile maps in-cluster and the exact registry reference without giving Host runner configuration', async () => {
  const values = configured(), items = buildManifests(values), home = await mkdtemp(join(tmpdir(), 'pe-connectors-profile-'))
  try {
    const env = find(items, 'ConfigMap', 'power-evolve-platform-config', values.namespace).data
    const { profile } = await renderProfile('platform', env, home)
    const config = yaml.load(await readFile(join(profile, 'cordis.patch.yml'), 'utf8'), { schema })[1].config
    assert.equal(config.sshRunnerKubeconfigFile, 'in-cluster')
    assert.equal(config.sshRunnerNamespace, values.connectorRunner.namespace)
    assert.equal(config.sshRunnerImage, values.connectorRunner.image)
    assert.equal(config.sshRunnerIngressCidrs, values.connectorRunner.proxySourceCidrs.join(','))
    assert.equal(config.sshRunnerImagePullSecretName, values.imagePullSecretName)
    assert.equal(config.sshCredentialKeyFile, sshCredentialKeyPath)
    assert.equal(config.sshDestinationAllowlist, '10.70.0.11:2222,10.70.0.12:22')
    const hostEnv = find(items, 'ConfigMap', 'power-evolve-host-config', values.namespace).data
    const host = await renderProfile('host', { ...hostEnv, ...connectorRunnerEnvironment(
      connectorRunnerValues(values.connectorRunner, values)) }, join(home, 'host'))
    assert.equal((await readFile(join(host.profile, 'cordis.patch.yml'), 'utf8')).includes('sshRunner'), false)
    for (const mode of ['stdio', 'disabled', 'public']) {
      const alternate = configured()
      if (mode === 'stdio') alternate.connectorRunner.sshDestinations = []
      if (mode === 'disabled') alternate.connectorRunner = null
      if (mode === 'public') delete alternate.imagePullSecretName
      const data = find(buildManifests(alternate), 'ConfigMap', 'power-evolve-platform-config', values.namespace).data
      const alt = await renderProfile('platform', data, join(home, mode))
      const cfg = yaml.load(await readFile(join(alt.profile, 'cordis.patch.yml'), 'utf8'), { schema })[1].config
      assert.equal(cfg.sshRunnerImagePullSecretName, mode === 'public' || mode === 'disabled' ? '' : values.imagePullSecretName)
      if (mode !== 'public') assert.equal(cfg.sshCredentialKeyFile, '')
      if (mode === 'disabled') assert.equal(cfg.sshRunnerKubeconfigFile, '')
    }
  } finally { await rm(home, { recursive: true, force: true }) }
})

test('startup and readiness use real key/allowlist parsers and read no SSH key in stdio-only mode', async () => {
  const values = configured(), selected = connectorRunnerValues(values.connectorRunner, values)
  const env = connectorRunnerEnvironment(selected)
  const files = new Map([[connectorKeyPath, controlKey], [sshCredentialKeyPath, sshKey]])
  const reads = []
  const reader = async path => { reads.push(path); if (!files.has(path)) throw new Error('missing'); return files.get(path) }
  await validateConnectorStartup(env, reader)
  assert.deepEqual(reads, [connectorKeyPath, sshCredentialKeyPath])
  const secret = { data: { 'connector-key': encode(controlKey), 'ssh-credential-key': encode(sshKey) } }
  assert.deepEqual(await validateConnectorSecret(values, secret), { connectorRunnerReady: true, sshConfigured: true })
  for (const path of [connectorKeyPath, sshCredentialKeyPath]) {
    const prior = files.get(path)
    files.delete(path)
    await assert.rejects(validateConnectorStartup(env, reader), /Invalid Connector Runner deployment materials/)
    files.set(path, 'private-invalid-material')
    await assert.rejects(validateConnectorStartup(env, reader), error =>
      error.message === 'Invalid Connector Runner deployment materials')
    files.set(path, prior)
  }
  await assert.rejects(validateConnectorSecret(values, { data: { 'connector-key': encode(controlKey) } }))
  const stdio = configured()
  stdio.connectorRunner.sshDestinations = []
  const stdioEnv = connectorRunnerEnvironment(connectorRunnerValues(stdio.connectorRunner, stdio))
  reads.length = 0
  await validateConnectorStartup(stdioEnv, reader)
  assert.deepEqual(reads, [connectorKeyPath])
  assert.deepEqual(await validateConnectorSecret(stdio, { data: { 'connector-key': encode(controlKey) } }),
    { connectorRunnerReady: true, sshConfigured: false })
  await validateConnectorStartup({}, () => { throw new Error('disabled must not read') })
})

test('preflight rejects edited connector RBAC, Host projection, listener and unowned grants', () => {
  const values = configured(), ns = values.connectorRunner.namespace
  for (const mutate of [
    items => { find(items, 'Role', connectorRoleName, ns).rules[0].verbs.push('list') },
    items => { find(items, 'RoleBinding', connectorRoleName, ns).subjects[0].name = 'power-evolve-host' },
    items => { find(items, 'NetworkPolicy', 'default-deny', ns).spec.egress.push({}) },
    items => { find(items, 'Deployment', connectorListenerName, ns).spec.template.spec.containers[0].image = 'latest' },
    items => { find(items, 'ServiceAccount', 'default', ns).imagePullSecrets = [{ name: 'wrong-pull-secret' }] },
    items => { find(items, 'Deployment', 'power-evolve-host', values.namespace).spec.template.spec.volumes[0]
      .projected.sources[0].secret.items.push({ key: 'ssh-credential-key', path: 'ssh-credential-key' }) },
    items => { items.push({ apiVersion: 'rbac.authorization.k8s.io/v1', kind: 'Role',
      metadata: { namespace: 'other-namespace', name: 'extra-permission' }, rules: [] }) },
  ]) {
    const items = buildManifests(values)
    mutate(items)
    assert.throws(() => validateBundle(values, items))
  }
})

function clusterFixture() {
  const values = configured(), selected = connectorRunnerValues(values.connectorRunner, values)
  const items = buildManifests(values)
  const allowed = new Set()
  const subject = values.namespace + ':power-evolve-platform'
  for (const rule of find(items, 'Role', connectorRoleName, selected.namespace).rules) {
    for (const resource of rule.resources) for (const verb of rule.verbs) {
      allowed.add([selected.namespace, subject, verb,
        resource + (rule.apiGroups[0] ? '.' + rule.apiGroups[0] : '')].join('|'))
    }
  }
  const deployment = find(items, 'Deployment', connectorListenerName, selected.namespace)
  deployment.metadata.generation = 2
  deployment.status = { availableReplicas: 1, observedGeneration: 2 }
  find(items, 'Service', connectorListenerName, selected.namespace).spec.clusterIP = '10.43.0.9'
  let health = { healthy: true }
  const reads = []
  return { values, selected, items, allowed, subject, reads, setHealth: value => { health = value },
    io: {
      get: async (ns, kind, name) => {
        reads.push([ns, kind, name])
        if (kind === 'secret') return { metadata: { name } }
        const item = items.find(item => item.kind.toLowerCase() === kind
          && item.metadata.namespace === ns && item.metadata.name === name)
        if (!item) throw new Error('fixture object missing')
        return item
      },
      can: async (...args) => allowed.has(args.join('|')),
      proxy: async (ns, account, name) => {
        assert.equal(ns, selected.namespace)
        assert.equal(account, subject)
        assert.equal(name, connectorListenerName)
        return health
      },
    } }
}

test('cluster readiness checks real control-path observations and denies cross-namespace or Host authority', async () => {
  const fixture = clusterFixture()
  const invoke = () => checkConnectorCluster(fixture.selected, fixture.values, fixture.io)
  const report = await invoke()
  assert.equal(report.connectorControlHealthVerified, true)
  assert.equal(report.connectorNetworkEnforcementVerified, false)
  for (const grant of [
    [fixture.selected.namespace, fixture.subject, 'list', 'secrets'],
    [fixture.selected.namespace, fixture.subject, 'watch', 'pods'],
    [fixture.values.runnerNamespace, fixture.subject, 'create', 'pods'],
    [fixture.selected.namespace, fixture.values.namespace + ':power-evolve-host', 'get', 'secrets'],
    [fixture.selected.namespace, fixture.selected.namespace + ':default', 'get', 'pods'],
  ]) {
    fixture.allowed.add(grant.join('|'))
    await assert.rejects(invoke(), /unexpected connector/)
    fixture.allowed.delete(grant.join('|'))
  }
  const permission = [fixture.selected.namespace, fixture.subject, 'get', 'services/proxy'].join('|')
  fixture.allowed.delete(permission)
  await assert.rejects(invoke(), /Platform lacks connector/)
  fixture.allowed.add(permission)
  fixture.setHealth({ healthy: false })
  await assert.rejects(invoke(), /control health failed/)
  fixture.setHealth({ healthy: true })
  const deployment = find(fixture.items, 'Deployment', connectorListenerName, fixture.selected.namespace)
  deployment.status.observedGeneration = 1
  await assert.rejects(invoke(), /not Ready/)
  deployment.status.observedGeneration = 2
  const args = deployment.spec.template.spec.containers[0].args
  deployment.spec.template.spec.containers[0].args = ['arbitrary-listener']
  await assert.rejects(invoke(), /Forbidden listener container differs/)
  deployment.spec.template.spec.containers[0].args = args
  const read = fixture.io.get
  fixture.io.get = (ns, kind, name) => {
    if (kind === 'secret') throw new Error('registry Secret missing')
    return read(ns, kind, name)
  }
  await assert.rejects(invoke(), /registry Secret missing/)
  fixture.io.get = read
  const service = find(fixture.items, 'Service', connectorListenerName, fixture.selected.namespace)
  service.spec.selector = { 'app.kubernetes.io/name': 'wrong-listener' }
  await assert.rejects(invoke())
  assert.deepEqual(await checkConnectorCluster(null, fixture.values, {}), {})
})
