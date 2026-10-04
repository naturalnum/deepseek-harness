import test from 'node:test'
import assert from 'node:assert/strict'
import { mkdtemp, readFile, rm, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { officePreviewConfigPath, officePreviewValues, officePreviewManifests, officePreviewSources,
  officePreviewEnvironment, officePreviewPodVerbs, officePreviewProfile,
  validateOfficePreviewStartup } from './office-preview.mjs'

const example = JSON.parse(await readFile(new URL('../platform/office-preview.example.json', import.meta.url), 'utf8'))
function fixture() {
  const budgets = structuredClone(example)
  for (const field of ['namespace', 'volumeClaimName', 'volumeSubPath', 'localRoot']) delete budgets[field]
  return { namespace: 'pe-qa', runnerNamespace: 'pe-qa-runners',
    storage: { runnerClaim: 'pe-qa-runner-data' }, imagePullSecretName: 'application-registry',
    officePreview: { ...budgets, configMapName: 'pe-office-preview-config', imageAccess: 'preloaded',
      image: 'registry.example/parser@sha256:' + 'ab'.repeat(32), fontPolicyDigest: 'cd'.repeat(32) } }
}
function selected(values) { return officePreviewValues(values.officePreview, values) }
function platformEnv(values) {
  return { ...officePreviewEnvironment(selected(values), 'platform'),
    PE_SANDBOX_NAMESPACE: values.runnerNamespace, PE_SANDBOX_VOLUME_CLAIM: values.storage.runnerClaim }
}

test('omitted feature preserves existing deployment and never reads parser configuration', async () => {
  for (const input of [undefined, null]) {
    const disabled = officePreviewValues(input, {})
    assert.equal(disabled, null)
    assert.deepEqual(officePreviewManifests({}, disabled), [])
    assert.deepEqual(officePreviewPodVerbs(disabled), ['get', 'patch'])
    for (const role of ['host', 'platform']) {
      assert.deepEqual(officePreviewSources(disabled, role), [])
      assert.deepEqual(officePreviewEnvironment(disabled, role), {})
    }
  }
  assert.deepEqual(officePreviewProfile('host', {}), { officePreviewEnabled: false })
  assert.deepEqual(officePreviewProfile('platform', {}),
    { officePreviewConfigFile: '', officePreviewKubeconfigFile: '' })
  assert.equal(await validateOfficePreviewStartup({}, () => assert.fail('Disabled parser read a file')), null)
})

test('explicit budgets produce runtime-loader-compatible JSON from the existing namespace and PVC', async t => {
  const values = fixture(), enabled = selected(values)
  const [map] = officePreviewManifests(values, enabled)
  assert.deepEqual(map.metadata, { name: values.officePreview.configMapName, namespace: values.namespace,
    labels: { 'app.kubernetes.io/part-of': 'power-evolve' } })
  assert.equal(map.kind, 'ConfigMap')
  assert.deepEqual(Object.keys(map.data), ['office-preview.json'])
  const directory = await mkdtemp(join(tmpdir(), 'pe-office-deploy-'))
  t.after(() => rm(directory, { recursive: true, force: true }))
  const filename = join(directory, 'office-preview.json')
  await writeFile(filename, map.data['office-preview.json'], { mode: 0o600 })
  const reads = []
  const settings = await validateOfficePreviewStartup(platformEnv(values), path => {
    reads.push(path)
    assert.equal(path, officePreviewConfigPath)
    return readFile(filename, 'utf8')
  })
  assert.deepEqual(reads, [officePreviewConfigPath])
  assert.deepEqual(settings, enabled.config)
  assert.equal(settings.namespace, values.runnerNamespace)
  assert.equal(settings.volumeClaimName, values.storage.runnerClaim)
  assert.equal(settings.localRoot, '/data/office-previews')
  assert.equal(settings.volumeSubPath, 'office-previews')
  assert.equal(settings.maxConcurrentParsers, 1)
  assert.equal(settings.memoryMiB, 3072)
  assert.equal(settings.cpuMilliCores, 1000)
  assert.equal(settings.imageAccess, undefined)
  assert.equal(settings.imagePullSecretName, undefined)
  values.officePreview.limits.pages = 1
  assert.equal(enabled.config.limits.pages, example.limits.pages)
})

test('Host receives only the feature flag and Platform only the fixed configuration projection', () => {
  const values = fixture(), enabled = selected(values)
  assert.deepEqual(officePreviewSources(enabled, 'host'), [])
  assert.deepEqual(officePreviewSources(enabled, 'platform'), [{ configMap: {
    name: values.officePreview.configMapName,
    items: [{ key: 'office-preview.json', path: 'office-preview.json' }],
  } }])
  assert.deepEqual(officePreviewEnvironment(enabled, 'host'), { PE_OFFICE_PREVIEW_ENABLED: '1' })
  assert.deepEqual(officePreviewProfile('host', officePreviewEnvironment(enabled, 'host')),
    { officePreviewEnabled: true })
  assert.deepEqual(officePreviewProfile('platform', officePreviewEnvironment(enabled, 'platform')),
    { officePreviewConfigFile: officePreviewConfigPath, officePreviewKubeconfigFile: 'in-cluster' })
  assert.throws(() => officePreviewProfile('host', officePreviewEnvironment(enabled, 'platform')))
  assert.throws(() => officePreviewProfile('platform', officePreviewEnvironment(enabled, 'host')))
  assert.throws(() => officePreviewProfile('host', { PE_OFFICE_PREVIEW_ENABLED: 'true' }))
  assert.throws(() => officePreviewSources(enabled, 'runner'))
})

test('parser grants add only create/delete to the existing pods rule and create no network or account resources', () => {
  const values = fixture(), enabled = selected(values)
  const rules = [{ apiGroups: ['agents.x-k8s.io'], resources: ['sandboxes'], verbs: ['get', 'list', 'create', 'delete'] },
    { apiGroups: [''], resources: ['pods'], verbs: officePreviewPodVerbs(null) },
    { apiGroups: [''], resources: ['services', 'secrets'], verbs: ['get', 'create', 'delete'] }]
  const original = structuredClone(rules)
  rules[1].verbs = officePreviewPodVerbs(enabled)
  assert.deepEqual(rules[0], original[0])
  assert.deepEqual(rules[2], original[2])
  assert.deepEqual(rules[1], { apiGroups: [''], resources: ['pods'], verbs: ['get', 'patch', 'create', 'delete'] })
  assert.deepEqual(officePreviewManifests(values, enabled).map(row => row.kind), ['ConfigMap'])
})

test('malformed placement, missing budgets, protocol limits and unsafe timing fail before rendering', () => {
  for (const mutate of [
    x => { delete x.officePreview.pollMs },
    x => { x.officePreview.image = 'registry.example/parser:latest' },
    x => { x.officePreview.fontPolicyDigest = 'invalid' },
    x => { x.officePreview.configMapName = 'power-evolve-platform-config' },
    x => { x.runnerNamespace = x.namespace },
    x => { x.storage.runnerClaim = '../other' },
    x => { x.officePreview.localRoot = '/data/homes' },
    x => { x.officePreview.limits.pages = 1001 },
    x => { x.officePreview.limits.outputBytes = 8388609 },
    x => { x.officePreview.limits.foreignBudget = 1 },
    x => { x.officePreview.maxConcurrentParsers = 0 },
    x => { x.officePreview.memoryMiB = 1.5 },
    x => { x.officePreview.pollMs = x.officePreview.leaseMs },
    x => { x.officePreview.leaseMs = 2 * x.officePreview.kubernetesTimeoutMs - 1 },
    x => { x.officePreview.jobDeadlineMs = x.officePreview.limits.timeoutMs - 1 },
    x => { x.officePreview.terminationGraceSeconds = -1 },
  ]) {
    const values = fixture()
    mutate(values)
    assert.throws(() => selected(values), error => error.message === 'Invalid Office preview deployment metadata')
  }
})

test('public/preloaded image declarations exclude pull credentials without rejecting application registry auth', () => {
  const values = fixture()
  const loaded = selected(values)
  values.officePreview.imageAccess = 'public'
  const publicImage = selected(values)
  assert.deepEqual(publicImage.config, loaded.config)
  assert.equal(loaded.imageAccess, 'preloaded')
  assert.equal(publicImage.imageAccess, 'public')
  for (const access of [undefined, 'private']) {
    values.officePreview.imageAccess = access
    assert.throws(() => selected(values), /private registry pulls are unsupported/u)
  }
  values.officePreview.imageAccess = 'public'
  values.officePreview.imagePullSecretName = 'parser-registry'
  assert.throws(() => selected(values), /Invalid Office preview deployment metadata/u)
})

test('startup rejects edited identity, placement or paths through the production loader without leaking bytes', async () => {
  const values = fixture(), enabled = selected(values), env = platformEnv(values)
  for (const mutate of [
    x => { x.namespace = 'foreign-runners' },
    x => { x.volumeClaimName = 'foreign-pvc' },
    x => { x.volumeSubPath = 'homes' },
    x => { x.localRoot = '/data/homes' },
    x => { x.localRoot = '/data/other-preview' },
    x => { x.image = 'registry.example/parser:mutable' },
    x => { x.limits.inputBytes = 0 },
    x => { x.unknownPrivateValue = 'private-input-must-not-appear' },
  ]) {
    const settings = structuredClone(enabled.config)
    mutate(settings)
    await assert.rejects(validateOfficePreviewStartup(env, async () => JSON.stringify(settings)), error =>
      error.message === 'Invalid Office preview deployment configuration')
  }
  await assert.rejects(validateOfficePreviewStartup(env, async () => '{private-input'), error =>
    error.message === 'Invalid Office preview deployment configuration')
  await assert.rejects(validateOfficePreviewStartup(env, async () => { throw new Error('private-path') }), error =>
    error.message === 'Invalid Office preview deployment configuration')
  for (const changed of [
    { PE_OFFICE_PREVIEW_CONFIG_FILE: '/arbitrary/file' },
    { PE_OFFICE_PREVIEW_KUBECONFIG_FILE: '/arbitrary/kubeconfig' },
    { PE_OFFICE_PREVIEW_CONFIG_FILE: '' },
    { PE_OFFICE_PREVIEW_KUBECONFIG_FILE: '' },
  ]) {
    await assert.rejects(validateOfficePreviewStartup({ ...env, ...changed }, () => assert.fail('Invalid path read')),
      /Invalid Office preview deployment metadata/u)
  }
})
