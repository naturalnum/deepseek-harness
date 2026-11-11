/** Build a product update for an existing Linux installation, retaining its native dependencies. */
import { createHash } from 'node:crypto'
import { execFileSync, spawn } from 'node:child_process'
import { createReadStream } from 'node:fs'
import { lstat, mkdir, mkdtemp, readFile, readdir, realpath, rename, rm, unlink, writeFile } from 'node:fs/promises'
import { dirname, isAbsolute, join, matchesGlob, relative, resolve, sep } from 'node:path'
import { fileURLToPath } from 'node:url'
import { create, list } from 'tar'
import { load } from 'js-yaml'

const RESEARCH = 'integrations/epri-research'
const WORKSPACE_MANIFEST = /^(?:packages\/[^/]+\/[^/]+|vendor\/[^/]+|apps\/[^/]+)\/package\.json$/
const sourceOnly = /^(?:src|tests?|docs|native)(?:\/|$)|\.(?:spec|test)\.[cm]?[jt]sx?$/
const checksum = bytes => createHash('sha256').update(bytes).digest('hex')

function sortedValue(value) {
  if (Array.isArray(value)) return value.map(sortedValue)
  if (value === null || typeof value !== 'object') return value
  return Object.fromEntries(Object.keys(value).sort().map(key => [key, sortedValue(value[key])]))
}

/**
 * Hash external package resolutions and dependency edges, ignoring workspace importers and YAML formatting.
 * @param {string | object} lockfile - pnpm lockfile YAML or its parsed contents.
 * @returns {string} SHA-256 of recursively sorted packages and snapshots.
 */
export function externalDependencyHash(lockfile) {
  const parsed = typeof lockfile === 'string' ? load(lockfile) : lockfile
  if (!parsed || typeof parsed.packages !== 'object' || parsed.packages === null || Array.isArray(parsed.packages)
    || typeof parsed.snapshots !== 'object' || parsed.snapshots === null || Array.isArray(parsed.snapshots)) {
    throw new Error('pnpm 依赖清单缺少 packages 或 snapshots。')
  }
  return checksum(JSON.stringify(sortedValue({ packages: parsed.packages, snapshots: parsed.snapshots })))
}

function excluded(path) {
  return path.split('/').some(part => ['node_modules', '.git', '.private', '__pycache__'].includes(part)
    || part === '.env' || part.startsWith('.env.') || part.includes('.private.'))
    || path.endsWith('.node') || path.endsWith('.pyc')
}

function safePath(path) {
  return typeof path === 'string' && path !== '' && !isAbsolute(path) && !path.includes('\\')
    && !path.includes('\0') && !path.split('/').some(part => part === '' || part === '.' || part === '..')
    && /^(?:packages\/[^/]+\/[^/]+|vendor\/[^/]+|apps\/[^/]+|integrations\/epri-research)\//.test(path)
    && !excluded(path)
}

async function regularFile(root, path) {
  let current = root
  const parts = path.split('/')
  for (const [index, part] of parts.entries()) {
    current = join(current, part)
    const info = await lstat(current)
    if (info.isSymbolicLink() || (index < parts.length - 1 && !info.isDirectory())) return false
    if (index === parts.length - 1) return info.isFile()
  }
  return false
}

async function collectBuilt(root, path, selected) {
  if (excluded(path)) return
  let info
  try { info = await lstat(join(root, path)) } catch (error) {
    if (error.code === 'ENOENT') return
    throw error
  }
  if (info.isSymbolicLink()) return
  if (info.isFile()) selected.add(path)
  else if (info.isDirectory()) {
    for (const child of await readdir(join(root, path))) await collectBuilt(root, `${path}/${child}`, selected)
  }
}

