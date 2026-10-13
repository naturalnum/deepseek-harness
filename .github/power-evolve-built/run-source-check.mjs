/** Run the unchanged complete source gate and register its fresh evidence and actual exit. */
import assert from 'node:assert/strict'
import { spawnSync } from 'node:child_process'
import { appendFileSync, mkdtempSync, readdirSync } from 'node:fs'
import { join, resolve } from 'node:path'
import { fileURLToPath } from 'node:url'

const repository = resolve(fileURLToPath(new URL('../..', import.meta.url)))
assert.equal(process.platform, 'linux')
assert.equal(process.argv.length, 4)
assert.equal(process.argv[2], '--evidence-root')
assert(process.env.GITHUB_OUTPUT, 'The source step must register its actual result')
const root = mkdtempSync(join(resolve(process.argv[3]), 'source-entry-'))
appendFileSync(process.env.GITHUB_OUTPUT, 'evidence_root=' + root + '\n')
const child = spawnSync('pnpm', ['exec', 'tsx', 'products/power-evolve/scripts/cloud-check.mjs',
  '--scope=current', '--only=discovery,selftest,source'], {
  cwd: repository, shell: false, stdio: 'inherit',
  env: { ...process.env, TMPDIR: root, TMP: root, TEMP: root },
})
const reports = readdirSync(root).filter(name => name.startsWith('pe-cloud-check-'))
appendFileSync(process.env.GITHUB_OUTPUT, 'exit_code=' + (child.status ?? 'null') + '\n'
  + 'signal=' + (child.signal ?? '') + '\n')
if (reports.length === 1) appendFileSync(process.env.GITHUB_OUTPUT, 'report=' + join(root, reports[0], 'report.json') + '\n')
if (child.error) throw child.error
assert.equal(child.signal, null, 'A terminated source process cannot receive the coverage exception')
assert([0, 1].includes(child.status), 'The source gate did not exit normally')
process.exitCode = child.status
