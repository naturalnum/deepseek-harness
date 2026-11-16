/** Control the original two-phase Linux launcher; its kernel, storage and application checks stay intact. */
import fs from 'node:fs'
import { posix } from 'node:path'
import { createHash } from 'node:crypto'
import { setTimeout as delay } from 'node:timers/promises'
import { CandidateError } from './inspect.mjs'

const HOME = '/run/dsh-feature-root'
const STATE = '/run/dsh-feature-launch-v1/state.json'
const uuid = value => typeof value === 'string' && /^[a-f0-9]{8}-[a-f0-9]{4}-4[a-f0-9]{3}-[89ab][a-f0-9]{3}-[a-f0-9]{12}$/.test(value)
const hash = bytes => createHash('sha256').update(bytes).digest('hex')
// Docker exec owns this shell directly; its final exec remains discoverable by the normal inspector.
const LAUNCH = `set -eu
umask 077
exec </dev/null
exec 1>>"$1" 2>&1
exec 3<>"$2" 4<>"$3" 5<>"$4"
exec /bin/sh "$5" launch --input "$6" --sha256 "$7"
`
const fail = handle => {
  const error = new CandidateError('原命名空间启动未确认；保留原启动进程和操作责任，不重发或继续发布。')
  if (handle) error.recoveryHandle = handle
  throw error
}

function canonical(path) {
  if (typeof path !== 'string' || !/^\/[A-Za-z0-9_./-]+$/.test(path) || path === '/' || posix.normalize(path) !== path) fail()
  return path
}

/**
 * Build the original FD3/4/5 shell entry whose final application remains the same direct Docker exec process.
 * @param {object} paths Existing exclusive files, pinned launcher/input paths and actual input SHA256.
 * @returns {string[]} Positional argv only; no process is started and no file is opened here.
 */
export function buildRecoveryLaunchCommand({ launcher, input, inputSha256, log, measurement, ready, journal }) {
  for (const path of [launcher, input, log, measurement, ready, journal]) canonical(path)
  if (!/^[a-f0-9]{64}$/.test(inputSha256)) fail()
  return ['/bin/sh', '-c', LAUNCH, 'pe-cloud-cold-launch', log, measurement, ready, journal, launcher, input, inputSha256]
}

function protectedParent(path) {
  for (let parent = posix.dirname(path); parent !== '/'; parent = posix.dirname(parent)) {
    const stat = fs.lstatSync(parent)
    if (!stat.isDirectory() || stat.isSymbolicLink() || stat.uid !== 0 || (stat.mode & 0o022) !== 0) fail()
  }
}

function readProtected(path, maximum, mode, allowEmpty = false) {
  canonical(path)
  const fd = fs.openSync(path, fs.constants.O_RDONLY | fs.constants.O_NOFOLLOW)
  try {
    const before = fs.fstatSync(fd)
    if (!before.isFile() || before.nlink !== 1 || before.uid !== 0 || (before.mode & 0o022) !== 0
      || mode !== undefined && (before.mode & 0o7777) !== mode || before.size < (allowEmpty ? 0 : 1) || before.size > maximum) fail()
    const bytes = fs.readFileSync(fd), after = fs.fstatSync(fd)
    if (['dev', 'ino', 'size', 'mtimeMs', 'ctimeMs'].some(key => before[key] !== after[key])) fail()
    return bytes
  } finally { fs.closeSync(fd) }
}

/**
 * Hash one actual Root-owned immutable public asset through a protected non-symlink file descriptor.
 * @param {string} path Canonical actual path beneath protected Root directories.
 * @returns {Promise<object>} Path and streamed SHA256; changed identities or writable parents refuse.
 */
export async function pinRecoveryAsset(path) {
  canonical(path); protectedParent(path)
  const fd = fs.openSync(path, fs.constants.O_RDONLY | fs.constants.O_NOFOLLOW)
  try {
    const before = fs.fstatSync(fd)
    if (!before.isFile() || before.uid !== 0 || before.nlink !== 1 || (before.mode & 0o022) !== 0 || before.size < 1) fail()
    const digest = createHash('sha256')
    for await (const chunk of fs.createReadStream(path, { fd, autoClose: false })) digest.update(chunk)
    const after = fs.fstatSync(fd)
    if (['dev', 'ino', 'size', 'mtimeMs', 'ctimeMs'].some(key => before[key] !== after[key])) fail()
    return { path, sha256: digest.digest('hex') }
  } finally { fs.closeSync(fd) }
}

