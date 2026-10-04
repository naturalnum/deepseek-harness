/** Deployment integration uses built Application parsers; cluster/node observations are explicit fixtures. */
import test from 'node:test'
import assert from 'node:assert/strict'
import { mkdtemp, readFile, rm, stat, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { createRequire } from 'node:module'
import { buildManifests, render } from './render.mjs'
import { renderProfile } from './start.mjs'
import { buildLocalHttpManifests } from './local-http.mjs'
import { validateBundle, validateOfficePreviewMaterials, checkOfficePreviewNodes } from './preflight.mjs'
import { officePreviewConfigPath, officePreviewValues } from './office-preview.mjs'

const require = createRequire(new URL('../application/package.json', import.meta.url))
const yaml = require('js-yaml')
const schema = yaml.DEFAULT_SCHEMA.extend(new yaml.Type('tag:yaml.org,2002:js', {
  kind: 'scalar', construct: value => value,
}))
const baseline = JSON.parse(await readFile(new URL('./values.example.json', import.meta.url), 'utf8'))
const example = JSON.parse(await readFile(new URL('../platform/office-preview.example.json', import.meta.url), 'utf8'))
function configured() {
  const settings = structuredClone(example)
  for (const field of ['namespace', 'volumeClaimName', 'volumeSubPath', 'localRoot']) delete settings[field]
  return { ...structuredClone(baseline), officePreview: { ...settings,
    configMapName: 'pe-office-preview', imageAccess: 'preloaded',
    image: 'registry.internal/preview@sha256:' + 'ab'.repeat(32), fontPolicyDigest: 'cd'.repeat(32) } }
}
const find = (items, kind, name, namespace) => items.find(item => item.kind === kind
  && item.metadata.name === name && item.metadata.namespace === namespace)
const config = (items, values, role) => find(items, 'ConfigMap', 'power-evolve-' + role + '-config', values.namespace).data
const office = (items, values) => find(items, 'ConfigMap', values.officePreview.configMapName, values.namespace)
const spec = (items, values, role) => find(items, 'Deployment', 'power-evolve-' + role, values.namespace).spec.template.spec
async function directory(t) {
  const root = await mkdtemp(join(tmpdir(), 'pe-office-render-'))
  t.after(() => rm(root, { recursive: true, force: true }))
  return root
}

test('disabled renderer retains the original resources, Host projections and runner permissions', async t => {
  const items = buildManifests(baseline)
  for (const officePreview of [undefined, null]) assert.deepEqual(buildManifests({ ...baseline, officePreview }), items)
  assert.equal(validateBundle(baseline, items).resources, 23)
  assert.equal(items.filter(row => row.kind === 'ConfigMap').length, 2)
  assert.equal(config(items, baseline, 'host').PE_OFFICE_PREVIEW_ENABLED, undefined)
  assert.equal(config(items, baseline, 'platform').PE_OFFICE_PREVIEW_CONFIG_FILE, undefined)
  const home = await directory(t)
  for (const role of ['host', 'platform']) {
    const result = await renderProfile(role, config(items, baseline, role), join(home, role),
      () => assert.fail('Disabled configuration read'))
    const rows = yaml.load(await readFile(join(result.profile, 'cordis.patch.yml'), 'utf8'), { schema })
    assert.equal(rows.at(-1).config[role === 'host' ? 'officePreviewEnabled' : 'officePreviewConfigFile'],
      role === 'host' ? false : '')
  }
})

test('enabled renderer, foundation, private projection and Profile use the same production loader settings', async t => {
  const values = configured(), items = yaml.loadAll(render(values)).filter(Boolean)
  assert.equal(validateBundle(values, items).resources, 24)
  const before = buildManifests(baseline)
  assert.deepEqual(spec(items, values, 'host'), spec(before, baseline, 'host'))
  assert.deepEqual(items.filter(row => row.kind === 'NetworkPolicy'), before.filter(row => row.kind === 'NetworkPolicy'))
  assert.deepEqual(items.filter(row => row.kind === 'ServiceAccount'), before.filter(row => row.kind === 'ServiceAccount'))
  const foundation = yaml.loadAll(render(values, 'foundation')).filter(Boolean)
  const workloads = yaml.loadAll(render(values, 'workloads')).filter(Boolean)
  assert(office(foundation, values))
  assert.equal(office(workloads, values), undefined)
  assert.equal(foundation.length + workloads.length, items.length)
  assert.deepEqual(spec(items, values, 'platform').volumes[0].projected.sources.at(-1), { configMap: {
    name: values.officePreview.configMapName, items: [{ key: 'office-preview.json', path: 'office-preview.json' }],
  } })
  assert.deepEqual(find(items, 'Role', 'power-evolve-platform-runner', values.runnerNamespace).rules[1],
    { apiGroups: [''], resources: ['pods'], verbs: ['get', 'patch', 'create', 'delete'] })
  const home = await directory(t), filename = join(home, 'projection.json'), reads = []
  await writeFile(filename, office(items, values).data['office-preview.json'], { mode: 0o600 })
  const reader = path => { assert.equal(path, officePreviewConfigPath); reads.push(path); return readFile(filename, 'utf8') }
  for (const role of ['host', 'platform']) {
    const result = await renderProfile(role, config(items, values, role), join(home, role), reader)
    const rows = yaml.load(await readFile(join(result.profile, 'cordis.patch.yml'), 'utf8'), { schema })
    const settings = rows.at(-1).config
    if (role === 'host') {
      assert.equal(settings.officePreviewEnabled, true)
      assert.equal(settings.officePreviewConfigFile, undefined)
    } else {
      assert.equal(settings.officePreviewConfigFile, officePreviewConfigPath)
      assert.equal(settings.officePreviewKubeconfigFile, 'in-cluster')
    }
  }
  assert.deepEqual(reads, [officePreviewConfigPath])
})

test('static preflight rejects changed Office bytes, Host configuration, projection, RBAC and network rules', () => {
  const values = configured()
  for (const edit of [
    items => { office(items, values).data['office-preview.json'] = '{}' },
    items => { office(items, values).data.extra = 'private-fixture' },
    items => { office(items, values).binaryData = { extra: 'private-fixture' } },
    items => { items.push(structuredClone(office(items, values))) },
    items => { config(items, values, 'host').PE_OFFICE_PREVIEW_CONFIG_FILE = officePreviewConfigPath },
    items => { delete config(items, values, 'host').PE_OFFICE_PREVIEW_ENABLED },
    items => { config(items, values, 'platform').PE_OFFICE_PREVIEW_KUBECONFIG_FILE = '/other/file' },
    items => { spec(items, values, 'host').volumes[0].projected.sources.push(
      spec(items, values, 'platform').volumes[0].projected.sources.at(-1)) },
    items => { spec(items, values, 'platform').volumes[0].projected.sources.at(-1).configMap.items[0].path = 'other.json' },
    items => { find(items, 'Role', 'power-evolve-platform-runner', values.runnerNamespace).rules[1].verbs.push('list') },
    items => { find(items, 'NetworkPolicy', 'default-deny', values.runnerNamespace).spec.egress.push({}) },
  ]) {
    const items = buildManifests(values)
    edit(items)
    assert.throws(() => validateBundle(values, items), error => !error.message.includes('private-fixture'))
  }
})

test('invalid mounted Office settings and role references fail before Profile creation', async t => {
  const values = configured(), items = buildManifests(values), home = await directory(t)
  const env = config(items, values, 'platform')
  for (const [index, edit] of [
    settings => { settings.namespace = 'foreign-runners' },
    settings => { settings.localRoot = '/data/homes' },
    settings => { settings.limits.pages = 0 },
  ].entries()) {
    const settings = JSON.parse(office(items, values).data['office-preview.json'])
    edit(settings)
    const uncreated = join(home, 'invalid-' + index)
    await assert.rejects(renderProfile('platform', env, uncreated, async () => JSON.stringify(settings)),
      /Invalid Office preview deployment configuration/u)
    await assert.rejects(stat(uncreated), { code: 'ENOENT' })
  }
  const hostHome = join(home, 'wrong-role')
  await assert.rejects(renderProfile('host', { ...config(items, values, 'host'),
    PE_OFFICE_PREVIEW_CONFIG_FILE: officePreviewConfigPath }, hostHome), /Invalid Office preview deployment metadata/u)
  await assert.rejects(stat(hostHome), { code: 'ENOENT' })
})

test('live material preflight reads only the declared ConfigMap and runs the actual built parser', async () => {
  const values = configured(), items = buildManifests(values), reads = []
  assert.deepEqual(await validateOfficePreviewMaterials(baseline, () => assert.fail('Disabled lookup')),
    { officePreviewReady: false })
  assert.deepEqual(await validateOfficePreviewMaterials(values, async (kind, name) => {
    reads.push([kind, name]); return office(items, values)
  }), { officePreviewReady: true })
  assert.deepEqual(reads, [['configmap', values.officePreview.configMapName]])
  for (const edit of [
    map => { map.data['office-preview.json'] = '{private-fixture' },
    map => { const settings = JSON.parse(map.data['office-preview.json']); settings.image = 'other:mutable'
      map.data['office-preview.json'] = JSON.stringify(settings) },
    map => { map.data.extra = 'private-fixture' },
  ]) {
    const map = structuredClone(office(items, values)); edit(map)
    await assert.rejects(validateOfficePreviewMaterials(values, async () => map), error =>
      error.message === 'Invalid Office preview deployment materials')
  }
})

test('preloaded node checks require exact immutable refs on all eligible nodes and do not claim public pulls', () => {
  const values = configured(), selected = officePreviewValues(values.officePreview, values)
  const node = () => ({ spec: {}, status: { conditions: [{ type: 'Ready', status: 'True' }],
    images: [{ names: [selected.config.image] }] } })
  assert.deepEqual(checkOfficePreviewNodes(selected, [node(), node()]), {
    officePreviewImageAccess: 'preloaded', officePreviewPreloadedImageVerified: true, officePreviewPreloadedNodes: 2,
  })
  const missing = node(); missing.status.images = [{ names: ['registry.internal/preview:latest'] }]
  assert.throws(() => checkOfficePreviewNodes(selected, [node(), missing]), /exact immutable/u)
  const cordoned = structuredClone(missing); cordoned.spec.unschedulable = true
  const unready = structuredClone(missing); unready.status.conditions[0].status = 'False'
  const tainted = structuredClone(missing); tainted.spec.taints = [{ key: 'blocked', effect: 'NoSchedule' }]
  assert.equal(checkOfficePreviewNodes(selected, [node(), cordoned, unready, tainted]).officePreviewPreloadedNodes, 1)
  assert.throws(() => checkOfficePreviewNodes(selected, [cordoned, unready, tainted]), /Ready schedulable/u)
  assert.deepEqual(checkOfficePreviewNodes(null, []), {})
  assert.deepEqual(checkOfficePreviewNodes({ ...selected, imageAccess: 'public' }, []),
    { officePreviewImageAccess: 'public', officePreviewPreloadedImageVerified: false })
})

test('local HTTP inherits Office settings and remains outside production HTTPS acceptance', async t => {
  const values = configured()
  values.hostPublicOrigin = 'http://127.0.0.1:19804'
  values.platformPublicOrigin = 'http://127.0.0.1:19806'
  const items = buildLocalHttpManifests(values, { nodeRoot: '/var/lib/qa-office' })
  assert(office(items, values))
  assert.equal(config(items, values, 'host').PE_OFFICE_PREVIEW_ENABLED, '1')
  assert.equal(config(items, values, 'platform').PE_LOCAL_HTTP, '1')
  assert.throws(() => validateBundle(values, items), /Host public Origin/u)
  const home = await directory(t)
  const result = await renderProfile('platform', config(items, values, 'platform'), home,
    async () => office(items, values).data['office-preview.json'])
  const rows = yaml.load(await readFile(join(result.profile, 'cordis.patch.yml'), 'utf8'), { schema })
  assert.equal(rows.at(-1).config.hostOrigin, values.hostPublicOrigin)
  assert.equal(rows.at(-1).config.officePreviewConfigFile, officePreviewConfigPath)
})
