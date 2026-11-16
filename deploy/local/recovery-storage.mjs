/** Restore only the original ext4 domains recorded by the existing static v3 provisioner. */
import fs from 'node:fs'
import { posix } from 'node:path'
import { execFileSync } from 'node:child_process'
import { createHash } from 'node:crypto'
import { createRequire } from 'node:module'
import { fileURLToPath } from 'node:url'
import { CandidateError } from './inspect.mjs'

const fail = () => { throw new CandidateError('原存储身份或恢复结果未确认；保留现场，不换设备号、不重新分配。') }
const absolute = value => typeof value === 'string' && /^\/[A-Za-z0-9_./-]+$/.test(value)
  && value !== '/' && posix.normalize(value) === value
const numeric = value => typeof value === 'string' && /^\d+$/.test(value)
const digest = bytes => createHash('sha256').update(bytes).digest('hex')
const options = ['ro', 'rw', 'nodev', 'nosuid', 'noexec', 'relatime', 'noatime']

function domains(owner) {
  if (owner?.schema !== 'dsh-static-storage-v3-owner/v1' || owner.phase !== 'preallocated-and-measured-not-activated'
    || !/^[a-f0-9]{8}-[a-f0-9]{4}-4[a-f0-9]{3}-[89ab][a-f0-9]{3}-[a-f0-9]{12}$/.test(owner.resourceId)
    || !Array.isArray(owner.domains) || owner.domains.length !== 11 || !Array.isArray(owner.slots) || owner.slots.length !== 3) fail()
  const roles = ['arena', 'control', ...owner.slots.flatMap(slot => {
    if (!/^[A-Za-z0-9_-]{1,64}$/.test(slot?.slotId)) fail()
    return ['private', 'projects', 'environments/slot-0'].map(kind => slot.slotId + '/' + kind)
  })]
  const rows = roles.map((role, index) => {
    const found = owner.domains.filter(row => row.role === role)
    if (found.length !== 1) fail()
    const row = found[0]
    if (!absolute(row.image) || !absolute(row.mountPath) || !row.mountPath.startsWith('/srv/dsh-features-' + owner.resourceId + '/')
      || !/^\/dev\/loop(?:0|[1-9]\d*)$/.test(row.loop) || Number(row.loop.slice(9)) > 4095
      || !['device', 'inode', 'backingDevice', 'backingInode', 'backingBytes', 'filesystemBytes', 'filesystemInodes'].every(key => numeric(row[key]))
      || row.inode !== '2' || (row.account === true) !== (index >= 2)
      || (row.executable === true) !== role.endsWith('/environments/slot-0')) fail()
    return row
  })
  for (const key of ['role', 'image', 'mountPath', 'loop']) if (new Set(rows.map(row => row[key])).size !== rows.length) fail()
  const arena = rows[0]
  if (arena.image.startsWith('/srv/dsh-features-' + owner.resourceId + '/')
    || rows.slice(1).some(row => !row.image.startsWith(arena.mountPath + '/backings/') || row.backingDevice !== arena.device)) fail()
  return rows
}

function mountRows(text) {
  const decode = value => value.replace(/\\([0-7]{3})/g, (_match, octal) => String.fromCharCode(Number.parseInt(octal, 8)))
  return text.trim().split('\n').map(line => {
    const [left, right] = line.split(' - '), parts = left.split(' '), tail = right?.split(' ')
    if (parts.length < 6 || !tail || tail.length < 3) fail()
    return { path: decode(parts[4]), root: decode(parts[3]), device: parts[2], options: parts[5].split(','), filesystem: tail[0], source: decode(tail[1]) }
  })
}