function identity(handle) {
  const prefix = '/proc/' + handle.pid
  const namespaceId = fs.readlinkSync(prefix + '/ns/mnt'), stat = fs.readFileSync(prefix + '/stat', 'utf8')
  const startTicks = stat.slice(stat.lastIndexOf(')') + 2).split(/\s+/)[19]
  const uids = fs.readFileSync(prefix + '/status', 'utf8').match(/^Uid:\s+(.*)$/m)?.[1].trim().split(/\s+/)
  if (!/^mnt:\[\d+\]$/.test(namespaceId) || !/^\d+$/.test(startTicks) || uids?.length !== 4
    || handle.startTicks !== undefined && handle.startTicks !== startTicks
    || handle.namespaceId !== undefined && handle.namespaceId !== namespaceId) fail(handle)
  return { namespaceId, startTicks, uid: uids.every(value => value === uids[0]) ? Number(uids[0]) : -1 }
}

function records(handle) {
  const bytes = readProtected(handle.logPath, 1048576, 0o600, true), result = []
  for (const line of bytes.toString('utf8').split('\n').slice(0, -1)) {
    let row
    try { row = JSON.parse(line) } catch (_error) { continue }
    if (row.phase === 'namespace-failed-preserved') fail(handle)
    if (row.resourceId === handle.resourceId && (handle.pid === undefined || row.shellPid === handle.pid)) result.push(row)
  }
  return result
}

function within(handle) {
  if (handle.signal.aborted || performance.now() >= handle.deadlineAtMs || handle.terminal !== null) fail(handle)
}

async function observe(handle, phase) {
  while (true) {
    within(handle)
    const found = records(handle).filter(row => row.phase === phase)
    if (found.length > 1) fail(handle)
    if (found.length === 1) return found[0]
    await delay(Math.min(100, Math.max(1, handle.deadlineAtMs - performance.now())))
  }
}

/**
 * Prepare the supplied original launcher's exclusive Root-owned fd3/fd4/fd5 files and streamed source hashes.
 * @param {object} input - Explicit paths {scripts:{launcher,steps,measurement},staticInput,
 * assets:{node,seccomp,storageProbe,files,staging}}, new operationDirectory, signal, deadlineAtMs based on
 * performance.now(), and original waitMs. Caller is Linux Root in its owned carrier's base namespace.
 * @returns {Promise<object>} An argv array for the existing detached Docker exec mechanism. No child is
 * spawned here: the launcher must become the actual exec process so normal lifecycle inspection can stop it.
 * Preparing a new directory never authorizes release of an old app, native transaction, or SDK allocation.
 */
