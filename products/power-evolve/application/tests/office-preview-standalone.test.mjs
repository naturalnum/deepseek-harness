/** Artifact-plane smoke; build @power-evolve/contracts before running this isolated-parser resource check. */
import assert from 'node:assert/strict'
import { readFile } from 'node:fs/promises'
import { spawnSync } from 'node:child_process'
import test from 'node:test'

test('the parser validation resource loads with no package resolver or string code generation', async () => {
  const bytes = await readFile(new URL('../../contracts/lib/browser/office-preview.js', import.meta.url))
  const url = `data:text/javascript;base64,${bytes.toString('base64')}`
  const checked = spawnSync(process.execPath, ['--disallow-code-generation-from-strings', '--input-type=module'], {
    input: `const validation = await import(${JSON.stringify(url)});\n`
      + "if (!validation.officePreviewCancelRequest.safeParse({ requestId: 'lost-ack', generation: 'a'.repeat(64) }).success) process.exit(1);\n"
      + "if (validation.officePreviewResultSchema.safeParse({ backend: 'native' }).success) process.exit(2);\n",
    encoding: 'utf8', timeout: 10_000,
  })
  assert.equal(checked.error, undefined)
  assert.equal(checked.status, 0, checked.stderr)
})
