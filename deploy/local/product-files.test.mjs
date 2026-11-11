/** Product replacement fixtures use ordinary temporary directories and never alter a real mount. */
import assert from 'node:assert/strict'
import { test } from 'node:test'
import { createHash } from 'node:crypto'
import { createRequire } from 'node:module'
import { execFileSync } from 'node:child_process'
import { chmodSync, existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, statSync, symlinkSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { dirname, join } from 'node:path'

const require = createRequire(import.meta.url)
const { collectManagedFiles, planUpdate, installFiles, prepare, prepareRestoreSource, withWritableRoot } = require('./product-files.cjs')
const hash = bytes => createHash('sha256').update(bytes).digest('hex')

function fixture(t) {
  const root = mkdtempSync(join(tmpdir(), 'pe-product-files-'))
  t.after(() => rmSync(root, { recursive: true, force: true }))
  return root
}

function file(root, name, text, mode = 0o644) {
  mkdirSync(dirname(join(root, name)), { recursive: true })
  writeFileSync(join(root, name), text)
  chmodSync(join(root, name), mode)
  const bytes = Buffer.from(text)
  return { path: name, size: bytes.length, mode, sha256: hash(bytes) }
}

function archive(root, files, destination) {
  execFileSync('tar', ['-czf', destination, '-C', root, '--null', '-T', '-'], {
    input: Buffer.from(files.map(row => row.path).join('\0') + '\0'),
  })
}

test('prepares without changing installed files, then replaces and restores stale/new files while retaining native and unmanaged files', t => {
  const directory = fixture(t)
  const product = join(directory, 'product'), source = join(directory, 'source'), backup = join(directory, 'backup')
  const oldPackage = file(product, 'packages/demo/plugin/package.json', '{"version":"old"}')
  const oldChanged = file(product, 'packages/demo/plugin/lib/main.js', 'old implementation')
  const oldStale = file(product, 'packages/demo/plugin/lib/stale.js', 'old output')
  file(product, 'packages/demo/plugin/lib/same.js', 'same output')
  file(product, 'packages/demo/plugin/lib/native.node', 'installed native bytes')
  file(product, 'packages/demo/plugin/lib/node_modules/dependency.js', 'installed dependency')
  file(product, 'operator-config.json', 'unmanaged configuration')
  const next = [
    file(source, oldPackage.path, '{"version":"new"}'),
    file(source, oldChanged.path, 'new implementation', 0o755),
    file(source, 'packages/demo/plugin/lib/added.js', 'new output'),
    file(source, 'packages/demo/plugin/lib/same.js', 'same output'),
  ]
  const manifest = { files: next, managedRoots: ['packages/demo/plugin/lib'] }
  const archivePath = join(directory, 'new.tar.gz')
  archive(source, next, archivePath)
  assert.deepEqual(prepare({ productRoot: product, archivePath, manifest, backupDir: backup }), {
    mode: 'prepare', files: 4, changed: 2, added: 1, removed: 1,
  })
  assert.equal(readFileSync(join(product, oldChanged.path), 'utf8'), 'old implementation')
  assert.equal(existsSync(join(product, 'packages/demo/plugin/lib/added.js')), false)
  const state = JSON.parse(readFileSync(join(backup, 'rollback.json'), 'utf8'))
  assert.deepEqual(state.plan, {
    changed: [oldChanged.path, oldPackage.path].sort(),
    added: ['packages/demo/plugin/lib/added.js'], removed: [oldStale.path],
  })
  assert.equal(state.oldFiles.length, 4)
  installFiles({ productRoot: product, sourceRoot: join(backup, 'new'), files: next, remove: state.plan.removed })
  assert.equal(readFileSync(join(product, oldChanged.path), 'utf8'), 'new implementation')
  assert.equal(statSync(join(product, oldChanged.path)).mode & 0o777, 0o755)
  assert.equal(existsSync(join(product, oldStale.path)), false)
  const old = join(backup, 'old')
  mkdirSync(old)
  execFileSync('tar', ['-xzf', join(backup, 'old.tar.gz'), '-C', old])
  installFiles({ productRoot: product, sourceRoot: old, files: state.oldFiles, remove: state.plan.added })
  assert.equal(readFileSync(join(product, oldChanged.path), 'utf8'), 'old implementation')
  assert.equal(statSync(join(product, oldChanged.path)).mode & 0o777, 0o644)
  assert.equal(readFileSync(join(product, oldPackage.path), 'utf8'), '{"version":"old"}')
  assert.equal(readFileSync(join(product, oldStale.path), 'utf8'), 'old output')
  assert.equal(existsSync(join(product, state.plan.added[0])), false)
  assert.equal(readFileSync(join(product, 'packages/demo/plugin/lib/native.node'), 'utf8'), 'installed native bytes')
  assert.equal(readFileSync(join(product, 'packages/demo/plugin/lib/node_modules/dependency.js'), 'utf8'), 'installed dependency')
  assert.equal(readFileSync(join(product, 'operator-config.json'), 'utf8'), 'unmanaged configuration')
})

test('checks all staged bytes before replacing any destination', t => {
  const directory = fixture(t), product = join(directory, 'product'), source = join(directory, 'source')
  file(product, 'lib/a.js', 'old a')
  file(product, 'lib/b.js', 'old b')
  const a = file(source, 'lib/a.js', 'new a'), b = file(source, 'lib/b.js', 'new b')
  writeFileSync(join(source, b.path), 'corrupt staged bytes')
  assert.throws(() => installFiles({ productRoot: product, sourceRoot: source, files: [a, b] }), /differ from the manifest/)
  assert.equal(readFileSync(join(product, a.path), 'utf8'), 'old a')
  assert.equal(readFileSync(join(product, b.path), 'utf8'), 'old b')
})

test('extracts the old archive once, reuses verified restore files, and refuses changed bytes or modes', t => {
  const directory = fixture(t), source = join(directory, 'source'), backup = join(directory, 'backup')
  mkdirSync(backup)
  const old = file(source, 'lib/main.js', 'original executable', 0o755)
  archive(source, [old], join(backup, 'old.tar.gz'))
  const restored = prepareRestoreSource(backup, [old])
  assert.equal(restored, join(backup, 'old'))
  assert.equal(readFileSync(join(restored, old.path), 'utf8'), 'original executable')
  const noExtraction = () => { throw new Error('A verified existing source must not be extracted again.') }
  assert.equal(prepareRestoreSource(backup, [old], noExtraction), restored)
  writeFileSync(join(restored, old.path), 'changed bytes')
  assert.throws(() => prepareRestoreSource(backup, [old], noExtraction), /differ from the manifest/)
  writeFileSync(join(restored, old.path), 'original executable')
  chmodSync(join(restored, old.path), 0o644)
  assert.throws(() => prepareRestoreSource(backup, [old], noExtraction), /differ from the manifest/)
})

test('refuses an existing restore source that is a symlink or an ordinary file', t => {
  const directory = fixture(t), backup = join(directory, 'backup'), outside = join(directory, 'outside')
  mkdirSync(backup)
  mkdirSync(outside)
  symlinkSync(outside, join(backup, 'old'))
  assert.throws(() => prepareRestoreSource(backup, []), /ordinary directory/)
  rmSync(join(backup, 'old'))
  writeFileSync(join(backup, 'old'), 'not a directory')
  assert.throws(() => prepareRestoreSource(backup, []), /ordinary directory/)
})

test('refuses replacement through a file or parent symlink and never changes its external target', t => {
  const directory = fixture(t), product = join(directory, 'product'), source = join(directory, 'source')
  const outside = join(directory, 'outside')
  mkdirSync(join(product, 'lib'), { recursive: true })
  mkdirSync(outside)
  writeFileSync(join(outside, 'main.js'), 'external file')
  symlinkSync(join(outside, 'main.js'), join(product, 'lib/main.js'))
  const next = file(source, 'lib/main.js', 'new bytes')
  assert.throws(() => collectManagedFiles(product, ['lib'], [next]), /symbolic links/)
  assert.throws(() => installFiles({ productRoot: product, sourceRoot: source, files: [next] }), /symbolic links/)
  symlinkSync(outside, join(product, 'linked-parent'))
  const parent = file(source, 'linked-parent/main.js', 'new parent bytes')
  assert.throws(() => installFiles({ productRoot: product, sourceRoot: source, files: [parent] }), /symbolic links/)
  assert.equal(readFileSync(join(outside, 'main.js'), 'utf8'), 'external file')
})

test('native modules cannot enter either the replacement or deletion plan', t => {
  const directory = fixture(t), product = join(directory, 'product'), source = join(directory, 'source')
  const native = file(product, 'lib/native.node', 'installed native')
  const staged = file(source, native.path, 'different native')
  assert.throws(() => planUpdate([native], []), /Native modules/)
  assert.throws(() => installFiles({ productRoot: product, sourceRoot: source, files: [staged] }), /Native modules/)
  assert.throws(() => installFiles({ productRoot: product, sourceRoot: source, files: [], remove: [native.path] }), /Native modules/)
  assert.equal(readFileSync(join(product, native.path), 'utf8'), 'installed native')
})

test('replacement failure still restores both read-only controls, including when remount itself fails', () => {
  for (const failRemount of [false, true]) {
    const calls = []
    const run = (name, args) => {
      calls.push([name, ...args])
      if (args.includes('--getro')) return Buffer.from('1\n')
      if (name === 'findmnt') return Buffer.from('ro,relatime\n')
      if (failRemount && args.includes('remount,ro')) throw new Error('fixture remount failure')
      return Buffer.alloc(0)
    }
    assert.throws(() => withWritableRoot({ productRoot: '/fixture/product', productDevice: '/fixture/device' },
      () => { throw new Error('fixture replacement failure') }, run), /read-only restoration failed/)
    assert.ok(calls.some(row => row.join(' ') === 'mount -o remount,ro /fixture/product'))
    assert.ok(calls.some(row => row.join(' ') === 'blockdev --setro /fixture/device'))
  }
})