export async function prepareRecoveryNamespace({ paths, operationDirectory, signal, deadlineAtMs, waitMs, expectedInput }) {
  try {
    if (process.platform !== 'linux' || process.getuid() !== 0 || !(signal instanceof AbortSignal) || signal.aborted
      || !Number.isFinite(deadlineAtMs) || deadlineAtMs <= performance.now() || deadlineAtMs - performance.now() > 1800000
      || !Number.isSafeInteger(waitMs) || waitMs < 1000 || waitMs > 1800000) fail()
    const exact = (value, keys) => value && Object.keys(value).sort().join(',') === keys.sort().join(',')
    if (!exact(paths, ['scripts', 'staticInput', 'assets']) || !exact(paths.scripts, ['launcher', 'steps', 'measurement'])
      || !exact(paths.assets, ['node', 'seccomp', 'storageProbe', 'files', 'staging'])) fail()
    const scripts = {}, assets = {}
    for (const [key, path] of Object.entries(paths.scripts)) scripts[key] = await pinRecoveryAsset(path)
    const staticInput = await pinRecoveryAsset(paths.staticInput)
    for (const [key, path] of Object.entries(paths.assets)) assets[key] = await pinRecoveryAsset(path)
    const original = JSON.parse(readProtected(paths.staticInput, 32768))
    if (!uuid(original.resourceId) || original.architecture !== process.arch || hash(readProtected(paths.staticInput, 32768)) !== staticInput.sha256) fail()
    const samePins = (expected, actual) => expected && Object.keys(expected).sort().join(',') === Object.keys(actual).sort().join(',')
      && Object.entries(actual).every(([key, value]) => expected[key]?.path === value.path && expected[key]?.sha256 === value.sha256)
    if (expectedInput && (expectedInput.resourceId !== original.resourceId || expectedInput.waitMs !== waitMs
      || !samePins(expectedInput.scripts, scripts) || !samePins(expectedInput.assets, assets)
      || expectedInput.staticInput?.path !== staticInput.path || expectedInput.staticInput?.sha256 !== staticInput.sha256)) fail()
    canonical(operationDirectory); protectedParent(operationDirectory)
    if (signal.aborted || performance.now() >= deadlineAtMs) fail()
    fs.mkdirSync(operationDirectory, { mode: 0o700 })
    const create = (name, bytes = Buffer.alloc(0)) => {
      const path = posix.join(operationDirectory, name), fd = fs.openSync(path, 'wx+', 0o600)
      try { if (bytes.length) fs.writeFileSync(fd, bytes); fs.fsyncSync(fd) }
      finally { fs.closeSync(fd) }
      return path
    }
    const document = { schema: 'dsh-feature-namespace-launch/v1', resourceId: original.resourceId, scripts, staticInput, assets, waitMs }
    const inputBytes = Buffer.from(JSON.stringify(document, null, 2) + '\n'), input = create('input.json', inputBytes)
    const measurement = create('measurement.json'), ready = create('ready.json'), journal = create('journal.jsonl'), log = create('launch.log')
    return { launchCommand: buildRecoveryLaunchCommand({ launcher: paths.scripts.launcher, input, inputSha256: hash(inputBytes),
      log, measurement, ready, journal }),
    inputSha256: hash(inputBytes), resourceId: original.resourceId, operationDirectory }
  } catch (_error) { fail() }
}

/**
 * Observe the original direct Docker exec preparation and open only its original ready-file description.
 * @param {object} input Explicit operation directory, captured original launch pins, signal and the original
 * remaining deadline. The caller has already started the returned launchCommand exactly once and owns its exec ID.
 * @returns {Promise<object>} Actual shell pid/namespace, freshly measured plan, and a handle used only for one
 * original FD4 publication. The host owns exec termination/normal lifecycle; this never fabricates its outcome.
 */
export async function observeRecoveryNamespace({ operationDirectory, expectedInput, signal, deadlineAtMs }) {
  let handle
  try {
    canonical(operationDirectory); protectedParent(operationDirectory)
    if (!(signal instanceof AbortSignal) || signal.aborted || !Number.isFinite(deadlineAtMs) || deadlineAtMs <= performance.now()) fail()
    const inputBytes = readProtected(operationDirectory + '/input.json', 32768, 0o600)
    const input = JSON.parse(inputBytes)
    const expected = { schema: expectedInput.schema, resourceId: expectedInput.resourceId, scripts: expectedInput.scripts,
      staticInput: expectedInput.staticInput, assets: expectedInput.assets, waitMs: expectedInput.waitMs }
    const equivalent = value => JSON.stringify(value, function (key, item) {
      return item && typeof item === 'object' && !Array.isArray(item)
        ? Object.fromEntries(Object.keys(item).sort().map(name => [name, item[name]])) : item
    })
    if (equivalent(input) !== equivalent(expected)) fail()
    handle = { resourceId: input.resourceId, signal, deadlineAtMs, terminal: null, operationDirectory,
      logPath: operationDirectory + '/launch.log', measurementPath: operationDirectory + '/measurement.json',
      readyPath: operationDirectory + '/ready.json', readyFd: null, nodePath: input.assets.node.path,
      inputSha256: hash(inputBytes), readyAttempted: false }
    handle.closeReady = () => { if (handle.readyFd !== null) { fs.closeSync(handle.readyFd); handle.readyFd = null } }
    const prepared = await observe(handle, 'waiting-new-root-profile-not-application-ready')
    if (!Number.isSafeInteger(prepared.shellPid) || prepared.shellPid <= 0) fail(handle)
    handle.pid = prepared.shellPid
    const observed = identity(handle)
    if (observed.uid !== 0 || prepared.mountNamespace !== observed.namespaceId || prepared.outputRoot !== HOME || prepared.readyDescriptor !== 4) fail(handle)
    Object.assign(handle, observed)
    const state = JSON.parse(readProtected('/proc/' + handle.pid + '/root' + STATE, 262144, 0o444))
    const storagePlanBytes = readProtected(handle.measurementPath, 262144, 0o600)
    if (state.resourceId !== handle.resourceId || state.inputSha256 !== handle.inputSha256 || state.shellPid !== handle.pid
      || state.mountNamespace !== handle.namespaceId || state.planSha256 !== hash(storagePlanBytes)
      || prepared.planSha256 !== state.planSha256 || state.administratorDescriptors?.length !== 3) fail(handle)
    handle.state = state; handle.profileHome = '/proc/' + handle.pid + '/root' + HOME
    identity(handle); within(handle)
    // The original generator creates these directories; prepare deliberately leaves HOME absent.
    for (const suffix of ['', '/profiles', '/profiles/cloud']) {
      const directory = handle.profileHome + suffix
      fs.mkdirSync(directory, { mode: 0o755 }); fs.chownSync(directory, 0, 0); fs.chmodSync(directory, 0o755)
    }
    identity(handle); within(handle)
    handle.readyFd = fs.openSync(handle.readyPath, fs.constants.O_RDWR | fs.constants.O_NOFOLLOW)
    return { handle, storagePlanBytes }
  } catch (_error) {
    handle?.closeReady()
    fail(handle)
  }
}