function linuxIo() {
  const run = (command, argv) => execFileSync(command, argv, { encoding: 'utf8', maxBuffer: 1048576, stdio: ['ignore', 'pipe', 'pipe'] }).trim()
  const stat = path => fs.lstatSync(path, { bigint: true })
  const protectedParent = path => {
    for (let parent = posix.dirname(path); parent !== '/'; parent = posix.dirname(parent)) {
      const info = stat(parent)
      if (!info.isDirectory() || info.isSymbolicLink() || info.uid !== 0n || (info.mode & 0o022n) !== 0n) fail()
    }
  }
  const protectedBytes = (path, maximum = 16777216) => {
    if (!absolute(path)) fail()
    protectedParent(path)
    const fd = fs.openSync(path, fs.constants.O_RDONLY | fs.constants.O_NOFOLLOW)
    try {
      const before = fs.fstatSync(fd)
      if (!before.isFile() || before.nlink !== 1 || before.uid !== 0 || (before.mode & 0o022) !== 0
        || before.size < 1 || before.size > maximum) fail()
      const bytes = fs.readFileSync(fd), after = fs.fstatSync(fd), named = fs.lstatSync(path)
      if (['dev', 'ino', 'size', 'mtimeMs', 'ctimeMs'].some(key => before[key] !== after[key] || after[key] !== named[key])) fail()
      return bytes
    } finally { fs.closeSync(fd) }
  }
  return {
    platform: () => process.platform === 'linux' && process.getuid() === 0,
    mounts: pid => mountRows(fs.readFileSync('/proc/' + (pid === undefined ? 'self' : pid) + '/mountinfo', 'utf8')),
    loops: () => {
      const rows = JSON.parse(run('losetup', ['--list', '--json', '--output', 'NAME,BACK-FILE,RO'])).loopdevices
      if (!Array.isArray(rows)) fail()
      return rows
    },
    backing: path => {
      protectedParent(path)
      const info = stat(path)
      if (!info.isFile() || info.isSymbolicLink() || info.nlink !== 1n || info.uid !== 0n || (info.mode & 0o7777n) !== 0o600n) fail()
      return { device: String(info.dev), inode: String(info.ino), bytes: String(info.size) }
    },
    uuid: path => run('blkid', ['-p', '-s', 'UUID', '-o', 'value', path]),
    domain: path => {
      const info = stat(path), geometry = fs.statfsSync(path, { bigint: true })
      if (!info.isDirectory() || info.isSymbolicLink() || geometry.type !== 0xef53n) fail()
      return { device: String(info.dev), inode: String(info.ino), uid: Number(info.uid), gid: Number(info.gid),
        mode: Number(info.mode & 0o7777n), filesystemBytes: String(geometry.blocks * geometry.bsize), filesystemInodes: String(geometry.files) }
    },
    productDirectory: path => {
      if (!absolute(path)) fail()
      protectedParent(path)
      const info = stat(path)
      if (!info.isDirectory() || info.isSymbolicLink() || info.uid !== 0n || info.gid !== 0n || (info.mode & 0o022n) !== 0n) fail()
      return { device: String(info.dev), inode: String(info.ino), uid: Number(info.uid), gid: Number(info.gid), mode: Number(info.mode & 0o7777n) }
    },
    productPins: (reference, installAnchor) => {
      if (!absolute(reference?.path) || !/^[a-f0-9]{64}$/.test(reference.sha256) || !absolute(installAnchor)) fail()
      const bytes = protectedBytes(reference.path)
      if (digest(bytes) !== reference.sha256) fail()
      const manifest = JSON.parse(bytes), root = posix.dirname(installAnchor)
      if (manifest.format !== 'pe-cloud-update/v1' || !/^[a-f0-9]{40}$/.test(manifest.sourceCommit)
        || !Array.isArray(manifest.files) || !manifest.files.length || manifest.files.length > 50000
        || new Set(manifest.files.map(row => row.path)).size !== manifest.files.length) fail()
      const modulePath = root + '/deploy/local/product-files.cjs', moduleBytes = protectedBytes(modulePath)
      const { collectManagedFiles } = createRequire(installAnchor)(modulePath)
      const actual = collectManagedFiles(root, [], manifest.files), expected = new Map(manifest.files.map(row => [row.path, row]))
      if (actual.length !== expected.size) fail()
      for (const row of actual) {
        const pin = expected.get(row.path), path = root + '/' + row.path
        if (!pin || ['size', 'mode', 'sha256'].some(key => pin[key] !== row[key])) fail()
        protectedParent(path)
        const info = stat(path)
        if (!info.isFile() || info.isSymbolicLink() || info.uid !== 0n || info.nlink !== 1n || (info.mode & 0o022n) !== 0n) fail()
      }
      return { manifestSha256: reference.sha256, sourceCommit: manifest.sourceCommit, files: actual.length,
        productFilesModuleSha256: digest(moduleBytes), anchorSha256: digest(protectedBytes(installAnchor)),
        sourcePackageSha256: digest(protectedBytes(root + '/SOURCE-PACKAGE.json')),
        assemblySha256: digest(protectedBytes(root + '/PRODUCT-ASSEMBLY.json')) }
    },
    verifier: () => { const path = fileURLToPath(import.meta.url); return { path, sha256: digest(protectedBytes(path)) } },
    bindProduct: row => run('mount', ['--bind', row.sourcePath, row.mountPath]),
    protectProduct: row => run('mount', ['-o', ['remount', 'bind', ...row.mountOptions].join(','), row.mountPath]),
    bind: row => {
      const minor = Number(row.loop.slice(9))
      if (fs.readFileSync('/sys/class/block/loop' + minor + '/dev', 'utf8').trim() !== '7:' + minor) fail()
      let info
      try { info = stat(row.loop) } catch (error) { if (error.code !== 'ENOENT') throw error }
      if (!info) { run('mknod', ['-m', '0600', row.loop, 'b', '7', String(minor)]); info = stat(row.loop) }
      const expected = (7n << 8n) | (BigInt(minor) & 255n) | ((BigInt(minor) & ~255n) << 12n)
      if (!info.isBlockDevice() || info.rdev !== expected || info.uid !== 0n || info.gid !== 0n || (info.mode & 0o7777n) !== 0o600n) fail()
      run('losetup', ['--nooverlap', ...(row.readOnly === true ? ['--read-only'] : []), row.loop, row.image])
    },
    mount: row => {
      protectedParent(row.mountPath)
      const info = stat(row.mountPath)
      if (!info.isDirectory() || info.isSymbolicLink() || info.uid !== 0n || fs.readdirSync(row.mountPath).length !== 0) fail()
      run('mount', ['-t', 'ext4', '-o', [...row.mountOptions, 'nodiscard'].join(','), row.loop, row.mountPath])
    },
  }
}

