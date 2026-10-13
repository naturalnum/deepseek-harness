/** Frozen native execution evidence and source-map conversion for the shared coverage provider. */
import { createHash, randomUUID } from 'node:crypto'
import { existsSync, mkdirSync, readFileSync, readdirSync, realpathSync, writeFileSync } from 'node:fs'
import { createRequire } from 'node:module'
import { dirname, isAbsolute, relative, resolve } from 'node:path'
import { fileURLToPath, pathToFileURL } from 'node:url'

const required = createRequire(createRequire(import.meta.url).resolve('@vitest/coverage-v8/package.json'))

/** Hash original or executed UTF-8 source for evidence matching.
 * @param source Source text or bytes.
 * @returns SHA-256 digest.
 */
export function sourceHash(source) {
  return createHash('sha256').update(source).digest('hex')
}

/** Freeze native test/source inputs before their runner begins.
 * @param root Checkout or isolated fixture root.
 * @param runtime Complete production runtime inventory.
 * @param tests Required native source tests.
 * @param directory Fresh evidence directory.
 * @param scope Optional named product scope; isolated collector controls supply explicit files directly.
 * @returns Absolute input manifest path.
 */
export function prepareNativeCoverage(root, runtime, tests, directory, scope) {
  const physicalRoot = realpathSync(root)
  mkdirSync(resolve(directory, 'raw'), { recursive: true })
  mkdirSync(resolve(directory, 'code'), { recursive: true })
  const input = { version: 1, root: resolve(root), physicalRoot, directory, runtime, tests,
    ...(scope ? { scope: { ...scope, hash: sourceHash(readFileSync(resolve(root, scope.manifest))) } } : {}),
    hashes: Object.fromEntries([...new Set([...runtime, ...tests])].map(file =>
      [file, sourceHash(readFileSync(resolve(root, file)))])) }
  const path = resolve(directory, 'inputs.json')
  writeFileSync(path, JSON.stringify(input, null, 2))
  return path
}

/** Preload source collection and tsx in the native runner and all its Node subprocesses.
 * @param inputPath Frozen input manifest.
 * @returns Explicit native coverage environment; no shell command interpolation.
 */
export function nativeCoverageEnvironment(inputPath) {
  const input = JSON.parse(readFileSync(inputPath, 'utf8'))
  const collector = pathToFileURL(fileURLToPath(new URL('./cloud-capture.mjs', import.meta.url))).href
  const tsx = pathToFileURL(createRequire(import.meta.url).resolve('tsx')).href
  return { PE_CLOUD_COVERAGE_INPUT: inputPath, NODE_V8_COVERAGE: resolve(input.directory, 'raw'),
    NODE_OPTIONS: (process.env.NODE_OPTIONS ?? '') + ' --import=' + collector + ' --import=' + tsx }
}

/** Preserve native source capture for an explicitly pure JavaScript child without the gate-added TypeScript loader.
 * @param environment Parent environment; user Node options remain byte-for-byte intact.
 * @returns Child environment with only the final gate-owned tsx import removed when the exact coverage suffix is present.
 */
export function nativePureJavaScriptChildEnvironment(environment = process.env) {
  const result = { ...environment }
  if (!environment.PE_CLOUD_COVERAGE_INPUT || !environment.NODE_V8_COVERAGE || typeof environment.NODE_OPTIONS !== 'string') return result
  const collector = pathToFileURL(fileURLToPath(new URL('./cloud-capture.mjs', import.meta.url))).href
  const tsx = pathToFileURL(createRequire(import.meta.url).resolve('tsx')).href
  const collectorImport = ' --import=' + collector, tsxImport = ' --import=' + tsx
  if (environment.NODE_OPTIONS.endsWith(collectorImport + tsxImport)) {
    result.NODE_OPTIONS = environment.NODE_OPTIONS.slice(0, -tsxImport.length)
  }
  return result
}

/** Prepare one actual Linux execution namespace with explicitly transported input and evidence paths.
 * @param inputPath Frozen parent native manifest.
 * @param options Actual executionRoot, optional executionDirectory and collector URL; copy input bytes unchanged.
 * @returns Local context directory/input path and the remote Node environment. Each PID namespace needs its own context.
 */
