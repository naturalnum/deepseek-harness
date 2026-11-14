/** Native byte-reservation regression; ext4 qualification is emulated by the existing review-only helper. */
import assert from 'node:assert/strict'
import { chmodSync, closeSync, fstatSync, mkdirSync, mkdtempSync, openSync, readFileSync, readdirSync, rmSync, statSync, writeFileSync } from 'node:fs'
import { createRequire } from 'node:module'
import { join } from 'node:path'

assert.equal(process.platform, 'linux')
assert.equal(process.argv.length, 4, 'review-only-addon.node disposable-parent')
assert.ok(process.getuid() > 0 && process.getgid() > 0)
const native = createRequire(import.meta.url)(process.argv[2])
const root = mkdtempSync(join(process.argv[3], 'skill-store-capacity-')), store = join(root, 'skill-working-copies')
try {
  mkdirSync(store, { mode: 0o700 })
  const names = ['1', '2'].map(digit => `project-${digit.repeat(64)}.json`)
  for (const name of names) writeFileSync(join(store, name), ' '.repeat(4096), { mode: 0o600 })
  const fd = openSync(root, 'r')
  let identity, mount
  try {
    identity = fstatSync(fd, { bigint: true })
    mount = /^mnt_id:\s+(\d+)$/mu.exec(readFileSync(`/proc/self/fdinfo/${fd}`, 'utf8'))?.[1]
  } finally { closeSync(fd) }
  assert.ok(mount)
  const args = [root, String(identity.dev), String(identity.ino), mount, process.getuid(), process.getgid(),
    4096, 2, 5000, new Int32Array(new SharedArrayBuffer(4)), 2, 8192, 32768, 4]
  const descriptors = readdirSync('/proc/self/fd').length
  const outcome = frame => ({ tag: frame[5], errno: new DataView(frame.buffer, frame.byteOffset, frame.byteLength).getUint32(8, true) })
  assert.deepEqual(outcome(native.inspectSkillStore(...args)), { tag: 1, errno: 0 })
  assert.deepEqual(outcome(native.verifySkillStore(...args)), { tag: 3, errno: 27 })
  // A writable reserve fits when explicitly configured; neither call changes data or limits.
  assert.deepEqual(outcome(native.verifySkillStore(...args.slice(0, 12), 65536, 4)), { tag: 1, errno: 0 })
  chmodSync(join(store, names[0]), 0o644)
  assert.deepEqual(outcome(native.inspectSkillStore(...args)), { tag: 3, errno: 1 })
  chmodSync(join(store, names[0]), 0o600)
  assert.deepEqual(outcome(native.inspectSkillStore(root, String(identity.dev), String(identity.ino + 1n), ...args.slice(3))),
    { tag: 3, errno: 116 })
  assert.deepEqual(readdirSync(store).sort(), names)
  for (const name of names) assert.equal(statSync(join(store, name)).size, 4096)
  assert.equal(readdirSync('/proc/self/fd').length, descriptors)
  console.log(JSON.stringify({ readWithoutWriteReserve: true, writeReserveEnforced: true,
    permissionsAndRootIdentityEnforced: true, recordsPreserved: 2, descriptorsClosed: true,
    qualificationEmulated: true, applicationOrKernelIsolationAcceptance: false }))
} finally { rmSync(root, { recursive: true, force: false }) }
