/** Cloud corpus and report admission; missing evidence always rejects. */
import { globSync, readFileSync, realpathSync } from 'node:fs'
import { relative, resolve } from 'node:path'
import ts from 'typescript'

/** Repository-relative product owner. */
export const product = 'products/power-evolve'
/** Runtime code covered by the cloud source lane, independent of test selection. */
export const runtimePatterns = [
  product + '/*/src/**/*.{ts,tsx,js,mjs}',
  product + '/deploy/**/*.{js,mjs}',
  product + '/cloud-web/scripts/**/*.{js,mjs}',
  product + '/application/web/**/*.{js,mjs}',
  product + '/sandbox/*.{js,mjs}',
  product + '/sandbox/scripts/**/*.{js,mjs}',
  '.github/power-evolve-office/**/*.mjs',
]
// Build-stage tools retain static checks and current cold-image qualification.
const buildTooling = [product + '/deploy/cloud-image-build.mjs', product + '/deploy/cloud-image-pack.mjs']
const excluded = ['**/node_modules/**', '**/lib/**', '**/dist/**', '**/assets/**']
const normalize = value => value.replaceAll('\\', '/')

/** Enumerate authored cloud code, tests and documentation without following built output.
 * @param root Absolute checkout root.
 * @returns Sorted independent inventories used by every lane.
 */
export function inventory(root) {
  const find = patterns => globSync(patterns, { cwd: root, exclude: excluded }).map(normalize).sort()
  const tests = [...new Set(find([product + '/**/tests/**/*.{spec,test}.{ts,tsx,js,mjs}',
    product + '/deploy/**/*.{spec,test}.{ts,tsx,js,mjs}',
    '.github/power-evolve-office/**/*.{spec,test}.{ts,tsx,js,mjs}']))].sort()
  const runtime = find(runtimePatterns).filter(file => !file.endsWith('.d.ts') && !tests.includes(file) && !buildTooling.includes(file))
  const sourceTests = tests.filter(file => !file.includes('.built.'))
  const nodeTests = sourceTests.filter((file) => {
    const parsed = ts.createSourceFile(file, readFileSync(resolve(root, file), 'utf8'), ts.ScriptTarget.Latest, true)
    return parsed.statements.some(statement => ts.isImportDeclaration(statement)
      && ts.isStringLiteral(statement.moduleSpecifier) && statement.moduleSpecifier.text === 'node:test')
  })
  const vitestTests = sourceTests.filter(file => !nodeTests.includes(file))
  const builtTests = tests.filter(file => file.includes('.built.'))
  const tooling = find([product + '/scripts/cloud-*.{mjs,d.mts}', '.github/power-evolve-built/**/*.mjs', ...buildTooling])
  const nativeAssets = find([product + '/*/src/**/*.{py,sh}', product + '/sandbox/**/*.{py,sh}',
    product + '/**/Dockerfile*', product + '/sandbox/**/requirements-*',
    '.github/power-evolve-office/**/*.json'])
  const docMetadata = find([product + '/*.i18n.yaml', product + '/*/*.i18n.yaml', product + '/deploy/**/*.i18n.yaml'])
  return { runtime, nativeAssets, docMetadata, sourceTests, vitestTests, nodeTests, builtTests, tooling,
    lint: [...new Set([...runtime, ...tests, ...find(product + '/*/tests/**/*.{ts,tsx,js,mjs}'), ...tooling])].sort(),
    docs: find([product + '/*.md', product + '/*/*.md', product + '/deploy/**/*.md']),
    manifests: find(product + '/*/package.json') }
}

/** Reject a narrowed corpus and missing tests in each shipped code owner.
 * @param actual Current discovery.
 * @param baseline Reviewed discovery before changing the gate.
 * @returns Diagnostics; an empty array is the only admitted result.
 */
export function corpusErrors(actual, baseline) {
  const failures = []
  for (const field of ['runtime', 'sourceTests', 'builtTests']) {
    if (actual[field].length === 0) failures.push(field + ': empty corpus')
    for (const file of baseline[field]) {
      if (!actual[field].includes(file)) failures.push(field + ': baseline file missing: ' + file)
    }
  }
  for (const field of ['nativeAssets', 'docMetadata']) {
    for (const file of baseline[field] ?? []) {
      if (!actual[field].includes(file)) failures.push(field + ': baseline file missing: ' + file)
    }
  }
  for (const owner of ['application', 'contracts', 'connector-runner', 'client-account', 'client-extension-center']) {
    if (!actual.sourceTests.some(file => file.startsWith(product + '/' + owner + '/'))) {
      failures.push(owner + ': no source behavior tests')
    }
  }
  for (const owner of ['application', 'client-account', 'client-extension-center', 'cloud-web']) {
    if (!actual.builtTests.some(file => file.startsWith(product + '/' + owner + '/'))) {
      failures.push(owner + ': no built-artifact tests')
    }
  }
  return failures
}

