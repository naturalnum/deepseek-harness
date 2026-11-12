/** Linux product-file replacement and rollback for an existing stopped installation. */
const fs = require('node:fs')
const path = require('node:path')
const { createHash, randomUUID } = require('node:crypto')
const { execFileSync } = require('node:child_process')

const digest = bytes => createHash('sha256').update(bytes).digest('hex')
const runCommand = (name, args, options = {}) => execFileSync(name, args, { stdio: ['pipe', 'pipe', 'pipe'], ...options })
const protectedPath = name => name.split('/').includes('node_modules') || name.endsWith('.node')

function relativePath(name) {
  if (typeof name !== 'string' || name === '' || path.isAbsolute(name) || name.includes('\\')
    || name.includes('\0') || name.split('/').some(part => part === '' || part === '.' || part === '..')) {
    throw new Error('Product paths must be relative file names.')
  }
  return name
}

function writablePath(name) {
  relativePath(name)
  if (protectedPath(name)) throw new Error('Native modules and dependency directories are not managed product files.')
  return name
}

/** Inspect every component without following a target or parent symlink; absence is allowed. */
function inspect(root, name) {
  relativePath(name)
  let current = root
  const base = fs.lstatSync(root)
  if (!base.isDirectory() || base.isSymbolicLink()) throw new Error('Product root must be an ordinary directory.')
  const parts = name.split('/')
  for (const [index, part] of parts.entries()) {
    current = path.join(current, part)
    let info
    try { info = fs.lstatSync(current) } catch (error) {
      if (error.code === 'ENOENT') return undefined
      throw error
    }
    if (info.isSymbolicLink() || index < parts.length - 1 && !info.isDirectory()) {
      throw new Error('Managed paths must not traverse symbolic links or non-directories.')
    }
    if (index === parts.length - 1) return info
  }
}

function metadata(root, name) {
  const info = inspect(root, name)
  if (!info?.isFile()) throw new Error('A managed product file is missing or is not a regular file.')
  const bytes = fs.readFileSync(path.join(root, name))
  return { path: name, size: bytes.length, mode: info.mode & 0o777, sha256: digest(bytes) }
}

function verifyFiles(root, files) {
  for (const expected of files) {
    writablePath(expected.path)
    const actual = metadata(root, expected.path)
    if (actual.size !== expected.size || actual.sha256 !== expected.sha256 || actual.mode !== expected.mode) {
      throw new Error('Product file bytes or permissions differ from the manifest.')
    }
  }
}

/** Collect old regular files in managed roots, plus exact new targets such as package manifests. */
function collectManagedFiles(root, roots, nextFiles = []) {
  const selected = new Set()
  function visit(name) {
    relativePath(name)
    if (protectedPath(name)) return
    let info
    try { info = fs.lstatSync(path.join(root, name)) } catch (error) {
      if (error.code === 'ENOENT') return
      throw error
    }
    // Unselected links remain untouched; selected destinations are rejected by inspect below.
    if (info.isSymbolicLink()) return
    inspect(root, name)
    if (info.isFile()) selected.add(name)
    else if (info.isDirectory()) for (const child of fs.readdirSync(path.join(root, name))) visit(`${name}/${child}`)
    else throw new Error('Managed product roots contain a special file.')
  }
  for (const name of roots) visit(name)
  for (const row of nextFiles) {
    writablePath(row.path)
    const info = inspect(root, row.path)
    if (info !== undefined) {
      if (!info.isFile()) throw new Error('A new product destination is not a regular file.')
      selected.add(row.path)
    }
  }
  return [...selected].sort().map(name => metadata(root, name))
}

/** Classify byte/permission changes separately from added and stale managed files. */
function planUpdate(oldFiles, nextFiles) {
  const old = new Map(oldFiles.map(row => [writablePath(row.path), row]))
  const next = new Map(nextFiles.map(row => [writablePath(row.path), row]))
  const changed = [], added = [], removed = []
  for (const [name, row] of next) {
    const previous = old.get(name)
    if (!previous) added.push(name)
    else if (previous.sha256 !== row.sha256 || previous.size !== row.size || previous.mode !== row.mode) changed.push(name)
  }
  for (const name of old.keys()) if (!next.has(name)) removed.push(name)
  return { changed: changed.sort(), added: added.sort(), removed: removed.sort() }
}

