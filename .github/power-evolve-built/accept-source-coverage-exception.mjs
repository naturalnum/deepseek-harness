/** Admit only the named delivery coverage-ratio exception; retain the gate's FAILED report. */
import assert from 'node:assert/strict'
import { createHash } from 'node:crypto'
import { lstatSync, readFileSync, realpathSync, writeFileSync } from 'node:fs'
import { dirname, isAbsolute, relative, resolve } from 'node:path'
import { fileURLToPath } from 'node:url'
import { coverageErrors, testReportErrors } from '../../products/power-evolve/scripts/cloud-policy.mjs'
import { cloudScope } from '../../products/power-evolve/scripts/cloud-scope.mjs'

const repository = resolve(fileURLToPath(new URL('../..', import.meta.url)))
const flags = new Map()
for (let index = 2; index < process.argv.length; index += 2) {
  const flag = process.argv[index], value = process.argv[index + 1]
  assert(['--report', '--evidence-root', '--exit-code', '--out'].includes(flag) && value && !flags.has(flag))
  flags.set(flag, value)
}
assert.equal(flags.size, 4)
const reportFile = flags.get('--report'), evidenceRoot = flags.get('--evidence-root')
assert(isAbsolute(reportFile) && isAbsolute(evidenceRoot))
assert.equal(realpathSync(evidenceRoot), evidenceRoot, 'Fresh source evidence directory must not resolve through a symlink')
assert.equal(dirname(dirname(reportFile)), evidenceRoot)
assert.equal(realpathSync(dirname(reportFile)), dirname(reportFile))
assert.equal(flags.get('--out'), resolve(evidenceRoot, 'source-acceptance.json'), 'Acceptance output must belong to this fresh source invocation')
assert(!relative(evidenceRoot, reportFile).startsWith('..'), 'Source report must belong to this fresh invocation')
const file = lstatSync(reportFile), directory = lstatSync(evidenceRoot)
assert(file.isFile() && !file.isSymbolicLink() && directory.isDirectory() && !directory.isSymbolicLink())
const bytes = readFileSync(reportFile), report = JSON.parse(bytes)
assert.equal(report.output, dirname(reportFile))
assert(report.finishedAt && Date.parse(report.finishedAt) >= Date.parse(report.startedAt))
assert.deepEqual(report.selected, ['discovery', 'selftest', 'source'])
assert.equal(report.scope.selection, 'current')
assert.deepEqual(report.corpus, cloudScope(repository, 'current').corpus)
assert.deepEqual(report.results.map(result => result.lane), report.selected, 'Additional input or gate failures remain blocking')
for (const [file, expected] of Object.entries(report.hashes)) {
  assert.equal(createHash('sha256').update(readFileSync(resolve(repository, file))).digest('hex'), expected,
    'Source gate input changed: ' + file)
}
const source = report.results.find(result => result.lane === 'source')
for (const result of report.results.filter(result => result !== source)) {
  assert.equal(result.status, 'passed'); assert.deepEqual(result.failures, [])
}
const vitest = JSON.parse(readFileSync(resolve(report.output, 'vitest.json')))
assert.deepEqual(testReportErrors(repository, report.corpus.vitestTests, vitest), [])
assert.equal(vitest.numTotalTests, vitest.numPassedTests)
const runtime = JSON.parse(readFileSync(resolve(report.output, 'vitest-runtime-errors.json')))
assert.deepEqual(runtime, { version: 1, reason: 'passed', unhandledErrors: 0, modules: report.corpus.vitestTests.length })
assert.equal(source.counts.cases, source.counts.passedCases)
assert(source.counts.cases > 0)
if (report.corpus.nodeTests.length) {
  assert(source.counts.nodeRunnerExecutions.length > 0)
  for (const run of source.counts.nodeRunnerExecutions) {
    assert.equal(run.exitCode, 0); assert.equal(run.signal, null)
    assert(run.cases > 0); assert.equal(run.cases, run.passedCases)
  }
  assert.equal(source.counts.nodeCoverageMerged, true)
  assert(source.counts.nativeConversions > 0)
}
const summaryFile = resolve(report.output, 'coverage/coverage-summary.json')
const finalFile = resolve(report.output, 'coverage/coverage-final.json')
const gaps = coverageErrors(repository, report.corpus.runtime,
  JSON.parse(readFileSync(summaryFile)), JSON.parse(readFileSync(finalFile)))
let exception = null
if (source.status === 'passed') {
  assert.equal(flags.get('--exit-code'), '0'); assert.equal(source.counts.exitCode, 0)
  assert.equal(report.status, 'passed'); assert.deepEqual(source.failures, []); assert.deepEqual(gaps, [])
} else {
  assert.equal(flags.get('--exit-code'), '1'); assert.equal(source.counts.exitCode, 1)
  assert.equal(source.status, 'failed'); assert.equal(report.status, 'failed')
  assert(gaps.length > 0, 'An unexplained source failure cannot receive the coverage exception')
  for (const gap of gaps) {
    const match = /: (?:lines|statements|functions|branches) must be 100%; observed (\d+(?:\.\d+)?)$/u.exec(gap)
    assert(match && Number(match[1]) >= 0 && Number(match[1]) < 100,
      'Coverage omission, empty instrumentation or conversion failure remains blocking: ' + gap)
  }
  assert.deepEqual([...source.failures].sort(), [...gaps, 'source exit=1 signal=null'].sort(),
    'A failure outside the coverage ratios remains blocking')
  exception = 'PE_CLOUD_DELIVERY_PER_FILE_COVERAGE_SHORTFALL'
  console.log('::warning::' + exception + ': original coverage FAILED report retained; complete built checks remain required')
}
writeFileSync(flags.get('--out'), JSON.stringify({ version: 1, exception,
  acceptance: exception ? 'accepted-with-named-coverage-exception' : 'passed', behavior: 'passed',
  coverage: exception ? 'FAILED' : 'passed', originalGateStatus: report.status,
  originalExitCode: Number(flags.get('--exit-code')), report: reportFile,
  reportSha256: createHash('sha256').update(bytes).digest('hex'), coverageFailures: gaps,
  originalThresholds: { perFile: true, lines: 100, statements: 100, functions: 100, branches: 100 },
  builtStillRequired: true }, null, 2) + '\n', { flag: 'wx', mode: 0o600 })