function backingMatches(row, observed) {
  return observed.device === row.backingDevice && observed.inode === row.backingInode && observed.bytes === row.backingBytes
}

function mounted(row, io, retained) {
  const matches = io.mounts().filter(mount => mount.path === row.mountPath)
  if (!matches.length) return false
  if (matches.length !== 1 || matches[0].root !== '/' || matches[0].filesystem !== 'ext4' || matches[0].source !== row.loop) fail()
  const info = io.domain(row.mountPath)
  if (['device', 'inode', 'filesystemBytes', 'filesystemInodes'].some(key => info[key] !== row[key])) fail()
  if (retained && (['uid', 'gid', 'mode'].some(key => info[key] !== row.rootMetadata[key])
    || row.mountOptions.some(option => !matches[0].options.includes(option))
    || !row.mountOptions.includes('noexec') && matches[0].options.includes('noexec'))) fail()
  return { mount: matches[0], info }
}

function loopReady(row, io) {
  const all = io.loops(), matches = all.filter(loop => loop.name === row.loop)
  if (matches.length > 1) fail()
  for (const loop of all) {
    if (typeof loop['back-file'] !== 'string') fail()
    if (loop.name !== row.loop && loop['back-file'] === row.image) fail()
  }
  if (!matches.length) return false
  const loop = matches[0]
  const readOnly = [true, 1, '1'].includes(loop.ro) ? true : [false, 0, '0'].includes(loop.ro) ? false : null
  if (loop['back-file'] !== row.image || readOnly !== (row.readOnly === true) || io.uuid(row.loop) !== row.fsUuid) fail()
  return true
}

const productMounts = (rows, root) => rows.filter(row => row.path === root || row.path.startsWith(root + '/'))
const mountIdentity = rows => JSON.stringify(rows.map(row => [row.path, row.root, row.device, row.filesystem, row.source,
  options.filter(option => row.options.includes(option)).sort()]).sort())
const mountSource = row => Object.fromEntries(['path', 'root', 'device', 'filesystem', 'source'].map(key => [key, row[key]]))
const parentMount = (rows, path) => rows.filter(row => row.path !== path && path.startsWith(row.path.replace(/\/$/, '') + '/'))
  .sort((a, b) => b.path.length - a.path.length)[0]

