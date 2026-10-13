/** Negative controls for product discovery, runner evidence and official rule adapters. */
import assert from 'node:assert/strict'
import { spawnSync } from 'node:child_process'
import { randomUUID } from 'node:crypto'
import { mkdir, mkdtemp, rm, symlink, writeFile } from 'node:fs/promises'
import { readFileSync, readdirSync, realpathSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { createRequire } from 'node:module'
import { fileURLToPath, pathToFileURL } from 'node:url'
import { test } from 'node:test'
import ts from 'typescript'
import { corpusErrors, coverageDirectiveErrors, coverageErrors, declarationErrors, inventory, tapReport, testReportErrors } from './cloud-policy.mjs'
import { builtTestInvocation, cloudLintConfig, dependencyReport, jsdocCollector, readmeMetadataErrors, scopeTypeProgram, spawnPnpm } from './cloud-static.mjs'
import { convertNativeCoverage, nativeCoverageEnvironment, nativeDockerCoverageArguments, nativePureJavaScriptChildEnvironment,
  prepareNativeCoverage, prepareNativeCoverageContext, sourceHash } from './cloud-coverage.mjs'
import { findViolations, anchorCache } from '../../../scripts/verify-md-links.ts'
import { packageReadmeSummaryErrors } from '../../../scripts/verify-package-readme-summaries.ts'
import { collectPackageDependencyViolations, collectRuntimeSourceExportUses,
  readWorkspacePackageManifests } from '../../../scripts/verify-package-dependencies.ts'
import { PACKAGE_DEPENDENCY_POLICY } from '../../../scripts/package-dependency-policy.ts'
import { cloudScope, scopeManifestErrors, scopeManifestPath, deferredRuntimeImportErrors } from './cloud-scope.mjs'
import { createCloudCoverageProvider } from './cloud-provider.mjs'
import { cloudPeerPolicyErrors, createCloudPeerPolicy } from './cloud-peer-policy.mjs'

const isolatedEnvironment = () => {
  const env = { ...process.env }
  delete env.NODE_TEST_CONTEXT
  return env
}

const root = fileURLToPath(new URL('../../../', import.meta.url))
const file = 'products/power-evolve/application/src/case.ts'
const metric = { total: 1, covered: 1, skipped: 0, pct: 100 }
const summary = { [join(root, file)]: { lines: metric, branches: metric, functions: metric, statements: metric } }
const detail = { [join(root, file)]: { statementMap: { 0: {} } } }

test('built artifact invocation retains mandatory reporters and fixtures without source resolver inheritance', () => {
  const files = cloudScope(root, 'current').corpus.builtTests
  assert.equal(files.length, 10)
  assert.equal(files.filter(path => path.endsWith('.mjs')).length, 9)
  const typed = 'products/power-evolve/cloud-web/tests/native-assets.built.spec.ts'
  assert.deepEqual(files.filter(path => !path.endsWith('.mjs')), [typed])
  const runtimeConfig = join(root, 'tsconfig.power-evolve.built-runtime.json')
  const config = ts.readConfigFile(runtimeConfig, ts.sys.readFile)
  assert.equal(config.error, undefined)
  assert.equal(config.config.extends, undefined)
  assert.equal(config.config.compilerOptions.paths, undefined)
  assert.equal(config.config.compilerOptions.baseUrl, undefined)
  assert.deepEqual(config.config.files, [])
  const testArgs = ['--test', '--test-reporter=tap', '--test-reporter=owned-reporter.mjs',
    '--test-reporter-destination=stdout', '--test-reporter-destination=owned-report.jsonl']
  const environment = { NODE_OPTIONS: '--import=source-loader.mjs', NODE_PATH: '/owned/src',
    TSX_TSCONFIG_PATH: '/owned/source-tsconfig.json', PE_CLOUD_COVERAGE_INPUT: '/owned/source-inputs.json',
    PE_CLOUD_SOURCE_SUBPROCESS_ENV: 'source capture', npm_config_node_options: '--import=source-loader.mjs',
    NPM_CONFIG_NODE_OPTIONS: '--import=source-loader.mjs', pnpm_config_node_options: '--import=source-loader.mjs',
    PNPM_CONFIG_NODE_OPTIONS: '--import=source-loader.mjs', NODE_V8_COVERAGE: '/owned/artifact-v8',
    POWER_EVOLVE_FACTORY_FILE: '/owned/lib/client.js', PE_TEST_DATABASE_URL_FILE: '/owned/database-url', OWNED_OTHER: 'retained' }
  const before = structuredClone(environment)
  for (const path of files) {
    const invocation = builtTestInvocation(root, path, testArgs, environment)
    assert.equal(invocation.command, process.execPath)
    assert.deepEqual(invocation.args.slice(path === typed ? 2 : 0), [...testArgs, path])
    if (path === typed) {
      assert.equal(invocation.args[0], '--import')
      assert.equal(invocation.args[1], pathToFileURL(createRequire(import.meta.url).resolve('tsx/esm')).href)
      assert.equal(invocation.runtimeConfig, runtimeConfig)
    } else assert.equal(invocation.runtimeConfig, undefined)
    assert.deepEqual(invocation.env, { NODE_V8_COVERAGE: '/owned/artifact-v8', POWER_EVOLVE_FACTORY_FILE: '/owned/lib/client.js',
      PE_TEST_DATABASE_URL_FILE: '/owned/database-url', OWNED_OTHER: 'retained',
      ...path === typed ? { TSX_TSCONFIG_PATH: runtimeConfig } : {} })
  }
  assert.deepEqual(environment, before)
  assert.throws(() => builtTestInvocation(root, 'products/power-evolve/application/tests/undeclared.built.spec.ts', testArgs),
    /Unsupported artifact test syntax/u)
})

test('built artifact resolver executes package lib while actual source and inherited loader controls reject', async (t) => {
  const temporary = await mkdtemp(join(tmpdir(), 'pe-built-resolver-control-'))
  t.after(() => rm(temporary, { recursive: true, force: true }))
  const name = '@power-evolve/built-resolution-selftest'
  const packageRoot = join(temporary, 'node_modules', name)
  await mkdir(join(packageRoot, 'lib'), { recursive: true })
  await mkdir(join(temporary, 'src'))
  const artifact = join(packageRoot, 'lib/runtime.mjs'), source = join(temporary, 'src/runtime.ts')
  const poison = join(temporary, 'inherited-loader.mjs'), sourceConfig = join(temporary, 'tsconfig.json')
  await writeFile(join(temporary, 'package.json'), JSON.stringify({ type: 'module' }))
  await writeFile(join(packageRoot, 'package.json'), JSON.stringify({ name, type: 'module', exports: './lib/runtime.mjs' }))
  await writeFile(artifact, "export const plane = 'artifact'; export const moduleUrl = import.meta.url\n")
  await writeFile(source, "throw new Error('SOURCE_SHADOW_EXECUTED'); export const plane = 'source'; export const moduleUrl = import.meta.url\n")
  await writeFile(poison, "throw new Error('INHERITED_LOADER_EXECUTED')\n")
  await writeFile(sourceConfig, JSON.stringify({ compilerOptions: { baseUrl: '.', paths: { [name]: ['./src/runtime.ts'] } } }))
  const artifactUrl = pathToFileURL(realpathSync(artifact)).href
  const body = "import assert from 'node:assert/strict'\nimport {test} from 'node:test'\n"
    + 'import {plane,moduleUrl} from ' + JSON.stringify(name) + '\n'
    + "test('actual prepared package export',()=>{assert.equal(plane,'artifact');assert.equal(moduleUrl,"
    + JSON.stringify(artifactUrl) + ');assert.equal(process.env.OWNED_OTHER,"retained")})\n'
  const javascript = join(temporary, 'probe.built.test.mjs'), typed = join(temporary, 'probe.built.spec.ts')
  await writeFile(javascript, body)
  await writeFile(typed, body + 'const syntax: {plane:string} = {plane}; assert.equal(syntax.plane,"artifact")\n')
  const loader = pathToFileURL(createRequire(import.meta.url).resolve('tsx/esm')).href
  const inherited = { ...isolatedEnvironment(), NODE_OPTIONS: '--import=' + pathToFileURL(poison).href,
    TSX_TSCONFIG_PATH: sourceConfig, OWNED_OTHER: 'retained' }
  delete inherited.NODE_V8_COVERAGE
  const shadow = spawnSync(process.execPath, ['--import', loader, '--test', typed], {
    cwd: temporary, env: { ...inherited, NODE_OPTIONS: '' }, encoding: 'utf8',
  })
  assert.notEqual(shadow.status, 0)
  assert.match(shadow.stdout + shadow.stderr, /SOURCE_SHADOW_EXECUTED/u)
  const inheritedLoader = spawnSync(process.execPath, ['--test', javascript], {
    cwd: temporary, env: inherited, encoding: 'utf8',
  })
  assert.notEqual(inheritedLoader.status, 0)
  assert.match(inheritedLoader.stdout + inheritedLoader.stderr, /INHERITED_LOADER_EXECUTED/u)
  for (const [index, path] of [javascript, typed].entries()) {
    const coverage = join(temporary, 'v8-' + index)
    const invocation = builtTestInvocation(root, index === 0 ? path
      : 'products/power-evolve/cloud-web/tests/native-assets.built.spec.ts', ['--test', '--test-reporter=tap'],
    { ...inherited, NODE_V8_COVERAGE: coverage })
    // The private TS probe uses the same formal resolver, without adding a repository test path.
    const args = [...invocation.args.slice(0, -1), path]
    const run = spawnSync(invocation.command, args, { cwd: temporary, env: invocation.env, encoding: 'utf8' })
    assert.equal(run.status, 0, run.stdout + run.stderr)
    const scripts = readdirSync(coverage).filter(name => name.endsWith('.json')).flatMap(name =>
      JSON.parse(readFileSync(join(coverage, name), 'utf8')).result)
    const executed = url => scripts.some(script => script.url === url
      && script.functions.some(fn => fn.ranges.some(range => range.count > 0)))
    assert(executed(artifactUrl), 'The prepared package lib must actually execute')
    assert(!executed(pathToFileURL(realpathSync(source)).href), 'The source shadow must not execute')
    assert(!executed(pathToFileURL(realpathSync(poison)).href), 'The inherited loader must not execute')
  }
})

async function withSourceSubprocessFixture(run) {
  const temporary = await mkdtemp(join(tmpdir(), 'pe-source-subprocess-control-'))
  try {
    await writeFile(join(temporary, 'package.json'), '{"type":"module"}')
    await writeFile(join(temporary, 'native.ts'), 'export function pick(value: boolean): number { if (value) return 1; return 0 }\n')
    await writeFile(join(temporary, 'child.mjs'), "import {pick} from './native.ts'\npick(true)\npick(false)\nconsole.log(process.pid)\n")
    await writeFile(join(temporary, 'parent.mjs'),
      "import {spawnSync} from 'node:child_process'\n"
      + 'const environment = JSON.parse(process.env.PE_CLOUD_SOURCE_SUBPROCESS_ENV)\n'
      + 'const child = spawnSync(process.execPath, [process.argv[2]], {encoding:"utf8", env:{...process.env,...environment}})\n'
      + 'if(child.error || child.status !== 0 || child.signal) throw new Error("Source subprocess failed")\n'
      + 'console.log(JSON.stringify({parentPid:process.pid, childPid:Number(child.stdout.trim())}))\n')
    const prepare = name => prepareNativeCoverage(temporary, ['native.ts'], ['child.mjs'], join(temporary, name))
    const launch = (environment) => {
      const env = isolatedEnvironment()
      delete env.NODE_OPTIONS
      delete env.NODE_V8_COVERAGE
      return spawnSync(process.execPath, [join(temporary, 'parent.mjs'), join(temporary, 'child.mjs')], {
        cwd: temporary, encoding: 'utf8', timeout: 30_000,
        env: { ...env, PE_CLOUD_SOURCE_SUBPROCESS_ENV: JSON.stringify(environment) },
      })
    }
    await run({ temporary, prepare, launch })
  } finally { await rm(temporary, { recursive: true, force: true }) }
}

test('named scope retains full backlog and defers only the reviewed client SSH files', () => {
  const current = cloudScope(root, 'current'), full = cloudScope(root, 'full')
  assert.equal(current.name, 'mcp-pdf'); assert.equal(full.name, 'full')
  assert.equal(full.corpus.runtime.length - current.corpus.runtime.length, 4)
  assert.equal(full.corpus.sourceTests.length - current.corpus.sourceTests.length, 3)
  assert(current.corpus.sourceTests.includes('products/power-evolve/client-extension-center/tests/transport-failures.spec.ts'))
  for (const field of ['nodeTests', 'builtTests', 'nativeAssets']) assert.deepEqual(current.corpus[field], full.corpus[field])
  assert.deepEqual(corpusErrors(full.corpus, full.baseline), [])
  assert.throws(() => cloudScope(root, 'unknown'), /expected current or full/u)
})

test('named scope rejects unclassified files, missing owners, altered thresholds and arbitrary deferrals', () => {
  const full = inventory(root), manifest = JSON.parse(readFileSync(join(root, scopeManifestPath), 'utf8'))
  assert.deepEqual(scopeManifestErrors(full, manifest), [])
  const added = { ...full, runtime: [...full.runtime, 'products/power-evolve/application/src/unclassified.ts'] }
  assert(scopeManifestErrors(added, manifest).some(error => error.includes('unclassified file')))
  const duplicate = structuredClone(manifest); duplicate.entries.push(duplicate.entries[0])
  assert(scopeManifestErrors(full, duplicate).some(error => error.includes('duplicate record')))
  const missingOwner = structuredClone(manifest); missingOwner.entries[0].owner = ''
  assert(scopeManifestErrors(full, missingOwner).some(error => error.includes('owner or reason')))
  const invalidSupportOwner = structuredClone(manifest); invalidSupportOwner.lintSupport[0].owner = 3
  assert(scopeManifestErrors(full, invalidSupportOwner).some(error => error.includes('invalid lint support record')))
  const arbitrary = structuredClone(manifest); arbitrary.entries.find(item => item.kind === 'runtime' && item.status === 'shared').status = 'deferred'
  assert(scopeManifestErrors(full, arbitrary).some(error => error.includes('unreviewed deferral')))
  for (const metric of ['lines', 'statements', 'functions', 'branches']) {
    const lower = structuredClone(manifest); lower.policy.coverage[metric] = 99
    assert(scopeManifestErrors(full, lower).some(error => error.includes('thresholds must remain 100')))
  }
  const truthyPerFile = structuredClone(manifest); truthyPerFile.policy.coverage.perFile = 'true'
  assert(scopeManifestErrors(full, truthyPerFile).some(error => error.includes('thresholds must remain 100')))
})

test('named scope rejects current runtime import and re-export of a deferred implementation', async () => {
  const temporary = await mkdtemp(join(tmpdir(), 'pe-scope-import-control-'))
  try {
    await writeFile(join(temporary, 'deferred.ts'), 'export const value = 1\n')
    for (const source of ["import {value} from './deferred.ts'", "export {value} from './deferred.ts'", "void import('./deferred.ts')"]) {
      await writeFile(join(temporary, 'current.ts'), source)
      assert.equal(deferredRuntimeImportErrors(temporary, { runtime: ['current.ts', 'deferred.ts'] }, ['deferred.ts']).length, 1)
    }
    await writeFile(join(temporary, 'current.ts'), "import type {value} from './deferred.ts'")
    assert.deepEqual(deferredRuntimeImportErrors(temporary, { runtime: ['current.ts', 'deferred.ts'] }, ['deferred.ts']), [])
  } finally { await rm(temporary, { recursive: true, force: true }) }
})

test('named scope preserves ambient declarations when its generated program lives outside the checkout', async () => {
  const temporary = await mkdtemp(join(tmpdir(), 'pe-scope-ambient-control-'))
  try {
    const fixture = join(temporary, 'checkout'), output = join(temporary, 'external')
    const ambient = join(fixture, 'node_modules', '@types', 'scope-fixture')
    await mkdir(ambient, { recursive: true }); await mkdir(output)
    await writeFile(join(ambient, 'index.d.ts'), 'declare const ambientVersion: number\n')
    await writeFile(join(fixture, 'current.ts'), 'export const version: number = ambientVersion\n')
    await writeFile(join(fixture, 'deferred.ts'), "export const postponed: never = 'not-current'\n")
    await writeFile(join(fixture, 'tsconfig.json'), JSON.stringify({
      compilerOptions: { types: ['scope-fixture'], strict: true, noEmit: true }, files: ['current.ts', 'deferred.ts'],
    }))
    const originalPath = join(fixture, 'tsconfig.json')
    const parsed = ts.parseJsonConfigFileContent(ts.readConfigFile(originalPath, ts.sys.readFile).config,
      ts.sys, fixture, {}, originalPath)
    const scoped = scopeTypeProgram(fixture, 'tsconfig.json', parsed, ['deferred.ts'], output, 0)
    assert.deepEqual(scoped.files, [join(fixture, 'current.ts')])
    const configured = ts.readConfigFile(scoped.path, ts.sys.readFile).config
    const parse = config => ts.parseJsonConfigFileContent(config, ts.sys, output, {}, scoped.path)
    const diagnostics = (config) => {
      const program = parse(config)
      return ts.getPreEmitDiagnostics(ts.createProgram({ rootNames: program.fileNames, options: program.options }))
    }
    const relocated = { ...configured, compilerOptions: {} }
    assert(diagnostics(relocated).some(diagnostic => diagnostic.code === 2688))
    assert.deepEqual(diagnostics(configured), [])
    assert.deepEqual(parse(configured).options.types, parsed.options.types)
  } finally { await rm(temporary, { recursive: true, force: true }) }
})

test('named scope provider rejects a foreign selection, manifest or native corpus before instrumentation', async () => {
  const temporary = await mkdtemp(join(tmpdir(), 'pe-native-scope-provider-control-'))
  const prior = process.env.PE_CLOUD_COVERAGE_INPUT
  try {
    const scope = cloudScope(root), path = join(temporary, 'foreign-input.json')
    const original = { root, runtime: scope.corpus.runtime, tests: scope.corpus.nodeTests,
      scope: { selection: scope.selection, manifest: scope.manifestPath } }
    const foreignInputs = [
      { ...original, scope: { ...original.scope, selection: scope.selection === 'current' ? 'full' : 'current' } },
      { ...original, scope: { ...original.scope, manifest: 'foreign-scope.json' } },
      { ...original, runtime: original.runtime.slice(1) },
      { ...original, tests: original.tests.slice(1) },
    ]
    process.env.PE_CLOUD_COVERAGE_INPUT = path
    for (const input of foreignInputs) {
      await writeFile(path, JSON.stringify(input))
      await assert.rejects(createCloudCoverageProvider(), /native and Vitest named scopes differ/u)
    }
  } finally {
    if (prior === undefined) delete process.env.PE_CLOUD_COVERAGE_INPUT
    else process.env.PE_CLOUD_COVERAGE_INPUT = prior
    await rm(temporary, { recursive: true, force: true })
  }
})

test('discovery rejects a removed baseline, empty corpus and owners without tests', () => {
  const current = inventory(root)
  const valid = { ...current, sourceTests: [...current.sourceTests], builtTests: [...current.builtTests] }
  for (const owner of ['contracts', 'connector-runner']) valid.sourceTests.push('products/power-evolve/' + owner + '/tests/case.spec.ts')
  for (const owner of ['client-account', 'client-extension-center', 'cloud-web']) {
    valid.builtTests.push('products/power-evolve/' + owner + '/tests/case.built.test.mjs')
  }
  assert.deepEqual(corpusErrors(valid, current), [])
  assert(corpusErrors({ ...valid, runtime: [] }, current).some(error => error.includes('empty corpus')))
  assert(corpusErrors({ ...valid, sourceTests: valid.sourceTests.slice(1) }, current).some(error => error.includes('baseline file missing')))
  const missing = { ...valid, sourceTests: valid.sourceTests.filter(path => !path.includes('/contracts/')) }
  assert(corpusErrors(missing, current).some(error => error.includes('no source behavior tests')))
})

for (const declaration of [
  "import { test } from 'vitest'; test.skip('case', () => {})",
  "import { it as check } from 'vitest'; check['only']('case', () => {})",
  "import { describe } from 'vitest'; describe.skipIf(false)('suite', () => {})",
  "import { test } from 'vitest'; test.runIf(true)('case', () => {})",
  "import { test } from 'vitest'; test.todo('case')",
  "import * as runner from 'vitest'; runner.test.skip('case', () => {})",
  "import test from 'node:test'; test('case', { skip: true }, () => {})",
  "import { test } from 'node:test'; test('case', { todo: 'pending' }, () => {})",
  "import { it } from 'vitest'; xit('case', () => {})",
  "import { test } from 'vitest'; const alias = test; alias.only('case', () => {})",
  "import { test } from 'vitest'; const exclusive = test.only; exclusive('case', () => {})",
]) {
  test('syntax rejects ' + declaration, () => {
    assert(declarationErrors('case.spec.ts', declaration).length > 0)
  })
}
test('ordinary tests, false Node options and a string mentioning skip remain admitted', () => {
  assert.deepEqual(declarationErrors('case.spec.ts',
    "import { test } from 'node:test'; test('skip is text', { skip: false }, () => {})"), [])
})

test('runner JSON rejects absent suites, skipped cases and empty reports', () => {
  const sourceFile = file.replace('/src/', '/tests/').replace('.ts', '.spec.ts')
  const report = { success: true, numTotalTests: 1, testResults: [{
    name: join(root, sourceFile), status: 'passed', assertionResults: [{ status: 'passed', fullName: 'case' }],
  }] }
  assert.deepEqual(testReportErrors(root, [sourceFile], report), [])
  assert(testReportErrors(root, [sourceFile, 'missing.spec.ts'], report).some(error => error.includes('missing from report')))
  assert(testReportErrors(root, [sourceFile], { ...report, numPendingTests: 1 }).some(error => error.includes('numPendingTests')))
  assert(testReportErrors(root, [sourceFile], { success: true, numTotalTests: 0, testResults: [] }).length > 0)
  const skipped = structuredClone(report)
  skipped.testResults[0].assertionResults[0].status = 'pending'
  assert(testReportErrors(root, [sourceFile], skipped).some(error => error.includes('pending')))
})

test('coverage rejects missing files, missing detailed evidence and every lower metric', () => {
  assert.deepEqual(coverageErrors(root, [file], summary, detail), [])
  assert(coverageErrors(root, [file, 'missing.ts'], summary, detail).some(error => error.includes('missing runtime')))
  assert(coverageErrors(root, [file], summary, {}).some(error => error.includes('empty file report')))
  for (const key of ['lines', 'statements', 'functions', 'branches']) {
    const broken = structuredClone(summary)
    broken[join(root, file)][key].pct = 99.99
    assert(coverageErrors(root, [file], broken, detail).some(error => error.includes(key + ' must be 100%')))
  }
})

test('coverage admits an executed empty function and rejects missing or unexecuted function evidence', async () => {
  const temporary = realpathSync(await mkdtemp(join(tmpdir(), 'pe-empty-function-coverage-')))
  try {
    await symlink(join(root, 'node_modules'), join(temporary, 'node_modules'), 'junction')
    await writeFile(join(temporary, 'package.json'), '{"type":"module"}')
    await writeFile(join(temporary, 'empty.ts'), 'export function apply(): void {}\n')
    const config = join(temporary, 'vitest.config.mjs')
    await writeFile(config, 'export default ' + JSON.stringify({ root: temporary, test: {
      include: ['case.spec.ts'], pool: 'forks', maxWorkers: 1, passWithNoTests: false,
      coverage: { enabled: true, reportOnFailure: true, provider: 'v8', include: ['empty.ts'],
        reportsDirectory: join(temporary, 'coverage'), reporter: ['json', 'json-summary'],
        thresholds: { perFile: true, lines: 100, statements: 100, functions: 100, branches: 100 } },
    } }))
    for (const called of [true, false]) {
      await writeFile(join(temporary, 'case.spec.ts'), "import {test,expect} from 'vitest'; import {apply} from './empty.ts';"
        + "test('empty plugin entry',()=>{" + (called ? 'apply();' : '') + "expect(typeof apply).toBe('function')})")
      const run = spawnPnpm(['exec', 'vitest', 'run', '--config', config],
        { cwd: root, env: isolatedEnvironment(), encoding: 'utf8', timeout: 30_000 })
      assert.equal(run.error, undefined); assert.equal(run.signal, null)
      assert.equal(run.status, called ? 0 : 1, run.stdout + run.stderr)
      const path = join(temporary, 'empty.ts')
      const result = JSON.parse(readFileSync(join(temporary, 'coverage/coverage-summary.json'), 'utf8'))
      const final = JSON.parse(readFileSync(join(temporary, 'coverage/coverage-final.json'), 'utf8'))
      assert.equal(Object.keys(final[path].statementMap).length, 0)
      assert.equal(Object.keys(final[path].fnMap).length, 1)
      const errors = coverageErrors(temporary, ['empty.ts'], result, final)
      if (!called) {
        assert(errors.some(error => error.includes('functions must be 100%')))
        continue
      }
      assert.deepEqual(errors, [])
      const missing = structuredClone(final)
      missing[path].fnMap = {}; missing[path].f = {}
      assert(coverageErrors(temporary, ['empty.ts'], result, missing)
        .some(error => error.includes('executable source has empty instrumentation')))
    }
  } finally { await rm(temporary, { recursive: true, force: true }) }
})

test('lint adapter retains official rules and admits product JS/MJS and tests', () => {
  const official = ts.parseConfigFileTextToJson('config', readFileSync(join(root, '.oxlintrc.json'), 'utf8')).config
  const adapted = cloudLintConfig(official)
  assert(!adapted.ignorePatterns.includes('**/*.mjs'))
  assert(!adapted.ignorePatterns.includes('**/*.js'))
  assert(adapted.overrides.some(override => override.files.some(pattern => pattern.includes('/tests/'))))
  assert(adapted.overrides.some(override => override.files.includes('products/power-evolve/application/web/**/*.{js,mjs}')))
  const strict = adapted.overrides.find(override => Object.hasOwn(override.rules, 'typescript/no-floating-promises'))
  assert.equal(strict.rules['typescript/no-floating-promises'], 'error')
  assert.throws(() => cloudLintConfig({ ignorePatterns: [], overrides: [] }), /no product rules/u)
})

test('real oxlint rejects a product MJS rule violation from a temp configuration', async () => {
  const temporary = await mkdtemp(join(tmpdir(), 'pe-lint-control-'))
  const path = 'products/power-evolve/scripts/cloud-negative-' + randomUUID() + '.mjs'
  const required = createRequire(join(root, 'package.json'))
  try {
    const official = ts.parseConfigFileTextToJson('config', readFileSync(join(root, '.oxlintrc.json'), 'utf8')).config
    const config = cloudLintConfig(official)
    for (const override of config.overrides) {
      override.files = override.files.map(pattern => join(root, pattern).replaceAll('\\', '/'))
      if (override.jsPlugins) override.jsPlugins = override.jsPlugins.map(plugin => required.resolve(plugin))
    }
    const configPath = join(temporary, 'config.json')
    await writeFile(configPath, JSON.stringify(config))
    await writeFile(join(root, path), 'var sample = 1\nconsole.log(sample)\n')
    const args = ['exec', 'tsx', 'scripts/run-oxlint.ts', '--config', configPath, path]
    const bad = spawnPnpm(args, { cwd: root, encoding: 'utf8', timeout: 30_000 })
    assert.equal(bad.error, undefined)
    assert.equal(bad.signal, null)
    assert.equal(bad.status, 1)
    assert.match(bad.stdout + bad.stderr, /eslint\(no-var\)/u)
    await writeFile(join(root, path), 'const sample = 1\nconsole.log(sample)\n')
    const good = spawnPnpm(args, { cwd: root, encoding: 'utf8', timeout: 30_000 })
    assert.equal(good.error, undefined)
    assert.equal(good.signal, null)
    assert.equal(good.status, 0, good.stdout + good.stderr)
  } finally {
    await rm(join(root, path), { force: true })
    await rm(temporary, { recursive: true, force: true })
  }
})

test('official JSDoc rejects undocumented TS and MJS exports and missing parameters', async () => {
  const temporary = await mkdtemp(join(tmpdir(), 'pe-jsdoc-control-'))
  try {
    await writeFile(join(temporary, 'bad.ts'), 'export function broken(value: string): string { return value }\n')
    await writeFile(join(temporary, 'bad.mjs'), 'export function broken(value) { return value }\n')
    await writeFile(join(temporary, 'returns.mjs'),
      '/** Return the input.\n * @param value Original input.\n */\nexport function broken(value) { return value }\n')
    await writeFile(join(temporary, 'params.ts'), '/** Return the input. */\nexport function broken(value: string): string { return value }\n')
    await writeFile(join(temporary, 'good.ts'),
      '/** Return the input.\n * @param value Original input.\n * @returns Unmodified input.\n */\nexport function documented(value: string): string { return value }\n')
    const collect = await jsdocCollector(root, ['bad.ts', 'bad.mjs', 'returns.mjs', 'params.ts', 'good.ts'])
    const failures = collect(temporary)
    assert(failures.some(error => error.includes('bad.ts')))
    assert(failures.some(error => error.includes('bad.mjs')))
    assert(failures.some(error => error.includes('returns.mjs') && error.includes('@returns')))
    assert(failures.some(error => error.includes('params.ts') && error.includes('@param')))
    assert(!failures.some(error => error.includes('good.ts')))
  } finally { await rm(temporary, { recursive: true, force: true }) }
})

test('official documentation rejects missing links, anchors and an absent README Summary', async () => {
  const temporary = await mkdtemp(join(tmpdir(), 'pe-doc-control-'))
  try {
    const path = join(temporary, 'README.md')
    await writeFile(path, '# Example\n\n[missing](absent.md)\n\n[anchor](#absent)\n')
    const failures = findViolations(path, anchorCache(), temporary)
    assert(failures.some(error => error.reason === 'target'))
    assert(failures.some(error => error.reason === 'anchor'))
    assert.equal(packageReadmeSummaryErrors('README.md', '# Example\n').length, 1)
  } finally { await rm(temporary, { recursive: true, force: true }) }
})

test('official dependency policy rejects missing shared Cordis and runtime packages', () => {
  const facts = { manifestPath: 'products/power-evolve/example/package.json', manifest: { name: '@power-evolve/example' },
    role: 'configured-host', workspaceNames: new Set(), allSourceUses: new Map([['pg', ['src/example.ts']]]),
    hostRuntimeSourceUses: new Map([['pg', ['src/example.ts']]]), hostRuntimeExportUses: [],
    peerRequiredHostDependencies: new Set(), configurationOnlyDevDependencies: new Set(), clientInject: new Set() }
  const failures = collectPackageDependencyViolations({ facts: [facts], packages: [], policyViolations: [], workspaceNames: new Set() })
  assert(failures.some(error => error.includes('@deepseek-ai/cordis')))
  assert(failures.some(error => error.includes('pg')))
  const devOnly = { ...facts, manifest: { ...facts.manifest, devDependencies: { pg: '^8.16.3' } } }
  const misplaced = collectPackageDependencyViolations({ facts: [devOnly], packages: [], policyViolations: [], workspaceNames: new Set() })
  assert(misplaced.some(error => error.includes('pg') && error.includes('dependencies-only')))
  const production = { ...facts, manifest: { ...facts.manifest, dependencies: { pg: '^8.16.3' } } }
  const declared = collectPackageDependencyViolations({ facts: [production], packages: [],
    policyViolations: [], workspaceNames: new Set() })
  assert(!declared.some(error => error.includes('pg')))
})

test('actual cloud peer facts enforce matching declarations and retain stale, namespace and SAFE rejection', async () => {
  const temporary = await mkdtemp(join(tmpdir(), 'pe-peer-facts-control-'))
  try {
    const app = 'products/power-evolve/application', provider = 'products/power-evolve/contracts'
    await mkdir(join(temporary, app, 'src'), { recursive: true })
    await mkdir(join(temporary, provider, 'src'), { recursive: true })
    const manifest = { name: '@power-evolve/application', dependencies: { '@power-evolve/contracts': 'workspace:~', zod: '^4.4.3' } }
    await writeFile(join(temporary, app, 'package.json'), JSON.stringify(manifest))
    await writeFile(join(temporary, provider, 'package.json'), JSON.stringify({ name: '@power-evolve/contracts' }))
    await writeFile(join(temporary, app, 'src/index.ts'),
      "import { sharedToken } from '@power-evolve/contracts/test'\nexport const token = sharedToken\n")
    await writeFile(join(temporary, provider, 'src/index.ts'), "export const sharedToken = Symbol('shared')\n")
    const corpus = inventory(temporary), specifier = '@power-evolve/contracts/test'
    const policy = { ...PACKAGE_DEPENDENCY_POLICY, peerRequiredHostExports: {
      ...PACKAGE_DEPENDENCY_POLICY.peerRequiredHostExports, [specifier]: ['sharedToken'],
    } }
    const original = dependencyReport(temporary, corpus)
    assert(original.hostExportClassification.privateExports.some(error => error.includes(specifier + '#sharedToken')))
    const misplaced = dependencyReport(temporary, corpus, policy)
    assert.equal(misplaced.hostExportClassification.privateExports.length, 0)
    assert(misplaced.requiredSingletonErrors.some(error => error.includes('@power-evolve/contracts')))
    delete manifest.dependencies['@power-evolve/contracts']
    manifest.peerDependencies = { '@power-evolve/contracts': 'workspace:~' }
    manifest.devDependencies = { '@power-evolve/contracts': 'workspace:~' }
    await writeFile(join(temporary, app, 'package.json'), JSON.stringify(manifest))
    const shared = dependencyReport(temporary, corpus, policy)
    assert(!shared.requiredSingletonErrors.some(error => error.includes('@power-evolve/contracts')))
    const stale = dependencyReport(temporary, corpus, { ...policy, peerRequiredHostExports: {
      ...policy.peerRequiredHostExports, [specifier]: ['sharedToken', 'unusedValue', '*'],
    } })
    assert(stale.hostExportClassification.policyIntegrityErrors.some(error => error.includes('unusedValue')))
    assert(stale.hostExportClassification.policyIntegrityErrors.some(error => error.includes('unbounded')))
    const unsafe = dependencyReport(temporary, corpus, { ...policy, safeHostDependencyExports: {
      ...policy.safeHostDependencyExports, [specifier]: ['sharedToken'],
    } })
    assert(unsafe.hostExportClassification.policyIntegrityErrors.some(error => error.includes('preserve official safeHostDependencyExports')))
    assert(unsafe.failures.length > 0)
  } finally { await rm(temporary, { recursive: true, force: true }) }
})


test('reviewed cloud SDK peers retain official tokens and reject unreviewed or SAFE additions', () => {
  const policy = createCloudPeerPolicy(PACKAGE_DEPENDENCY_POLICY), corpus = cloudScope(root).corpus
  const packages = readWorkspacePackageManifests(root).all
  const workspaceNames = new Set([...packages.map(pkg => pkg.name), ...corpus.manifests.map(file =>
    JSON.parse(readFileSync(join(root, file), 'utf8')).name)])
  const uses = corpus.runtime.filter(file => file.startsWith('products/power-evolve/application/src/')
    || /^products\/power-evolve\/client-[^/]+\/src\/index\.ts$/u.test(file))
    .flatMap(file => collectRuntimeSourceExportUses(file, readFileSync(join(root, file), 'utf8'))
      .map(use => ({ ...use, sourcePath: file })))
  assert.deepEqual(cloudPeerPolicyErrors(policy, PACKAGE_DEPENDENCY_POLICY, uses, workspaceNames), [])
  assert.deepEqual(policy.safeHostDependencyExports, PACKAGE_DEPENDENCY_POLICY.safeHostDependencyExports)
  assert.deepEqual(policy.duplicateSafePackages, PACKAGE_DEPENDENCY_POLICY.duplicateSafePackages)
  assert(policy.peerRequiredHostExports['@deepseek-ai/dsh-session'].includes('SESSION_FORMAT_VERSION'))
  assert(policy.peerRequiredHostExports['@deepseek-ai/dsh-session'].includes('Session'))
  const missingToken = structuredClone(policy)
  missingToken.peerRequiredHostExports['@deepseek-ai/dsh-session'] =
    missingToken.peerRequiredHostExports['@deepseek-ai/dsh-session'].filter(name => name !== 'SESSION_FORMAT_VERSION')
  assert(cloudPeerPolicyErrors(missingToken, PACKAGE_DEPENDENCY_POLICY, uses, workspaceNames)
    .some(error => error.includes('preserve official peer entries')))
  const unreviewed = structuredClone(policy)
  unreviewed.peerRequiredHostExports['@deepseek-ai/dsh-tools'].push('unreviewedExport')
  assert(cloudPeerPolicyErrors(unreviewed, PACKAGE_DEPENDENCY_POLICY, uses, workspaceNames)
    .some(error => error.includes('preserve reviewed SDK')))
  const unsafe = structuredClone(policy)
  unsafe.safeHostDependencyExports['@deepseek-ai/dsh-tools'] = ['defineTool']
  assert(cloudPeerPolicyErrors(unsafe, PACKAGE_DEPENDENCY_POLICY, uses, workspaceNames)
    .some(error => error.includes('preserve official safeHostDependencyExports')))
})

test('deployment tests remain executed and linted while only actual runtime code requires coverage', async () => {
  const temporary = await mkdtemp(join(tmpdir(), 'pe-discovery-control-'))
  try {
    const deploy = join(temporary, 'products/power-evolve/deploy')
    const sandbox = join(temporary, 'products/power-evolve/sandbox')
    const officeInput = join(temporary, '.github/power-evolve-office')
    await mkdir(deploy, { recursive: true }); await mkdir(join(sandbox, 'tests'), { recursive: true })
    await mkdir(join(sandbox, 'scripts'), { recursive: true })
    await mkdir(join(officeInput, 'office-sdk-0.1.1-input'), { recursive: true })
    await writeFile(join(officeInput, 'reproduce-office-closure.mjs'), 'export const prepared = true')
    await writeFile(join(officeInput, 'office-sdk-0.1.1-input/package.json'), '{}')
    await writeFile(join(officeInput, 'office-sdk-0.1.1-input/package-lock.json'), '{}')
    await writeFile(join(deploy, 'start.mjs'), 'export const run = true')
    await writeFile(join(deploy, 'Dockerfile'), 'FROM scratch')
    await writeFile(join(deploy, 'fixture.test.mjs'), "import {test} from 'node:test'; test('case',()=>{})")
    await writeFile(join(sandbox, 'runner.mjs'), 'export const run = true')
    await writeFile(join(sandbox, 'command-child.py'), 'print(1)')
    await writeFile(join(sandbox, 'Dockerfile.office-preview'), 'FROM scratch')
    await writeFile(join(sandbox, 'scripts/assemble-office-preview.mjs'), 'export const assemble = true')
    await writeFile(join(sandbox, 'tests/runner.test.mjs'), "import {test} from 'node:test'; test('case',()=>{})")
    const corpus = inventory(temporary)
    assert.deepEqual(corpus.runtime, ['.github/power-evolve-office/reproduce-office-closure.mjs',
      'products/power-evolve/deploy/start.mjs', 'products/power-evolve/sandbox/runner.mjs',
      'products/power-evolve/sandbox/scripts/assemble-office-preview.mjs'])
    assert.equal(corpus.sourceTests.length, 2)
    assert.equal(corpus.nodeTests.length, 2)
    for (const file of corpus.nodeTests) assert(corpus.lint.includes(file))
    assert(corpus.lint.includes('products/power-evolve/sandbox/scripts/assemble-office-preview.mjs'))
    assert.deepEqual(corpus.nativeAssets, ['.github/power-evolve-office/office-sdk-0.1.1-input/package-lock.json',
      '.github/power-evolve-office/office-sdk-0.1.1-input/package.json',
      'products/power-evolve/deploy/Dockerfile',
      'products/power-evolve/sandbox/Dockerfile.office-preview',
      'products/power-evolve/sandbox/command-child.py'])
  } finally { await rm(temporary, { recursive: true, force: true }) }
})

test('pure JavaScript coverage child preserves user imports and native capture', () => {
  const collector = new URL('./cloud-capture.mjs', import.meta.url).href
  const tsx = pathToFileURL(createRequire(import.meta.url).resolve('tsx')).href
  const userOptions = '--trace-warnings --max-old-space-size=256 --import=' + tsx
  const environment = { PE_CLOUD_COVERAGE_INPUT: 'owned-frozen-input', NODE_V8_COVERAGE: 'owned-native-raw',
    NODE_OPTIONS: userOptions + ' --import=' + collector + ' --import=' + tsx, OWNED_OTHER: 'retained' }
  const before = { ...environment }, child = nativePureJavaScriptChildEnvironment(environment)
  assert.equal(child.NODE_OPTIONS, userOptions + ' --import=' + collector)
  assert.deepEqual(environment, before)
  assert.deepEqual(child, { ...before, NODE_OPTIONS: userOptions + ' --import=' + collector })
  assert.notEqual(child, environment)
})

test('pure JavaScript coverage child leaves unrelated Node options unchanged', () => {
  const collector = new URL('./cloud-capture.mjs', import.meta.url).href
  const tsx = pathToFileURL(createRequire(import.meta.url).resolve('tsx')).href
  const options = ' --import=' + collector + ' --import=' + tsx
  const coverage = { PE_CLOUD_COVERAGE_INPUT: 'owned-frozen-input', NODE_V8_COVERAGE: 'owned-native-raw' }
  for (const environment of [
    {}, { NODE_OPTIONS: options }, { ...coverage },
    { PE_CLOUD_COVERAGE_INPUT: coverage.PE_CLOUD_COVERAGE_INPUT, NODE_OPTIONS: options },
    { NODE_V8_COVERAGE: coverage.NODE_V8_COVERAGE, NODE_OPTIONS: options },
    { ...coverage, NODE_OPTIONS: ' --import=' + tsx },
    { ...coverage, NODE_OPTIONS: options + ' --trace-warnings' },
    { ...coverage, NODE_OPTIONS: ' --import=' + collector + ' --import "' + tsx + '"' },
  ]) assert.deepEqual(nativePureJavaScriptChildEnvironment(environment), environment)
})

test('source subprocess JSON transfer captures the actual child PID and keeps the parent outside native collection', async () => {
  await withSourceSubprocessFixture(async ({ temporary, prepare, launch }) => {
    const input = prepare('evidence'), run = launch(nativeCoverageEnvironment(input))
    assert.equal(run.error, undefined)
    assert.equal(run.signal, null)
    assert.equal(run.status, 0, run.stderr)
    const pids = JSON.parse(run.stdout)
    assert.notEqual(pids.parentPid, pids.childPid)
    const converted = await convertNativeCoverage(input)
    const summary = converted.map.getCoverageSummary().toJSON()
    for (const field of ['lines', 'statements', 'functions', 'branches']) assert.equal(summary[field].pct, 100)
    assert(converted.facts.conversions.some(row => row.file === 'native.ts' && row.mapped
      && row.raw.startsWith('coverage-' + pids.childPid + '-')))
    const captures = readdirSync(join(temporary, 'evidence/code'))
      .map(name => JSON.parse(readFileSync(join(temporary, 'evidence/code', name), 'utf8')))
    assert(captures.some(row => row.pid === pids.childPid))
    assert(!captures.some(row => row.pid === pids.parentPid))
  })
})

test('source subprocess mismatched capture environment rejects the actual raw evidence', async () => {
  await withSourceSubprocessFixture(async ({ prepare, launch }) => {
    const input = prepare('expected'), other = prepare('other')
    const run = launch({ ...nativeCoverageEnvironment(input), PE_CLOUD_COVERAGE_INPUT: other })
    assert.equal(run.status, 0, run.stderr)
    await assert.rejects(convertNativeCoverage(input), /ENOENT|input binding changed/u)
  })
})

test('source subprocess lib execution earns no coverage for an unexecuted source file', async () => {
  await withSourceSubprocessFixture(async ({ temporary, prepare, launch }) => {
    await writeFile(join(temporary, 'artifact.mjs'), 'export function pick(value) { if (value) return 1; return 0 }\n')
    await writeFile(join(temporary, 'child.mjs'), "import {pick} from './artifact.mjs'\npick(true)\npick(false)\nconsole.log(process.pid)\n")
    const input = prepare('evidence'), run = launch(nativeCoverageEnvironment(input))
    assert.equal(run.status, 0, run.stderr)
    const converted = await convertNativeCoverage(input)
    assert.equal(converted.facts.conversions.length, 0)
    const summary = { total: converted.map.getCoverageSummary().toJSON() }
    assert(coverageErrors(temporary, ['native.ts'], summary, converted.map.toJSON())
      .some(error => error.includes('native.ts')))
  })
})

test('actual native TS execution validates source maps, ranges, frozen inputs and missing test evidence', async () => {
  const temporary = await mkdtemp(join(tmpdir(), 'pe-native-coverage-control-'))
  try {
    const native = join(temporary, 'native.ts'), runner = join(temporary, 'runner.mjs')
    await writeFile(join(temporary, 'package.json'), '{"type":"module"}')
    await writeFile(native, 'export function pick(value: boolean): number { if (value) return 1; return 0 }\n')
    await writeFile(runner, "import { pick } from './native.ts'\npick(true)\n")
    const input = prepareNativeCoverage(temporary, ['native.ts'], ['runner.mjs'], join(temporary, 'evidence'))
    const run = spawnSync(process.execPath, [runner], { encoding: 'utf8',
      env: { ...isolatedEnvironment(), ...nativeCoverageEnvironment(input) }, timeout: 30_000 })
    assert.equal(run.error, undefined); assert.equal(run.signal, null); assert.equal(run.status, 0, run.stderr)
    const partial = await convertNativeCoverage(input)
    const metrics = partial.map.getCoverageSummary().toJSON()
    assert(metrics.branches.pct < 100)
    assert(partial.facts.conversions.some(item => item.file === 'native.ts' && item.mapped))
    const originalInput = readFileSync(input, 'utf8'), parsed = JSON.parse(originalInput)
    await writeFile(input, JSON.stringify({ ...parsed, tests: [...parsed.tests, 'absent.mjs'] }))
    await assert.rejects(convertNativeCoverage(input), /capture input binding changed/u)
    await writeFile(input, originalInput)
    await writeFile(join(temporary, 'absent.mjs'), 'export const required = true\n')
    const missing = prepareNativeCoverage(temporary, ['native.ts'], ['runner.mjs', 'absent.mjs'], join(temporary, 'missing'))
    const missingRun = spawnSync(process.execPath, [runner], { encoding: 'utf8',
      env: { ...isolatedEnvironment(), ...nativeCoverageEnvironment(missing) }, timeout: 30_000 })
    assert.equal(missingRun.status, 0, missingRun.stderr)
    await assert.rejects(convertNativeCoverage(missing), /absent from V8/u)
    await writeFile(native, readFileSync(native, 'utf8') + '\n// changed after execution\n')
    await assert.rejects(convertNativeCoverage(input), /input changed/u)
    await writeFile(native, 'export function pick(value: boolean): number { if (value) return 1; return 0 }\n')
    const code = readdirSync(join(temporary, 'evidence/code')).map(name => join(temporary, 'evidence/code', name))
      .find(path => Object.values(JSON.parse(readFileSync(path, 'utf8')).scripts).some(script => script.url.endsWith('native.ts')))
    const originalCode = readFileSync(code, 'utf8'), captured = JSON.parse(originalCode)
    const script = Object.values(captured.scripts).find(item => item.url.endsWith('native.ts'))
    const originalMapURL = script.sourceMapURL
    const map = JSON.parse(Buffer.from(originalMapURL.split(',')[1], 'base64').toString('utf8'))
    map.sourcesContent[0] += '\n// stale map\n'
    script.sourceMapURL = 'data:application/json;base64,' + Buffer.from(JSON.stringify(map)).toString('base64')
    await writeFile(code, JSON.stringify(captured))
    await assert.rejects(convertNativeCoverage(input), /source map does not match|source map evidence differs/u)
    script.code = script.code.replace(originalMapURL, script.sourceMapURL)
    script.hash = sourceHash(script.code)
    await writeFile(code, JSON.stringify(captured))
    await assert.rejects(convertNativeCoverage(input), /source map does not match frozen input/u)
    await writeFile(code, originalCode)
    const raw = readdirSync(join(temporary, 'evidence/raw')).map(name => join(temporary, 'evidence/raw', name))
      .find(path => JSON.parse(readFileSync(path, 'utf8')).result.some(script => script.url.endsWith('native.ts')))
    const originalRaw = readFileSync(raw, 'utf8'), broken = JSON.parse(originalRaw)
    broken.result.find(script => script.url.endsWith('native.ts')).functions[0].ranges[0].endOffset = 999999
    await writeFile(raw, JSON.stringify(broken))
    await assert.rejects(convertNativeCoverage(input), /range outside captured source/u)
    await writeFile(raw, originalRaw)
    await rm(code)
    await assert.rejects(convertNativeCoverage(input), /ENOENT/u)
  } finally { await rm(temporary, { recursive: true, force: true }) }
})

test('actual copied MJS roots and transported evidence merge only with byte and input bindings intact', async () => {
  const temporary = realpathSync(await mkdtemp(join(tmpdir(), 'pe-mapped-coverage-control-')))
  try {
    const source = 'export function pick(value) { if (value) return 1; return 0 }\n'
    await writeFile(join(temporary, 'runtime.mjs'), source)
    await writeFile(join(temporary, 'runner.mjs'), "import {pick} from './runtime.mjs'; pick(false)\n")
    const input = prepareNativeCoverage(temporary, ['runtime.mjs'], ['runner.mjs'], join(temporary, 'evidence'))
    const parent = spawnSync(process.execPath, [join(temporary, 'runner.mjs')], { encoding: 'utf8',
      env: { ...isolatedEnvironment(), ...nativeCoverageEnvironment(input) }, timeout: 30_000 })
    assert.equal(parent.status, 0, parent.stderr)
    const executionRoot = join(temporary, 'actual-copy'), executionDirectory = join(temporary, 'remote-evidence')
    await mkdir(executionRoot); await mkdir(join(executionDirectory, 'raw'), { recursive: true })
    await mkdir(join(executionDirectory, 'code')); await writeFile(join(executionRoot, 'runtime.mjs'), source)
    const context = prepareNativeCoverageContext(input, { executionRoot, executionDirectory,
      collector: new URL('./cloud-capture.mjs', import.meta.url).href })
    const contextText = readFileSync(context.inputPath, 'utf8')
    await writeFile(join(executionDirectory, 'inputs.json'), contextText)
    const child = spawnSync(process.execPath, ['--input-type=module', '--eval',
      `import {pick} from ${JSON.stringify(pathToFileURL(join(executionRoot, 'runtime.mjs')).href)}; pick(true)`],
    { encoding: 'utf8', env: { ...isolatedEnvironment(), ...context.environment }, timeout: 30_000 })
    assert.equal(child.status, 0, child.stderr)
    for (const folder of ['raw', 'code']) {
      for (const file of readdirSync(join(executionDirectory, folder))) {
        await writeFile(join(context.directory, folder, file), readFileSync(join(executionDirectory, folder, file)))
      }
    }
    const result = await convertNativeCoverage(input), metrics = result.map.getCoverageSummary().toJSON()
    for (const metric of ['lines', 'statements', 'functions', 'branches']) assert.equal(metrics[metric].pct, 100)
    assert(result.facts.conversions.some(row => row.actualUrl === pathToFileURL(join(executionRoot, 'runtime.mjs')).href
      && row.executionRoot === executionRoot))
    const altered = JSON.parse(contextText); altered.executionRoot = temporary
    await writeFile(context.inputPath, JSON.stringify(altered))
    await assert.rejects(convertNativeCoverage(input), /capture input binding changed/u)
    await writeFile(context.inputPath, contextText)
    const capture = readdirSync(join(context.directory, 'code'))[0], capturePath = join(context.directory, 'code', capture)
    const value = JSON.parse(readFileSync(capturePath, 'utf8'))
    for (const script of Object.values(value.scripts)) script.originalHash = 'wrong-byte-copy'
    await writeFile(capturePath, JSON.stringify(value))
    await assert.rejects(convertNativeCoverage(input), /evidence missing or mismatched/u)
  } finally { await rm(temporary, { recursive: true, force: true }) }
})

test('named scope native collection binds actual execution manifest bytes and rejects changes before conversion', async () => {
  const temporary = realpathSync(await mkdtemp(join(tmpdir(), 'pe-native-scope-control-')))
  try {
    const manifest = '{"name":"mcp-pdf","status":"current"}\n'
    await writeFile(join(temporary, 'scope.json'), manifest)
    await writeFile(join(temporary, 'runtime.mjs'), 'export const value = 1\n')
    await writeFile(join(temporary, 'runner.mjs'), "import {value} from './runtime.mjs'; if(value !== 1) throw new Error('actual behavior')\n")
    const scope = { selection: 'current', manifest: 'scope.json' }
    const input = prepareNativeCoverage(temporary, ['runtime.mjs'], ['runner.mjs'], join(temporary, 'evidence'), scope)
    const run = spawnSync(process.execPath, [join(temporary, 'runner.mjs')], { encoding: 'utf8',
      env: { ...isolatedEnvironment(), ...nativeCoverageEnvironment(input) }, timeout: 30_000 })
    assert.equal(run.status, 0, run.stderr)
    const result = await convertNativeCoverage(input)
    assert.deepEqual(result.facts.scope, { ...scope, hash: sourceHash(manifest) })
    await writeFile(join(temporary, 'scope.json'), manifest + '\n')
    await assert.rejects(convertNativeCoverage(input), /named scope manifest changed during execution/u)
    const changed = spawnSync(process.execPath, [join(temporary, 'runner.mjs')], { encoding: 'utf8',
      env: { ...isolatedEnvironment(), ...nativeCoverageEnvironment(input) }, timeout: 30_000 })
    assert.equal(changed.status, 1); assert.match(changed.stderr, /named scope manifest changed before collection/u)
    await writeFile(join(temporary, 'scope.json'), manifest)
    const executionRoot = join(temporary, 'actual-copy')
    await mkdir(executionRoot)
    const dockerArguments = nativeDockerCoverageArguments(input, { executionRoot })
    assert(dockerArguments.includes('type=bind,source=' + join(temporary, 'scope.json')
      + ',target=' + join(executionRoot, 'scope.json') + ',readonly'))
    for (const file of ['runtime.mjs', 'runner.mjs']) await writeFile(join(executionRoot, file), readFileSync(join(temporary, file)))
    await writeFile(join(executionRoot, 'scope.json'), manifest + '\n')
    const context = prepareNativeCoverageContext(input, { executionRoot,
      collector: new URL('./cloud-capture.mjs', import.meta.url).href })
    const copied = spawnSync(process.execPath, [join(executionRoot, 'runner.mjs')], { encoding: 'utf8',
      env: { ...isolatedEnvironment(), ...context.environment }, timeout: 30_000 })
    assert.equal(copied.status, 1); assert.match(copied.stderr, /named scope manifest changed before collection/u)
  } finally { await rm(temporary, { recursive: true, force: true }) }
})

test('real Vitest enforces 100% after native TS merge and preserves uncovered branches and behavior failures', async () => {
  const temporary = realpathSync(await mkdtemp(join(tmpdir(), 'pe-unified-provider-control-')))
  try {
    await symlink(join(root, 'node_modules'), join(temporary, 'node_modules'), 'junction')
    await writeFile(join(temporary, 'package.json'), '{"type":"module"}')
    await writeFile(join(temporary, 'native.ts'), 'export function pick(value: boolean): number { if (value) return 1; return 0 }\n')
    await writeFile(join(temporary, 'runner.mjs'), "import {test} from 'node:test'; import assert from 'node:assert/strict'; import { pick } from './native.ts'; test('native branch',()=>assert.equal(pick(true),1))\n")
    const input = prepareNativeCoverage(temporary, ['native.ts'], ['runner.mjs'], join(temporary, 'native'))
    const node = spawnSync(process.execPath, ['--test', '--test-reporter=tap', join(temporary, 'runner.mjs')], { encoding: 'utf8',
      env: { ...isolatedEnvironment(), ...nativeCoverageEnvironment(input) }, timeout: 30_000 })
    assert.equal(node.error, undefined); assert.equal(node.signal, null); assert.equal(node.status, 0, node.stderr)
    const config = join(temporary, 'vitest.config.mjs'), results = join(temporary, 'tests.json')
    const provider = fileURLToPath(new URL('./cloud-provider.mjs', import.meta.url))
    await writeFile(config, 'export default ' + JSON.stringify({ root: temporary, test: {
      include: ['case.spec.ts'], pool: 'forks', maxWorkers: 1, passWithNoTests: false,
      coverage: { enabled: true, reportOnFailure: true, provider: 'custom', customProviderModule: provider,
        reportsDirectory: join(temporary, 'coverage'), reporter: ['json', 'json-summary'], include: ['native.ts'],
        thresholds: { perFile: true, lines: 100, statements: 100, functions: 100, branches: 100 } },
    } }))
    const run = () => spawnPnpm(['exec', 'vitest', 'run', '--config', config, '--reporter=json', '--outputFile=' + results],
      { cwd: root, env: { ...isolatedEnvironment(), PE_CLOUD_COVERAGE_INPUT: input }, encoding: 'utf8', timeout: 30_000 })
    await writeFile(join(temporary, 'case.spec.ts'), "import {test,expect} from 'vitest'; import {pick} from './native.ts'; test('other branch',()=>expect(pick(false)).toBe(0))")
    const complete = run()
    assert.equal(complete.error, undefined); assert.equal(complete.signal, null)
    assert.equal(complete.status, 0, complete.stdout + complete.stderr)
    assert.equal(JSON.parse(readFileSync(results, 'utf8')).numFailedTests, 0)
    const summary = JSON.parse(readFileSync(join(temporary, 'coverage/coverage-summary.json'), 'utf8'))
    const final = JSON.parse(readFileSync(join(temporary, 'coverage/coverage-final.json'), 'utf8'))
    assert.deepEqual(coverageErrors(temporary, ['native.ts'], summary, final), [])
    await writeFile(join(temporary, 'case.spec.ts'), "import {test,expect} from 'vitest'; import {pick} from './native.ts'; test('same branch',()=>expect(pick(true)).toBe(1))")
    const uncovered = run()
    assert.equal(uncovered.error, undefined); assert.equal(uncovered.signal, null)
    assert.equal(uncovered.status, 1, uncovered.stdout + uncovered.stderr)
    assert.equal(JSON.parse(readFileSync(results, 'utf8')).numFailedTests, 0)
    assert.match(uncovered.stdout + uncovered.stderr, /branches.*100%|branches.*threshold/iu)
    await writeFile(join(temporary, 'case.spec.ts'), "import {test,expect} from 'vitest'; import {pick} from './native.ts'; test('real failure',()=>expect(pick(false)).toBe(999))")
    const failed = run()
    assert.equal(failed.error, undefined); assert.equal(failed.signal, null); assert.equal(failed.status, 1)
    assert.equal(JSON.parse(readFileSync(results, 'utf8')).numFailedTests, 1)
  } finally { await rm(temporary, { recursive: true, force: true }) }
})

test('current database.ts keeps executed transaction and unexecuted initializeDatabase through real tsx maps', async () => {
  const temporary = await mkdtemp(join(tmpdir(), 'pe-database-map-control-'))
  const probe = 'products/power-evolve/scripts/cloud-database-proof-' + randomUUID() + '.mjs'
  const database = 'products/power-evolve/application/src/platform/database.ts'
  try {
    // Pool/client are explicit substitutes; this verifies executed source mapping, not PostgreSQL behavior.
    await writeFile(join(root, probe), "import {EventEmitter} from 'node:events'; import {transaction} from "
      + JSON.stringify(pathToFileURL(join(root, database)).href) + ';\n'
      + 'const client=new EventEmitter();client.query=async()=>({rows:[]});client.release=()=>{};\n'
      + 'if(await transaction({connect:async()=>client},async()=>42)!==42)throw new Error("transaction result");\n')
    const input = prepareNativeCoverage(root, [database], [probe], temporary)
    const child = spawnSync(process.execPath, [join(root, probe)], { encoding: 'utf8',
      env: { ...isolatedEnvironment(), ...nativeCoverageEnvironment(input) }, timeout: 30_000 })
    assert.equal(child.error, undefined); assert.equal(child.signal, null); assert.equal(child.status, 0, child.stderr)
    const native = await convertNativeCoverage(input)
    assert(native.facts.conversions.some(item => item.file === database && item.mapped))
    const coverage = native.map.fileCoverageFor(join(root, database)).toJSON()
    const functions = Object.entries(coverage.fnMap)
    assert(functions.some(([id, fn]) => fn.name === 'transaction' && coverage.f[id] > 0))
    assert(functions.some(([id, fn]) => fn.name === 'initializeDatabase' && coverage.f[id] === 0))
    assert(native.map.getCoverageSummary().toJSON().functions.pct < 100)
  } finally {
    await rm(join(root, probe), { force: true })
    await rm(temporary, { recursive: true, force: true })
  }
})

test('actual native TAP rejects failing, skipped and empty runners without discarding their exit status', async () => {
  const temporary = await mkdtemp(join(tmpdir(), 'pe-tap-control-'))
  try {
    const cases = [
      ["import {test} from 'node:test'; test('pass',()=>{})", true, 0],
      ["import {test} from 'node:test'; test('fail',()=>{throw new Error('real failure')})", false, 1],
      ["import {test} from 'node:test'; test('skip',{skip:true},()=>{})", false, 0],
      ["import {test} from 'node:test'; test('pending',{todo:true},()=>{})", false, 0],
      ['', false, 0],
    ]
    for (const [source, expected, status] of cases) {
      const file = join(temporary, 'fixture.test.mjs')
      await writeFile(file, source)
      const evidence = join(temporary, 'events.jsonl')
      const reporter = fileURLToPath(new URL('./cloud-reporter.mjs', import.meta.url))
      const child = spawnSync(process.execPath, ['--test', '--test-reporter=tap', '--test-reporter=' + reporter,
        '--test-reporter-destination=stdout', '--test-reporter-destination=' + evidence, file],
      { encoding: 'utf8', env: isolatedEnvironment(), timeout: 30_000 })
      assert.equal(child.error, undefined); assert.equal(child.signal, null); assert.equal(child.status, status)
      const events = readFileSync(evidence, 'utf8').trim().split('\n').filter(Boolean).map(line => JSON.parse(line))
      assert.equal(tapReport('native fixture', child, [file], events).failures.length === 0, expected)
    }
  } finally { await rm(temporary, { recursive: true, force: true }) }
})

test('README metadata admits quoted YAML kinds and rejects missing, nonstring and duplicate kinds', () => {
  for (const value of ['package-reference', '"package-reference"', "'package-reference'"]) {
    assert.deepEqual(readmeMetadataErrors('README.md', '---\nkind: ' + value + '\n---\n# Example\n'), [])
  }
  for (const metadata of ['title: Example', 'kind: 123', 'kind: [package-reference]', 'kind: package-reference\nkind: other']) {
    assert(readmeMetadataErrors('README.md', '---\n' + metadata + '\n---\n# Example\n').length > 0)
  }
})

test('coverage ignores reject as source comments while ordinary strings remain admitted', () => {
  for (const comment of ['/* v8 ignore next */', '// c8 ignore next', '/* istanbul ignore file */', '/* node:coverage disable */']) {
    assert(coverageDirectiveErrors('runtime.mjs', comment + '\nexport const value = 1').length > 0)
  }
  assert.deepEqual(coverageDirectiveErrors('runtime.mjs', 'export const label = "v8 ignore next"'), [])
})

async function withStaticInitializerFixture(calls, run) {
  const temporary = realpathSync(await mkdtemp(join(tmpdir(), 'pe-static-initializer-control-')))
  try {
    await writeFile(join(temporary, 'package.json'), '{"type":"module"}')
    const source = [
      'let staticRuns = 0',
      'let neverRuns = 0',
      'let calledRuns = 0',
      'export let object: { never(): number; called(): number }',
      '',
      'export class StaticMethodProbe {',
      '  constructor(readonly value: number) {}',
      '  static {',
      '    staticRuns++',
      '    object = {',
      '      never() {',
      '        neverRuns++',
      '        return 7',
      '      },',
      '      called() {',
      '        calledRuns++',
      '        return calledRuns',
      '      },',
      '    }',
      '  }',
      '}',
      '',
      'export function readState() {',
      '  return { staticRuns, neverRuns, calledRuns }',
      '}',
      '',
    ].join('\n')
    await writeFile(join(temporary, 'initializer.ts'), source)
    await writeFile(join(temporary, 'runner.mjs'),
      "import assert from 'node:assert/strict'\nimport {object, readState} from './initializer.ts'\n"
      + `const returns=[];for(let index=0;index<${calls};index++)returns.push(object.called())\n`
      + `assert.deepEqual(returns,${JSON.stringify(calls === 0 ? [] : [1, 2, 3])})\n`
      + `const state=readState();assert.deepEqual(state,{staticRuns:1,neverRuns:0,calledRuns:${calls}})\n`
      + 'console.log(JSON.stringify({pid:process.pid,state,returns}))\n')
    const input = prepareNativeCoverage(temporary, ['initializer.ts'], ['runner.mjs'], join(temporary, 'evidence'))
    const child = spawnSync(process.execPath, [join(temporary, 'runner.mjs')], {
      cwd: temporary, encoding: 'utf8', timeout: 30_000,
      env: { ...isolatedEnvironment(), ...nativeCoverageEnvironment(input) },
    })
    assert.equal(child.error, undefined); assert.equal(child.signal, null); assert.equal(child.status, 0, child.stderr)
    const actual = JSON.parse(child.stdout)
    const native = await convertNativeCoverage(input)
    const facts = native.facts.conversions.filter(row => row.file === 'initializer.ts')
    assert.equal(facts.length, 1)
    const fact = facts[0]
    assert.equal(fact.mapped, true)
    assert(fact.raw.startsWith('coverage-' + actual.pid + '-'))
    const evidence = join(temporary, 'evidence')
    const raw = JSON.parse(readFileSync(join(evidence, 'raw', fact.raw), 'utf8'))
    const script = raw.result.find(row => row.scriptId === fact.scriptId && row.url === fact.actualUrl)
    assert(script)
    const match = /^coverage-(\d+)-\d+-(\d+)\.json$/u.exec(fact.raw)
    assert(match)
    const capture = JSON.parse(readFileSync(join(evidence, 'code', match[1] + '-' + match[2] + '.json'), 'utf8'))
    const executed = capture.scripts[fact.scriptId]
    assert.equal(executed.url, script.url)
    const { parseAstAsync } = await import('vite')
    const ast = await parseAstAsync(executed.code)
    const klass = ast.body.find(node => node.type === 'ClassDeclaration' && node.id?.name === 'StaticMethodProbe')
    assert(klass, 'The control requires the validated ClassDeclaration layout')
    assert(!klass.body.body.some(node => node.static && node.type === 'PropertyDefinition'))
    const owners = script.functions.filter(fn => fn.ranges[0]?.startOffset === klass.body.start
      && fn.ranges[0]?.endOffset === klass.body.end)
    assert.deepEqual(owners.filter(fn => fn.functionName === '<static_initializer>').map(fn => fn.ranges[0].count), [1])
    assert.deepEqual(owners.filter(fn => fn.functionName === '<instance_members_initializer>').map(fn => fn.ranges[0].count), [0])
    const block = klass.body.body.find(node => node.type === 'StaticBlock'
      && node.body.some(statement => statement.type === 'ExpressionStatement' && statement.expression.type === 'AssignmentExpression'))
    assert(block)
    const assignment = block.body.find(node => node.type === 'ExpressionStatement' && node.expression.type === 'AssignmentExpression')
    const methods = assignment.expression.right.properties
    assert.deepEqual(methods.map(node => [node.key.name, node.type, node.method, node.value.type]),
      [['never', 'Property', true, 'FunctionExpression'], ['called', 'Property', true, 'FunctionExpression']])
    const coverage = native.map.fileCoverageFor(join(temporary, 'initializer.ts')).toJSON()
    await run({ coverage, actual, script, methods, owners, classBody: { start: klass.body.start, end: klass.body.end } })
  } finally { await rm(temporary, { recursive: true, force: true }) }
}

function staticInitializerStatementCounts(coverage, line) {
  return Object.entries(coverage.statementMap).filter(([, loc]) => loc.start.line === line)
    .map(([id]) => coverage.s[id])
}

function staticInitializerFunctionCount(coverage, name) {
  const functions = Object.entries(coverage.fnMap).filter(([, loc]) => loc.name === name)
  assert.equal(functions.length, 1)
  return coverage.f[functions[0][0]]
}

test('actual native static execution retains one while the matching instance initializer and constructor stay uncalled', async (t) => {
  await withStaticInitializerFixture(0, async ({ coverage, actual, script, owners, classBody }) => {
    t.diagnostic(JSON.stringify({ actual, classBody, initializerOwners: owners }))
    for (const line of [6, 9, 10]) assert.deepEqual(staticInitializerStatementCounts(coverage, line), [1])
    assert.equal(staticInitializerFunctionCount(coverage, 'constructor'), 0)
    assert.deepEqual(staticInitializerStatementCounts(coverage, 7), [0])
    for (const name of ['never', 'called']) {
      assert.equal(staticInitializerFunctionCount(coverage, name), 0)
      assert(script.functions.filter(fn => fn.functionName === name).every(fn => fn.ranges[0].count === 0))
    }
    for (const line of [12, 13, 16, 17]) assert.deepEqual(staticInitializerStatementCounts(coverage, line), [0])
  })
})

test('actual native object methods in a static block retain zero and three calls from their own function ranges', async (t) => {
  await withStaticInitializerFixture(3, async ({ coverage, actual, script, methods, owners, classBody }) => {
    const called = script.functions.filter(fn => fn.functionName === 'called')
    assert.equal(called.length, 1)
    assert.equal(called[0].ranges[0].count, 3)
    const method = methods.find(node => node.key.name === 'called')
    assert(called[0].ranges[0].startOffset <= method.value.start && called[0].ranges[0].endOffset >= method.value.end)
    t.diagnostic(JSON.stringify({ actual, classBody, initializerOwners: owners, calledFunction: called[0] }))
    assert.equal(staticInitializerFunctionCount(coverage, 'never'), 0)
    assert(script.functions.filter(fn => fn.functionName === 'never').every(fn => fn.ranges[0].count === 0))
    assert.equal(staticInitializerFunctionCount(coverage, 'called'), 3)
    for (const line of [12, 13]) assert.deepEqual(staticInitializerStatementCounts(coverage, line), [0])
    for (const line of [16, 17]) assert.deepEqual(staticInitializerStatementCounts(coverage, line), [3])
    for (const line of [6, 9, 10]) assert.deepEqual(staticInitializerStatementCounts(coverage, line), [1])
    assert.equal(staticInitializerFunctionCount(coverage, 'constructor'), 0)
    assert.deepEqual(staticInitializerStatementCounts(coverage, 7), [0])
  })
})

async function withCompilerPrefixFixture(comment, run) {
  const temporary = realpathSync(await mkdtemp(join(tmpdir(), 'pe-compiler-prefix-control-')))
  try {
    await writeFile(join(temporary, 'package.json'), '{"type":"module"}')
    const source = (comment ? '/** Public declaration documentation; no executable source node here. */\n' : '') + [
      'export let constructorRuns=0, staticRuns=0, privateRuns=0, neverRuns=0, calledRuns=0',
      'export class VisibleProbe {',
      '  static marker=(()=>{ staticRuns++; return 11 })()',
      '  constructor() { constructorRuns++ }',
      '  #unused() { privateRuns++; return 99 }',
      '  invokePrivate() { return this.#unused() }',
      '  never(value:boolean) { neverRuns++; if(value) return 7; return 8 }',
      '  called() { calledRuns++; return calledRuns }',
      '}',
      'export function choose(value:boolean) {',
      '  if(value) return 7',
      '  return 9',
      '}',
      'export function readState() { return {constructorRuns,staticRuns,privateRuns,neverRuns,calledRuns} }',
      '',
    ].join('\n')
    const sourcePath = join(temporary, 'prefix.ts'), compiledPath = join(temporary, 'compiled.cjs')
    await writeFile(sourcePath, source)
    const compilerRequire = createRequire(createRequire(import.meta.url).resolve('tsx/package.json'))
    const esbuild = compilerRequire('esbuild')
    const compilation = esbuild.transformSync(source, { sourcefile: sourcePath, loader: 'ts', format: 'cjs',
      sourcemap: 'external', target: 'es2020', keepNames: true, minifyWhitespace: true, sourcesContent: true })
    const sourceMap = JSON.parse(compilation.map)
    assert.deepEqual(sourceMap.sources, [sourcePath]); assert.deepEqual(sourceMap.sourcesContent, [source])
    const code = compilation.code + '\n//# sourceMappingURL=data:application/json;base64,'
      + Buffer.from(compilation.map).toString('base64') + '\n'
    await writeFile(compiledPath, code)
    await writeFile(join(temporary, 'runner.mjs'),
      "import assert from 'node:assert/strict'\nimport {readFileSync} from 'node:fs'\n"
      + "import {Script,createContext} from 'node:vm'\n"
      + "const url=new URL('./compiled.cjs',import.meta.url);const code=readFileSync(url,'utf8')\n"
      + 'const module={exports:{}};new Script(code,{filename:new URL("./prefix.ts",import.meta.url).href})'
      + '.runInContext(createContext({module,exports:module.exports}))\n'
      + 'const values=[];for(let index=0;index<3;index++)values.push(new module.exports.VisibleProbe().called())\n'
      + 'assert.deepEqual(values,[1,2,3]);assert.equal(module.exports.VisibleProbe.marker,11)\n'
      + 'assert.equal(module.exports.choose(true),7);assert.equal(module.exports.choose(false),9);'
      + 'assert.equal(module.exports.choose(false),9)\n'
      + 'const state=JSON.parse(JSON.stringify(module.exports.readState()));'
      + 'assert.deepEqual(state,{constructorRuns:3,staticRuns:1,privateRuns:0,neverRuns:0,calledRuns:3})\n'
      + 'console.log(JSON.stringify({pid:process.pid,state,values}))\n')
    const input = prepareNativeCoverage(temporary, ['prefix.ts', 'compiled.cjs'], ['runner.mjs'], join(temporary, 'evidence'))
    const child = spawnSync(process.execPath, [join(temporary, 'runner.mjs')], {
      cwd: temporary, encoding: 'utf8', timeout: 30_000,
      env: { ...isolatedEnvironment(), ...nativeCoverageEnvironment(input) },
    })
    assert.equal(child.error, undefined); assert.equal(child.signal, null); assert.equal(child.status, 0, child.stderr)
    const actual = JSON.parse(child.stdout), native = await convertNativeCoverage(input)
    const facts = native.facts.conversions.filter(row => row.file === 'prefix.ts')
    assert.equal(facts.length, 1)
    const fact = facts[0]
    assert.equal(fact.mapped, true); assert(fact.raw.startsWith('coverage-' + actual.pid + '-'))
    const raw = JSON.parse(readFileSync(join(temporary, 'evidence', 'raw', fact.raw), 'utf8'))
    const script = raw.result.find(row => row.scriptId === fact.scriptId && row.url === fact.actualUrl)
    assert(script)
    const match = /^coverage-(\d+)-\d+-(\d+)\.json$/u.exec(fact.raw)
    assert(match)
    const capture = JSON.parse(readFileSync(join(temporary, 'evidence', 'code', match[1] + '-' + match[2] + '.json'), 'utf8'))
    const executed = capture.scripts[fact.scriptId]
    assert.equal(executed.code, code); assert.equal(executed.hash, sourceHash(code))
    assert.equal(executed.originalHash, sourceHash(source)); assert.equal(executed.url, script.url)
    const { parseAstAsync } = await import('vite'), ast = await parseAstAsync(code)
    const providerRequire = createRequire(createRequire(import.meta.url).resolve('@vitest/coverage-v8/package.json'))
    const converterRequire = createRequire(providerRequire.resolve('ast-v8-to-istanbul'))
    const { TraceMap, decodedMappings, originalPositionFor, LEAST_UPPER_BOUND } = converterRequire('@jridgewell/trace-mapping')
    const trace = new TraceMap(sourceMap), nodes = []
    const walk = (node) => {
      if (!node || typeof node !== 'object') return
      if (typeof node.type === 'string') nodes.push(node)
      for (const value of Object.values(node)) {
        if (Array.isArray(value)) value.forEach(walk)
        else if (value && typeof value === 'object') walk(value)
      }
    }
    walk(ast)
    const firstMapped = decodedMappings(trace)[0].find(segment => segment.length >= 4)
    assert(firstMapped)
    const roots = nodes.filter(node => ['FunctionDeclaration', 'FunctionExpression', 'ArrowFunctionExpression'].includes(node.type))
      .flatMap((node) => {
        const fn = script.functions.find(row => row.ranges[0]?.startOffset === node.start && row.ranges[0]?.endOffset === node.end)
        if (!fn) return []
        const prefix = code.slice(0, node.start).split('\n'), point = { line: prefix.length, column: prefix.at(-1).length }
        return [{ node, fn, point, glb: originalPositionFor(trace, point),
          lub: originalPositionFor(trace, { ...point, bias: LEAST_UPPER_BOUND }) }]
      })
    const glb = roots.filter(row => row.glb.line === 1 && row.glb.column === 0)
    const lub = roots.filter(row => row.glb.source === null && row.lub.line === 1 && row.lub.column === 0)
    assert(glb.length > 0 && lub.length > 0)
    assert(glb.every(row => row.node.type === 'ArrowFunctionExpression' && row.point.line === 1 && row.point.column >= firstMapped[0]))
    assert(lub.every(row => row.point.line === 1 && row.point.column < firstMapped[0]))
    const helper = script.functions.find(fn => fn.functionName === '__privateMethod')
    assert(helper); assert.equal(helper.ranges[0].count, 0)
    const choose = nodes.find(node => node.type === 'FunctionDeclaration' && node.id?.name === 'choose')
    assert(choose)
    const chooseNative = script.functions.find(fn => fn.ranges[0]?.startOffset === choose.start && fn.ranges[0]?.endOffset === choose.end)
    assert(chooseNative); assert.equal(chooseNative.ranges[0].count, 3)
    for (const [name, count] of [['constructor', 3], ['never', 0], ['called', 3]]) {
      const method = nodes.find(node => node.type === 'MethodDefinition' && node.key?.name === name)
      assert(method)
      const fn = script.functions.find(row => row.ranges[0]?.startOffset === method.start && row.ranges[0]?.endOffset === method.end)
      assert(fn); assert.equal(fn.ranges[0].count, count)
    }
    const coverage = native.map.fileCoverageFor(sourcePath).toJSON()
    await run({ comment, source, coverage, actual, glbCount: glb.reduce((sum, row) => sum + row.fn.ranges[0].count, 0),
      lubCount: lub.reduce((sum, row) => sum + row.fn.ranges[0].count, 0), firstMappedColumn: firstMapped[0],
      helperCount: helper.ranges[0].count, compilerVersion: esbuild.version, executedHash: executed.hash, scriptId: fact.scriptId })
  } finally { await rm(temporary, { recursive: true, force: true }) }
}

test('actual compiler prefix rejects comment-only LUB projection while retaining GLB exports, real tokens and zero-count code', async (t) => {
  for (const comment of [false, true]) {
    await withCompilerPrefixFixture(comment, async ({ source, coverage, actual, glbCount, lubCount, ...evidence }) => {
      assert.deepEqual(actual.state, { constructorRuns: 3, staticRuns: 1, privateRuns: 0, neverRuns: 0, calledRuns: 3 })
      assert.deepEqual(actual.values, [1, 2, 3]); assert(glbCount > 0 && lubCount > 0)
      for (const [name, count] of [['constructor', 3], ['never', 0], ['called', 3], ['choose', 3]]) {
        assert.equal(staticInitializerFunctionCount(coverage, name), count)
      }
      const line = text => source.split('\n').findIndex(row => row.includes(text)) + 1
      const staticCounts = staticInitializerStatementCounts(coverage, line('static marker='))
      assert(staticCounts.length > 0); assert(staticCounts.every(count => count === 1))
      const branchCounts = start => Object.entries(coverage.branchMap).filter(([, loc]) => loc.loc.start.line === start)
        .map(([id]) => coverage.b[id])
      assert.deepEqual(branchCounts(line('  if(value) return 7')), [[1, 2]])
      assert.deepEqual(branchCounts(line('never(value:boolean)')), [[0, 0]])
      const header = Object.entries(coverage.fnMap).filter(([, loc]) => loc.loc.start.line === 1 && loc.loc.start.column === 0)
      assert.equal(header.length, 1)
      const headerCount = coverage.f[header[0][0]]
      t.diagnostic(JSON.stringify({ ...evidence, actual, glbCount, lubCount, headerCount,
        zeroBranch: [0, 0], chooseBranch: [1, 2] }))
      assert.equal(headerCount, glbCount + (comment ? 0 : lubCount),
        comment ? 'Unmapped compiler helpers must not add calls to source documentation; explicitly mapped GLB exports remain'
          : 'The real source-token fallback must retain both mapped exports and unmapped helper calls')
      if (comment) {
        const commentBranches = Object.values(coverage.branchMap).filter(loc => loc.loc.start.line === 1 && loc.loc.start.column === 0)
        assert.equal(commentBranches.length, 0)
      }
    })
  }
})