export function prepareNativeCoverageContext(inputPath, options = {}) {
  const source = readFileSync(inputPath, 'utf8'), input = JSON.parse(source)
  const directory = resolve(input.directory, 'contexts', randomUUID())
  const executionRoot = options.executionRoot ?? input.physicalRoot
  const executionDirectory = options.executionDirectory ?? directory
  for (const path of [executionRoot, executionDirectory]) {
    if (!path.startsWith('/') || resolve(path) !== path) throw new Error('Native context requires canonical POSIX paths')
  }
  mkdirSync(resolve(directory, 'raw'), { recursive: true })
  mkdirSync(resolve(directory, 'code'), { recursive: true })
  const path = resolve(directory, 'inputs.json')
  writeFileSync(path, JSON.stringify({ ...input, directory, parentInputHash: sourceHash(source), executionRoot, executionDirectory }))
  const collector = options.collector ?? pathToFileURL(resolve(executionRoot, 'products/power-evolve/scripts/cloud-capture.mjs')).href
  return { directory, inputPath: path, environment: {
    PE_CLOUD_COVERAGE_INPUT: resolve(executionDirectory, 'inputs.json'),
    NODE_V8_COVERAGE: resolve(executionDirectory, 'raw'), NODE_OPTIONS: '--import=' + collector,
  } }
}

/** Give one Linux Node container its own capture namespace and readonly frozen source mounts.
 * Copied execution roots receive the same readonly named scope manifest.
 * @param inputPath Frozen parent native manifest.
 * @param options Optional actual byte-copy executionRoot; transformed sources at other roots are rejected.
 * @returns Docker create/run arguments for actual MJS source collection without a host-specific tsx binary.
 */
export function nativeDockerCoverageArguments(inputPath, options = {}) {
  const input = JSON.parse(readFileSync(inputPath, 'utf8'))
  const tooling = realpathSync(fileURLToPath(new URL('../../../', import.meta.url)))
  const collector = pathToFileURL(resolve(tooling, 'products/power-evolve/scripts/cloud-capture.mjs')).href
  const sources = [...new Set([tooling, input.physicalRoot])]
  if (sources.some(root => !root.startsWith('/'))) throw new Error('Native Docker coverage requires POSIX source paths')
  const executionRoot = options.executionRoot ?? input.physicalRoot
  const context = prepareNativeCoverageContext(inputPath, { executionRoot, collector })
  const scopeMount = input.scope && executionRoot !== input.physicalRoot
    ? ['--mount', 'type=bind,source=' + realpathSync(resolve(input.physicalRoot, input.scope.manifest))
      + ',target=' + resolve(executionRoot, input.scope.manifest) + ',readonly'] : []
  return [...Object.entries(context.environment).flatMap(([key, value]) => ['--env', key + '=' + value]),
    ...sources.flatMap(root => ['--mount', 'type=bind,source=' + root + ',target=' + root + ',readonly']),
    ...scopeMount,
    '--mount', 'type=bind,source=' + realpathSync(context.directory) + ',target=' + context.directory]
}

/** Resolve a native V8 URL to its physical corpus path.
 * @param root Physical corpus root.
 * @param url Native script URL.
 * @returns Relative source path, or undefined for non-file scripts.
 */
export function nativeSourcePath(root, url) {
  if (!url.startsWith('file:')) return undefined
  const parsed = new URL(url)
  parsed.search = ''; parsed.hash = ''
  return relative(root, fileURLToPath(parsed)).replaceAll('\\', '/')
}

function mappedSource(file, sourceRoot, source) {
  if (source.startsWith('file:')) return fileURLToPath(source)
  if (isAbsolute(source)) return source
  if (sourceRoot?.startsWith('file:')) return fileURLToPath(new URL(source, sourceRoot.endsWith('/') ? sourceRoot : sourceRoot + '/'))
  return resolve(dirname(file), sourceRoot ?? '', source)
}

