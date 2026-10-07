/** Real synthetic POSIX cache bytes; no PostgreSQL, Kubernetes, application or user materials. */
import assert from 'node:assert/strict'
import { createHash, randomUUID } from 'node:crypto'
import { chmod, mkdir, mkdtemp, readFile, realpath, rm, symlink, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import test from 'node:test'
import { validateOfficeBackupSelection, readOfficeBackupSelection, officeBackupCensus, validateOfficeBackupCensus, captureOfficeBackup,
  prepareRestoredOfficeBackup, writeRestoredOfficeBackup, verifyRestoredOfficeBackup } from '../../scripts/backup-office.mjs'

const hash = bytes => createHash('sha256').update(bytes).digest('hex')
const example = JSON.parse(await readFile(new URL('../../platform/office-preview.example.json', import.meta.url), 'utf8'))
const put = (path, bytes) => writeFile(path, bytes, { mode: 0o600, flag: 'wx' })
async function fixture(t) {
  const root = await realpath(await mkdtemp(join(tmpdir(), 'pe-backup-office-')))
  t.after(() => rm(root, { recursive: true, force: true }))
  const source = { configFile: join(root, 'source.json'), cacheRoot: join(root, 'source-cache') }
  const target = { configFile: join(root, 'target.json'), cacheRoot: join(root, 'target-data', 'office-previews') }
  const sourceSettings = { ...example, namespace: 'pe-source-runners', localRoot: source.cacheRoot }
  const targetSettings = { ...sourceSettings, namespace: 'pe-target-runners', volumeClaimName: 'target-pvc', localRoot: target.cacheRoot }
  await put(source.configFile, JSON.stringify(sourceSettings, null, 2) + '\n')
  await put(target.configFile, JSON.stringify(targetSettings, null, 2) + '\n')
  const bundle = join(root, 'bundle'); await mkdir(bundle, { mode: 0o700 })
  for (const path of ['data', 'config']) await mkdir(join(bundle, path), { mode: 0o700 })
  await mkdir(source.cacheRoot, { mode: 0o700 })
  const id = randomUUID(), nonce = randomUUID(), generation = 'a'.repeat(64), original = Buffer.from('synthetic-original-docx-not-a-user-document')
  const pdf = Buffer.from('%PDF-1.4\nsynthetic byte-preservation fixture\n%%EOF\n')
  const snapshot = { protocolVersion: 1, jobId: id, nonce, generation, sourceSha256: hash(original), sourceBytes: original.length,
    extension: 'docx', limits: sourceSettings.limits }
  const result = { protocolVersion: 1, jobId: id, nonce, generation, sourceSha256: snapshot.sourceSha256,
    pdfSha256: hash(pdf), pdfBytes: pdf.length, pages: 1, missingFonts: [], backend: 'wasm' }
  const state = { schema: 33, officeJobs: [{ id, state: 'succeeded', source_snapshot: snapshot, converter_snapshot: { image: example.image },
    result, worker_observation: { exit: { exitCode: 0 }, failure: null, errorCode: null }, stop_evidence: { status: 'KUBELET_STOPPED', jobId: id } }] }
  for (const part of ['input', 'output']) await mkdir(join(source.cacheRoot, id, part), { recursive: true, mode: 0o700 })
  await put(join(source.cacheRoot, id, 'input', 'job.json'), JSON.stringify(snapshot))
  await put(join(source.cacheRoot, id, 'input', 'source.docx'), original)
  await put(join(source.cacheRoot, id, 'output', 'result.json'), JSON.stringify(result))
  await put(join(source.cacheRoot, id, 'output', 'result.pdf'), pdf)
  return { root, source, target, bundle, sourceSettings, targetSettings, state, id, original, pdf }
}
const absent = path => assert.rejects(readFile(path), { code: 'ENOENT' })

async function capture(f) {
  return captureOfficeBackup(await readOfficeBackupSelection(f.source, []), f.bundle, f.state)
}

test('Office cache preserves original config, input, PDF bytes, modes and PG census without conversion', async t => {
  const f = await fixture(t), census = structuredClone(f.state.officeJobs), material = await capture(f)
  const target = await readOfficeBackupSelection(f.target, [join(f.root, 'target-data', 'workspaces')])
  const prepared = await prepareRestoredOfficeBackup(material, f.bundle, target, [join(f.root, 'target-data', 'workspaces'), f.source.cacheRoot])
  const restored = await writeRestoredOfficeBackup(prepared)
  await verifyRestoredOfficeBackup(material, restored, f.state)
  assert.deepEqual(f.state.officeJobs, census)
  assert.deepEqual(await readFile(join(restored.cacheRoot, f.id, 'output', 'result.pdf')), f.pdf)
  assert.deepEqual(await readFile(join(restored.cacheRoot, f.id, 'input', 'source.docx')), f.original)
  assert.deepEqual(await readFile(join(f.bundle, material.configFile)), await readFile(f.source.configFile))
  assert.equal(restored.configSha256, hash(await readFile(f.target.configFile)))
  assert.notEqual(restored.configSha256, restored.originalConfigSha256)
  await assert.rejects(writeRestoredOfficeBackup(prepared), /remains stopped and partial/u)
})

test('legacy cache omission rejects admitted historical jobs but permits cancellation-only or pre-Office records', async t => {
  const f = await fixture(t)
  await assert.rejects(captureOfficeBackup(null, f.bundle, f.state), /require explicit cache backup configuration/u)
  await assert.rejects(verifyRestoredOfficeBackup(null, null, f.state), /Legacy backup.*stopped and partial.*fresh target/u)
  for (const state of [{ schema: 31, officeJobs: [] }, { schema: 33, officeJobs: [{ id: randomUUID(), state: 'cancelled', source_snapshot: null }] }]) {
    assert.equal(await captureOfficeBackup(null, f.bundle, state), null)
    await verifyRestoredOfficeBackup(null, null, state)
  }
})

test('new census cannot omit a required cache descriptor or disagree with its recorded jobs', async t => {
  const f = await fixture(t), material = await capture(f), census = officeBackupCensus(f.state)
  assert.equal(validateOfficeBackupCensus(census, material), census)
  for (const bad of [null, { ...census, records: true }, { ...census, byteRecords: -1 },
    { ...census, sha256: 'invalid' }, { ...census, sha256: [census.sha256] }]) {
    assert.throws(() => validateOfficeBackupCensus(bad, material), /Invalid Office backup/u)
  }
  assert.throws(() => validateOfficeBackupCensus(census, null), /Invalid Office backup/u)
  assert.throws(() => validateOfficeBackupCensus({ ...census, records: 2 }, material), /Invalid Office backup/u)
  for (const bad of [undefined, false, 0, '']) {
    assert.throws(() => validateOfficeBackupCensus(officeBackupCensus({ officeJobs: [] }), bad), /Invalid Office backup/u)
  }
})

test('explicit enabled Office configuration with no prior cache can restore a fresh empty cache', async t => {
  const f = await fixture(t)
  await rm(f.source.cacheRoot, { recursive: true })
  f.state.officeJobs = []
  const material = await capture(f)
  assert.deepEqual(material.cacheFiles, [])
  assert.deepEqual(material.census, officeBackupCensus(f.state))
  const prepared = await prepareRestoredOfficeBackup(material, f.bundle, await readOfficeBackupSelection(f.target, []), [])
  const restored = await writeRestoredOfficeBackup(prepared)
  await verifyRestoredOfficeBackup(material, restored, f.state)
})

test('Office capture rejects missing or altered recorded bytes before publishing a descriptor', async t => {
  for (const name of ['source.docx', 'result.pdf', 'result.json']) await t.test(name, async t => {
    const f = await fixture(t), directory = name === 'source.docx' ? 'input' : 'output'
    await writeFile(join(f.source.cacheRoot, f.id, directory, name), 'synthetic altered bytes')
    await assert.rejects(capture(f), /Office cache backup failed/u)
    await absent(join(f.bundle, 'config', 'office-preview.json'))
  })
})

test('altered cache inventory or PG census cannot be reported as a restored Office result', async t => {
  const f = await fixture(t), material = await capture(f), target = await readOfficeBackupSelection(f.target, [])
  const prepared = await prepareRestoredOfficeBackup(material, f.bundle, target, [])
  const restored = await writeRestoredOfficeBackup(prepared)
  const changed = structuredClone(f.state); changed.officeJobs[0].result.pdfSha256 = '0'.repeat(64)
  await assert.rejects(verifyRestoredOfficeBackup(material, restored, changed), /census, configuration or cache bytes differ/u)
  await writeFile(join(restored.cacheRoot, f.id, 'output', 'result.pdf'), 'not-original')
  await assert.rejects(verifyRestoredOfficeBackup(material, restored, f.state), /census, configuration or cache bytes differ/u)
})

test('explicit roots, disjoint placement, unchanged nonplacement settings and fresh target are required', async t => {
  const f = await fixture(t), material = await capture(f)
  for (const bad of [{ configFile: f.source.configFile }, { ...f.source, cacheRoot: '/' }, { ...f.source, cacheRoot: 'relative' }]) {
    assert.throws(() => validateOfficeBackupSelection(bad), /Invalid Office backup/u)
  }
  await assert.rejects(readOfficeBackupSelection(f.source, [f.source.cacheRoot]), /Cannot inspect/u)
  const target = await readOfficeBackupSelection(f.target, [])
  await assert.rejects(prepareRestoredOfficeBackup(material, f.bundle, target, [f.target.cacheRoot]), /restore preparation failed/u)
  await assert.rejects(prepareRestoredOfficeBackup(material, f.bundle, target, [f.target.configFile]), /restore preparation failed/u)
  await writeFile(f.target.configFile, JSON.stringify({ ...f.targetSettings, image: 'changed.example/office@sha256:' + 'b'.repeat(64) }))
  await assert.rejects(prepareRestoredOfficeBackup(material, f.bundle, await readOfficeBackupSelection(f.target, []), []), /restore preparation failed/u)
  await writeFile(f.target.configFile, JSON.stringify(f.targetSettings))
  await mkdir(f.target.cacheRoot, { recursive: true, mode: 0o700 })
  await assert.rejects(prepareRestoredOfficeBackup(material, f.bundle, await readOfficeBackupSelection(f.target, []), []), /restore preparation failed/u)
})

test('symlink configuration, cache entries and target ancestors are refused', async t => {
  const f = await fixture(t), configLink = join(f.root, 'config-link.json')
  await symlink(f.source.configFile, configLink)
  await assert.rejects(readOfficeBackupSelection({ ...f.source, configFile: configLink }, []), /Cannot inspect/u)
  const link = join(f.source.cacheRoot, 'outside-link')
  await symlink(f.target.configFile, link)
  await assert.rejects(capture(f), /Office cache backup failed/u)
  await rm(link)
  const material = await capture(f), alias = join(f.root, 'target-alias')
  await mkdir(join(f.root, 'real-target'), { mode: 0o700 }); await symlink(join(f.root, 'real-target'), alias)
  const aliased = { ...f.target, cacheRoot: join(alias, 'cache') }
  await writeFile(f.target.configFile, JSON.stringify({ ...f.targetSettings, localRoot: aliased.cacheRoot }))
  await assert.rejects(readOfficeBackupSelection(aliased, []), /Cannot inspect/u)
  await chmod(join(f.bundle, material.configFile), 0o644)
  await writeFile(f.target.configFile, JSON.stringify(f.targetSettings))
  await assert.rejects(prepareRestoredOfficeBackup(material, f.bundle, await readOfficeBackupSelection(f.target, []), []), /restore preparation failed/u)
})


test('target configuration changes before copying or after PG restoration cannot be reported as success', async t => {
  const f = await fixture(t), material = await capture(f), target = await readOfficeBackupSelection(f.target, [])
  const prepared = await prepareRestoredOfficeBackup(material, f.bundle, target, [])
  await writeFile(f.target.configFile, JSON.stringify({ ...f.targetSettings, namespace: 'changed-target' }))
  await assert.rejects(writeRestoredOfficeBackup(prepared), /remains stopped and partial/u)
  await absent(join(f.target.cacheRoot, f.id, 'output', 'result.pdf'))
  await writeFile(f.target.configFile, target.bytes)
  const restored = await writeRestoredOfficeBackup(prepared)
  await writeFile(f.target.configFile, JSON.stringify({ ...f.targetSettings, namespace: 'changed-target' }))
  await assert.rejects(verifyRestoredOfficeBackup(material, restored, f.state), /configuration.*stopped and partial/u)
  assert.deepEqual(await readFile(join(restored.cacheRoot, f.id, 'output', 'result.pdf')), f.pdf)
})
