/** Artifact-plane regression: build this package's client.js before running this test with Node. */
import assert from 'node:assert/strict'
import { readFile } from 'node:fs/promises'
import { test } from 'node:test'
import { runInNewContext } from 'node:vm'

test('the published client factory needs no native module-table entry for its pure path builder', async () => {
  const source = await readFile(new URL('../lib/client.js', import.meta.url), 'utf8')
  let registration
  runInNewContext(source, { window: { __ModuleLoader__: { load(entry) { registration = entry } } } },
    { timeout: 1_000 })
  assert.equal(registration?.id, '@power-evolve/client-artifacts')
  assert.equal(typeof registration?.factory, 'function')
  const requested = []
  const baseline = new Set(['react', 'react/jsx-runtime', '@deepseek-ai/cordis',
    '@deepseek-ai/dsh-client-store', '@deepseek-ai/dsh-client-ui-slots', '@deepseek-ai/dsh-client-ui-primitives'])
  // Only factory admission is exercised; native UI services remain external and are not started here.
  const exports = registration.factory(id => {
    requested.push(id)
    assert.ok(baseline.has(id), `Unexpected client module-table dependency: ${id}`)
    return {}
  })
  assert.equal(typeof exports.apply, 'function')
  assert.ok(Array.isArray(exports.inject))
  assert.ok(!requested.includes('@deepseek-ai/dsh-util-workspace-path'))
  assert.doesNotMatch(source, /require\s*\(\s*['"]@deepseek-ai\/dsh-util-workspace-path(?:\/[^'"]*)?['"]\s*\)/u)
})