function published(path, patterns) {
  const ancestors = path.split('/').map((_part, index, parts) => parts.slice(0, index + 1).join('/'))
  const matches = pattern => ancestors.some(parent => matchesGlob(parent, pattern.replace(/^\.\//, '')))
  return patterns.some(pattern => !pattern.startsWith('!') && matches(pattern))
    && !patterns.some(pattern => pattern.startsWith('!') && matches(pattern.slice(1)))
}

/**
 * Select built JavaScript and tracked package resources without following links or copying native modules.
 * @param {string} root - Worktree directory.
 * @param {string[]} trackedPaths - Git-tracked paths, supplied separately for fixture tests.
 * @returns {Promise<string[]>} Sorted relative regular-file paths.
 */
export async function collectProductPaths(root, trackedPaths) {
  const selected = new Set()
  const manifests = trackedPaths.filter(path => WORKSPACE_MANIFEST.test(path))
  for (const manifestPath of manifests) {
    if (!await regularFile(root, manifestPath)) continue
    const packageRoot = dirname(manifestPath)
    const manifest = JSON.parse(await readFile(join(root, manifestPath), 'utf8'))
    selected.add(manifestPath)
    await collectBuilt(root, `${packageRoot}/lib`, selected)
    const patterns = manifest.files ?? []
    for (const path of trackedPaths) {
      if (!path.startsWith(`${packageRoot}/`) || excluded(path)) continue
      const name = path.slice(packageRoot.length + 1)
      if (!sourceOnly.test(name) && published(name, patterns) && await regularFile(root, path)) selected.add(path)
    }
  }
  await collectBuilt(root, 'apps/web/dist', selected)
  await collectBuilt(root, `${RESEARCH}/dist`, selected)
  for (const path of trackedPaths) {
    if (!path.startsWith(`${RESEARCH}/`) || excluded(path)) continue
    const name = path.slice(RESEARCH.length + 1)
    // Tests inside an imported skill remain part of its immutable resource tree.
    if (/^(?:plugins|src|upstream|examples|licenses)\//.test(name)
      || ['package.json', 'cordis.patch.yml', 'cordis.cloud.patch.yml', 'LICENSE', 'NOTICE'].includes(name)) {
      if (await regularFile(root, path)) selected.add(path)
    }
  }
  return [...selected].filter(safePath).sort()
}

async function fileDigest(path) {
  const hash = createHash('sha256')
  for await (const chunk of createReadStream(path)) hash.update(chunk)
  return hash.digest('hex')
}

function managedRoots(paths) {
  const roots = new Set()
  for (const path of paths) {
    const research = path.match(/^integrations\/epri-research\/(dist|plugins|src|upstream|examples|licenses)\//)
    const workspace = path.match(/^((?:packages\/[^/]+\/[^/]+|vendor\/[^/]+|apps\/[^/]+))\/([^/]+)\//)
    if (research) roots.add(`${RESEARCH}/${research[1]}`)
    else if (workspace) {
      const resource = workspace[2] === 'runtime' ? path.split('/').slice(0, -1).join('/') : `${workspace[1]}/${workspace[2]}`
      roots.add(resource)
    }
  }
  return [...roots].sort()
}

/**
 * Check that the archive contains exactly the regular files, bytes and modes named by its manifest.
 * @param {string} directory - Bundle directory containing manifest.json and products.tar.gz.
 * @returns {Promise<object>} Verified manifest; no archive member is extracted.
 */
export async function verifyBundle(directory) {
  const manifest = JSON.parse(await readFile(join(directory, 'manifest.json'), 'utf8'))
  if (manifest.format !== 'pe-cloud-update/v1' || !Array.isArray(manifest.files)) throw new Error('产品包清单格式不正确。')
  const expected = new Map()
  for (const row of manifest.files) {
    if (!safePath(row.path) || expected.has(row.path)) throw new Error('产品包清单包含不允许或重复的路径。')
    expected.set(row.path, row)
  }
  if (JSON.stringify(manifest.managedRoots) !== JSON.stringify(managedRoots([...expected.keys()]))) {
    throw new Error('受管理目录与产品文件清单不一致。')
  }
  const seen = new Set()
  const failures = []
  await list({ file: join(directory, 'products.tar.gz'), strict: true, onReadEntry(entry) {
    const row = expected.get(entry.path)
    if (!row || seen.has(entry.path) || entry.type !== 'File') {
      failures.push('归档包含清单之外、重复或非普通文件的成员。')
      return
    }
    seen.add(entry.path)
    const hash = createHash('sha256')
    entry.on('data', chunk => hash.update(chunk))
    entry.on('end', () => {
      if (entry.size !== row.size || (entry.mode & 0o777) !== row.mode || hash.digest('hex') !== row.sha256) {
        failures.push(`归档文件与清单不一致：${entry.path}`)
      }
    })
  } })
  if (failures.length || seen.size !== expected.size) throw new Error(failures[0] ?? '归档缺少清单中的文件。')
  return manifest
}

/**
 * Write and verify an update archive and its file manifest outside the worktree.
 * @param {string} root - Product source directory.
 * @param {string[]} paths - Selected relative regular-file paths.
 * @param {object} metadata - Source commit, Node version and lockfile digests.
 * @param {string} output - Destination directory outside the source tree.
 * @returns {Promise<object>} Written manifest.
 */
export async function writeBundle(root, paths, metadata, output) {
  const source = await realpath(root)
  await mkdir(output, { recursive: true })
  const destination = await realpath(output)
  const fromSource = relative(source, destination)
  if (fromSource !== '..' && !fromSource.startsWith(`..${sep}`) && !isAbsolute(fromSource)) {
    throw new Error('产品包输出目录必须在仓库之外。')
  }
  const files = []
  for (const path of [...paths].sort()) {
    if (!safePath(path) || !await regularFile(source, path)) throw new Error('产品包只能包含安全的相对普通文件。')
    const info = await lstat(join(source, path))
    files.push({ path, size: info.size, mode: info.mode & 0o777, sha256: await fileDigest(join(source, path)) })
  }
  // Exact managed files are the rows below; roots additionally identify stale output files to remove.
  const manifest = { format: 'pe-cloud-update/v1', ...metadata, managedRoots: managedRoots(paths), files }
  const temporary = await mkdtemp(join(destination, '.bundle-'))
  try {
    await create({ cwd: source, file: join(temporary, 'products.tar.gz'), gzip: true,
      portable: true, noMtime: true, noDirRecurse: true, strict: true }, files.map(row => row.path))
    await writeFile(join(temporary, 'manifest.json'), `${JSON.stringify(manifest, null, 2)}\n`)
    await verifyBundle(temporary)
    await rename(join(temporary, 'products.tar.gz'), join(destination, 'products.tar.gz'))
    await rename(join(temporary, 'manifest.json'), join(destination, 'manifest.json'))
  } finally {
    await rm(temporary, { recursive: true, force: true })
  }
  return manifest
}

async function command(executable, args, cwd) {
  await new Promise((resolveCommand, reject) => {
    const child = spawn(executable, args, { cwd, stdio: 'inherit' })
    child.once('error', reject)
    child.once('exit', (code, signal) => code === 0 ? resolveCommand() : reject(new Error(`${executable} 未成功结束（${signal ?? code}）。`)))
  })
}

async function buildProducts(root) {
  await command('pnpm', ['run', 'build:artifacts'], root)
  await command('pnpm', ['run', 'build:check'], root)
  const research = join(root, RESEARCH)
  const manifest = JSON.parse(await readFile(join(research, 'package.json'), 'utf8'))
  // End the previous development-link phase before reinstalling this package's own dependencies.
  for (const name of Object.keys(manifest.peerDependencies ?? {})) {
    const path = join(research, 'node_modules', name)
    try { if ((await lstat(path)).isSymbolicLink()) await unlink(path) } catch (error) {
      if (error.code !== 'ENOENT') throw error
    }
  }
  await command('npm', ['ci', '--omit=peer'], research)
  await command(process.execPath, ['scripts/link-cloud-peers.mjs'], research)
  await command(process.execPath, ['scripts/build.mjs'], research)
}

async function main(argv) {
  if (argv.includes('--help')) {
    console.log('用法：deploy/bundle [--output 仓库外目录]\n在 Node 24.19.0 下完整构建并生成现有安装的产品更新包；保留目标环境的 Linux 原生模块与依赖。')
    return
  }
  if (argv.length !== 0 && (argv.length !== 2 || argv[0] !== '--output')) throw new Error('只支持 --output 参数。')
  if (process.versions.node !== '24.19.0') throw new Error('请使用 Node 24.19.0 运行产品打包。')
  const root = resolve(dirname(fileURLToPath(import.meta.url)), '..')
  const git = args => execFileSync('git', args, { cwd: root, encoding: 'utf8' }).trim()
  git(['diff', '--exit-code', '--quiet', 'HEAD', '--', 'packages', 'apps', 'vendor', 'integrations', 'package.json', 'pnpm-lock.yaml'])
  const sourceCommit = git(['rev-parse', 'HEAD'])
  const output = resolve(argv[1] ?? join(dirname(root), 'bundles', git(['rev-parse', '--short', 'HEAD'])))
  await buildProducts(root)
  const paths = await collectProductPaths(root, git(['ls-files', '-z']).split('\0').filter(Boolean))
  const pnpmLock = await readFile(join(root, 'pnpm-lock.yaml'), 'utf8')
  const pnpmLockHash = checksum(pnpmLock)
  const researchLockHash = checksum(await readFile(join(root, RESEARCH, 'package-lock.json')))
  const manifest = await writeBundle(root, paths, { sourceCommit, nodeVersion: process.versions.node,
    pnpmLockHash, externalDependencyHash: externalDependencyHash(pnpmLock), researchLockHash,
    dependencyHash: checksum(`${pnpmLockHash}\n${researchLockHash}\n`) }, output)
  console.log(`产品更新包：${output}（${manifest.files.length} 个文件）`)
}

if (process.argv[1] && resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  main(process.argv.slice(2)).catch(error => { console.error(`打包失败：${error.message}`); process.exitCode = 1 })
}
