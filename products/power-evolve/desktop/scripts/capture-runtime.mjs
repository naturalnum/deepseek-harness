/** Capture existing production package bytes into a finite, relocatable trial runtime; never install or build. */
import { createHash, randomUUID } from 'node:crypto'
import { execFileSync } from 'node:child_process'
import {
  closeSync, constants, existsSync, fstatSync, fsyncSync, globSync, lstatSync, mkdirSync,
  openSync, readFileSync, readlinkSync, readSync, readdirSync, realpathSync, renameSync,
  rmSync, symlinkSync, writeFileSync, writeSync, fchmodSync,
} from 'node:fs'
import { basename, dirname, isAbsolute, join, relative, resolve, sep } from 'node:path'
import { fileURLToPath } from 'node:url'
import { parseArgs } from 'node:util'

const FORMAT = 'power-evolve-trial-runtime-v1'
const ROOTS = ['@deepseek-ai/dsh', '@power-evolve/device']
const ALLOWED_ROOTS = new Set([...ROOTS, '@power-evolve/host', '@power-evolve/platform'])
const PACKAGE_NAME = /^(?:@[a-z0-9][a-z0-9._~-]*\/)?[a-z0-9][a-z0-9._~-]*$/u
const LIMITS = { packages: 2048, files: 200_000, bytes: 4 * 1024 ** 3 }
const METADATA_LIMIT = 32 * 1024 ** 2

function fail(code, details) {
  const error = new Error(`trial_runtime_${code}`)
  if (details !== undefined) error.details = details
  throw error
}
function hash(bytes) { return createHash('sha256').update(bytes).digest('hex') }
function portable(path) { return path.split(sep).join('/') }
function inside(root, path) {
  const rel = relative(root, path)
  return rel === '' || (!isAbsolute(rel) && rel !== '..' && !rel.startsWith(`..${sep}`))
}
function safeRelative(path) {
  if (typeof path !== 'string' || path === '' || isAbsolute(path) || path.includes('\\') || path.includes('\0')
    || path.split('/').some(part => part === '' || part === '.' || part === '..')) fail('invalid_path', { path })
  return path
}
function forbidden(path) {
  return path.split('/').some(part => part === 'node_modules'
    || /^(?:\.git.*|\.env(?:\..*)?|\.npmrc|\.pnpmfile.*|\.artifacts|\.cache|\.DS_Store|\.tsbuildinfo|model\.env|database(?:-local)?-url|\.?private|\.?credentials)$/iu.test(part))
}
function json(path, limit = METADATA_LIMIT) {
  const fd = openSync(path, constants.O_RDONLY | constants.O_NOFOLLOW)
  try {
    const stat = fstatSync(fd)
    if (!stat.isFile() || stat.size > limit) fail('invalid_metadata')
    return JSON.parse(readFileSync(fd, 'utf8'))
  } finally { closeSync(fd) }
}
function manifest(root) {
  const value = json(join(root, 'package.json'), 1024 ** 2)
  if (!PACKAGE_NAME.test(value.name) || typeof value.version !== 'string' || value.version === '') fail('invalid_manifest')
  return value
}
function git(root, args) {
  const env = Object.fromEntries(Object.entries(process.env).filter(([name]) => !/KEY|SECRET|TOKEN|PASSWORD|^GIT_|^NODE_/iu.test(name)))
  return execFileSync('git', ['-C', root, ...args], { env, encoding: 'utf8', maxBuffer: 1024 ** 2, timeout: 10_000 }).trim()
}
function sourceGuard(sourceRoot, sourceCommit) {
  if (!isAbsolute(sourceRoot) || !/^[a-f0-9]{40}$/u.test(sourceCommit)) fail('invalid_source')
  if (git(sourceRoot, ['rev-parse', 'HEAD']) !== sourceCommit) fail('source_changed')
  if (git(sourceRoot, ['status', '--porcelain', '--untracked-files=no']) !== '') fail('source_dirty')
}

