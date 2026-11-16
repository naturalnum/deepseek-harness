/** Original verify-only continuation: real state transitions and retained-lock filesystem protocol. */
import assert from 'node:assert/strict'
import fs from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { test } from 'node:test'
import stateModule from './native-delivery-state.cjs'
import { runNativeVerifyContinuation } from './native-delivery.mjs'
import { continueNativeVerify, requireOriginalVerifyApplication } from './native-update.mjs'
import { ORIGINAL_VERIFY_OPERATION, claimOriginalVerifyAttempt } from './native-verify-evidence.mjs'
const { FORMAT, PROJECTION, legacyBarrier, requireOrdinaryUpdateState } = stateModule
const pins = { kind: 'successor-js', operation: ORIGINAL_VERIFY_OPERATION, descriptorSha256: '1'.repeat(64),
  originalTupleSha256: '2'.repeat(64), targetTupleSha256: '3'.repeat(64), compatibleTupleSha256: '4'.repeat(64) }
const history = ['reserved', 'guarded', 'check-pair-intent', 'paired', 'stop-intent', 'stopped',
  'backup-intent', 'backed-up', 'install-intent', 'installed', 'start-intent', 'started', 'verify-intent']
const unconfirmed = error => error.code === 'NATIVE_DELIVERY_UNCONFIRMED'
function fixture(t) {
  const directory = fs.mkdtempSync(join(tmpdir(), 'pe-original-verify-'))
  const beforeCleanup = []
  t.after(async () => { try { for (const close of beforeCleanup) await close() } finally { fs.rmSync(directory, { recursive: true }) } })
  fs.chmodSync(directory, 0o700)
  const lock = join(directory, 'operation.lock'), completed = join(directory, 'native-release-' + pins.operation + '.json')
  fs.writeFileSync(lock, JSON.stringify({ format: PROJECTION, operation: pins.operation }) + '\n', { mode: 0o600 })
  let record = { format: FORMAT, ...pins, directoryIdentity: { device: '1', inode: '2' }, sequence: 12,
    phase: 'verify-intent', history: [...history], productMayHaveChanged: true, profileMayHaveChanged: false, firstLaunchMayHaveRun: true }
  const authority = { read: async () => structuredClone(record), advance: async (expected, next) => {
    assert.deepEqual(expected, record); record = structuredClone(next); return structuredClone(record)
  } }
  return { directory, lock, completed, authority, beforeCleanup, record: () => record,
    run: options => runNativeVerifyContinuation({ directory, pins, authority,
      writeProjection: async value => { assert.deepEqual(value, legacyBarrier(record)); return value },
      observe: async () => pins.targetTupleSha256, ...options }) }
}
test('verification stays at intent while pending; success alone performs CAS13 and normal durable release', async t => {
  const f = fixture(t); let start, finish; const started = new Promise(resolve => { start = resolve })
  const pending = f.run({ verify: () => { start(); return new Promise(resolve => { finish = resolve }) } })
  f.beforeCleanup.push(async () => { finish?.(); await pending }); await started
  assert.equal(f.record().phase, 'verify-intent'); assert.ok(fs.existsSync(f.lock)); assert.equal(fs.existsSync(f.completed), false)
  finish(); const result = await pending
  assert.equal(result.sequence, 13); assert.equal(result.phase, 'verified'); assert.deepEqual(result.history, [...history, 'verified'])
  assert.equal(fs.existsSync(f.lock), false); assert.ok(fs.existsSync(f.completed))
})
test('a failed new verification retains original intent and the same lock inode, without release', async t => {
  const f = fixture(t), inode = fs.statSync(f.lock).ino; let calls = 0
  await assert.rejects(f.run({ verify: async () => { calls++; throw Error('original-smoke-nonzero') } }), unconfirmed)
  assert.equal(calls, 1); assert.equal(f.record().sequence, 12); assert.equal(fs.statSync(f.lock).ino, inode)
  assert.equal(fs.existsSync(f.completed), false); assert.equal(fs.existsSync(join(f.directory, 'native-release.pending')), false)
})
test('wrong selected tuple never starts verification or releases responsibility', async t => {
  const f = fixture(t); let calls = 0
  await assert.rejects(f.run({ verify: async () => { calls++ }, observe: async () => '9'.repeat(64) }), unconfirmed)
  assert.equal(calls, 0); assert.equal(f.record().phase, 'verify-intent'); assert.ok(fs.existsSync(f.lock))
})
test('post-verification tuple drift and Root CAS failure both retain the deployment lock', async t => {
  for (const fault of ['tuple', 'cas']) {
    const f = fixture(t); let observations = 0
    if (fault === 'cas') f.authority.advance = async () => { throw Error('unconfirmed-cas') }
    await assert.rejects(f.run({ verify: async () => {}, observe: async () =>
      ++observations === 2 && fault === 'tuple' ? '9'.repeat(64) : pins.targetTupleSha256 }), unconfirmed)
    assert.equal(f.record().phase, 'verify-intent'); assert.ok(fs.existsSync(f.lock)); assert.equal(fs.existsSync(f.completed), false)
  }
})
test('another operation, an already-verified phase and ordinary entry cannot use this continuation', async t => {
  await assert.rejects(continueNativeVerify({ operation: '00000000-0000-4000-8000-000000000001', line: '主线' }), unconfirmed)
  const f = fixture(t), record = f.record(); record.phase = 'verified'; record.sequence = 13; record.history.push('verified')
  await assert.rejects(f.run({ verify: async () => assert.fail('must not verify twice') }), unconfirmed)
  assert.throws(() => requireOrdinaryUpdateState(legacyBarrier(record)), unconfirmed); assert.ok(fs.existsSync(f.lock))
})
test('changed original app PID, start ticks, exec or keeper and another calling line are rejected', async () => {
  const holder = { pid: 27047, startTicks: '119852371', namespaceId: 'mnt:[4026533685]' }
  const original = { appPid: 78672, appStartTicks: '158001449',
    appExecId: 'a0de3a16ee6ee8497f31aa1290f254f8314b1fd147c4544bd8b83114389e744e', holder }
  for (const change of [{ appPid: 1 }, { appStartTicks: '1' }, { appExecId: '0'.repeat(64) }, { holder: { ...holder, pid: 1 } }]) {
    assert.throws(() => requireOriginalVerifyApplication({ ...original, ...change }, holder), unconfirmed)
  }
  await assert.rejects(continueNativeVerify({ operation: ORIGINAL_VERIFY_OPERATION, line: 'other' }), unconfirmed)
})
test('one exclusive durable attempt survives failure and cannot be silently replayed', t => {
  const f = fixture(t), evidence = { sessionSha256: '1'.repeat(64), providerCompletions: [] }
  claimOriginalVerifyAttempt(f.directory, evidence)
  const marker = join(f.directory, pins.operation + '.verify-attempt.json'), original = fs.readFileSync(marker)
  assert.throws(() => claimOriginalVerifyAttempt(f.directory, evidence), unconfirmed)
  assert.deepEqual(fs.readFileSync(marker), original); assert.ok(fs.existsSync(f.lock))
})
