/** Product discovery adapters for official static rules; no source or artifact repair. */
import { spawnSync } from 'node:child_process'
import { isBuiltin, createRequire } from 'node:module'
import { existsSync, readFileSync, writeFileSync } from 'node:fs'
import { dirname, relative, resolve } from 'node:path'
import { pathToFileURL } from 'node:url'
import ts from 'typescript'
import { load as loadYaml } from 'js-yaml'
import { product } from './cloud-policy.mjs'
import { anchorCache, findViolations } from '../../../scripts/verify-md-links.ts'
import { cloudScope } from './cloud-scope.mjs'
import { parseMarkdown, visitMarkdown } from '../../../scripts/markdown.ts'
import { packageReadmeSummaryErrors } from '../../../scripts/verify-package-readme-summaries.ts'
import { translationPairPaths, computeTranslationPairingRecord, parseTranslationPairingRecord,
  translationPairingRecordDiff } from '../../../scripts/translation-pairing-record.ts'
import { translationStructureSignature, translationStructureDiff, languageSwitcherTargets,
  parseTranslationMarkdown, parseTranslationPairingManifest,
  translationPairSourcePredicate } from '../../../scripts/translation-pairing.ts'
import { collectSourcePackageUses, collectRuntimeSourcePackageUses } from '../../../scripts/verify-client-packages.ts'
import { collectPackageDependencyViolations, collectHostDependencyExportPolicyViolations,
  readWorkspacePackageManifests, readPackageDependencyState,
  collectRuntimeSourceExportUses } from '../../../scripts/verify-package-dependencies.ts'
import { PACKAGE_DEPENDENCY_POLICY } from '../../../scripts/package-dependency-policy.ts'
import { createCloudPeerPolicy, cloudPeerPolicyErrors, cloudProtocolManifestErrors } from './cloud-peer-policy.mjs'

/** Run the locked package manager through Node, refusing implicit dependency installation.
 * @param args Package-manager arguments.
 * @param options Child process options.
 * @returns Completed child output, exit code and signal.
 */
export function spawnPnpm(args, options) {
  const manifestPath = createRequire(import.meta.url).resolve('pnpm')
  const manifest = JSON.parse(readFileSync(manifestPath, 'utf8'))
  return spawnSync(process.execPath, [resolve(dirname(manifestPath), manifest.bin.pnpm), ...args], {
    ...options, env: { ...process.env, ...options.env, pnpm_config_verify_deps_before_run: 'error' },
  })
}

/** Run artifact tests without inherited source resolvers; only the declared TS test needs syntax loading.
 * @param root Checkout owning the prepared artifacts and formal runtime configuration.
 * @param file Discovered mandatory artifact test, relative to the checkout.
 * @param testArgs Original Node test and reporter arguments.
 * @param environment Original factory, fixture and process environment.
 * @returns Direct Node invocation with a complete controlled environment and optional TS runtime configuration.
 */
export function builtTestInvocation(root, file, testArgs, environment = process.env) {
  const env = { ...environment }
  for (const name of ['NODE_OPTIONS', 'NODE_PATH', 'TSX_TSCONFIG_PATH', 'PE_CLOUD_COVERAGE_INPUT',
    'PE_CLOUD_SOURCE_SUBPROCESS_ENV', 'npm_config_node_options', 'NPM_CONFIG_NODE_OPTIONS',
    'pnpm_config_node_options', 'PNPM_CONFIG_NODE_OPTIONS']) delete env[name]
  if (file.endsWith('.mjs')) return { command: process.execPath, args: [...testArgs, file], env }
  if (file !== product + '/cloud-web/tests/native-assets.built.spec.ts') {
    throw new Error('Unsupported artifact test syntax: ' + file)
  }
  const runtimeConfig = resolve(root, 'tsconfig.power-evolve.built-runtime.json')
  env.TSX_TSCONFIG_PATH = runtimeConfig
  const loader = pathToFileURL(createRequire(import.meta.url).resolve('tsx/esm')).href
  return { command: process.execPath, args: ['--import', loader, ...testArgs, file], env, runtimeConfig }
}

