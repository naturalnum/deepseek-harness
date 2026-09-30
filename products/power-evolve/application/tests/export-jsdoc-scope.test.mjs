/** The product's documentation check must actually inspect explicitly selected product source files. */
import assert from 'node:assert/strict'
import { mkdtemp, mkdir, writeFile, rm } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { fileURLToPath } from 'node:url'
import { spawnSync } from 'node:child_process'
import test from 'node:test'

test('explicit product JSDoc inspection rejects missing prose and empty, absent or escaped selections', async t => {
  const root = await mkdtemp(join(tmpdir(), 'pe-doc-scope-'))
  t.after(() => rm(root, { recursive: true, force: true }))
  const product = 'products/power-evolve/application/src/example.ts'
  await mkdir(join(root, 'products/power-evolve/application/src'), { recursive: true })
  await writeFile(join(root, product), 'export const undocumented = 1\n')
  const documented = 'products/power-evolve/application/src/documented.ts'
  await writeFile(join(root, documented), '/** A documented product value. */\nexport const value = 1\n')
  const script = new URL('../../../../scripts/verify-export-jsdoc.ts', import.meta.url).href
  const source = `import assert from 'node:assert/strict';
import { collectExportJsdocViolations as check } from ${JSON.stringify(script)};
const root = ${JSON.stringify(root)}, product = ${JSON.stringify(product)};
assert.deepEqual(check(root), []);
assert.ok(check(root, [product]).some(item => item.includes('undocumented')));
assert.deepEqual(check(root, [${JSON.stringify(documented)}]), []);
assert.throws(() => check(root, []), /must not be empty/);
assert.throws(() => check(root, ['missing.ts']), /Invalid JSDoc source/);
assert.throws(() => check(root, ['../outside.ts']), /Invalid JSDoc source/);
`
  const result = spawnSync(process.execPath, ['--import', 'tsx/esm', '--input-type=module'], {
    input: source, encoding: 'utf8', cwd: fileURLToPath(new URL('../../../..', import.meta.url)), timeout: 20000,
  })
  assert.equal(result.status, 0, result.stderr)
})
