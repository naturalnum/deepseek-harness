/** Operator history budgets must fit bounded native snapshot transport before startup. */
import test from 'node:test'
import assert from 'node:assert/strict'
import { mkdtemp, readFile, rm, stat } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { createRequire } from 'node:module'
import { spawnSync } from 'node:child_process'
import { deploymentHistoryBudget, renderProfile } from './start.mjs'
import { buildLocalHttpManifests } from './local-http.mjs'

const MiB = 1024 ** 2
const require = createRequire(new URL('../application/package.json', import.meta.url))
const yaml = require('js-yaml')
const schema = yaml.DEFAULT_SCHEMA.extend(new yaml.Type('tag:yaml.org,2002:js', {
  kind: 'scalar', construct: value => value,
}))
const example = JSON.parse(await readFile(new URL('./values.example.json', import.meta.url), 'utf8'))
const values = { ...example, hostPublicOrigin: 'http://127.0.0.1:19804',
  platformPublicOrigin: 'http://127.0.0.1:19806' }
const items = buildLocalHttpManifests(values, { nodeRoot: '/var/local/pe-budget-test' })
const envFor = role => items.find(item => item.kind === 'ConfigMap'
  && item.metadata.name === `power-evolve-${role}-config`).data

test('defaults and explicit bounded history both fit the actual generated role Profiles', async () => {
  const dir = await mkdtemp(join(tmpdir(), 'pe-history-budget-'))
  try {
    for (const [name, budget, history, response] of [
      ['default', {}, 8 * MiB, 12 * MiB],
      ['long-report', { PE_MAX_HISTORY_BYTES: String(16 * MiB),
        PE_RUNTIME_MAX_RESPONSE_BYTES: String(24 * MiB) }, 16 * MiB, 24 * MiB],
    ]) {
      assert.deepEqual(deploymentHistoryBudget(budget), { maxHistoryBytes: history, maxResponseBytes: response })
      for (const role of ['host', 'platform']) {
        const profile = await renderProfile(role, { ...envFor(role), ...budget }, join(dir, name, role))
        const rows = yaml.load(await readFile(join(profile.profile, 'cordis.patch.yml'), 'utf8'), { schema })
        const selected = rows.find(row => row.id === (role === 'host' ? 'power-evolve-runtime' : 'power-evolve-platform'))
        assert.equal(selected.config[role === 'host' ? 'maxResponseBytes' : 'maxHistoryBytes'],
          role === 'host' ? response : history)
      }
    }
  } finally { await rm(dir, { recursive: true, force: true }) }
})

test('malformed, unbounded, and incompatible budgets reject before either Profile is written', async () => {
  const dir = await mkdtemp(join(tmpdir(), 'pe-invalid-history-budget-'))
  const invalid = []
  for (const key of ['PE_MAX_HISTORY_BYTES', 'PE_RUNTIME_MAX_RESPONSE_BYTES']) {
    for (const value of ['', '0', '1023', '-1', '1.5', '1e7', '01', ' 8388608', '8388608\n',
      'Infinity', '9007199254740993', String(97 * MiB), 8388608, null]) invalid.push({ [key]: value })
  }
  invalid.push({ PE_MAX_HISTORY_BYTES: String(16 * MiB) },
    { PE_RUNTIME_MAX_RESPONSE_BYTES: String(8 * MiB) },
    { PE_MAX_HISTORY_BYTES: String(64 * MiB), PE_RUNTIME_MAX_RESPONSE_BYTES: String(64 * MiB) })
  try {
    for (let index = 0; index < invalid.length; index++) {
      assert.throws(() => deploymentHistoryBudget(invalid[index]), /Invalid|headroom/)
      for (const role of ['host', 'platform']) {
        const home = join(dir, String(index), role)
        await assert.rejects(renderProfile(role, { ...envFor(role), ...invalid[index] }, home), /Invalid|headroom/)
        await assert.rejects(stat(home), { code: 'ENOENT' })
      }
    }
  } finally { await rm(dir, { recursive: true, force: true }) }
})

test('real startup rejects an incompatible snapshot budget before reading private credentials', () => {
  const result = spawnSync(process.execPath, [new URL('./start.mjs', import.meta.url).pathname, 'host'], {
    env: { ...envFor('host'), PE_MAX_HISTORY_BYTES: String(16 * MiB) }, encoding: 'utf8', timeout: 5000,
  })
  assert.equal(result.status, 1)
  assert.match(result.stderr, /snapshot transport requires/)
  assert.doesNotMatch(result.stderr, /Missing DSH_HOME|credential|ENOENT/)
})