/**
 * Publish the original seven-field ready protocol once, then observe the original sealed launcher reach dsh.
 * @param {object} handle - This operation's live handle; its original deadline is never extended.
 * @param {object} prepared - The exact six prepared files from rebuildRecoveryRoot, already published in its
 * confirmed profileHome. Hashes come from these real bytes, never hand-entered qualification values.
 * @returns {Promise<object>} Same pid/namespace and the running original CLI. Bootstrap, Native smoke and
 * typed shutdown remain the outer recovery owner's duties. Unknown outcomes retain the original handle.
 */
export async function sealRecoveryNamespace(handle, prepared) {
  try {
    within(handle); identity(handle)
    if (handle.readyAttempted || handle.readyFd === null) fail(handle)
    const find = path => {
      const rows = prepared.files.filter(row => row.relativePath === path)
      if (rows.length !== 1 || !Buffer.isBuffer(rows[0].bytes)) fail(handle)
      return rows[0].bytes
    }
    const planSha256 = hash(find('storage-plan.json'))
    if (planSha256 !== handle.state.planSha256) fail(handle)
    const info = fs.fstatSync(handle.readyFd), descriptor = handle.state.administratorDescriptors[1]
    if (!info.isFile() || info.nlink !== 1 || info.size !== 0 || info.uid !== 0 || info.gid !== 0 || (info.mode & 0o7777) !== 0o600
      || String(info.dev) !== descriptor.device || String(info.ino) !== descriptor.inode) fail(handle)
    const ready = Buffer.from(JSON.stringify({ schema: 'dsh-feature-namespace-ready/v1', resourceId: handle.resourceId, planSha256,
      rootDeploymentSha256: hash(find('rootDeployment.json')), profileSha256: hash(find('profiles/cloud/cordis.patch.yml')),
      baseConfigSha256: handle.state.baseConfigSha256, configurationComplete: true }) + '\n')
    within(handle); handle.readyAttempted = true
    if (fs.writeSync(handle.readyFd, ready, 0, ready.length, 0) !== ready.length) fail(handle)
    fs.fsyncSync(handle.readyFd); fs.closeSync(handle.readyFd); handle.readyFd = null
    const sealed = await observe(handle, 'sealed-new-root-inputs-not-application-ready')
    if (sealed.mountNamespace !== handle.namespaceId || sealed.planSha256 !== planSha256) fail(handle)
    while (true) {
      within(handle)
      const current = identity(handle), argv = fs.readFileSync('/proc/' + handle.pid + '/cmdline', 'utf8').split('\0').filter(Boolean)
      if (current.uid === 2000 && argv[0] === handle.nodePath && argv.some((value, index) => value === '/opt/dsh-installed-products/apps/cli/lib/bin.js'
        && argv[index + 1] === '--profile' && argv[index + 2] === 'cloud')) return { pid: handle.pid, namespaceId: handle.namespaceId, cliRunning: true }
      await delay(Math.min(100, Math.max(1, handle.deadlineAtMs - performance.now())))
    }
  } catch (_error) {
    if (handle?.readyFd !== null && handle?.readyFd !== undefined) {
      fs.closeSync(handle.readyFd); handle.readyFd = null
    }
    fail(handle)
  }
}