function validateProductBind(row) {
  if (row?.kind !== 'bind' || row.role !== 'products' || !absolute(row.installAnchor)
    || row.mountPath !== posix.dirname(row.installAnchor) || row.sourcePath !== row.mountPath
    || !numeric(row.device) || !numeric(row.inode) || !row.rootMetadata || row.rootMetadata.uid !== 0 || row.rootMetadata.gid !== 0
    || !Number.isSafeInteger(row.rootMetadata.mode) || row.rootMetadata.mode < 0 || row.rootMetadata.mode > 0o7777 || (row.rootMetadata.mode & 0o022) !== 0
    || !Array.isArray(row.mountOptions) || row.mountOptions.some(option => !options.includes(option))
    || !row.mountOptions.includes('ro') || row.mountOptions.includes('rw') || !row.sourceMount
    || ![row.sourceMount.path, row.sourceMount.root].every(path => path === '/' || absolute(path))
    || !/^\d+:\d+$/.test(row.sourceMount.device) || !['filesystem', 'source'].every(key => typeof row.sourceMount[key] === 'string' && row.sourceMount[key])
    || !absolute(row.productManifest?.path) || !/^[a-f0-9]{64}$/.test(row.productManifest.sha256)
    || !absolute(row.verifier?.path) || !/^[a-f0-9]{64}$/.test(row.verifier.sha256) || !row.productPins) fail()
}

function productBindMounted(row, io, applicationPid) {
  validateProductBind(row)
  const all = io.mounts(), mounts = productMounts(all, row.mountPath), parent = parentMount(all, row.mountPath)
  if (!parent || JSON.stringify(mountSource(parent)) !== JSON.stringify(row.sourceMount)
    || mounts.length > 1 || mounts.some(mount => mount.path !== row.mountPath)) fail()
  const source = io.productDirectory(row.sourcePath)
  if (source.device !== row.device || source.inode !== row.inode
    || ['uid', 'gid', 'mode'].some(key => source[key] !== row.rootMetadata[key])
    || JSON.stringify(io.productPins(row.productManifest, row.installAnchor)) !== JSON.stringify(row.productPins)
    || JSON.stringify(io.verifier()) !== JSON.stringify(row.verifier)) fail()
  if (applicationPid !== undefined && mountIdentity(productMounts(io.mounts(applicationPid), row.mountPath)) !== mountIdentity(mounts)) fail()
  if (!mounts.length) return false
  const mount = mounts[0], expectedRoot = posix.join(parent.root, posix.relative(parent.path, row.sourcePath))
  if (mount.root !== expectedRoot || ['device', 'filesystem', 'source'].some(key => mount[key] !== parent[key])
    || !mount.options.includes('ro') || mount.options.includes('rw')
    || JSON.stringify(options.filter(option => mount.options.includes(option)).sort()) !== JSON.stringify([...row.mountOptions].sort())) fail()
  return true
}

/**
 * Recheck one captured V3 product self-bind through actual Linux mounts, protected source and normal product pins.
 * @param {object} row Actual captured bind metadata, never a caller-supplied qualification boolean.
 * @param {number} applicationPid Actual application anchor; its product mount must equal the carrier's.
 * @param {object} io Optional focused-test I/O; the CLI and inspector use actual Linux Root observations.
 * @returns {object} A verified bind observation only after every original identity and product pin still matches.
 */
export function inspectRecoveryProductMount(row, applicationPid, io = linuxIo()) {
  if (!io.platform() || !Number.isSafeInteger(applicationPid) || applicationPid <= 0 || !productBindMounted(row, io, applicationPid)) fail()
  return { kind: 'bind', readOnly: true, verified: true }
}