/** Reject comment directives that could hide uncovered runtime code without a reviewed exception.
 * @param file Runtime display path.
 * @param source Authored source.
 * @returns Located coverage-ignore diagnostics; strings are not treated as directives.
 */
export function coverageDirectiveErrors(file, source) {
  const scanner = ts.createScanner(ts.ScriptTarget.Latest, false, ts.LanguageVariant.Standard, source)
  const errors = []
  for (let token = scanner.scan(); token !== ts.SyntaxKind.EndOfFileToken; token = scanner.scan()) {
    if ((token === ts.SyntaxKind.SingleLineCommentTrivia || token === ts.SyntaxKind.MultiLineCommentTrivia)
      && /\b(?:(?:v8|c8|istanbul)\s+ignore|node:coverage\s+disable)\b/u.test(scanner.getTokenText())) {
      errors.push(file + ':' + (source.slice(0, scanner.getTokenPos()).split('\n').length) + ': unreviewed coverage ignore directive')
    }
  }
  return errors
}

/** Admit native TAP only when a completed runner reports nonempty passing cases without skips or todos.
 * @param label Source or built stage identity.
 * @param result Child stdout, exit status and signal.
 * @param expectedFiles Required native test files.
 * @param events Fresh JSON lines from the native test-stream reporter.
 * @returns Actual case counts and rejecting diagnostics.
 */
export function tapReport(label, result, expectedFiles = [], events = []) {
  const count = key => Number(new RegExp('^# ' + key + ' (\\d+)$', 'mu').exec(result.stdout)?.[1] ?? 0)
  const cases = count('tests'), passedCases = count('pass'), failures = []
  if (result.status !== 0 || result.signal || cases === 0 || passedCases !== cases
    || count('fail') > 0 || count('cancelled') > 0 || count('skipped') > 0 || count('todo') > 0
    || /# (?:SKIP|TODO)/u.test(result.stdout)) {
    failures.push(label + ': failed, interrupted, empty, skipped or pending TAP; exit=' + result.status + ' signal=' + result.signal)
  }
  for (const file of expectedFiles) {
    const summaries = events.filter(event => event.type === 'test:summary' && event.data.file
      && realpathSync(event.data.file) === realpathSync(file))
    if (summaries.length !== 1 || !summaries[0].data.success || summaries[0].data.counts.tests === 0
      || summaries[0].data.counts.failed > 0 || summaries[0].data.counts.skipped > 0
      || summaries[0].data.counts.todo > 0 || summaries[0].data.counts.cancelled > 0) {
      failures.push(label + ': missing, empty or unsuccessful native file summary: ' + file)
    }
  }
  return { cases, passedCases, failures }
}

/** Find exclusive, skipped and pending declarations using Vitest/Node import identities.
 * @param file Display path and parser extension.
 * @param source Complete test source.
 * @returns Located violations, including aliased and computed runner calls.
 */
export function declarationErrors(file, source) {
  const parsed = ts.createSourceFile(file, source, ts.ScriptTarget.Latest, true)
  const names = new Set(['test', 'it', 'describe', 'suite', 'xit', 'xdescribe', 'xtest', 'fit', 'fdescribe'])
  for (const statement of parsed.statements) {
    if (!ts.isImportDeclaration(statement) || !ts.isStringLiteral(statement.moduleSpecifier)
      || !['vitest', 'node:test'].includes(statement.moduleSpecifier.text)) continue
    const clause = statement.importClause
    if (clause?.name) names.add(clause.name.text)
    if (clause?.namedBindings && ts.isNamedImports(clause.namedBindings)) {
      for (const binding of clause.namedBindings.elements) {
        if (names.has(binding.propertyName?.text ?? binding.name.text)) names.add(binding.name.text)
      }
    } else if (clause?.namedBindings) names.add(clause.namedBindings.name.text)
  }
  const chain = (expression) => {
    if (ts.isIdentifier(expression)) return [expression.text]
    if (ts.isCallExpression(expression)) return chain(expression.expression)
    if (ts.isPropertyAccessExpression(expression)) return [...chain(expression.expression), expression.name.text]
    if (ts.isElementAccessExpression(expression) && ts.isStringLiteral(expression.argumentExpression)) {
      return [...chain(expression.expression), expression.argumentExpression.text]
    }
    return []
  }
  const failures = new Set()
  const visit = (node) => {
    if (ts.isVariableDeclaration(node) && ts.isIdentifier(node.name) && node.initializer
      && names.has(chain(node.initializer)[0])) names.add(node.name.text)
    if (ts.isCallExpression(node) || ts.isPropertyAccessExpression(node) || ts.isElementAccessExpression(node)) {
      const parts = chain(ts.isCallExpression(node) ? node.expression : node)
      if (names.has(parts[0]) && (parts.some(part => ['only', 'skip', 'skipIf', 'runIf', 'todo'].includes(part))
        || ['xit', 'xdescribe', 'xtest', 'fit', 'fdescribe'].includes(parts[0])
        || ts.isCallExpression(node) && node.arguments.some(argument => ts.isObjectLiteralExpression(argument)
        && argument.properties.some(property =>
          ts.isPropertyAssignment(property) && ['skip', 'todo', 'only'].includes(property.name.getText(parsed).replaceAll("'", ''))
          && property.initializer.kind !== ts.SyntaxKind.FalseKeyword)))) {
        const line = parsed.getLineAndCharacterOfPosition(node.getStart(parsed)).line + 1
        failures.add(file + ':' + line + ': required cloud tests may not skip, defer or select exclusive cases')
      }
    }
    ts.forEachChild(node, visit)
  }
  visit(parsed)
  return [...failures]
}