function createParents(root, name) {
  let current = root
  for (const part of name.split('/').slice(0, -1)) {
    current = path.join(current, part)
    try { fs.mkdirSync(current, { mode: 0o755 }) } catch (error) { if (error.code !== 'EEXIST') throw error }
    const info = fs.lstatSync(current)
    if (!info.isDirectory() || info.isSymbolicLink()) throw new Error('Product parent must be an ordinary directory.')
  }
}

/** Replace files with same-directory atomic renames and remove only explicitly managed stale files. */
function installFiles({ productRoot, sourceRoot, files, remove = [] }) {
  verifyFiles(sourceRoot, files)
  for (const row of files) {
    const info = inspect(productRoot, row.path)
    if (info !== undefined && !info.isFile()) throw new Error('Product destination is not a regular file.')
  }
  for (const name of remove) {
    writablePath(name)
    const info = inspect(productRoot, name)
    if (info !== undefined && !info.isFile()) throw new Error('Only old regular files can be removed.')
  }
  for (const row of files) {
    createParents(productRoot, row.path)
    const destination = path.join(productRoot, row.path)
    const temporary = path.join(path.dirname(destination), `.pe-product-${randomUUID()}.tmp`)
    try {
      const fd = fs.openSync(temporary, fs.constants.O_WRONLY | fs.constants.O_CREAT | fs.constants.O_EXCL | fs.constants.O_NOFOLLOW, 0o600)
      try {
        fs.writeFileSync(fd, fs.readFileSync(path.join(sourceRoot, row.path)))
        fs.fchmodSync(fd, row.mode)
        fs.fsyncSync(fd)
      } finally { fs.closeSync(fd) }
      fs.renameSync(temporary, destination)
    } finally { fs.rmSync(temporary, { force: true }) }
    const parent = fs.openSync(path.dirname(destination), fs.constants.O_RDONLY | fs.constants.O_DIRECTORY)
    try { fs.fsyncSync(parent) } finally { fs.closeSync(parent) }
  }
  for (const name of remove) {
    try { fs.unlinkSync(path.join(productRoot, name)) } catch (error) { if (error.code !== 'ENOENT') throw error }
  }
  verifyFiles(productRoot, files)
}

function extract(archive, destination, run) {
  fs.mkdirSync(destination, { mode: 0o700 })
  run('tar', ['-xzf', archive, '-C', destination])
}

/** Reuse an existing ordinary restore directory only after rechecking every old file. */
function prepareRestoreSource(backupDir, oldFiles, run = runCommand) {
  const source = path.join(backupDir, 'old')
  let info
  try { info = fs.lstatSync(source) } catch (error) {
    if (error.code !== 'ENOENT') throw error
  }
  if (info === undefined) extract(path.join(backupDir, 'old.tar.gz'), source, run)
  else if (!info.isDirectory() || info.isSymbolicLink()) throw new Error('Restore source must be an ordinary directory.')
  verifyFiles(source, oldFiles)
  return source
}

/** Prepare staged bytes and a functional rollback record without writing the product mount. */
function prepare(input, run = runCommand) {
  const { productRoot, archivePath, manifest, backupDir } = input
  fs.mkdirSync(backupDir, { recursive: true, mode: 0o700 })
  if (!fs.lstatSync(backupDir).isDirectory() || fs.lstatSync(backupDir).isSymbolicLink()
    || fs.existsSync(path.join(backupDir, 'rollback.json')) || fs.existsSync(path.join(backupDir, 'old.tar.gz'))) {
    throw new Error('A fresh ordinary rollback directory is required.')
  }
  const source = path.join(backupDir, 'new')
  extract(archivePath, source, run)
  verifyFiles(source, manifest.files)
  const oldFiles = collectManagedFiles(productRoot, manifest.managedRoots, manifest.files)
  const plan = planUpdate(oldFiles, manifest.files)
  run('tar', ['-czf', path.join(backupDir, 'old.tar.gz'), '-C', productRoot, '--null', '-T', '-'], {
    input: Buffer.from(oldFiles.map(row => row.path).join('\0') + (oldFiles.length ? '\0' : '')),
  })
  const state = { format: 'pe-cloud-product-rollback/v1', oldFiles, nextFiles: manifest.files, plan }
  fs.writeFileSync(path.join(backupDir, 'rollback.json'), `${JSON.stringify(state)}\n`, { mode: 0o600, flag: 'wx' })
  return summary('prepare', state)
}