function captureSupport(owner, scope, io) {
  if (!absolute(scope.installAnchor) || !Number.isSafeInteger(scope.applicationPid) || scope.applicationPid <= 0) fail()
  const productRoot = posix.dirname(scope.installAnchor), mounts = io.mounts()
  const privateProducts = io.mounts(scope.applicationPid).filter(row => row.path === productRoot || row.path.startsWith(productRoot + '/'))
  const baseProducts = mounts.filter(row => row.path === productRoot || row.path.startsWith(productRoot + '/'))
  if (scope.productManifest !== undefined && baseProducts.length !== 1) fail()
  if (mountIdentity(privateProducts) !== mountIdentity(baseProducts)) fail()
  const arena = domains(owner)[0]
  const ancestor = mounts.filter(row => arena.image.startsWith(row.path.replace(/\/$/, '') + '/')).sort((a, b) => b.path.length - a.path.length)[0]
  const selected = [], products = []
  if (baseProducts.length) {
    if (baseProducts.length !== 1 || baseProducts[0].path !== productRoot) fail()
    if (baseProducts[0].root === '/' && /^\/dev\/loop\d+$/.test(baseProducts[0].source)) selected.push(['products', baseProducts[0]])
    else {
      const mount = baseProducts[0], parent = parentMount(mounts, productRoot), source = io.productDirectory(productRoot)
      if (!parent) fail()
      const row = { kind: 'bind', role: 'products', installAnchor: scope.installAnchor, sourcePath: productRoot, mountPath: productRoot,
        device: source.device, inode: source.inode, rootMetadata: Object.fromEntries(['uid', 'gid', 'mode'].map(key => [key, source[key]])),
        sourceMount: mountSource(parent), mountOptions: options.filter(option => mount.options.includes(option)),
        productManifest: scope.productManifest, productPins: io.productPins(scope.productManifest, scope.installAnchor), verifier: io.verifier() }
      if (!productBindMounted(row, io, scope.applicationPid)) fail()
      products.push(row)
    }
  }
  if (ancestor?.source?.startsWith('/dev/loop')) selected.push(['arena-parent', ancestor])
  return [...products, ...selected.map(([role, mount]) => {
    if (mount.root !== '/' || mount.filesystem !== 'ext4') fail()
    const loops = io.loops().filter(row => row.name === mount.source)
    if (loops.length !== 1 || typeof loops[0]['back-file'] !== 'string') fail()
    const image = loops[0]['back-file'], backing = io.backing(image), actual = io.domain(mount.path)
    const readOnly = [true, 1, '1'].includes(loops[0].ro) ? true : [false, 0, '0'].includes(loops[0].ro) ? false : null
    if (readOnly === null || readOnly !== (role === 'products') || actual.uid !== 0 || actual.gid !== 0 || actual.mode !== 0o755
      || actual.inode !== '2' || role === 'arena-parent' && actual.device !== arena.backingDevice) fail()
    const row = { kind: 'loop', role, mountPath: mount.path, loop: mount.source, image, readOnly, device: actual.device, inode: actual.inode,
      filesystemBytes: actual.filesystemBytes, filesystemInodes: actual.filesystemInodes,
      backingDevice: backing.device, backingInode: backing.inode, backingBytes: backing.bytes,
      rootMetadata: { uid: actual.uid, gid: actual.gid, mode: actual.mode },
      mountOptions: options.filter(option => mount.options.includes(option)), fsUuid: io.uuid(mount.source) }
    if (!/^[a-f0-9-]{36}$/.test(row.fsUuid) || !loopReady(row, io) || !mounted(row, io, true)) fail()
    return row
  })]
}