function validatedSourceMap(input, rel, captured, raw, url) {
  const data = captured.sourceMapURL
  let map
  if (data) {
    const embedded = [...captured.code.matchAll(/\/\/[#@]\s*sourceMappingURL=(\S+)/gu)].at(-1)?.[1]
    if (data.startsWith('data:') && embedded !== data) {
      throw new Error('Native coverage: source map evidence differs from executed code: ' + rel)
    }
    const match = /^data:application\/json(?:;charset=[^;,]+)?(;base64)?,([\s\S]+)$/u.exec(data)
    if (!match) throw new Error('Native coverage: unsupported source map URL: ' + rel)
    map = JSON.parse(match[1] ? Buffer.from(match[2], 'base64').toString('utf8') : decodeURIComponent(match[2]))
  } else map = raw['source-map-cache']?.[url]?.data
  if (!map) {
    if (sourceHash(captured.code) !== input.hashes[rel]) throw new Error('Native coverage: transformed source map missing: ' + rel)
    return undefined
  }
  const hasSourcesContent = Object.hasOwn(map, 'sourcesContent')
  if (map.version !== 3 || typeof map.mappings !== 'string' || !Array.isArray(map.sources)
    || !map.sources.every(source => typeof source === 'string')
    || (map.sourceRoot !== undefined && typeof map.sourceRoot !== 'string')
    || (hasSourcesContent && (!Array.isArray(map.sourcesContent) || map.sources.length !== map.sourcesContent.length
      || !map.sourcesContent.every(content => content === null || typeof content === 'string')))) {
    throw new Error('Native coverage: invalid source map: ' + rel)
  }
  const file = resolve(input.physicalRoot, rel)
  const paths = map.sources.map((source) => {
    const path = relative(input.physicalRoot, mappedSource(file, map.sourceRoot, source)).replaceAll('\\', '/')
    if (!Object.hasOwn(input.hashes, path)) throw new Error('Native coverage: source map does not match frozen input: ' + path)
    return path
  })
  let matched = false
  const sourcesContent = paths.map((path, index) => {
    const stored = hasSourcesContent ? map.sourcesContent[index] : null
    const content = stored === null ? readFileSync(resolve(input.root, path), 'utf8') : stored
    if (sourceHash(content) !== input.hashes[path]) {
      throw new Error('Native coverage: source map does not match frozen input: ' + path)
    }
    if (path === rel) matched = true
    return content
  })
  if (!matched) throw new Error('Native coverage: source map omits executed source: ' + rel)
  return { ...map, sourcesContent }
}

/** Convert each process's actual executed code before merging source-level Istanbul maps.
 * @param inputPath Frozen runtime/test manifest and native evidence directories.
 * @returns Native coverage map and auditable conversion facts.
 */
export async function convertNativeCoverage(inputPath) {
  const input = JSON.parse(readFileSync(inputPath, 'utf8'))
  if (input.scope && sourceHash(readFileSync(resolve(input.root, input.scope.manifest))) !== input.scope.hash) {
    throw new Error('Native coverage: named scope manifest changed during execution')
  }
  if (input.version !== 1) throw new Error('Native coverage: unknown input version')
  for (const [file, hash] of Object.entries(input.hashes)) {
    if (sourceHash(readFileSync(resolve(input.root, file))) !== hash) throw new Error('Native coverage: input changed: ' + file)
  }
  const { createCoverageMap } = required('istanbul-lib-coverage')
  const convert = (await import(pathToFileURL(required.resolve('ast-v8-to-istanbul')).href)).default
  const { parseAstAsync } = await import('vite')
  const map = createCoverageMap({}), observed = new Set(), conversions = []
  const directories = [{ directory: input.directory, context: 'root', executionRoot: input.physicalRoot,
    inputHash: sourceHash(readFileSync(inputPath, 'utf8')) }]
  const contexts = resolve(input.directory, 'contexts')
  if (existsSync(contexts)) {
    for (const context of readdirSync(contexts)) {
      if (!/^[a-f0-9-]{36}$/u.test(context)) throw new Error('Native coverage: unexpected context name')
      const directory = resolve(contexts, context)
      const childText = readFileSync(resolve(directory, 'inputs.json'), 'utf8'), child = JSON.parse(childText)
      const { parentInputHash, executionRoot, executionDirectory, ...frozen } = child
      if (child.directory !== directory || parentInputHash !== sourceHash(readFileSync(inputPath, 'utf8'))
        || [executionRoot, executionDirectory].some(path => typeof path !== 'string' || !path.startsWith('/') || resolve(path) !== path)
        || JSON.stringify({ ...frozen, directory: input.directory }) !== JSON.stringify(input)) {
        throw new Error('Native coverage: container context does not match frozen parent')
      }
      directories.push({ directory, context, executionRoot, inputHash: sourceHash(childText) })
    }
  }
  const files = directories.flatMap(({ directory, context, executionRoot, inputHash }) => {
    const names = readdirSync(resolve(directory, 'raw')).filter(file => /^coverage-\d+-\d+-\d+\.json$/u.test(file))
    if (names.length === 0) throw new Error('Native coverage: no fresh V8 evidence in ' + context)
    return names.map(name => ({ name, directory, context, executionRoot, inputHash }))
  })
  for (const { name, directory, context, executionRoot, inputHash } of files) {
    const match = /^coverage-(\d+)-\d+-(\d+)\.json$/u.exec(name)
    const raw = JSON.parse(readFileSync(resolve(directory, 'raw', name), 'utf8'))
    const capturePath = resolve(directory, 'code', match[1] + '-' + match[2] + '.json')
    let captured = existsSync(capturePath) ? JSON.parse(readFileSync(capturePath, 'utf8')) : undefined
    if (captured && captured.inputHash !== inputHash) throw new Error('Native coverage: capture input binding changed in ' + context)
    for (const script of raw.result) {
      const rel = nativeSourcePath(executionRoot, script.url)
      if (input.tests.includes(rel)) observed.add(rel)
      if (!input.runtime.includes(rel)) continue
      captured ??= JSON.parse(readFileSync(capturePath, 'utf8'))
      if (captured.inputHash !== inputHash) throw new Error('Native coverage: capture input binding changed in ' + context)
      if (captured.errors.length > 0) throw new Error('Native coverage: source capture failed: ' + captured.errors.join('; '))
      const execution = captured.scripts[script.scriptId]
      if (!execution || execution.url !== script.url || execution.hash !== sourceHash(execution.code)
        || execution.originalHash !== input.hashes[rel]) throw new Error('Native coverage: executed source evidence missing or mismatched: ' + rel)
      if (!script.functions.every(fn => fn.ranges.every(range => Number.isInteger(range.startOffset)
        && Number.isInteger(range.endOffset) && Number.isInteger(range.count) && range.count >= 0
        && range.startOffset >= 0 && range.endOffset >= range.startOffset && range.endOffset <= execution.code.length))) {
        throw new Error('Native coverage: executed range outside captured source: ' + rel)
      }
      if (executionRoot !== input.physicalRoot && (!/\.[cm]?js$/u.test(rel)
        || sourceHash(execution.code) !== input.hashes[rel]
        || execution.sourceMapURL || raw['source-map-cache']?.[script.url]?.data)) {
        throw new Error('Native coverage: mapped execution root requires byte-identical untransformed MJS/JS: ' + rel)
      }
      const sourceMap = validatedSourceMap(input, rel, execution, raw, script.url)
      const converted = await convert({ code: execution.code, ast: await parseAstAsync(execution.code), sourceMap,
        coverage: { ...script, url: pathToFileURL(resolve(input.physicalRoot, rel)).href }, wrapperLength: 0 })
      const normalized = {}
      for (const [path, value] of Object.entries(converted)) {
        const source = relative(input.physicalRoot, path).replaceAll('\\', '/')
        if (!input.runtime.includes(source)) {
          throw new Error('Native coverage: conversion produced an unexpected source: ' + path)
        }
        const target = resolve(input.root, source)
        normalized[target] = { ...value, path: target }
      }
      map.merge(normalized)
      conversions.push({ raw: name, context, file: rel, scriptId: script.scriptId, actualUrl: script.url,
        executionRoot, executedHash: execution.hash, mapped: !!sourceMap })
    }
  }
  for (const test of input.tests) if (!observed.has(test)) throw new Error('Native coverage: test file absent from V8 evidence: ' + test)
  const facts = { inputPath, ...(input.scope ? { scope: input.scope } : {}),
    observedTests: [...observed].sort(), conversions, files: map.files() }
  writeFileSync(resolve(input.directory, 'native-istanbul.json'), JSON.stringify(map.toJSON()))
  writeFileSync(resolve(input.directory, 'conversion.json'), JSON.stringify(facts, null, 2))
  return { map, facts }
}
