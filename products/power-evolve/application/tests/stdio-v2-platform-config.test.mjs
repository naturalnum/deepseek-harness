/** Synthetic operator files exercise the production config loader without infrastructure or private inputs. */
import assert from 'node:assert/strict'
import { mkdtemp, rm, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import test from 'node:test'
import { loadStdioPlatformConfigV2 } from '../lib/platform/stdio-v2-platform-config.js'

const configPath = '/synthetic-operator/stdio.json', keyPath = '/synthetic-operator/approval-key'
const key = 'aB'.repeat(32)
const refusal = error => {
  assert.equal(error.message, 'Invalid STDIO v2 platform configuration')
  assert.equal(error.cause, undefined)
  return true
}
function settings() {
  return { approvalKeyFile: keyPath,
    limits: { runtimeMs: 10000, requestMs: 1000, stdinGraceMs: 0, terminateGraceMs: 0, killGraceMs: 1000,
      maxInputBytes: 524288, maxMessageBytes: 65536, maxProtocolBytes: 262144, maxProtocolMessages: 20,
      maxJsonDepth: 32, maxJsonNodes: 10000, maxPages: 4, maxTools: 20, maxCatalogBytes: 65536,
      maxToolBytes: 16384, maxResultBytes: 32768, maxStderrBytes: 4096 },
    management: { maxNameBytes: 128, pageItems: 10, maxConnections: 8 },
    admission: { maxConnections: 8, maxTools: 20, maxSnapshotBytes: 524288, maxDescriptionBytes: 4096 },
    cloudDeployment: { kind: 'cloud', deploymentId: '00000000-0000-4000-8000-000000000001', protocolVersion: 2,
      platform: { os: 'linux', architecture: 'arm64' }, imageReference: `registry.invalid/runner@sha256:${'1'.repeat(64)}`,
      configImageId: `sha256:${'2'.repeat(64)}`, runtimeImageIds: [`containerd://sha256:${'3'.repeat(64)}`] },
    maxReplyBytes: 131072, maxPendingPerUser: 8, maxCallsPerChain: 3, chainLifetimeMs: 60000, approvalLifetimeMs: 10000,
    worker: { pollMs: 500, renewMs: 1000, leaseMs: 5000, maxActive: 4, maxCandidates: 16 },
    transport: { requestTimeoutMs: 3000, maxTrackedActions: 32 } }
}
function reader(value = settings(), keyText = key) {
  const paths = []
  return { paths, async readText(path) {
    paths.push(path)
    if (path === configPath) return JSON.stringify(value)
    if (path === keyPath) return keyText
    throw new Error(`Unexpected synthetic path: ${path}`)
  } }
}
async function reject(value) {
  const input = reader(value)
  await assert.rejects(loadStdioPlatformConfigV2(configPath, input.readText), refusal)
  assert.deepEqual(input.paths, [configPath], 'invalid settings are rejected before any key read')
}

test('disabled configuration reads neither operator settings nor a key', async () => {
  assert.equal(await loadStdioPlatformConfigV2('', () => assert.fail('disabled loader read a file')), null)
})

test('enabled configuration retains explicit budgets and distinct Cloud image pins and resolves only its own key', async () => {
  const original = settings(), input = reader(original, `\n${key}\n`)
  const loaded = await loadStdioPlatformConfigV2(configPath, input.readText)
  assert.deepEqual(input.paths, [configPath, keyPath])
  assert.deepEqual(loaded.settings, original)
  assert(loaded.approvalKey instanceof Uint8Array)
  assert.equal(loaded.approvalKey.byteLength, 32)
  assert.deepEqual(loaded.approvalKey, Uint8Array.from({ length: 32 }, () => 0xab))
  assert(!JSON.stringify(loaded.settings).includes(key))
  const runner = { limits: loaded.settings.limits, maxReplyBytes: loaded.settings.maxReplyBytes }
  assert.deepEqual(Object.keys(runner).sort(), ['limits', 'maxReplyBytes'])
  assert.equal(Object.hasOwn(loaded.settings, 'maxActions'), false)
})

test('default reader loads only synthetic files from the test-owned temporary directory', async t => {
  const root = await mkdtemp(join(tmpdir(), 'pe-stdio-config-'))
  t.after(() => rm(root, { recursive: true, force: true }))
  const input = settings(); input.approvalKeyFile = join(root, 'key')
  const path = join(root, 'config.json')
  await writeFile(input.approvalKeyFile, key, { mode: 0o600 })
  await writeFile(path, JSON.stringify(input), { mode: 0o600 })
  assert.deepEqual((await loadStdioPlatformConfigV2(path)).settings, input)
})

test('every deployment field is explicit; missing values cannot inherit defaults', async () => {
  const original = settings()
  for (const name of Object.keys(original)) {
    const value = settings(); delete value[name]; await reject(value)
  }
  for (const group of ['limits', 'management', 'admission', 'worker', 'transport', 'cloudDeployment']) {
    for (const name of Object.keys(original[group])) {
      const value = settings(); delete value[group][name]; await reject(value)
    }
  }
})

test('paths must be absolute and free of control characters before they can reach the reader', async () => {
  for (const path of ['stdio.json', ' ', '/operator/stdio\0.json', '/operator/stdio\n.json']) {
    await assert.rejects(loadStdioPlatformConfigV2(path, () => assert.fail('invalid path read a file')), refusal)
  }
  for (const path of ['key', '', '/operator/key\0', '/operator/key\n']) {
    const input = settings(); input.approvalKeyFile = path; await reject(input)
  }
})

test('unsupported targets, mutable image tags, unexpected fields and invalid pins fail before key access', async () => {
  for (const mutate of [
    value => { value.cloudDeployment.kind = 'desktop' },
    value => { value.cloudDeployment.imageReference = 'registry.invalid/runner:latest' },
    value => { value.cloudDeployment.protocolVersion = 3 },
    value => { value.cloudDeployment.runtimeImageIds = [] },
    value => { value.cloudDeployment.runtimeImageIds.push(value.cloudDeployment.runtimeImageIds[0]) },
    value => { value.cloudDeployment.platform.architecture = 'x86_64' },
    value => { value.maxActions = 1 },
    value => { value.worker.extra = true },
    value => { value.transport.maxReplyBytes = 1 },
    value => { value.limits.extra = true },
  ]) { const value = settings(); mutate(value); await reject(value) }
})

test('finite integer and timer limits match service constructors and renewal must precede lease expiry', async () => {
  for (const [group, name, invalid] of [
    [null, 'maxReplyBytes', 0], [null, 'maxPendingPerUser', 2_147_483_648],
    [null, 'chainLifetimeMs', 2_147_483_648], [null, 'approvalLifetimeMs', 2_147_483_648],
    ['limits', 'runtimeMs', 2_147_483_648], ['limits', 'killGraceMs', 0],
    ['limits', 'maxTools', Number.MAX_SAFE_INTEGER + 1], ['management', 'pageItems', 1.5],
    ['admission', 'maxSnapshotBytes', '524288'], ['worker', 'pollMs', 2_147_483_648],
    ['worker', 'maxActive', 2_147_483_648], ['worker', 'maxCandidates', -1],
    ['worker', 'renewMs', 5000], ['worker', 'renewMs', 5001],
    ['transport', 'requestTimeoutMs', 2_147_483_648], ['transport', 'maxTrackedActions', 0],
  ]) {
    const value = settings(); (group === null ? value : value[group])[name] = invalid; await reject(value)
  }
  const value = settings(); value.maxReplyBytes = Number.MAX_SAFE_INTEGER
  value.transport.maxTrackedActions = Number.MAX_SAFE_INTEGER
  assert.deepEqual((await loadStdioPlatformConfigV2(configPath, reader(value).readText)).settings, value)
})

test('invalid JSON, reader failures and malformed key material produce one redacted error without an original cause', async () => {
  for (const readText of [
    async () => '{"private-input":"not closed',
    async () => { throw new Error(`private-reader ${configPath} ${key}`) },
    async path => path === configPath ? JSON.stringify(settings()) : Promise.reject(new Error(`private-key ${keyPath} ${key}`)),
  ]) await assert.rejects(loadStdioPlatformConfigV2(configPath, readText), refusal)
  for (const bytes of ['', 'a'.repeat(62), 'a'.repeat(66), 'g'.repeat(64), 'a'.repeat(32) + '\0' + 'a'.repeat(31),
    Buffer.alloc(32).toString('base64'), 'a'.repeat(32) + ' ' + 'a'.repeat(32)]) {
    const input = reader(settings(), bytes)
    await assert.rejects(loadStdioPlatformConfigV2(configPath, input.readText), refusal)
    assert.deepEqual(input.paths, [configPath, keyPath])
  }
})