function assertStopped(namespaceId) {
  if (fs.readlinkSync('/proc/self/ns/mnt') !== namespaceId) throw new Error('Product mount namespace differs from the selected installation.')
  for (const pid of fs.readdirSync('/proc').filter(name => /^\d+$/.test(name))) {
    let argv
    try { argv = fs.readFileSync(`/proc/${pid}/cmdline`, 'utf8').split('\0') } catch (error) {
      if (error.code === 'ENOENT' || error.code === 'ESRCH') continue
      throw error
    }
    if (argv.some(value => value === 'apps/cli/lib/bin.js' || value.endsWith('/apps/cli/lib/bin.js'))) {
      throw new Error('The application must be stopped before product replacement.')
    }
  }
}

/** Restore both mount and block-device read-only state even after replacement or reseal failure. */
function withWritableRoot(input, action, run = runCommand) {
  const { productRoot, productDevice } = input
  const sealed = () => String(run('blockdev', ['--getro', productDevice])).trim() === '1'
    && String(run('findmnt', ['-n', '-o', 'OPTIONS', '--target', productRoot])).trim().split(',').includes('ro')
  if (!sealed()) throw new Error('Product mount and device must initially be read-only.')
  const failures = []
  try {
    run('blockdev', ['--setrw', productDevice])
    run('mount', ['-o', 'remount,rw', productRoot])
    action()
    run('sync', [])
  } catch (error) { failures.push(error) }
  finally {
    try { run('mount', ['-o', 'remount,ro', productRoot]) } catch (error) { failures.push(error) }
    try { run('blockdev', ['--setro', productDevice]) } catch (error) { failures.push(error) }
    try { if (!sealed()) throw new Error('Product read-only restoration is unconfirmed.') } catch (error) { failures.push(error) }
  }
  if (failures.length) throw new AggregateError(failures, 'Product replacement or read-only restoration failed.')
}

function summary(mode, state) {
  const restoring = mode === 'restore'
  return { mode, files: mode === 'restore' ? state.oldFiles.length : state.nextFiles.length,
    changed: state.plan.changed.length, added: (restoring ? state.plan.removed : state.plan.added).length,
    removed: (restoring ? state.plan.added : state.plan.removed).length }
}

/** Execute one Linux operation; archive integrity has already been checked by the caller's bundle verifier. */
function execute(input, run = runCommand) {
  if (input.mode === 'prepare') return prepare(input, run)
  if (!['install', 'restore'].includes(input.mode)) throw new Error('Unsupported product-file operation.')
  const state = JSON.parse(fs.readFileSync(path.join(input.backupDir, 'rollback.json'), 'utf8'))
  if (state.format !== 'pe-cloud-product-rollback/v1') throw new Error('Unsupported rollback record.')
  const restoring = input.mode === 'restore'
  const source = restoring ? prepareRestoreSource(input.backupDir, state.oldFiles, run) : path.join(input.backupDir, 'new')
  const files = restoring ? state.oldFiles : state.nextFiles
  if (!restoring) verifyFiles(source, files)
  assertStopped(input.namespaceId)
  const writeNames = new Set([...state.plan.changed, ...(restoring ? state.plan.removed : state.plan.added)])
  withWritableRoot(input, () => {
    installFiles({ productRoot: input.productRoot, sourceRoot: source,
      files: files.filter(row => writeNames.has(row.path)), remove: restoring ? state.plan.added : state.plan.removed })
    verifyFiles(input.productRoot, files)
  }, run)
  return summary(input.mode, state)
}

module.exports = { collectManagedFiles, planUpdate, installFiles, prepare, prepareRestoreSource, execute, withWritableRoot }

if (require.main === module) {
  let input = ''
  process.stdin.setEncoding('utf8')
  process.stdin.on('data', chunk => { input += chunk })
  process.stdin.on('end', () => {
    try { console.log(JSON.stringify(execute(JSON.parse(input)))) }
    catch (_error) {
      console.error('产品文件操作失败；请检查归档、应用停止状态及只读恢复。')
      process.exitCode = 1
    }
  })
}
