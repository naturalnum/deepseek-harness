/** Real producer CLIs and built configuration parsers over owned synthetic inputs; no Linux/SDK qualification. */
import { afterEach, test } from 'node:test'
import assert from 'node:assert/strict'
import fs from 'node:fs'
import { fileURLToPath } from 'node:url'
import { spawnSync } from 'node:child_process'
import { digest, producerFixture } from './producer-fixture.mjs'

const owned = []
afterEach(() => { for (const fixture of owned.splice(0)) fixture.cleanup() })
const fixture = () => {
  const value = producerFixture(process.env.DSH_DEPLOY_TEST_PUBLIC_INPUTS, process.env.DSH_DEPLOY_TEST_INSTALL_ANCHOR)
  owned.push(value); return value
}
function run(f, name, options = {}) {
  const file = options.input ?? (name === 'assemble-native-sdk.mjs' ? f.sdkInput : f.searchInput)
  const args = ['--input', file, '--sha256', options.sha256 ?? digest(fs.readFileSync(file)), '--output-dir', f.output]
  if (options.checkOnly !== false) args.push('--check-only', options.checkOnly ?? 'true')
  if (options.extra) args.push(...options.extra)
  return spawnSync(process.execPath, [fileURLToPath(new URL(name, import.meta.url)), ...args], {
    encoding: 'utf8', timeout: 20000, maxBuffer: 65536, env: { PATH: process.env.PATH ?? '', NARB_DISABLE_NATIVE_CACHE: '1' },
  })
}
const preserved = f => f.created.map(file => [file, digest(fs.readFileSync(file))])
function unchanged(f, original) {
  assert.deepEqual(preserved(f), original); assert.equal(fs.existsSync(f.output), false)
}
function successful(result) {
  assert.equal(result.error, undefined); assert.equal(result.status, 0, result.stderr)
  return JSON.parse(result.stdout)
}
function refused(result, message) {
  assert.equal(result.error, undefined); assert.notEqual(result.status, 0); assert.match(result.stderr, message)
}

test('SDK check-only validates a fresh exact pair and real public Linux rg without writing private outputs', () => {
  const f = fixture(), original = preserved(f), value = successful(run(f, 'assemble-native-sdk.mjs'))
  assert.equal(value.status, 'assembly-checked-no-write'); assert.equal(value.originalRootDeploymentParserPassed, true)
  assert.equal(value.allowedHostPaths, 6); assert.equal(value.sdkModelValidationPending, true); assert.equal(value.dockerExecuted, false)
  unchanged(f, original)
})

test('search check-only composes the bounded preset while retaining approved consumers and all input bytes', () => {
  const f = fixture(), original = preserved(f), value = successful(run(f, 'prepare-native-search-inputs.mjs'))
  assert.equal(value.status, 'native-search-inputs-checked-no-write'); assert.equal(value.searchEntries, 1)
  assert.equal(value.additionalConsumersPreserved, 1); assert.equal(value.searchOutputMaxBytes, 4096)
  assert.equal(value.skeletonSha256, digest(JSON.stringify(f.expectedSearchSkeleton, null, 2) + '\n'))
  const expected = structuredClone(f.search)
  expected.runtime.singleInstance = true
  expected.runtime.accountPolicy.presets[0].configSha256 = f.declarationDigest(f.expectedSearchSkeleton[0].config)
  expected.execution.managed.commands.allowedTools.push('glob', 'grep')
  expected.execution.managed.commands.additionalTools.push('glob', 'grep')
  expected.accountSkeleton = { path: f.output + '/account-profile.native-search.json', sha256: value.skeletonSha256 }
  assert.equal(value.parameterSha256, digest(JSON.stringify(expected, null, 2) + '\n'))
  assert.equal(value.credentialsRead, false); assert.equal(value.applicationStarted, false); unchanged(f, original)
})

