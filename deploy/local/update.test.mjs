/** Exercise the actual Node -e/stdin boundary without accessing the candidate environment. */
import assert from 'node:assert/strict'
import { createHash } from 'node:crypto'
import { execFileSync, spawnSync } from 'node:child_process'
import { chmodSync, existsSync, mkdirSync, mkdtempSync, readFileSync, realpathSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { test } from 'node:test'
import { buildProductProgram } from './update.mjs'

test('the real product program prepares from asynchronous stdin and leaves the installed product untouched', t => {
  const directory = realpathSync(mkdtempSync(join(tmpdir(), 'pe-update-program-')))
  t.after(() => rmSync(directory, { recursive: true, force: true }))
  const product = join(directory, 'product'), source = join(directory, 'source')
  const backupDir = join(directory, 'rollback'), archivePath = join(directory, 'products.tar.gz')
  const path = 'apps/web/dist/index.html'
  for (const root of [product, source]) mkdirSync(join(root, 'apps/web/dist'), { recursive: true })
  writeFileSync(join(product, path), 'installed product before update')
  writeFileSync(join(source, path), 'candidate product after update')
  chmodSync(join(source, path), 0o644)
  const bytes = readFileSync(join(source, path))
  execFileSync('tar', ['-czf', archivePath, '-C', source, path])
  const manifest = { managedRoots: ['apps/web/dist'], files: [{ path, size: bytes.length, mode: 0o644,
    sha256: createHash('sha256').update(bytes).digest('hex') }] }
  const helper = readFileSync(new URL('./product-files.cjs', import.meta.url), 'utf8')
  const result = spawnSync(process.execPath, ['-e', buildProductProgram(helper)], {
    input: JSON.stringify({ mode: 'prepare', productRoot: product, archivePath, manifest, backupDir }),
    encoding: 'utf8',
  })
  assert.equal(result.error, undefined)
  assert.equal(result.signal, null, 'the subprocess must finish by itself')
  assert.equal(result.status, 0, result.stderr)
  assert.deepEqual(JSON.parse(result.stdout), { mode: 'prepare', files: 1, changed: 1, added: 0, removed: 0 })
  assert.equal(existsSync(join(backupDir, 'rollback.json')), true)
  assert.equal(readFileSync(join(product, path), 'utf8'), 'installed product before update')
})