function workspacePackages(root) {
  // This repo declares a plain scalar packages list; unsupported YAML is refused, never guessed.
  const text = readFileSync(join(root, 'pnpm-workspace.yaml'), 'utf8')
  const block = /^packages:\s*\n((?:[ \t]+.*\n|\n)*)/mu.exec(text)?.[1]
  if (block === undefined) fail('invalid_workspace')
  const patterns = []
  for (const line of block.split('\n')) {
    if (/^\s*(?:#.*)?$/u.test(line)) continue
    const value = /^\s+-\s+([a-zA-Z0-9_/*.-]+)\s*$/u.exec(line)?.[1]
    if (value === undefined || value.split('/').includes('..')) fail('invalid_workspace')
    patterns.push(`${value}/package.json`)
  }
  const packages = new Map()
  for (const path of globSync(patterns, { cwd: root }).sort()) {
    const directory = realpathSync(join(root, dirname(path)))
    if (!inside(root, directory)) fail('workspace_escape')
    const value = manifest(directory)
    if (packages.has(value.name)) fail('duplicate_workspace')
    packages.set(value.name, directory)
  }
  return packages
}

function nodeLookup(root, name) {
  for (let directory = root;; directory = dirname(directory)) {
    const candidate = join(directory, 'node_modules', name)
    try {
      const actual = realpathSync(candidate)
      if (!existsSync(join(actual, 'package.json'))) fail('dependency_manifest_missing')
      return actual
    } catch (error) {
      if (error.code !== 'ENOENT') throw error
      // A dangling alias is a broken installation, not permission to use a workspace fallback.
      try { lstatSync(candidate); fail('dangling_dependency') } catch (missing) {
        if (missing.code !== 'ENOENT') throw missing
      }
    }
    if (dirname(directory) === directory) return undefined
  }
}

function payloadFiles(root, value, workspaceMember) {
  const files = new Set(['package.json'])
  const missingDeclaredFiles = []
  const missingEntries = []
  const add = (path) => {
    const rel = portable(relative(root, path))
    if (rel === '') { for (const entry of readdirSync(root).sort()) add(join(root, entry)); return }
    safeRelative(rel)
    if (forbidden(rel)) return
    if (realpathSync(path) !== path) fail('payload_symlink', { package: value.name, path: rel })
    const stat = lstatSync(path)
    if (stat.isSymbolicLink()) fail('payload_symlink', { package: value.name, path: rel })
    if (stat.isDirectory()) {
      for (const entry of readdirSync(path).sort()) add(join(path, entry))
    } else if (stat.isFile()) files.add(rel)
    else fail('payload_not_regular')
  }
  if (value.files !== undefined) {
    if (!Array.isArray(value.files) || value.files.some(pattern => typeof pattern !== 'string')) fail('invalid_files')
    const exclusions = []
    for (const raw of value.files) {
      const exclude = raw.startsWith('!')
      const pattern = (exclude ? raw.slice(1) : raw).replace(/^\.\//u, '').replace(/^\/+/u, '').replace(/\/$/u, '')
      safeRelative(pattern)
      if (exclude) { exclusions.push(pattern); continue }
      if (forbidden(pattern)) fail('unsafe_files', { package: value.name, pattern })
      const matches = globSync(pattern, { cwd: root }).sort()
      if (matches.length === 0) missingDeclaredFiles.push(pattern)
      for (const path of matches) add(join(root, path))
    }
    for (const path of globSync(exclusions, { cwd: root })) {
      const rel = portable(path)
      for (const selected of files) if (selected === rel || selected.startsWith(`${rel}/`)) files.delete(selected)
    }
  } else {
    for (const entry of readdirSync(root).sort()) add(join(root, entry))
  }
  for (const entry of readdirSync(root)) {
    if (/^(?:readme|licen[cs]e|copying)(?:\.|$)/iu.test(entry)) add(join(root, entry))
  }
  const required = new Set()
  function entry(path) {
    if (typeof path !== 'string' || !path.startsWith('./') || /[?*]/u.test(path) || /\.d\.[cm]?ts$/u.test(path)) return
    if (path === './') { required.add('.'); return }
    required.add(safeRelative(path.slice(2).replace(/\/$/u, '')))
  }
  function exports(value) {
    if (typeof value === 'string') entry(value)
    else if (value && typeof value === 'object') {
      for (const [key, child] of Object.entries(value)) {
        if (key.startsWith('.') || ['default', 'node', 'node-addons', 'import', 'require'].includes(key)) exports(child)
      }
    }
  }
  if (typeof value.main === 'string' && value.main !== '') {
    const main = safeRelative(value.main.replace(/^\.\//u, '').replace(/\/$/u, ''))
    const resolvedMain = [main, `${main}.js`, `${main}.json`, `${main}.node`].find(path => existsSync(join(root, path)))
    required.add(resolvedMain ?? main)
  }
  for (const path of Object.values(typeof value.bin === 'string' ? { bin: value.bin } : value.bin ?? {})) {
    required.add(safeRelative(path.replace(/^\.\//u, '')))
  }
  exports(value.exports)
  if (value.dsh?.bundle?.patch !== undefined) entry(value.dsh.bundle.patch)
  if (value.name === '@power-evolve/application') {
    required.add('src/device/local-files.py'); required.add('src/platform/safe-posix.py')
  }
  for (const path of required) {
    if (!existsSync(join(root, path))) {
      if (workspaceMember) fail('missing_entry', { package: value.name, path })
      missingEntries.push(path); continue
    }
    add(join(root, path))
  }
  return { missingDeclaredFiles, missingEntries, files: [...files].sort().map(path => {
    const stat = lstatSync(join(root, path))
    if (!stat.isFile()) fail('payload_not_regular')
    return { path, bytes: stat.size, executable: (stat.mode & 0o111) !== 0 }
  }) }
}

/**
 * Read a fixed clean checkout's actual production/peer graph and declared payloads without copying or executing packages.
 * @param options - Absolute sourceRoot, full sourceCommit and optional product roots; defaults select CLI and Device.
 * @returns Finite physical-package graph, explicit workspace fallback edges, version/cycle diagnostics and byte/file totals.
 */
export function inspectTrialRuntime(options) {
  const { sourceRoot, sourceCommit, roots = ROOTS } = options
  sourceGuard(sourceRoot, sourceCommit)
  const source = realpathSync(sourceRoot)
  if (!Array.isArray(roots) || roots.length === 0 || new Set(roots).size !== roots.length || roots.some(name => !ALLOWED_ROOTS.has(name))) fail('invalid_roots')
  const workspace = workspacePackages(source)
  const nodes = new Map()
  const missing = []
  const skipped = []
  function visit(root) {
    root = realpathSync(root)
    if (nodes.has(root)) return nodes.get(root).id
    if (nodes.size >= LIMITS.packages) fail('package_limit')
    const value = manifest(root)
    const id = hash(`${root}\0${readFileSync(join(root, 'package.json'))}`)
    let payload
    try { payload = payloadFiles(root, value, workspace.get(value.name) === root) } catch (error) {
      if (error.message.startsWith('trial_runtime_')) error.details = { package: value.name, ...error.details }
      throw error
    }
    const node = { id, name: value.name, version: value.version, source: root, ...payload, dependencies: [] }
    nodes.set(root, node)
    const dependencyNames = new Set([...Object.keys(value.dependencies ?? {}), ...Object.keys(value.peerDependencies ?? {}), ...Object.keys(value.optionalDependencies ?? {})])
    for (const name of [...dependencyNames].sort()) {
      if (!PACKAGE_NAME.test(name)) fail('invalid_dependency')
      const declarations = ['dependencies', 'peerDependencies', 'optionalDependencies']
        .filter(section => value[section]?.[name] !== undefined).map(section => ({ section, range: value[section][name] }))
      if (declarations.some(item => typeof item.range !== 'string')) fail('invalid_dependency')
      const optional = value.optionalDependencies?.[name] !== undefined
        || (value.dependencies?.[name] === undefined && value.peerDependenciesMeta?.[name]?.optional === true)
      let target = nodeLookup(root, name)
      let resolution = 'node'
      if (target === undefined && declarations.some(item => item.range.startsWith('workspace:'))) {
        target = workspace.get(name)
        resolution = 'workspace-manifest'
      }
      if (target === undefined) {
        ;(optional ? skipped : missing).push({ from: node.id, name, declarations })
        continue
      }
      if (manifest(target).name !== name) fail('dependency_identity')
      node.dependencies.push({ name, target: visit(target), resolution, declarations })
    }
    return node.id
  }
  const entries = roots.map(name => {
    const path = workspace.get(name)
    if (path === undefined) fail('root_missing')
    return { name, id: visit(path) }
  })
  const packages = [...nodes.values()].sort((a, b) => a.id.localeCompare(b.id))
  const byId = new Map(packages.map(node => [node.id, node]))
  const active = new Set(), done = new Set(), cycles = []
  function cycle(id, trail) {
    if (active.has(id)) { cycles.push([...trail.slice(trail.indexOf(id)), id]); return }
    if (done.has(id)) return
    active.add(id)
    for (const edge of byId.get(id).dependencies) cycle(edge.target, [...trail, id])
    active.delete(id); done.add(id)
  }
  for (const node of packages) cycle(node.id, [])
  const versions = new Map()
  for (const node of packages) versions.set(node.name, new Set([...(versions.get(node.name) ?? []), node.version]))
  const multiVersions = [...versions].filter(([, values]) => values.size > 1)
    .map(([name, values]) => ({ name, versions: [...values].sort() })).sort((a, b) => a.name.localeCompare(b.name))
  const totals = packages.reduce((total, node) => ({ files: total.files + node.files.length,
    bytes: total.bytes + node.files.reduce((sum, file) => sum + file.bytes, 0) }), { files: 0, bytes: 0 })
  if (totals.files > LIMITS.files || totals.bytes > LIMITS.bytes) fail('payload_limit')
  sourceGuard(sourceRoot, sourceCommit)
  return { format: FORMAT, sourceRoot: source, sourceCommit, roots: entries, packages, missing, skipped, multiVersions, cycles, totals }
}

function fileDigest(path) {
  if (realpathSync(path) !== path) fail('payload_symlink')
  const fd = openSync(path, constants.O_RDONLY | constants.O_NOFOLLOW)
  try {
    const stat = fstatSync(fd)
    if (!stat.isFile()) fail('payload_not_regular')
    const digest = createHash('sha256'), buffer = Buffer.alloc(64 * 1024)
    let bytes = 0, count
    while ((count = readSync(fd, buffer, 0, buffer.length, null)) !== 0) { digest.update(buffer.subarray(0, count)); bytes += count }
    const after = fstatSync(fd)
    if (stat.dev !== after.dev || stat.ino !== after.ino || stat.size !== after.size || stat.mtimeMs !== after.mtimeMs || bytes !== stat.size) fail('source_changed')
    return { bytes, sha256: digest.digest('hex'), executable: (stat.mode & 0o111) !== 0 }
  } finally { closeSync(fd) }
}
function inventory(root) {
  root = realpathSync(root)
  const files = [], aliases = []
  function visit(directory) {
    for (const entry of readdirSync(directory).sort()) {
      const path = join(directory, entry), rel = portable(relative(root, path)), stat = lstatSync(path)
      if (stat.isSymbolicLink()) {
        const target = readlinkSync(path)
        if (isAbsolute(target) || !inside(root, resolve(dirname(path), target)) || !inside(root, realpathSync(path))) fail('alias_escape')
        aliases.push({ path: rel, target: portable(target) })
      } else if (stat.isDirectory()) visit(path)
      else if (stat.isFile()) files.push({ path: rel, ...fileDigest(path) })
      else fail('payload_not_regular')
    }
  }
  visit(root)
  return { files: files.sort((a, b) => a.path.localeCompare(b.path)), aliases: aliases.sort((a, b) => a.path.localeCompare(b.path)) }
}
function copyFile(source, destination) {
  if (realpathSync(source) !== source) fail('payload_symlink')
  const input = openSync(source, constants.O_RDONLY | constants.O_NOFOLLOW)
  let output
  try {
    const before = fstatSync(input)
    if (!before.isFile()) fail('payload_not_regular')
    mkdirSync(dirname(destination), { recursive: true, mode: 0o700 })
    output = openSync(destination, constants.O_WRONLY | constants.O_CREAT | constants.O_EXCL | constants.O_NOFOLLOW, 0o600)
    const buffer = Buffer.alloc(64 * 1024)
    let count
    while ((count = readSync(input, buffer, 0, buffer.length, null)) !== 0) {
      let written = 0
      while (written < count) written += writeSync(output, buffer, written, count - written)
    }
    fchmodSync(output, (before.mode & 0o111) === 0 ? 0o444 : 0o555)
    fsyncSync(output)
    const after = fstatSync(input)
    if (before.ino !== after.ino || before.dev !== after.dev || before.size !== after.size || before.mtimeMs !== after.mtimeMs) fail('source_changed')
  } finally { if (output !== undefined) closeSync(output); closeSync(input) }
}
function syncDirectory(path) {
  const fd = openSync(path, constants.O_RDONLY | constants.O_DIRECTORY | constants.O_NOFOLLOW)
  try { fsyncSync(fd) } finally { closeSync(fd) }
}

/**
 * Materialize an inspected checkout into a new owner-only output/runtime tree; internal relative aliases preserve cycles and peer versions.
 * @param options - inspectTrialRuntime inputs plus an absolute, nonexistent output path outside every source package.
 * @returns Verified record with original resolution paths, fixed root entry paths, file hashes and finite alias targets; no interpreter/private state is copied.
 */
export function captureTrialRuntime(options) {
  const plan = inspectTrialRuntime(options)
  if (plan.missing.length !== 0) fail('missing_dependencies')
  if (!isAbsolute(options.output ?? '')) fail('invalid_output')
  const output = join(realpathSync(dirname(options.output)), basename(options.output))
  if (inside(plan.sourceRoot, output)
    || plan.packages.some(node => inside(node.source, output))) fail('invalid_output')
  mkdirSync(output, { mode: 0o700 }) // EEXIST refuses every existing capture, including incomplete captures.
  const owned = lstatSync(output), stage = join(output, `.stage-${randomUUID()}`), runtime = join(output, 'runtime')
  try {
    mkdirSync(stage, { mode: 0o700 })
    const expected = new Map()
    for (const node of plan.packages) {
      const destination = join(stage, 'objects', node.id)
      mkdirSync(destination, { recursive: true, mode: 0o700 })
      for (const file of node.files) {
        const source = join(node.source, file.path), target = join(destination, file.path)
        const before = fileDigest(source)
        copyFile(source, target)
        if (JSON.stringify(before) !== JSON.stringify(fileDigest(target))) fail('source_changed')
        expected.set(source, before)
      }
    }
    function alias(path, target) {
      mkdirSync(dirname(path), { recursive: true, mode: 0o700 })
      symlinkSync(relative(dirname(path), target), path, 'dir')
    }
    for (const node of plan.packages) for (const edge of node.dependencies) {
      alias(join(stage, 'objects', node.id, 'node_modules', edge.name), join(stage, 'objects', edge.target))
    }
    for (const entry of plan.roots) alias(join(stage, 'node_modules', entry.name), join(stage, 'objects', entry.id))
    const captured = inventory(stage)
    for (const [path, record] of expected) if (JSON.stringify(record) !== JSON.stringify(fileDigest(path))) fail('source_changed')
    const rechecked = inspectTrialRuntime(options)
    if (JSON.stringify(plan) !== JSON.stringify(rechecked)) fail('source_changed')
    const directories = []
    function dirs(path) {
      for (const entry of readdirSync(path, { withFileTypes: true })) if (entry.isDirectory()) dirs(join(path, entry.name))
      directories.push(path)
    }
    dirs(stage)
    for (const directory of directories) syncDirectory(directory)
    renameSync(stage, runtime)
    const record = { ...plan, inventory: captured, paths: Object.fromEntries(plan.roots.map(entry => [entry.name, `runtime/node_modules/${entry.name}`])),
      operatorSha256: hash(readFileSync(fileURLToPath(import.meta.url))) }
    const descriptor = join(output, 'capture.json')
    writeFileSync(descriptor, `${JSON.stringify(record, null, 2)}\n`, { flag: 'wx', mode: 0o600 })
    const fd = openSync(descriptor, constants.O_RDONLY | constants.O_NOFOLLOW)
    try { fsyncSync(fd) } finally { closeSync(fd) }
    syncDirectory(output)
    return verifyTrialRuntime(output)
  } catch (error) {
    const current = lstatSync(output)
    if (current.dev === owned.dev && current.ino === owned.ino && current.isDirectory()) rmSync(output, { recursive: true })
    throw error
  }
}

/**
 * Check captured bytes, all relative aliases and dependency/root resolutions without consulting or executing source packages.
 * @param output - Absolute capture directory containing capture.json and runtime/.
 * @returns Recorded capture metadata after complete local inventory and identity checks.
 */
export function verifyTrialRuntime(output) {
  const record = json(join(output, 'capture.json'))
  if (record.format !== FORMAT || !Array.isArray(record.packages) || !Array.isArray(record.roots) || !record.inventory) fail('invalid_capture')
  const runtimePath = join(output, 'runtime')
  if (!lstatSync(runtimePath).isDirectory() || lstatSync(runtimePath).isSymbolicLink()) fail('alias_escape')
  const runtime = realpathSync(runtimePath)
  const actual = inventory(runtime)
  if (JSON.stringify(actual) !== JSON.stringify(record.inventory)) fail('inventory_changed')
  const byId = new Map(record.packages.map(node => [node.id, node]))
  for (const node of record.packages) {
    if (!/^[a-f0-9]{64}$/u.test(node.id) || !PACKAGE_NAME.test(node.name)) fail('invalid_capture')
    const path = join(runtime, 'objects', node.id), value = manifest(path)
    if (value.name !== node.name || value.version !== node.version) fail('capture_identity')
    for (const edge of node.dependencies) {
      if (!PACKAGE_NAME.test(edge.name) || !byId.has(edge.target)
        || realpathSync(join(path, 'node_modules', edge.name)) !== join(runtime, 'objects', edge.target)) fail('capture_resolution')
    }
  }
  for (const entry of record.roots) {
    if (!ALLOWED_ROOTS.has(entry.name) || !byId.has(entry.id)
      || realpathSync(join(runtime, 'node_modules', entry.name)) !== join(runtime, 'objects', entry.id)) fail('capture_resolution')
  }
  if (JSON.stringify(record.paths) !== JSON.stringify(Object.fromEntries(record.roots.map(entry => [entry.name, `runtime/node_modules/${entry.name}`])))) fail('capture_resolution')
  return record
}

function main() {
  const { values, positionals } = parseArgs({ allowPositionals: true, options: {
    help: { type: 'boolean' }, source: { type: 'string' }, commit: { type: 'string' }, out: { type: 'string' }, roots: { type: 'string', multiple: true },
  } })
  if (values.help) {
    console.log('capture-runtime.mjs inspect|capture --source <absolute-clean-checkout> --commit <full-sha> [--roots <package> ...] [--out <new-absolute-directory>]\ncapture-runtime.mjs verify --out <capture-directory>')
    return
  }
  if (positionals.length !== 1) fail('invalid_arguments')
  const options = { sourceRoot: values.source, sourceCommit: values.commit, roots: values.roots, output: values.out }
  if (positionals[0] === 'inspect') console.log(JSON.stringify(inspectTrialRuntime(options), null, 2))
  else if (positionals[0] === 'capture') {
    const record = captureTrialRuntime(options)
    console.log(JSON.stringify({ output: values.out, sourceCommit: record.sourceCommit, packages: record.packages.length, ...record.totals, paths: record.paths }))
  } else if (positionals[0] === 'verify') {
    const record = verifyTrialRuntime(values.out)
    console.log(JSON.stringify({ verified: true, sourceCommit: record.sourceCommit, packages: record.packages.length, ...record.totals }))
  } else fail('invalid_arguments')
}

if (process.argv[1] && realpathSync(process.argv[1]) === fileURLToPath(import.meta.url)) {
  try { main() } catch (error) {
    // Public operator failures disclose codes, never package contents or ambient stderr.
    console.error(JSON.stringify(error.message?.startsWith('trial_runtime_') ? { error: error.message, details: error.details }
      : { error: `trial_runtime_${error.code ?? 'capture_failed'}` }))
    process.exitCode = 1
  }
}