/** Verify a fresh Vitest JSON report covers every discovered test file and case.
 * @param root Checkout root for canonical path comparison.
 * @param files Expected source test paths.
 * @param report Parsed runner JSON.
 * @returns Missing, failed, skipped and empty-result diagnostics.
 */
export function testReportErrors(root, files, report) {
  const failures = []
  if (report.success !== true || !(report.numTotalTests > 0)) failures.push('source: unsuccessful or empty test report')
  const results = Array.isArray(report.testResults) ? report.testResults : []
  const present = new Map(results.map(result => [normalize(relative(root, resolve(result.name))), result]))
  for (const file of files) {
    const result = present.get(file)
    if (!result) { failures.push('source: test file missing from report: ' + file); continue }
    if (result.status !== 'passed' || !Array.isArray(result.assertionResults) || result.assertionResults.length === 0) {
      failures.push('source: failed or empty suite: ' + file)
    }
    for (const test of result.assertionResults ?? []) {
      if (test.status !== 'passed') failures.push(file + ': ' + test.fullName + ': ' + test.status)
    }
  }
  for (const file of present.keys()) if (!files.includes(file)) failures.push('source: unexpected test file: ' + file)
  for (const field of ['numPendingTests', 'numTodoTests', 'numFailedTests', 'numFailedTestSuites']) {
    if (report[field] > 0) failures.push('source: ' + field + '=' + report[field])
  }
  return failures
}

/** Require all runtime files and all four official per-file 100% metrics.
 * @param root Checkout root.
 * @param files Complete runtime inventory, independent of executed tests.
 * @param summary Fresh Istanbul summary report.
 * @param final Fresh Istanbul detailed report.
 * @returns Coverage omissions and unmet thresholds.
 */
export function coverageErrors(root, files, summary, final) {
  const failures = []
  const paths = report => new Map(Object.entries(report).filter(([file]) => file !== 'total')
    .map(([file, result]) => [normalize(relative(root, resolve(file))), result]))
  const summaries = paths(summary), details = paths(final)
  if (summaries.size === 0 || details.size === 0) failures.push('coverage: empty file report')
  for (const file of files) {
    const metrics = summaries.get(file), detail = details.get(file)
    if (!metrics || !detail) { failures.push('coverage: missing runtime file: ' + file); continue }
    for (const metric of ['lines', 'statements', 'functions', 'branches']) {
      if (!metrics[metric] || metrics[metric].pct !== 100) {
        failures.push(file + ': ' + metric + ' must be 100%; observed ' + metrics[metric]?.pct)
      }
    }
    const instrumented = [detail.statementMap, detail.fnMap, detail.branchMap]
      .some(map => map && Object.keys(map).length > 0)
    if (!instrumented) {
      // Type-only modules can emit no instrumented runtime code.
      const emitted = ts.transpileModule(readFileSync(resolve(root, file), 'utf8'), { compilerOptions: {
        module: ts.ModuleKind.ESNext, target: ts.ScriptTarget.ESNext,
      }, fileName: file }).outputText
      const parsed = ts.createSourceFile(file, emitted, ts.ScriptTarget.Latest, true)
      const runtime = parsed.statements.some(statement => !ts.isImportDeclaration(statement)
        && !ts.isExportDeclaration(statement))
      if (runtime) failures.push(file + ': executable source has empty instrumentation')
    }
  }
  for (const file of summaries.keys()) if (!files.includes(file)) failures.push('coverage: unexpected file: ' + file)
  return failures
}
