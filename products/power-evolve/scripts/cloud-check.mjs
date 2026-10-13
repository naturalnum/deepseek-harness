/** Serial cloud checks. Built tests consume prepared artifacts and never silently build them. */
import { spawnSync } from 'node:child_process'
import { createHash } from 'node:crypto'
import { existsSync, globSync, mkdtempSync, readFileSync, realpathSync, statSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { resolve } from 'node:path'
import { fileURLToPath } from 'node:url'
import { corpusErrors, coverageDirectiveErrors, coverageErrors, declarationErrors, inventory, tapReport, testReportErrors } from './cloud-policy.mjs'
import { builtTestInvocation, runStatic, spawnPnpm } from './cloud-static.mjs'
import { nativeCoverageEnvironment, prepareNativeCoverage } from './cloud-coverage.mjs'
import { cloudScope, scopeManifestPath } from './cloud-scope.mjs'

const root = fileURLToPath(new URL('../../../', import.meta.url))
const lanes = ['discovery', 'selftest', 'types', 'lint', 'jsdoc', 'dependencies', 'docs', 'duplication', 'source', 'built']
const args = process.argv.slice(2)
if (args.some(arg => !arg.startsWith('--only=') && !arg.startsWith('--scope='))) {
  throw new Error('Usage: cloud-check.mjs [--scope=current|full] [--only=lane,lane]')
}
const scopes = args.filter(arg => arg.startsWith('--scope='))
if (scopes.length > 1) throw new Error('Use one explicit cloud scope')
const scope = cloudScope(root, scopes[0]?.slice('--scope='.length) ?? process.env.PE_CLOUD_SCOPE ?? 'current')
const only = args.filter(arg => arg.startsWith('--only='))
const selected = only.length === 0 ? lanes : only.flatMap(arg => arg.slice('--only='.length).split(','))
if (selected.length === 0 || selected.some(lane => ![...lanes, 'client', 'built-portable'].includes(lane))) throw new Error('Unknown or empty lane selection')
const output = mkdtempSync(resolve(tmpdir(), 'pe-cloud-check-'))
const corpus = scope.corpus
const baseline = scope.baseline
const configurationPatterns = ['tsconfig*.json', 'vitest*.ts', 'products/power-evolve/*/tsconfig*.json',
  'products/power-evolve/*/tsdown*.ts', 'products/power-evolve/*/vitest*.ts',
  'products/power-evolve/*/assets/cloud-schema*.{sql,json}', 'products/power-evolve/deploy/baseline.json',
  '.github/workflows/power-evolve-cloud.yml', '.github/power-evolve-office/**/*.{mjs,json}',
  '.github/power-evolve-built/**/*.{mjs,json}']
const configuration = globSync(configurationPatterns, { cwd: root }).sort()
const artifacts = globSync(['products/power-evolve/*/lib/**/*.{js,mjs,json}',
  'products/power-evolve/cloud-web/dist/**/*'], { cwd: root }).filter(file => statSync(resolve(root, file)).isFile())
const rules = globSync('scripts/**/*.{ts,tsx,js,mjs,json,yaml}', { cwd: root })
const report = { startedAt: new Date().toISOString(), output, selected, corpus,
  scope: { selection: scope.selection, name: scope.name, manifest: scopeManifestPath, deferred: scope.deferred,
    fullCounts: Object.fromEntries(Object.entries(scope.full).map(([field, files]) => [field, files.length])),
    fullBacklog: scope.selection === 'full' ? 'selected' : 'not-run' },
  hashes: Object.fromEntries([...new Set([...corpus.runtime, ...corpus.sourceTests, ...corpus.builtTests,
    ...corpus.tooling, ...corpus.lint, ...corpus.nativeAssets, ...corpus.docMetadata, ...corpus.docs, ...corpus.manifests,
    ...configuration, ...artifacts, ...rules,
    'pnpm-lock.yaml', 'pnpm-workspace.yaml', '.oxlintrc.json', '.jscpd.json',
    'patches/ast-v8-to-istanbul@1.0.5.patch',
    'products/power-evolve/scripts/cloud-corpus.json', scopeManifestPath])].map(file =>
    [file, createHash('sha256').update(readFileSync(resolve(root, file))).digest('hex')])),
  results: [] }
const save = () => writeFileSync(resolve(output, 'report.json'), JSON.stringify(report, null, 2) + '\n')
const child = (command, values, log, env = {}, inheritEnvironment = true) => {
  console.log(command + ' ' + values.join(' '))
  const options = { cwd: root, shell: false, encoding: 'utf8',
    env: { ...inheritEnvironment ? process.env : {}, ...env, PE_CLOUD_SCOPE: scope.selection }, maxBuffer: 64 * 1024 * 1024 }
  const result = command === 'pnpm' ? spawnPnpm(values, options) : spawnSync(command, values, options)
  writeFileSync(resolve(output, log), result.stdout + result.stderr)
  process.stdout.write(result.stdout)
  process.stderr.write(result.stderr)
  if (result.error) throw result.error
  return result
}
const nativeReport = (name) => {
  const path = resolve(output, name)
  return existsSync(path) ? readFileSync(path, 'utf8').trim().split('\n').filter(Boolean).map(line => JSON.parse(line)) : []
}
const nativeArgs = name => ['--test', '--test-concurrency=1', '--test-reporter=tap',
  '--test-reporter=' + fileURLToPath(new URL('./cloud-reporter.mjs', import.meta.url)),
  '--test-reporter-destination=stdout', '--test-reporter-destination=' + resolve(output, name)]
console.log('Cloud evidence: ' + output)
console.log(JSON.stringify({ sourceFiles: corpus.runtime.length, sourceTestFiles: corpus.sourceTests.length,
  builtTestFiles: corpus.builtTests.length, lintFiles: corpus.lint.length, documentationFiles: corpus.docs.length }))
save()
for (const lane of selected) {
  const started = Date.now()
  const failures = [], counts = {}, records = []
  try {
    if (lane === 'discovery') {
      failures.push(...corpusErrors(scope.full, baseline))
      for (const file of corpus.runtime) failures.push(...coverageDirectiveErrors(file, readFileSync(resolve(root, file), 'utf8')))
      for (const file of [...corpus.sourceTests, ...corpus.builtTests]) {
        failures.push(...declarationErrors(file, readFileSync(resolve(root, file), 'utf8')))
      }
    } else if (lane === 'selftest') {
      const result = child('pnpm', ['exec', 'tsx', '--test', '--test-reporter=tap',
        'products/power-evolve/scripts/cloud-selftest.mjs'], 'selftest.log')
      if (result.status !== 0 || result.signal) failures.push('selftest exit=' + result.status + ' signal=' + result.signal)
    } else if (lane === 'client') {
      const tests = corpus.vitestTests.filter(file => /^products\/power-evolve\/client-(?:account|extension-center)\//u.test(file))
      for (const owner of ['client-account', 'client-extension-center']) {
        if (!tests.some(file => file.startsWith('products/power-evolve/' + owner + '/'))) failures.push('client: empty owner ' + owner)
      }
      for (const file of tests) failures.push(...declarationErrors(file, readFileSync(resolve(root, file), 'utf8')))
      const result = child('pnpm', ['exec', 'vitest', 'run', '--config', 'vitest.power-evolve.cloud.config.ts', ...tests,
        '--reporter=default', '--reporter=json', '--outputFile.json=' + resolve(output, 'client.json')], 'client.log')
      counts.exitCode = result.status
      if (result.status !== 0 || result.signal) failures.push('client exit=' + result.status + ' signal=' + result.signal)
      const path = resolve(output, 'client.json')
      if (!existsSync(path)) failures.push('client: fresh test JSON missing')
      else {
        const run = JSON.parse(readFileSync(path, 'utf8'))
        counts.cases = run.numTotalTests
        counts.passedCases = run.numPassedTests
        failures.push(...testReportErrors(root, tests, run))
      }
    } else if (lane === 'source') {
      for (const file of corpus.runtime) failures.push(...coverageDirectiveErrors(file, readFileSync(resolve(root, file), 'utf8')))
      for (const file of corpus.sourceTests) failures.push(...declarationErrors(file, readFileSync(resolve(root, file), 'utf8')))
      const nodeCoverage = resolve(output, 'node-coverage')
      let nativeInputs, sourceHelperEnvironment = {}
      if (corpus.nodeTests.length > 0) {
        nativeInputs = prepareNativeCoverage(root, corpus.runtime, corpus.nodeTests, nodeCoverage, {
          selection: scope.selection, manifest: scopeManifestPath,
        })
        const imageParent = 'products/power-evolve/deploy/employee4-image.test.mjs'
        const bindings = [
          ['products/power-evolve/application/tests/sandbox-protocol-service.test.mjs', 'PE_SANDBOX_TEST_LINUX_IMAGE', 'PE_SANDBOX_TEST_PG_IMAGE'],
          ['products/power-evolve/application/tests/employee6-stdio-worker-source.test.mjs', 'PE_EMPLOYEE6_STDIO_LINUX_IMAGE', 'PE_EMPLOYEE6_STDIO_PG_IMAGE'],
          ['products/power-evolve/connector-runner/tests/main-linux-entry.test.mjs', 'PE_CONNECTOR_TEST_LINUX_IMAGE'],
        ].filter(([file]) => corpus.nodeTests.includes(file))
        const keys = [...new Set(bindings.flatMap(([, ...names]) => names))]
        const staged = keys.some(key => process.env[key] === undefined)
        if (staged && !corpus.nodeTests.includes(imageParent)) throw new Error('Required Linux helper image has no admitted source producer')
        const batches = staged ? [[imageParent], corpus.nodeTests.filter(file => file !== imageParent)] : [corpus.nodeTests]
        const runs = []
        const nativeEnvironment = nativeCoverageEnvironment(nativeInputs)
        let inspection = 0
        const dockerValue = (args) => {
          const result = spawnSync('docker', args, { cwd: root, shell: false, encoding: 'utf8', timeout: 15_000 })
          writeFileSync(resolve(output, 'source-image-inspect-' + inspection++ + '.log'), (result.stdout ?? '') + (result.stderr ?? ''))
          if (result.error || result.signal || result.status !== 0) throw new Error('Actual Linux helper image inspection failed')
          return result.stdout.trim()
        }
        const helperEnvironment = () => {
          if (keys.length === 0) return {}
          const [os, observed] = dockerValue(['info', '--format', '{{.OSType}} {{.Architecture}}']).split(' ')
          const architecture = ['arm64', 'aarch64'].includes(observed) ? 'arm64' : ['amd64', 'x86_64'].includes(observed) ? 'amd64' : undefined
          if (os !== 'linux' || !architecture) throw new Error('Linux helpers require an actual native amd64/arm64 Docker daemon')
          let coreImage, pgImage
          if (bindings.some(([, key]) => process.env[key] === undefined)) {
            const owner = process.env.PE_CLOUD_IMAGE_OWNER, tag = process.env.PE_TEST_CLOUD_IMAGE
            if (!owner || tag !== 'pe-employee4-cloud:' + owner) throw new Error('Source Linux image ownership input is missing')
            const [id, actualOwner] = dockerValue(['image', 'inspect', '--format', '{{.Id}} {{index .Config.Labels "org.power-evolve.employee4"}}', tag]).split(' ')
            if (actualOwner !== owner) throw new Error('Source Linux image owner differs')
            coreImage = id
          }
          if (bindings.some(([, , key]) => key && process.env[key] === undefined)) {
            const container = process.env.PE_CLOUD_PG_ID, owner = process.env.PE_CLOUD_PG_OWNER
            if (!container || !owner) throw new Error('Owned PostgreSQL actual image input is missing')
            const [id, actualOwner] = dockerValue(['inspect', '--format', '{{.Image}} {{index .Config.Labels "codex.owner"}}', container]).split(' ')
            if (actualOwner !== owner) throw new Error('Owned PostgreSQL image source differs')
            pgImage = id
          }
          const environment = {}, validated = new Set()
          for (const [, linuxKey, pgKey] of bindings) for (const key of [linuxKey, pgKey].filter(Boolean)) {
            const id = process.env[key] ?? (key === pgKey ? pgImage : coreImage)
            if (!/^sha256:[a-f0-9]{64}$/u.test(id ?? '')) throw new Error('Linux helper requires an immutable actual image ID: ' + key)
            if (!validated.has(id)) {
              if (dockerValue(['image', 'inspect', '--format', '{{.Id}} {{.Os}} {{.Architecture}}', id]) !== `${id} linux ${architecture}`) {
                throw new Error('Linux helper image differs from the actual Docker architecture: ' + key)
              }
              validated.add(id)
            }
            environment[key] = id
          }
          counts.nativeHelperImages = environment
          counts.nativeDockerPlatform = 'linux/' + architecture
          return environment
        }
        counts.nodeCases = 0; counts.nodePassedCases = 0
        try {
          for (const [index, files] of batches.entries()) {
            if (files.length === 0) continue
            if (!staged || index > 0) sourceHelperEnvironment = helperEnvironment()
            const reporter = 'source-node-' + index + '.jsonl', log = 'source-node-' + index + '.log'
            const run = { files, reporter, log }; runs.push(run)
            const node = child(process.execPath, [...nativeArgs(reporter), ...files], log,
              { ...nativeEnvironment, ...sourceHelperEnvironment })
            const admitted = tapReport('source Node batch ' + index, node, files.map(file => resolve(root, file)), nativeReport(reporter))
            Object.assign(run, { exitCode: node.status, signal: node.signal, cases: admitted.cases, passedCases: admitted.passedCases })
            counts.nodeCases += admitted.cases; counts.nodePassedCases += admitted.passedCases
            failures.push(...admitted.failures)
            if (staged && index === 0 && admitted.failures.length > 0) throw new Error('Source Linux image producer failed; dependent parents were not started')
          }
        } finally {
          // Preserve original reporter bytes and actual TAP; totals sum the actual admitted runners above.
          for (const [field, destination] of [['reporter', 'source-node.jsonl'], ['log', 'source-node.log']]) {
            writeFileSync(resolve(output, destination), runs.map(run => resolve(output, run[field]))
              .filter(path => existsSync(path)).map(path => readFileSync(path, 'utf8')).join(''))
          }
          counts.nodeRunnerExecutions = runs
          const expected = corpus.nodeTests.map(file => realpathSync(resolve(root, file)))
          const summaries = nativeReport('source-node.jsonl').filter(event => event.type === 'test:summary' && event.data.file)
          if (summaries.some(event => !expected.includes(realpathSync(event.data.file)))) failures.push('source Node: unexpected parent summary')
          for (const file of expected) {
            const observed = summaries.filter(event => realpathSync(event.data.file) === file)
            if (observed.length !== 1 || !observed[0].data.success || observed[0].data.counts.tests === 0
              || observed[0].data.counts.failed > 0 || observed[0].data.counts.skipped > 0
              || observed[0].data.counts.todo > 0 || observed[0].data.counts.cancelled > 0) {
              failures.push('source Node: missing, duplicate, empty or unsuccessful parent summary: ' + file)
            }
          }
        }
      }
      // Explicit discovery is checked against the runner report; CLI filters cannot narrow this lane.
      const result = child('pnpm', ['exec', 'vitest', 'run', '--config', 'vitest.power-evolve.cloud.config.ts',
        '--coverage', '--coverage.reportOnFailure', '--coverage.reportsDirectory=' + resolve(output, 'coverage'),
        '--reporter=default', '--reporter=json',
        '--reporter=' + resolve(root, '.github/power-evolve-built/source-runtime-errors-reporter.mjs'),
        '--outputFile.json=' + resolve(output, 'vitest.json')], 'source.log',
      { ...sourceHelperEnvironment, PE_CLOUD_SOURCE_RUNTIME_ERRORS_FILE: resolve(output, 'vitest-runtime-errors.json'),
        ...nativeInputs ? { PE_CLOUD_COVERAGE_INPUT: nativeInputs,
          PE_CLOUD_SOURCE_SUBPROCESS_ENV: JSON.stringify(nativeCoverageEnvironment(nativeInputs)) } : {} })
      counts.exitCode = result.status
      if (result.status !== 0 || result.signal) failures.push('source exit=' + result.status + ' signal=' + result.signal)
      const runtimePath = resolve(output, 'vitest-runtime-errors.json')
      if (!existsSync(runtimePath)) failures.push('source: fresh runtime error report missing')
      else {
        const runtime = JSON.parse(readFileSync(runtimePath, 'utf8'))
        counts.vitestRuntime = runtime
        if (runtime.version !== 1 || runtime.reason !== 'passed' || runtime.unhandledErrors !== 0
          || runtime.modules !== corpus.vitestTests.length) failures.push('source: incomplete, interrupted or unsuccessful runtime report')
      }
      const path = resolve(output, 'vitest.json')
      if (!existsSync(path)) failures.push('source: fresh test JSON missing')
      else {
        const result = JSON.parse(readFileSync(path, 'utf8'))
        counts.vitestCases = result.numTotalTests
        counts.cases = result.numTotalTests + (counts.nodeCases ?? 0)
        counts.passedCases = result.numPassedTests + (counts.nodePassedCases ?? 0)
        failures.push(...testReportErrors(root, corpus.vitestTests, result))
      }
      const summaryPath = resolve(output, 'coverage/coverage-summary.json'), finalPath = resolve(output, 'coverage/coverage-final.json')
      if (!existsSync(summaryPath) || !existsSync(finalPath)) failures.push('coverage: fresh summary or detailed JSON missing')
      else {
        const summary = JSON.parse(readFileSync(summaryPath, 'utf8')), final = JSON.parse(readFileSync(finalPath, 'utf8'))
        counts.coverageFiles = Object.keys(final).length
        counts.coverageTotals = summary.total
        if (nativeInputs) {
          const nativeReport = resolve(output, 'coverage/native-coverage.json')
          counts.nodeCoverageMerged = existsSync(nativeReport)
          if (!counts.nodeCoverageMerged) failures.push('coverage: unified provider did not produce native conversion evidence')
          else counts.nativeConversions = JSON.parse(readFileSync(nativeReport, 'utf8')).conversions.length
        }
        failures.push(...coverageErrors(root, corpus.runtime, summary, final))
      }
    } else if (lane === 'built' || lane === 'built-portable') {
      const portableFiles = ['products/power-evolve/client-account/tests/client-factory.built.test.mjs',
        'products/power-evolve/client-extension-center/tests/client-factory.built.test.mjs',
        'products/power-evolve/cloud-web/tests/native-assets.built.spec.ts']
      // The POSIX built lane still admits the entire corpus; Windows retains these portable consumers.
      const builtFiles = lane === 'built' ? corpus.builtTests : portableFiles
      for (const file of portableFiles) if (!corpus.builtTests.includes(file)) failures.push('built-portable: required file missing: ' + file)
      counts.files = builtFiles.length
      counts.completeCorpus = lane === 'built'
      for (const file of builtFiles) failures.push(...declarationErrors(file, readFileSync(resolve(root, file), 'utf8')))
      if (builtFiles.length === 0) failures.push('built: empty test corpus')
      else {
        counts.cases = 0
        counts.passedCases = 0
        for (const [index, file] of builtFiles.entries()) {
          const owner = file.slice('products/power-evolve/'.length).split('/')[0]
          const artifact = ['client-account', 'client-extension-center'].includes(owner)
            ? resolve(root, 'products/power-evolve', owner, 'lib/client.js') : undefined
          if (artifact && !existsSync(artifact)) failures.push('built: prepared factory missing: ' + artifact)
          const invocation = builtTestInvocation(root, file, nativeArgs('built-' + index + '.jsonl'),
            { ...process.env, ...artifact ? { POWER_EVOLVE_FACTORY_FILE: artifact } : {} })
          const result = child(invocation.command, invocation.args, 'built-' + index + '.log', invocation.env, false)
          const admitted = tapReport('built: ' + file, result, [resolve(root, file)], nativeReport('built-' + index + '.jsonl'))
          counts.cases += admitted.cases
          counts.passedCases += admitted.passedCases
          records.push({ file, artifact, command: invocation.command, args: invocation.args, runtimeConfig: invocation.runtimeConfig,
            exitCode: result.status, signal: result.signal, cases: admitted.cases })
          failures.push(...admitted.failures)
        }
      }
    } else failures.push(...await runStatic(lane, root, output, entry => records.push(entry), scope.selection))
  } catch (error) { failures.push(error instanceof Error ? error.stack : String(error)) }
  report.results.push({ lane, status: failures.length === 0 ? 'passed' : 'failed', durationMs: Date.now() - started,
    failures, counts, records })
  save()
  console.log(lane + ': ' + (failures.length === 0 ? 'PASS' : 'FAIL (' + failures.length + ')'))
  for (const failure of failures) console.error(failure)
}
// Parallel employees may change source while a lane runs. Reject evidence spanning two inputs.
for (const [file, hash] of Object.entries(report.hashes)) {
  if (!existsSync(resolve(root, file)) || createHash('sha256').update(readFileSync(resolve(root, file))).digest('hex') !== hash) {
    report.results.push({ lane: 'input-stability', status: 'failed', failures: ['input changed during checks: ' + file] })
  }
}
const current = inventory(root)
if (JSON.stringify(current) !== JSON.stringify(scope.full)) {
  report.results.push({ lane: 'input-stability', status: 'failed', failures: ['cloud corpus changed during checks; rerun after integration'] })
}
if (JSON.stringify(globSync(configurationPatterns, { cwd: root }).sort()) !== JSON.stringify(configuration)) {
  report.results.push({ lane: 'input-stability', status: 'failed', failures: ['cloud configuration corpus changed during checks'] })
}
report.finishedAt = new Date().toISOString()
report.status = report.results.every(result => result.status === 'passed') ? 'passed' : 'failed'
save()
console.log('Result: ' + report.status + '; evidence: ' + resolve(output, 'report.json'))
process.exitCode = report.status === 'passed' ? 0 : 1
