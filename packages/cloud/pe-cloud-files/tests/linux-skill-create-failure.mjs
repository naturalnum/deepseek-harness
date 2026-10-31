/** Opt-in native outcome regression; test-only ext4 qualification is explicitly emulated. */
import assert from 'node:assert/strict'
import { randomUUID } from 'node:crypto'
import { chmodSync, closeSync, existsSync, fstatSync, mkdirSync, mkdtempSync, openSync, readFileSync, readdirSync, realpathSync, rmSync, statSync } from 'node:fs'
import { createRequire } from 'node:module'
import { isAbsolute, join } from 'node:path'

assert.equal(process.platform, 'linux')
assert.equal(process.argv.length, 7, 'fault-addon.node approved-disposable-parent version|project|bundle-private|bundle-project container|version after-effect|denied|normal')
const [asset, parent, operation, target, mode] = process.argv.slice(2)
assert.ok(isAbsolute(asset) && asset.endsWith('.node') && isAbsolute(parent))
assert.ok(['version', 'project', 'bundle-private', 'bundle-project'].includes(operation))
assert.ok(['container', 'version'].includes(target) && ['after-effect', 'denied', 'normal'].includes(mode))
assert.ok(operation !== 'bundle-project' || target === 'version', 'bundle projection requires its preprepared skills parent')
assert.ok(process.getuid() > 0 && process.getgid() > 0)
const native = createRequire(import.meta.url)(asset)
const root = mkdtempSync(join(realpathSync(parent), 'skill-create-'))
const previous = [process.env.DSH_FILES_CREATE_FAILURE, process.env.DSH_FILES_CREATE_TARGET]
process.env.DSH_FILES_CREATE_FAILURE = mode
process.env.DSH_FILES_CREATE_TARGET = target
const descriptors = readdirSync('/proc/self/fd').length
function unlock(directory) {
  chmodSync(directory, 0o700)
  for (const entry of readdirSync(directory, { withFileTypes: true })) {
    if (entry.isDirectory()) unlock(join(directory, entry.name))
  }
}
try {
  const fd = openSync(root, 'r')
  let identity, mount
  try {
    identity = fstatSync(fd, { bigint: true })
    mount = /^mnt_id:\s+(\d+)$/mu.exec(readFileSync(`/proc/self/fdinfo/${fd}`, 'utf8'))?.[1]
  } finally { closeSync(fd) }
  assert.ok(mount)
  const project = operation === 'project' || operation === 'bundle-project'
  const metadata = project ? join(root, '.pe') : root
  if (project) mkdirSync(metadata, { mode: 0o700 })
  const skills = join(metadata, 'skills')
  if (target === 'version') mkdirSync(skills, { mode: 0o700 })
  const base = [root, String(identity.dev), String(identity.ino), mount, process.getuid(), process.getgid()]
  const id = randomUUID(), body = new Uint8Array([65]), resource = new Uint8Array([66])
  const cancel = new Int32Array(new SharedArrayBuffer(4))
  let frame
  if (operation === 'version') {
    frame = native.prepareSkillVersion(...base, id, body, resource, 4, 65536, 128, 1024, 5000, cancel, 4096)
  } else if (operation === 'project') {
    frame = native.projectSkillVersion(...base, id, body, resource, 4, 65536, 128, 1024, 5000, cancel, 4096,
      String(identity.dev), String(statSync(metadata, { bigint: true }).ino), mount, '0')
  } else {
    frame = native.skillBundleOperation(...base, project ? 1 : 0, id,
      [{ relativePath: 'SKILL.md', data: body }], [], [], '', 4, 65536, 128, 1024, 8, 4, 4096, 1024,
      5000, cancel, project ? String(statSync(metadata, { bigint: true }).ino) : '0', '0')
  }
  assert.ok(frame instanceof Uint8Array)
  const tag = frame[5], flags = frame[6], errno = new DataView(frame.buffer, frame.byteOffset, frame.byteLength).getUint32(8, true)
  const directory = target === 'container' ? skills : join(skills, '.pending-' + id)
  const actualResidue = existsSync(directory)
  assert.equal(readdirSync('/proc/self/fd').length, descriptors, 'actual descriptor count returns to baseline')
  console.log(JSON.stringify({ operation, target, mode, tag, flags, errno, actualResidue,
    qualificationEmulated: true, applicationOrKernelIsolationAcceptance: false }))
  assert.equal(tag, mode === 'normal' ? 1 : mode === 'denied' ? 2 : 3)
  assert.equal(errno, mode === 'normal' ? 0 : mode === 'denied' ? 13 : 5)
  assert.ok(flags & 1, 'all known descriptors actually closed')
  assert.equal(actualResidue, mode === 'after-effect' || mode === 'normal' && target === 'container')
  assert.equal(existsSync(join(skills, id)), mode === 'normal')
} finally {
  for (const [index, name] of ['DSH_FILES_CREATE_FAILURE', 'DSH_FILES_CREATE_TARGET'].entries()) {
    if (previous[index] === undefined) delete process.env[name]
    else process.env[name] = previous[index]
  }
  unlock(root)
  rmSync(root, { recursive: true, force: false })
}
