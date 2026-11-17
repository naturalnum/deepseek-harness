/** Uses the published parser from a matching build; run after build:artifacts. */
import assert from 'node:assert/strict'
import { test } from 'node:test'
import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import { fileURLToPath } from 'node:url'
import { createHash } from 'node:crypto'
import { prepareOfficeRuntime, stageOfficeRuntime, officeRuntimeTargets, stageOfficeFeatureAssets } from './office-runtime.mjs'

const anchor = process.env.DSH_DEPLOY_TEST_INSTALL_ANCHOR ?? fileURLToPath(new URL('../../package.json', import.meta.url))
const imageDigest = 'sha256:' + 'a'.repeat(64), selection = { imageDigest, platform: 'amd64' }
const entry = { id: 'workspace-dependencies', name: '@deepseek-ai/dsh-tool-workspace-dependencies',
  config: { source: '/opt/dsh/runtime', executionManifest: '/opt/dsh-features/office-dependencies-v1/public' } }

function fixture(t, arch = 'x64') {
  const directory = fs.mkdtempSync(path.join(os.tmpdir(), 'office-runtime-deployment-'))
  t.after(() => fs.rmSync(directory, { recursive: true, force: true }))
  const source = path.join(directory, 'runtime.json')
  const bytes = Buffer.from(JSON.stringify({ desktopVersion: 'actual-parser-fixture', platform: 'linux', arch,
    python: '3.12.13', node: '22.23.2', pythonPackages: { openpyxl: '3.1.5' } }) + '\n')
  fs.writeFileSync(source, bytes)
  return { directory, bytes, reference: { path: source, workloadImageDigest: imageDigest,
    sha256: createHash('sha256').update(bytes).digest('hex') } }
}

test('stages exact image bytes and every final installation target before launch', async t => {
  const f = fixture(t), prepared = await prepareOfficeRuntime(f.reference, selection, anchor)
  const target = path.join(f.directory, 'staged')
  stageOfficeRuntime(prepared, target)
  assert.deepEqual(fs.readFileSync(path.join(target, 'runtime.json')), f.bytes)
  assert.equal(JSON.parse(fs.readFileSync(path.join(target, 'IMAGE.json'))).workloadImageDigest, imageDigest)
  assert.deepEqual(officeRuntimeTargets([entry, entry], prepared), ['/opt/dsh-features/office-dependencies-v1/public/runtime.json'])
  assert.throws(() => stageOfficeRuntime(prepared, target), /EEXIST/)
})

test('missing file and a configured tool without a carrier refuse before publication', async t => {
  const f = fixture(t)
  fs.unlinkSync(f.reference.path)
  await assert.rejects(prepareOfficeRuntime(f.reference, selection, anchor), /ENOENT/)
  assert.throws(() => officeRuntimeTargets([entry], undefined), /require a staged/)
  assert.deepEqual(officeRuntimeTargets([], undefined), [])
})

test('the published Native parser normalizes the deployed OCI arch without rewriting image bytes', async t => {
  const f = fixture(t, 'amd64')
  const prepared = await prepareOfficeRuntime(f.reference, selection, anchor)
  assert.equal(prepared.manifest.arch, 'x64')
  assert.deepEqual(prepared.bytes, f.bytes)
})

test('image, payload hash and platform mismatches refuse before staging', async t => {
  const f = fixture(t)
  await assert.rejects(prepareOfficeRuntime(f.reference, { ...selection, imageDigest: 'sha256:' + 'b'.repeat(64) }, anchor), /selected workload/)
  await assert.rejects(prepareOfficeRuntime({ ...f.reference, sha256: '0'.repeat(64) }, selection, anchor), /changed/)
  await assert.rejects(prepareOfficeRuntime(f.reference, { ...selection, platform: 'arm64' }, anchor), /platform differs/)
})

test('the deployment mount contains the base, module link and exact referenced manifest', async t => {
  const f = fixture(t), prepared = await prepareOfficeRuntime(f.reference, selection, anchor)
  const directory = path.join(f.directory, 'feature-assets'), accountBaseBytes = Buffer.from(JSON.stringify([entry]))
  const input = { directory, accountBaseBytes, targets: officeRuntimeTargets([entry], prepared),
    nativeConfigPath: '/opt/dsh-features/account-base.yml', productRoot: '/opt/dsh-installed-products' }
  assert.equal(stageOfficeFeatureAssets(prepared, input), directory)
  assert.deepEqual(fs.readFileSync(path.join(directory, 'account-base.yml')), accountBaseBytes)
  assert.equal(fs.readlinkSync(path.join(directory, 'node_modules')), '/opt/dsh-installed-products/node_modules')
  assert.deepEqual(fs.readFileSync(path.join(directory, 'office-dependencies-v1/public/runtime.json')), f.bytes)
  assert.throws(() => stageOfficeFeatureAssets(prepared, input), /EEXIST/)
  const forbidden = path.join(f.directory, 'forbidden')
  assert.throws(() => stageOfficeFeatureAssets(prepared, { ...input, directory: forbidden, targets: ['/outside/runtime.json'] }), /feature mount/)
  assert.equal(fs.existsSync(forbidden), false)
})