function supportRows(snapshot) {
  if (snapshot.support === undefined) return [] // Legacy storage-only captures never claimed runtime support mounts.
  if (!Array.isArray(snapshot.support) || snapshot.support.length > 2 || !absolute(snapshot.supportScope?.installAnchor)) fail()
  const arena = domains(snapshot.owner)[0], seen = new Set()
  for (const row of snapshot.support) {
    if (row?.kind === 'bind') {
      validateProductBind(row)
      if (seen.has(row.role) || row.installAnchor !== snapshot.supportScope.installAnchor) fail()
      seen.add(row.role); continue
    }
    if (row?.kind !== undefined && row.kind !== 'loop') fail()
    if (!['products', 'arena-parent'].includes(row?.role) || seen.has(row.role) || !absolute(row.image) || !absolute(row.mountPath)
      || !/^\/dev\/loop(?:0|[1-9]\d*)$/.test(row.loop) || Number(row.loop.slice(9)) > 4095 || row.inode !== '2' || !/^[a-f0-9-]{36}$/.test(row.fsUuid)
      || !['device', 'backingDevice', 'backingInode', 'backingBytes', 'filesystemBytes', 'filesystemInodes'].every(key => numeric(row[key]))
      || !row.rootMetadata || row.rootMetadata.uid !== 0 || row.rootMetadata.gid !== 0 || row.rootMetadata.mode !== 0o755
      || !Array.isArray(row.mountOptions) || row.mountOptions.some(option => !options.includes(option))
      || !['nodev', 'nosuid'].every(option => row.mountOptions.includes(option))
      || row.readOnly !== (row.role === 'products') || !row.mountOptions.includes(row.readOnly ? 'ro' : 'rw')
      || row.mountOptions.includes(row.readOnly ? 'rw' : 'ro')
      || (row.role === 'products' ? row.mountPath !== posix.dirname(snapshot.supportScope.installAnchor)
        : !arena.image.startsWith(row.mountPath + '/') || row.device !== arena.backingDevice)) fail()
    seen.add(row.role)
  }
  return [...snapshot.support].sort((a, b) => a.role === 'products' ? -1 : b.role === 'products' ? 1 : 0)
}

/**
 * Capture actual UUIDs, domain ownership and effective flags for the existing provisioner's eleven domains.
 * @param {object} owner - Original complete static v3 owner document; no data, credentials or plan is generated.
 * @param {object} io - Optional Linux I/O for focused tests; the default reads the actual Root filesystem/kernel.
 * @param {object} supportScope Actual installAnchor/applicationPid and, for a V3 product bind, its protected
 * normal productManifest path/SHA. Product type comes from the real mount, not an approval flag.
 * @returns {object} Non-secret storage snapshot. The caller privately retains it before stopping its owned runtime.
 */
export function captureRecoveryStorage(owner, io = linuxIo(), supportScope) {
  try {
    if (!io.platform()) fail()
    const captured = []
    for (const row of domains(owner)) {
      if (!backingMatches(row, io.backing(row.image))) fail()
      const observed = mounted(row, io, false), fsUuid = io.uuid(row.loop)
      if (!observed || !/^[a-f0-9-]{36}$/.test(fsUuid)) fail()
      const mountOptions = options.filter(option => observed.mount.options.includes(option))
      if (!['rw', 'nodev', 'nosuid'].every(option => mountOptions.includes(option))
        || (row.executable === true ? mountOptions.includes('noexec') : !mountOptions.includes('noexec'))) fail()
      if (row.account === true ? observed.info.uid <= 0 || observed.info.gid <= 0 || observed.info.mode !== 0o700
        : observed.info.uid !== 0 || observed.info.gid !== 0 || observed.info.mode !== 0o755) fail()
      const retained = { ...row, fsUuid, mountOptions,
        rootMetadata: Object.fromEntries(['uid', 'gid', 'mode'].map(key => [key, observed.info[key]])) }
      if (!loopReady(retained, io)) fail()
      captured.push(retained)
    }
    return { schema: 'pe-cloud-recovery-storage/v1', owner: { schema: owner.schema, phase: owner.phase,
      resourceId: owner.resourceId, slots: owner.slots, domains: captured },
      ...(supportScope === undefined ? {} : { supportScope, support: captureSupport(owner, supportScope, io) }) }
  } catch (_error) { fail() }
}

/**
 * Restore the original product self-bind or loops and mounts in dependency order; unknown outcomes stop.
 * @param {object} snapshot - This instance's actual captureRecoveryStorage output, retained outside lost tmpfs.
 * @param {object} settings - check observes without mutation; io defaults to real Linux Root I/O. The caller owns
 * the operation lock and budget and confirms normal application/SDK terminal release before calling restore.
 * @returns {object} Actual readiness per domain. This never creates/formats backings, changes ownership, picks
 * new loop numbers, unmounts data, clears controller records, or claims application/SDK readiness.
 */