/** Reuse official JSDoc declaration checks; JS requires a described result in lieu of TS return syntax.
 * @param root Checkout owning the official rule.
 * @param files Exact runtime/tooling files to check.
 * @returns The official collector bound to the explicit product corpus.
 */
export async function jsdocCollector(root, files) {
  const file = resolve(root, 'scripts/verify-export-jsdoc.ts')
  let source = readFileSync(file, 'utf8')
  const discovery = "globSync('packages/*/*/src/**/*.ts', { cwd: scanRoot })"
  if (!source.includes(discovery)) throw new Error('Official JSDoc discovery changed; review the cloud adapter')
  const returnsCheck = 'if (!returnsWaived) checkReturns(where, returnType, returns, w.sf, w.violations)'
  if (!source.includes(returnsCheck)) throw new Error('Official JSDoc return check changed; review the cloud adapter')
  source = source.replace(discovery, JSON.stringify(files))
    .replace("const root = resolve(import.meta.dirname, '..')", 'const root = ' + JSON.stringify(root))
    .replace('{ skipLibCheck: true, noLib: true, types: [] }', '{ skipLibCheck: true, noLib: true, types: [], allowJs: true }')
    .replace('...parsed.options,\n    noEmit:', '...parsed.options,\n    allowJs: true,\n    noEmit:')
    .replace(returnsCheck, 'if (!returnsWaived) {\n'
      + '    if (/\\.[cm]?js$/.test(w.sf.fileName)) {\n'
      + "      if (returns === null || !returns.trim()) w.violations.push(where + ' needs a described @returns in JavaScript.')\n"
      + '    } else checkReturns(where, returnType, returns, w.sf, w.violations)\n'
      + '  }')
  const required = createRequire(file)
  const output = ts.transpileModule(source, { compilerOptions: {
    target: ts.ScriptTarget.ESNext, module: ts.ModuleKind.ESNext,
  } }).outputText.replace(/from (['"])([^'"]+)\1/gu, (whole, quote, specifier) => {
    if (isBuiltin(specifier)) return whole
    const path = specifier.startsWith('.') ? resolve(dirname(file), specifier) : required.resolve(specifier)
    return 'from ' + quote + pathToFileURL(path).href + quote
  })
  return (await import('data:text/javascript;base64,' + Buffer.from(output).toString('base64'))).collectExportJsdocViolations
}

/** Map official general source/test lint overrides onto products and admit JS/MJS syntax rules.
 * @param config Parsed official JSONC configuration.
 * @returns Product-only overrides preserving the applicable upstream rule values.
 */
export function cloudLintConfig(config) {
  const result = structuredClone(config)
  delete result.$schema
  result.ignorePatterns = result.ignorePatterns.filter(pattern => !['**/*.js', '**/*.mjs'].includes(pattern))
  const mapped = []
  for (const override of result.overrides) {
    const relevant = override.files.filter(pattern => pattern.startsWith('packages/*/*/')
      || pattern === 'packages/**/*.{ts,tsx}')
    if (relevant.length === 0) continue
    const files = relevant.map(pattern => pattern.replace('packages/*/*/', product + '/*/')
      .replace('packages/', product + '/'))
    mapped.push({ ...override, files })
    const js = structuredClone(override)
    js.files = files.map(pattern => pattern.replace('{ts,tsx}', '{js,mjs}'))
    if (files.some(pattern => pattern.includes('/src/')) || files.some(pattern => pattern === product + '/**/*.{ts,tsx}')) {
      js.files.push(product + '/deploy/**/*.{js,mjs}', product + '/application/web/**/*.{js,mjs}',
        product + '/cloud-web/scripts/**/*.{js,mjs}', product + '/scripts/cloud-*.mjs', product + '/sandbox/*.{js,mjs}',
        product + '/sandbox/scripts/**/*.{js,mjs}', '.github/power-evolve-office/**/*.mjs',
        '.github/power-evolve-built/**/*.mjs')
    }
    js.rules = Object.fromEntries(Object.entries(js.rules).filter(([name]) => !name.startsWith('typescript/')))
    if (js.plugins) js.plugins = js.plugins.filter(plugin => plugin !== 'typescript')
    mapped.push(js)
  }
  if (mapped.length === 0) throw new Error('Official lint overrides changed; no product rules discovered')
  result.overrides = mapped
  return result
}

const packageName = (specifier) => {
  if (isBuiltin(specifier) || /^[./#]/u.test(specifier) || specifier.includes(':')) return undefined
  return specifier.startsWith('@') ? specifier.split('/').slice(0, 2).join('/') : specifier.split('/')[0]
}
const addUse = (map, name, file) => map.set(name, [...(map.get(name) ?? []), file])

/** Separate source/production import errors from managed section rules and unreviewed Host export classifications.
 * @param root Checkout containing the unchanged official dependency policy.
 * @param corpus Complete product discovery.
 * @param policy Official policy with only reviewed, named private cloud peers added.
 * @returns Structured diagnostics, applicability facts and all rejecting findings.
 */
export function dependencyReport(root, corpus, policy = PACKAGE_DEPENDENCY_POLICY) {
  const upstream = readWorkspacePackageManifests(root).all
  const packages = corpus.manifests.map((manifestPath) => {
    const manifest = JSON.parse(readFileSync(resolve(root, manifestPath), 'utf8'))
    return { manifestPath, dir: dirname(manifestPath), name: manifest.name, manifest }
  })
  const workspaceNames = new Set([...upstream, ...packages].map(pkg => pkg.name))
  const facts = [], importErrors = [], applicability = []
  for (const pkg of packages) {
    const files = corpus.runtime.filter(file => file.startsWith(pkg.dir + '/'))
    const allSourceUses = new Map(), hostRuntimeSourceUses = new Map(), hostRuntimeExportUses = []
    for (const file of files) {
      const source = readFileSync(resolve(root, file), 'utf8')
      for (const specifier of collectSourcePackageUses(file, source)) {
        const name = packageName(specifier)
        if (!name) continue
        addUse(allSourceUses, name, file)
        const sections = ['dependencies', 'devDependencies', 'peerDependencies', 'optionalDependencies']
        if (!sections.some(section => Object.hasOwn(pkg.manifest[section] ?? {}, name))
          && !sections.some(section => Object.hasOwn(pkg.manifest[section] ?? {}, '@types/' + name.replace(/^@/u, '').replace('/', '__')))) {
          importErrors.push(file + ': undeclared package ' + name)
        }
      }
      if (pkg.manifest.dsh?.client && file !== pkg.dir + '/src/index.ts' && !file.startsWith(pkg.dir + '/src/host/')) continue
      for (const specifier of collectRuntimeSourcePackageUses(file, source)) {
        const name = packageName(specifier)
        if (name) {
          addUse(hostRuntimeSourceUses, name, file)
          if (!Object.hasOwn(pkg.manifest.dependencies ?? {}, name) && !Object.hasOwn(pkg.manifest.peerDependencies ?? {}, name)) {
            importErrors.push(file + ': runtime import is not a production dependency: ' + name)
          }
        }
      }
      for (const use of collectRuntimeSourceExportUses(file, source)) {
        const name = packageName(use.specifier)
        if (name) hostRuntimeExportUses.push({ ...use, packageName: name, sourcePath: file })
      }
    }
    if (files.length === 0 || !pkg.manifest.dsh?.client && !files.some(file => file.includes('/src/'))) continue
    // The official managed policy is for Client faces/configured Cordis Hosts, not ordinary wire/SDK libraries.
    const managed = pkg.manifest.dsh?.client || pkg.name === '@power-evolve/application'
      || hostRuntimeSourceUses.has('@deepseek-ai/cordis')
    if (!managed) {
      applicability.push({ package: pkg.name, role: 'ordinary-library',
        checks: 'all source imports and production declarations; Cordis plugin peer rules do not apply' })
      continue
    }
    const peerRequiredHostDependencies = new Set(hostRuntimeExportUses
      .filter(use => policy.peerRequiredHostExports[use.specifier]?.includes(use.exportName))
      .map(use => use.packageName))
    facts.push({ manifestPath: pkg.manifestPath, manifest: pkg.manifest, workspaceNames, allSourceUses,
      hostRuntimeSourceUses, hostRuntimeExportUses, peerRequiredHostDependencies,
      configurationOnlyDevDependencies: new Set(), clientInject: new Set(pkg.manifest.dsh?.client?.inject ?? []),
      role: pkg.manifest.dsh?.client ? 'client-host' : 'configured-host' })
  }
  const official = readPackageDependencyState(root)
  const cloudPeerErrors = cloudPeerPolicyErrors(policy, PACKAGE_DEPENDENCY_POLICY,
    facts.flatMap(fact => fact.hostRuntimeExportUses), workspaceNames)
  const policyViolations = [...cloudPeerErrors, ...collectHostDependencyExportPolicyViolations([...official.facts, ...facts],
    workspaceNames, policy)]
  const hasCloudPeers = Object.keys(policy.peerRequiredHostExports)
    .some(specifier => !Object.hasOwn(PACKAGE_DEPENDENCY_POLICY.peerRequiredHostExports, specifier))
  const sectionErrors = [...collectPackageDependencyViolations({ facts, packages, workspaceNames, policyViolations: [] }),
    ...hasCloudPeers ? cloudProtocolManifestErrors(Object.fromEntries(packages.map(pkg => [pkg.name, pkg.manifest]))) : []]
  const unclassified = policyViolations.filter(error => error.includes('is not classified as safe or peer-required'))
  const privateExports = unclassified.filter(error => /@power-evolve\/[^\s#]+#/u.test(error))
  const requiredSingletonErrors = sectionErrors.filter(error => error.includes('matching peerDependencies + devDependencies'))
  const privateRangeReview = sectionErrors.filter(error => error.includes('@power-evolve/') && error.includes('workspace:~'))
  return { importErrors, sectionErrors, requiredSingletonErrors, privateRangeReview,
    hostExportClassification: { privateExports, officialExports: unclassified.filter(error => !privateExports.includes(error)),
      policyIntegrityErrors: policyViolations.filter(error => !unclassified.includes(error)),
      reason: 'Unclassified runtime exports reject; named cloud peers retain official unused, namespace and section checks.' },
    applicability, managedRoles: facts.map(fact => ({ package: fact.manifest.name, role: fact.role })),
    failures: [...importErrors, ...policyViolations, ...sectionErrors] }
}

/** Parse README frontmatter as YAML so quoted kinds remain valid and malformed metadata rejects.
 * @param file README display path.
 * @param source Complete Markdown source.
 * @returns Missing or invalid kind/frontmatter diagnostics.
 */
export function readmeMetadataErrors(file, source) {
  const header = /^---\r?\n([\s\S]*?)\r?\n---(?:\r?\n|$)/u.exec(source)
  if (!header) return [file + ': README kind metadata missing']
  try {
    const metadata = loadYaml(header[1])
    if (!metadata || typeof metadata.kind !== 'string' || !/^[a-z-]+$/u.test(metadata.kind)) {
      return [file + ': README kind metadata missing or invalid']
    }
    return []
  } catch (error) { return [file + ': invalid README YAML: ' + error.message] }
}

function documentationErrors(root, corpus) {
  const failures = [], anchors = anchorCache()
  const officialPair = translationPairSourcePredicate(parseTranslationPairingManifest(
    readFileSync(resolve(root, 'scripts/translation-pairing.manifest.json'), 'utf8')))
  if (corpus.docs.length === 0) failures.push('docs: empty corpus')
  const paired = new Set(corpus.docs.filter(file => !file.endsWith('.zh.md') && existsSync(resolve(root, file.replace(/\.md$/u, '.zh.md')))))
  for (const file of corpus.docs) {
    const source = readFileSync(resolve(root, file), 'utf8')
    failures.push(...findViolations(resolve(root, file), anchors, root).map(item =>
      item.file + ':' + item.line + ': broken ' + item.reason + ': ' + item.url))
    const masked = source.replace(/^---\n[\s\S]*?\n---/u, match => match.replace(/[^\n]/gu, ' '))
      .split('\n').map(line => line.trimStart().startsWith(':::') ? '' : line).join('\n')
    visitMarkdown(parseMarkdown(masked), (node) => {
      if (node.type === 'paragraph' && node.position.end.line > node.position.start.line) {
        failures.push(file + ':' + node.position.start.line + ': hard-wrapped prose paragraph')
        return false
      }
    })
  }
  for (const manifest of corpus.manifests) {
    const file = dirname(manifest) + '/README.md'
    if (!existsSync(resolve(root, file))) { failures.push(file + ': package README missing'); continue }
    const source = readFileSync(resolve(root, file), 'utf8')
    failures.push(...packageReadmeSummaryErrors(file, source))
    for (const heading of ['Table of Contents', 'Model Experience', 'Known Limitations and Deferred Work', 'Dev Note']) {
      if (!source.includes('## ' + heading + '\n')) failures.push(file + ': missing canonical section ' + heading)
    }
    failures.push(...readmeMetadataErrors(file, source))
    if (!paired.has(file)) failures.push(file + ': bilingual counterpart missing')
  }
  for (const file of paired) {
    const paths = translationPairPaths(file)
    const en = readFileSync(resolve(root, file), 'utf8'), zh = readFileSync(resolve(root, paths.zh), 'utf8')
    const context = { repoRoot: root, isTranslationPairSource: officialPair }
    if (en.split('\n').length !== zh.split('\n').length) failures.push(file + ': bilingual physical line counts differ')
    failures.push(...translationStructureDiff(
      translationStructureSignature(parseTranslationMarkdown(en), languageSwitcherTargets(paths.zh),
        { ...context, sourcePath: paths.source, markdown: en }),
      translationStructureSignature(parseTranslationMarkdown(zh), languageSwitcherTargets(paths.source),
        { ...context, sourcePath: paths.zh, markdown: zh }),
    ).map(error => file + ': ' + error))
    if (!existsSync(resolve(root, paths.meta))) { failures.push(file + ': translation confirmation sidecar missing'); continue }
    const recorded = parseTranslationPairingRecord(readFileSync(resolve(root, paths.meta), 'utf8'))
    if (!recorded) { failures.push(file + ': invalid translation sidecar'); continue }
    try {
      failures.push(...translationPairingRecordDiff(recorded, computeTranslationPairingRecord(paths, en, zh, context))
        .map(error => file + ': ' + error))
    } catch (error) { failures.push(file + ': ' + error.message) }
  }
  return failures
}

function typeConfigs(root) {
  const configs = new Set()
  const visit = (path) => {
    if (configs.has(path)) return
    const loaded = ts.readConfigFile(resolve(root, path), ts.sys.readFile)
    if (loaded.error) throw new Error(ts.flattenDiagnosticMessageText(loaded.error.messageText, '\n'))
    configs.add(path)
    for (const reference of loaded.config.references ?? []) {
      let target = resolve(root, dirname(path), reference.path)
      if (!target.endsWith('.json')) target += '/tsconfig.json'
      if (target.startsWith(resolve(root, product) + '/')) visit(relative(root, target).replaceAll('\\', '/'))
    }
  }
  for (const path of ['tsconfig.power-evolve.host.json', 'tsconfig.power-evolve.client.json',
    'tsconfig.power-evolve.test-host.json', 'tsconfig.power-evolve.test-client.json']) visit(path)
  return [...configs]
}

/** Create an external scoped program with the original ambient-type lookup.
 * @param root Checkout owning the original program.
 * @param project Original project path relative to the checkout.
 * @param parsed Original parsed compiler options and files.
 * @param deferred Exact reviewed files omitted from current roots.
 * @param output Private directory for the generated configuration.
 * @param index Unique configuration ordinal.
 * @returns Generated configuration path and retained root files.
 */
export function scopeTypeProgram(root, project, parsed, deferred, output, index) {
  const excluded = new Set(deferred.map(file => resolve(root, file)))
  const files = parsed.fileNames.filter(file => !excluded.has(file))
  const path = resolve(output, 'scope-types-' + index + '.json')
  const typeRoots = ts.getEffectiveTypeRoots({ ...parsed.options, configFilePath: resolve(root, project) }, ts.sys)
  writeFileSync(path, JSON.stringify({ extends: resolve(root, project), compilerOptions: { typeRoots }, files, include: [],
    references: parsed.projectReferences?.map(reference => ({ path: reference.path })) ?? [] }))
  return { path, files }
}

/** Execute one static lane without changing shared configuration.
 * @param lane One of types, lint, jsdoc, dependencies, docs or duplication.
 * @param root Checkout root.
 * @param output Private run directory for generated configurations.
 * @param record Receives commands, exit facts and actual program discovery for the run report.
 * @param selection Current release or explicit full backlog entry.
 * @returns Diagnostics from analysis and child exit status.
 */
export async function runStatic(lane, root, output, record = () => {}, selection = 'current') {
  const scope = cloudScope(root, selection), corpus = scope.corpus
  const deferred = selection === 'full' ? [] : scope.deferred
  let commandIndex = 0
  const run = (args) => {
    console.log('pnpm ' + args.join(' '))
    const result = spawnPnpm(args, { cwd: root, encoding: 'utf8', shell: false, maxBuffer: 64 * 1024 * 1024 })
    const log = lane + '-' + commandIndex + '.log'
    commandIndex += 1
    writeFileSync(resolve(output, log), result.stdout + result.stderr)
    process.stdout.write(result.stdout)
    process.stderr.write(result.stderr)
    record({ command: 'pnpm', args, exitCode: result.status, signal: result.signal, log })
    if (result.error) throw result.error
    return result.status === 0 && result.signal === null ? [] : ['command failed: exit=' + result.status + ' signal=' + result.signal]
  }
  if (lane === 'jsdoc') return (await jsdocCollector(root, [...corpus.runtime, ...corpus.tooling]))(root)
  if (lane === 'dependencies') {
    const report = dependencyReport(root, corpus, createCloudPeerPolicy(PACKAGE_DEPENDENCY_POLICY))
    const path = resolve(output, 'dependencies.json')
    writeFileSync(path, JSON.stringify(report, null, 2))
    record({ report: path, directImportErrors: report.importErrors.length,
      requiredSingletonErrors: report.requiredSingletonErrors.length, sectionAndRangeErrors: report.sectionErrors.length,
      privateExportClassifications: report.hostExportClassification.privateExports.length,
      officialExportClassifications: report.hostExportClassification.officialExports.length,
      applicability: report.applicability })
    return report.failures
  }
  if (lane === 'docs') return documentationErrors(root, corpus)
  if (lane === 'types') {
    const configs = typeConfigs(root), admitted = new Set(), failures = []
    for (const [index, config] of configs.entries()) {
      const loaded = ts.readConfigFile(resolve(root, config), ts.sys.readFile)
      const parsed = ts.parseJsonConfigFileContent(loaded.config, ts.sys, resolve(root, dirname(config)))
      failures.push(...parsed.errors.map(error => config + ': ' + ts.flattenDiagnosticMessageText(error.messageText, '\n')))
      const program = scopeTypeProgram(root, config, parsed, deferred, output, index)
      for (const file of program.files) admitted.add(file)
      record({ originalProgram: config, program: program.path,
        rootFiles: program.files.map(file => relative(root, file).replaceAll('\\', '/')) })
      if (parsed.fileNames.length === 0 && !loaded.config.references?.length) failures.push(config + ': empty TS program')
      if (program.files.length > 0) {
        console.log(config + ': ' + program.files.length + ' current root files')
        failures.push(...run(['exec', 'tsc', '-p', program.path, '--noEmit', '--incremental', 'false', '--composite', 'false',
          '--pretty', 'false']))
      }
    }
    for (const file of [...corpus.runtime, ...corpus.sourceTests, ...corpus.builtTests].filter(file => /\.(?:[cm]?ts|tsx)$/u.test(file))) {
      if (!admitted.has(resolve(root, file))) failures.push('types: discovered file has no actual TS program: ' + file)
    }
    return failures
  }
  if (lane === 'lint') {
    const parsed = ts.parseConfigFileTextToJson('.oxlintrc.json', readFileSync(resolve(root, '.oxlintrc.json'), 'utf8'))
    if (parsed.error) throw new Error('Cannot parse official oxlint JSONC')
    const config = cloudLintConfig(parsed.config)
    const required = createRequire(resolve(root, 'package.json'))
    for (const override of config.overrides) {
      // Oxlint anchors overrides at the configuration directory, including a private temp directory.
      override.files = override.files.map(pattern => resolve(root, pattern).replaceAll('\\', '/'))
      if (override.jsPlugins) override.jsPlugins = override.jsPlugins.map(plugin => required.resolve(plugin))
    }
    const path = resolve(output, 'oxlint.json')
    writeFileSync(path, JSON.stringify(config))
    const failures = [], admitted = new Set()
    for (const [index, project] of typeConfigs(root).entries()) {
      const loaded = ts.readConfigFile(resolve(root, project), ts.sys.readFile)
      const parsed = ts.parseJsonConfigFileContent(loaded.config, ts.sys, resolve(root, dirname(project)))
      const roots = new Set(parsed.fileNames)
      const selected = corpus.lint.filter(file => roots.has(resolve(root, file)) && /\.(?:[cm]?ts|tsx)$/u.test(file))
      if (selected.length === 0) continue
      const program = scopeTypeProgram(root, project, parsed, deferred, output, index)
      for (const file of selected) admitted.add(file)
      failures.push(...run(['exec', 'tsx', 'scripts/run-oxlint.ts', '--config', path, '--tsconfig', program.path, ...selected]))
    }
    for (const file of corpus.lint.filter(file => /\.(?:[cm]?ts|tsx)$/u.test(file))) {
      if (!admitted.has(file)) failures.push('lint: TS file has no actual program: ' + file)
    }
    const javascript = corpus.lint.filter(file => /\.[cm]?js$/u.test(file))
    failures.push(...run(['exec', 'tsx', 'scripts/run-oxlint.ts', '--config', path, ...javascript]))
    return failures
  }
  if (lane === 'duplication') {
    const config = JSON.parse(readFileSync(resolve(root, '.jscpd.json'), 'utf8'))
    config.format = [...new Set([...config.format, 'javascript'])]
    config.pattern = '**/*.{ts,tsx,js,mjs}'
    config.absolute = true
    config.reporters = [...new Set([...config.reporters, 'json'])]
    config.output = resolve(output, 'duplication')
    const path = resolve(output, 'jscpd.json')
    writeFileSync(path, JSON.stringify(config))
    const failures = run(['exec', 'jscpd', '--config', path, ...corpus.runtime])
    const reportPath = resolve(config.output, 'jscpd-report.json')
    if (!existsSync(reportPath)) return [...failures, 'duplication: JSON report missing: ' + reportPath]
    const report = JSON.parse(readFileSync(reportPath, 'utf8'))
    if (!Array.isArray(report.duplicates)) return [...failures, 'duplication: clone locations missing: ' + reportPath]
    record({ report: reportPath, clones: report.duplicates.length })
    for (const clone of report.duplicates) {
      const locations = [clone.firstFile, clone.secondFile]
      if (locations.some(location => !location?.name || !Number.isSafeInteger(location.start)
        || !Number.isSafeInteger(location.end) || location.start < 1 || location.end < location.start)) {
        failures.push('duplication: incomplete clone location: ' + reportPath)
      } else if (failures.length > 0) failures.push('duplication: ' + locations.map(location =>
        relative(root, location.name).replaceAll('\\', '/') + ':' + location.start + '-' + location.end).join(' matches '))
    }
    return failures
  }
  throw new Error('Unknown static lane: ' + lane)
}
