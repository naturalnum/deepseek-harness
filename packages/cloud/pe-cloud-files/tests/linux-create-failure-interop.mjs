/** Explicit Linux native creation-fault regression; uses only one owned disposable directory. */
import assert from 'node:assert/strict'
import { createHash } from 'node:crypto'
import { closeSync, existsSync, fstatSync, mkdtempSync, openSync, readFileSync, readdirSync, realpathSync, rmSync } from 'node:fs'
import { createRequire } from 'node:module'
import { isAbsolute, join } from 'node:path'

assert.equal(process.platform, 'linux')
assert.equal(process.argv.length, 6, 'staging|text fault-addon.node approved-disposable-parent after-effect|denied|normal')
const [kind, asset, parent, mode] = process.argv.slice(2)
assert.ok(['staging', 'text'].includes(kind) && ['after-effect', 'denied', 'normal'].includes(mode))
assert.ok(isAbsolute(asset) && asset.endsWith('.node') && isAbsolute(parent))
const require = createRequire(import.meta.url), native = require(asset)
const root = mkdtempSync(join(realpathSync(parent), 'create-failure-'))
const previous = process.env.DSH_FILES_CREATE_FAILURE
process.env.DSH_FILES_CREATE_FAILURE = mode
try {
  const fd = openSync(root, 'r')
  let identity, mount
  try {
    identity = fstatSync(fd, { bigint: true })
    mount = /^mnt_id:\s+(\d+)$/mu.exec(readFileSync(`/proc/self/fdinfo/${fd}`, 'utf8'))?.[1]
  } finally { closeSync(fd) }
  assert.ok(mount)
  const cancel = new Int32Array(new SharedArrayBuffer(4)), content = new Uint8Array([65])
  let result, temporary, target
  if (kind === 'text') {
    native.openAnchor(root, String(identity.dev), String(identity.ino), mount)
    let error
    try {
      result = native.writeText(root, 'one.txt', '.dsh-text-fixture', content, 64, 'unconditional', '', cancel)
    } catch (cause) { error = cause } finally { native.closeAnchor() }
    temporary = readdirSync(root).filter(name => name.startsWith('.dsh-text-'))
    target = join(root, 'one.txt')
    if (mode === 'normal') {
      assert.equal(error, undefined)
      assert.equal(result.operation, 'create')
      assert.deepEqual(readFileSync(target), Buffer.from(content))
    } else {
      assert.equal(error?.outcome, mode === 'after-effect' ? 'unknown' : 'not-published')
      result = { code: error.code, outcome: error.outcome }
    }
  } else {
    const digest = createHash('sha256').update(content).digest('hex')
    const input = { rootPath: root, device: String(identity.dev), inode: String(identity.ino), mountId: mount,
      digest, name: 'one.txt', maxPathBytes: 4096, maxBytes: 1024, expectedBytes: 1, maxChunkBytes: 128,
      timeoutMs: 5000, cancel }
    result = native.begin(input)
    if (mode === 'normal') {
      assert.equal(result.kind, 'write')
      const handle = result.handle
      assert.equal(native.write(handle, 0, content).kind, 'written')
      result = native.finalize(handle)
      assert.equal(result.kind, 'published')
    } else {
      assert.equal(result.kind, mode === 'after-effect' ? 'unknown' : 'failed')
      if (mode === 'after-effect') assert.throws(() => native.begin(input), { code: 'EBUSY' })
    }
    const folder = join(root, '.pe', 'attachments', digest)
    temporary = existsSync(folder) ? readdirSync(folder).filter(name => name.startsWith('.stage-')) : []
    target = join(folder, 'one.txt')
    assert.equal(result.closed, true)
    assert.equal(result.clean, mode !== 'after-effect')
    if (mode === 'normal') assert.deepEqual(readFileSync(target), Buffer.from(content))
  }
  assert.equal(temporary.length, mode === 'after-effect' ? 1 : 0)
  assert.equal(existsSync(target), mode === 'normal')
  console.log(JSON.stringify({ status: 'passed', kind, mode, nativeFacts: result, actualTemporaryFiles: temporary,
    platform: process.platform, architecture: process.arch, node: process.version,
    creationFailureInjected: mode !== 'normal', accountOrDeploymentAcceptance: false }))
} finally {
  if (previous === undefined) delete process.env.DSH_FILES_CREATE_FAILURE
  else process.env.DSH_FILES_CREATE_FAILURE = previous
  rmSync(root, { recursive: true, force: false })
}