export function restoreRecoveryStorage(snapshot, { check = false, io = linuxIo(), signal, deadlineAtMs } = {}) {
  const completed = []
  let recoveryDomain = null, recoveryPhase = 'validate', mutationAttempted = false
  try {
    if (snapshot?.schema !== 'pe-cloud-recovery-storage/v1' || !io.platform()) fail()
    const data = domains(snapshot.owner), support = supportRows(snapshot), rows = [...support, ...data]
    const loopRows = rows.filter(row => row.kind !== 'bind')
    if (new Set(loopRows.map(row => row.loop)).size !== loopRows.length || new Set(rows.map(row => row.mountPath)).size !== rows.length) fail()
    for (const row of data) {
      if (!/^[a-f0-9-]{36}$/.test(row.fsUuid) || !Array.isArray(row.mountOptions)
        || !['rw', 'nodev', 'nosuid'].every(option => row.mountOptions.includes(option)) || row.mountOptions.includes('ro')
        || row.mountOptions.some(option => !options.includes(option))
        || !row.rootMetadata || !['uid', 'gid', 'mode'].every(key => Number.isSafeInteger(row.rootMetadata[key]) && row.rootMetadata[key] >= 0)
        || row.rootMetadata.mode > 0o7777 || row.rootMetadata.uid > 4294967295 || row.rootMetadata.gid > 4294967295
        || (row.executable === true ? row.mountOptions.includes('noexec') : !row.mountOptions.includes('noexec'))
        || (row.account === true ? row.rootMetadata.uid <= 0 || row.rootMetadata.gid <= 0 || row.rootMetadata.mode !== 0o700
          : row.rootMetadata.uid !== 0 || row.rootMetadata.gid !== 0 || row.rootMetadata.mode !== 0o755)) fail()
    }
    for (const row of rows) {
      recoveryDomain = row.role; recoveryPhase = 'observe'
      if (signal?.aborted || deadlineAtMs !== undefined && performance.now() >= deadlineAtMs) fail()
      if (row.kind === 'bind') {
        let ready = productBindMounted(row, io), changed = false
        if (signal?.aborted || deadlineAtMs !== undefined && performance.now() >= deadlineAtMs) fail()
        if (!check && !ready) {
          recoveryPhase = 'product-bind'; mutationAttempted = true; io.bindProduct(row); changed = true
          if (signal?.aborted || deadlineAtMs !== undefined && performance.now() >= deadlineAtMs) fail()
          recoveryPhase = 'product-readonly'; io.protectProduct(row)
          ready = productBindMounted(row, io)
          if (!ready) fail()
        }
        if (signal?.aborted || deadlineAtMs !== undefined && performance.now() >= deadlineAtMs) fail()
        completed.push({ role: row.role, ready, changed })
        if (!ready) break
        continue
      }
      if (!backingMatches(row, io.backing(row.image)) || io.uuid(row.image) !== row.fsUuid) fail()
      let loop = loopReady(row, io), mount = mounted(row, io, true), changed = false
      if (!loop && mount) fail()
      if (!check && !loop) { recoveryPhase = 'bind'; mutationAttempted = true; io.bind(row); changed = true; if (!loopReady(row, io)) fail(); loop = true }
      if (signal?.aborted || deadlineAtMs !== undefined && performance.now() >= deadlineAtMs) fail()
      if (!check && !mount) { recoveryPhase = 'mount'; mutationAttempted = true; io.mount(row); changed = true; mount = mounted(row, io, true); if (!mount) fail() }
      if (signal?.aborted || deadlineAtMs !== undefined && performance.now() >= deadlineAtMs) fail()
      completed.push({ role: row.role, ready: Boolean(loop && mount), changed })
      // Descendant backings cannot be observed through a missing parent mount.
      if (!loop || !mount) break
    }
    return { ready: completed.length === rows.length && completed.every(row => row.ready), check, domains: completed }
  } catch (_error) {
    const error = new CandidateError('原存储恢复未完成；保留现场和原操作责任，不重试或继续启动应用。')
    error.completedDomains = completed
    error.recoveryDomain = recoveryDomain
    error.recoveryPhase = recoveryPhase
    error.recoveryOutcome = signal?.aborted ? 'cancelled' : deadlineAtMs !== undefined && performance.now() >= deadlineAtMs ? 'timed-out' : 'failed'
    error.mutationAttempted = mutationAttempted
    throw error
  }
}