for (const name of ['assemble-native-sdk.mjs', 'prepare-native-search-inputs.mjs']) {
  test(name + ' rejects unknown options and ambiguous check-only values before any output', () => {
    const f = fixture(), original = preserved(f)
    refused(run(f, name, { extra: ['--unapproved', 'value'] }), /Exact .*arguments required/)
    refused(run(f, name, { checkOnly: 'false' }), /Only explicit check-only true/)
    unchanged(f, original)
  })
  test(name + ' refuses a changed original input and an existing output directory', () => {
    const f = fixture()
    refused(run(f, name, { sha256: '0'.repeat(64) }), /exact new assembly parameters|Exact original input digest/)
    fs.mkdirSync(f.output)
    refused(run(f, name), /new private output|new output directory/)
    assert.deepEqual(fs.readdirSync(f.output), [])
  })
  test(name + ' retains the Linux Root write guard', t => {
    if (process.platform === 'linux' && process.getuid() === 0) {
      t.skip('The guarded actual-write lane requires its separate fresh Linux fixture run.'); return
    }
    const f = fixture(), original = preserved(f)
    refused(run(f, name, { checkOnly: false }), /Only .*Root.*write/); unchanged(f, original)
  })
}

test('SDK rejects any other supplier digest without changing the declared fixed pair', () => {
  const f = fixture(); f.sdk.images.workload = 'sha256:' + '0'.repeat(64)
  const input = f.write('wrong-supplier.json', f.sdk), original = preserved(f)
  refused(run(f, 'assemble-native-sdk.mjs', { input }), /Only the newly built exact Native pair/); unchanged(f, original)
})

test('SDK checks the complete pinned public source before parser or output publication', () => {
  const f = fixture(), file = f.sdk.publicSources.config.path
  fs.appendFileSync(file, '\n# altered public source\n')
  const original = preserved(f)
  refused(run(f, 'assemble-native-sdk.mjs'), /Pinned public\/new source changed/); unchanged(f, original)
})

test('SDK refuses non-session environment selection', () => {
  const f = fixture(); f.plan.slots[0].environmentBank.mode = 'single-session'
  const planPath = f.write('wrong-storage-plan.json', f.plan); f.sdk.plan = { ...f.sdk.plan, ...f.ref(planPath) }
  const input = f.write('wrong-storage-sdk.json', f.sdk), original = preserved(f)
  refused(run(f, 'assemble-native-sdk.mjs', { input }), /Session-directory environment|Static storage facts/i)
  unchanged(f, original)
})

test('SDK refuses a project selection that exposes an account private domain', () => {
  const f = fixture(); f.plan.slots[0].projects.rootPath = f.plan.slots[0].private.rootPath
  const planPath = f.write('private-project-plan.json', f.plan); f.sdk.plan = { ...f.sdk.plan, ...f.ref(planPath) }
  const input = f.write('private-project-sdk.json', f.sdk), original = preserved(f)
  refused(run(f, 'assemble-native-sdk.mjs', { input }), /project|private|storage|domain|path/i)
  unchanged(f, original)
})

test('search refuses changed preset approval and duplicate consumer preparation without overwriting it', () => {
  const f = fixture(); f.search.runtime.accountPolicy.presets[0].configSha256 = '0'.repeat(64)
  const changed = f.write('wrong-preset.json', f.search)
  refused(run(f, 'prepare-native-search-inputs.mjs', { input: changed }), /Original approved preset differs/)
  f.search.runtime.accountPolicy.presets[0].configSha256 = JSON.parse(fs.readFileSync(f.searchInput)).runtime.accountPolicy.presets[0].configSha256
  f.search.execution.managed.commands.allowedTools.push('glob')
  const duplicate = f.write('duplicate-consumer.json', f.search), original = preserved(f)
  refused(run(f, 'prepare-native-search-inputs.mjs', { input: duplicate }), /Original additional consumers and capacity/)
  unchanged(f, original)
})
