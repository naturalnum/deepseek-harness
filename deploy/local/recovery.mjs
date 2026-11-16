#!/usr/bin/env node
/** Cold recovery inside one existing owned Linux carrier, using its original provisioner and launcher. */
import fs from 'node:fs'
import * as filesystem from 'node:fs/promises'
import { posix } from 'node:path'
import { hostname } from 'node:os'
import { createHash } from 'node:crypto'
import { pathToFileURL } from 'node:url'
import { CandidateError } from './inspect.mjs'
import { captureRecoveryRoot, confirmRecoveryCarrierLifecycle, rebuildRecoveryRoot, writeRecoveryRoot } from './recovery-root.mjs'
import { RECOVERY_ROOT_FILES } from './recovery-config.mjs'
import { captureRecoveryStorage, restoreRecoveryStorage } from './recovery-storage.mjs'
import { prepareRecoveryNamespace, observeRecoveryNamespace, sealRecoveryNamespace, pinRecoveryAsset } from './recovery-namespace.mjs'
import { validateRecoveryInputs } from './recovery-validation.mjs'

const HELP = '用法：node deploy/local/recovery.mjs snapshot|check|prepare|publish --input ROOT私密JSON --sha256 SHA256\n仅操作本实例原存储/配置，不创建容器、格式化或清理数据。prepare/publish由宿主恢复入口持原操作锁调用；原冒烟未过不报告恢复成功。'
const hash = bytes => createHash('sha256').update(bytes).digest('hex')
const fail = () => { throw new CandidateError('冷重建输入或结果未确认；原数据及已完成步骤保留，不自动重试。') }
const canonical = path => typeof path === 'string' && /^\/[A-Za-z0-9_./-]+$/.test(path) && path !== '/' && posix.normalize(path) === path

function readRoot(path, maximum = 1048576, privateFile = true) {
  if (!canonical(path)) fail()
  for (let parent = posix.dirname(path); parent !== '/'; parent = posix.dirname(parent)) {
    const info = fs.lstatSync(parent)
    if (!info.isDirectory() || info.isSymbolicLink() || info.uid !== 0 || (info.mode & 0o022) !== 0) fail()
  }
  const fd = fs.openSync(path, fs.constants.O_RDONLY | fs.constants.O_NOFOLLOW)
  try {
    const before = fs.fstatSync(fd)
    if (!before.isFile() || before.nlink !== 1 || before.uid !== 0 || (before.mode & (privateFile ? 0o077 : 0o022)) !== 0 || before.size < 1 || before.size > maximum) fail()
    const bytes = fs.readFileSync(fd), after = fs.fstatSync(fd)
    if (['dev', 'ino', 'size', 'mtimeMs', 'ctimeMs'].some(key => before[key] !== after[key])) fail()
    return bytes
  } finally { fs.closeSync(fd) }
}

function processIdentity(pid) {
  if (!Number.isSafeInteger(pid) || pid <= 0) fail()
  const stat = fs.readFileSync('/proc/' + pid + '/stat', 'utf8')
  return { pid, startTicks: stat.slice(stat.lastIndexOf(')') + 2).split(/\s+/)[19], namespaceId: fs.readlinkSync('/proc/' + pid + '/ns/mnt') }
}

function sameIdentity(left, right) {
  return left.pid === right.pid && left.startTicks === right.startTicks && left.namespaceId === right.namespaceId
}

function originalNamespaceReferences(namespaceId) {
  const references = []
  for (const name of fs.readdirSync('/proc').filter(value => /^[1-9]\d*$/.test(value))) {
    try {
      const before = processIdentity(Number(name)), descriptors = '/proc/' + name + '/fd'
      const holds = before.namespaceId === namespaceId || fs.readdirSync(descriptors).some(fd => {
        try { return fs.readlinkSync(descriptors + '/' + fd) === namespaceId }
        catch (error) { if (['ENOENT', 'ESRCH'].includes(error.code)) return false; throw error }
      })
      if (holds && sameIdentity(before, processIdentity(Number(name)))) references.push(before)
    } catch (error) { if (!['ENOENT', 'ESRCH'].includes(error.code)) throw error }
  }
  return references.sort((left, right) => left.pid - right.pid)
}

function liveApplication(pid, nodePath) {
  const identity = processIdentity(pid), argv = fs.readFileSync('/proc/' + pid + '/cmdline', 'utf8').split('\0').filter(Boolean)
  const uid = fs.readFileSync('/proc/' + pid + '/status', 'utf8').match(/^Uid:\s+(.*)$/m)?.[1].trim().split(/\s+/)
  if (identity.namespaceId === processIdentity(1).namespaceId || !uid?.every(value => value === '2000') || argv[0] !== nodePath
    || !argv.some((value, index) => value === '/opt/dsh-installed-products/apps/cli/lib/bin.js' && argv[index + 1] === '--profile' && argv[index + 2] === 'cloud')) fail()
  return identity
}

async function snapshot(specification) {
  const { snapshotDirectory, storageOwnerPath, launchInputPath, applicationPid } = specification
  if (!canonical(snapshotDirectory)) fail()
  const owner = JSON.parse(readRoot(storageOwnerPath)), launch = JSON.parse(readRoot(launchInputPath, 1048576, false))
  if (launch.schema !== 'dsh-feature-namespace-launch/v1' || launch.resourceId !== owner.resourceId) fail()
  const application = liveApplication(applicationPid, launch.assets.node.path), carrier = processIdentity(1)
  const captured = await captureRecoveryRoot('/proc/' + applicationPid + '/root/run/dsh-feature-root')
  const profile = JSON.parse(captured.files.rootBytes.toString('utf8').replace(/^\uFEFF/, ''))
  const fileRoots = profile.flatMap(operation => operation.insert ?? []).filter(row => row.id === 'files-root')
  const helperPath = fileRoots[0]?.config?.helperPath
  if (fileRoots.length !== 1 || typeof helperPath !== 'string' || !/^\/opt\/dsh-feature-assets\/[A-Za-z0-9_.-]+\.node$/.test(helperPath)) fail()
  const helper = fs.lstatSync(helperPath), applicationHelper = fs.lstatSync('/proc/' + applicationPid + '/root' + helperPath)
  if (['dev', 'ino', 'size', 'uid', 'gid', 'mode'].some(key => helper[key] !== applicationHelper[key])) fail()
  const configurationAssets = [await pinRecoveryAsset(helperPath)]
  const staticBytes = readRoot(launch.staticInput.path, 32768, false)
  if (hash(staticBytes) !== launch.staticInput.sha256) fail()
  const staticInput = JSON.parse(staticBytes)
  if (staticInput.resourceId !== owner.resourceId) fail()
  let supportBackings
  if (specification.supportSnapshotDirectory !== undefined) {
    const reference = retained({ snapshotDirectory: specification.supportSnapshotDirectory })
    if (reference.storage.owner.resourceId !== owner.resourceId || reference.storage.supportScope.installAnchor !== staticInput.installAnchor
      || !restoreRecoveryStorage(reference.storage, { check: true }).ready) fail()
    supportBackings = reference.storage.support.filter(row => row.kind === 'loop').map(row => ({ role: row.role, image: row.image }))
  }
  const storage = captureRecoveryStorage(owner, undefined, { installAnchor: staticInput.installAnchor, applicationPid,
    ...(supportBackings === undefined ? {} : { supportBackings }),
    ...(specification.productManifest === undefined ? {} : { productManifest: specification.productManifest }) })
  const namespaceReferences = originalNamespaceReferences(application.namespaceId)
  if (!sameIdentity(application, liveApplication(applicationPid, launch.assets.node.path))) fail()
  // A new private side directory is the functional backup; no existing source is renamed or replaced.
  const parent = posix.dirname(snapshotDirectory), parentInfo = fs.lstatSync(parent)
  if (!parentInfo.isDirectory() || parentInfo.isSymbolicLink() || parentInfo.uid !== 0 || (parentInfo.mode & 0o022) !== 0) fail()
  fs.mkdirSync(snapshotDirectory, { mode: 0o700 })
  const targetDirectory = snapshotDirectory + '/files'
  fs.mkdirSync(targetDirectory, { mode: 0o700 }); fs.mkdirSync(targetDirectory + '/profiles'); fs.mkdirSync(targetDirectory + '/profiles/cloud')
  const prepared = { files: RECOVERY_ROOT_FILES.map((relativePath, index) => ({ relativePath,
    bytes: Object.values(captured.files)[index], ...captured.fileMetadata[relativePath] })) }
  await writeRecoveryRoot(captured, prepared, targetDirectory, filesystem)
  const metadata = { schema: 'pe-cloud-cold-recovery-snapshot/v1', hostname: hostname(), application, carrier, namespaceReferences,
    storage, launch, configurationAssets, fileMetadata: captured.fileMetadata, moduleLink: captured.moduleLink,
    fileSha256: Object.fromEntries(Object.entries(captured.files).map(([name, bytes]) => [name, hash(bytes)])) }
  const handle = fs.openSync(snapshotDirectory + '/metadata.json', 'wx', 0o600)
  try { fs.writeFileSync(handle, JSON.stringify(metadata, null, 2) + '\n'); fs.fsyncSync(handle) } finally { fs.closeSync(handle) }
  for (const directory of [targetDirectory + '/profiles/cloud', targetDirectory + '/profiles', targetDirectory, snapshotDirectory, parent]) {
    const descriptor = fs.openSync(directory, fs.constants.O_RDONLY | fs.constants.O_DIRECTORY | fs.constants.O_NOFOLLOW)
    try { fs.fsyncSync(descriptor) } finally { fs.closeSync(descriptor) }
  }
  return { snapshotSaved: true, resources: storage.owner.domains.length, supportResources: storage.support.length,
    productMount: storage.support.find(row => row.role === 'products') ?? null, secretValuesLogged: false }
}

function retained(specification) {
  if (!canonical(specification.snapshotDirectory)) fail()
  const metadata = JSON.parse(readRoot(specification.snapshotDirectory + '/metadata.json'))
  if (metadata.schema !== 'pe-cloud-cold-recovery-snapshot/v1' || metadata.hostname !== hostname()
    || metadata.launch.resourceId !== metadata.storage.owner.resourceId || !Array.isArray(metadata.storage.support)) fail()
  return metadata
}

async function sources(specification, metadata) {
  const captured = await captureRecoveryRoot(specification.snapshotDirectory + '/files')
  if (JSON.stringify(captured.fileMetadata) !== JSON.stringify(metadata.fileMetadata)
    || JSON.stringify(captured.moduleLink) !== JSON.stringify(metadata.moduleLink)
    || Object.entries(captured.files).some(([name, bytes]) => hash(bytes) !== metadata.fileSha256?.[name])) fail()
  if (!Array.isArray(metadata.configurationAssets) || metadata.configurationAssets.length !== 1) fail()
  for (const asset of metadata.configurationAssets) {
    if ((await pinRecoveryAsset(asset.path)).sha256 !== asset.sha256) fail()
  }
  return captured
}

function coldCarrier(metadata) {
  const carrier = processIdentity(1)
  const references = metadata.namespaceReferences?.map(row => {
    try { return processIdentity(row.pid) }
    catch (error) { if (['ENOENT', 'ESRCH'].includes(error.code)) return null; throw error }
  })
  const lifecycle = confirmRecoveryCarrierLifecycle(metadata, { carrier, references })
  return { ...carrier, lifecycle }
}

function requireVacantCarrier(metadata) {
  for (const entry of fs.readdirSync('/proc').filter(name => /^[1-9]\d*$/.test(name))) {
    let argv
    try { argv = fs.readFileSync('/proc/' + entry + '/cmdline', 'utf8').split('\0').filter(Boolean) }
    catch (error) { if (['ENOENT', 'ESRCH'].includes(error.code)) continue; throw error }
    if (argv.includes('/opt/dsh-installed-products/apps/cli/lib/bin.js') || argv.includes(metadata.launch.scripts.launcher.path)) fail()
  }
}

function within(signal, deadlineAtMs) {
  if (signal.aborted || performance.now() >= deadlineAtMs) {
    const error = new CandidateError('冷重建取消或原期限已到；保留操作责任及现场。')
    error.recoveryOutcome = signal.aborted ? 'cancelled' : 'timed-out'
    throw error
  }
}

async function prepare(specification, signal, startedAtMs) {
  if (!Number.isSafeInteger(specification.budgetMs) || specification.budgetMs < 1000 || specification.budgetMs > 1800000) fail()
  const deadlineAtMs = startedAtMs + specification.budgetMs
  within(signal, deadlineAtMs)
  const metadata = retained(specification), carrier = coldCarrier(metadata)
  requireVacantCarrier(metadata)
  await sources(specification, metadata)
  const paths = { scripts: Object.fromEntries(Object.entries(metadata.launch.scripts).map(([key, value]) => [key, value.path])),
    staticInput: metadata.launch.staticInput.path, assets: Object.fromEntries(Object.entries(metadata.launch.assets).map(([key, value]) => [key, value.path])) }
  const namespace = await prepareRecoveryNamespace({ paths, operationDirectory: specification.operationDirectory,
    waitMs: metadata.launch.waitMs, expectedInput: metadata.launch, signal, deadlineAtMs })
  const restored = restoreRecoveryStorage(metadata.storage, { signal, deadlineAtMs })
  if (!restored.ready) fail()
  within(signal, deadlineAtMs)
  // hrtime is the same Linux kernel monotonic clock across these two Root commands; publish cannot renew it.
  const control = { snapshotDirectory: specification.snapshotDirectory, resourceId: metadata.launch.resourceId, carrier,
    deadlineMonotonicMs: Number(process.hrtime.bigint() / 1000000n) + Math.floor(deadlineAtMs - performance.now()) }
  const fd = fs.openSync(specification.operationDirectory + '/recovery-control.json', 'wx', 0o600)
  try { fs.writeFileSync(fd, JSON.stringify(control) + '\n'); fs.fsyncSync(fd) } finally { fs.closeSync(fd) }
  return { ...namespace, storageReady: true, carrierLifecycle: carrier.lifecycle, ready: false, smokeStatus: 'not-run' }
}

async function publish(specification, signal) {
  if (!canonical(specification.operationDirectory)) fail()
  const metadata = retained(specification), carrier = coldCarrier(metadata)
  const control = JSON.parse(readRoot(specification.operationDirectory + '/recovery-control.json'))
  if (control.snapshotDirectory !== specification.snapshotDirectory || control.resourceId !== metadata.launch.resourceId
    || !sameIdentity(control.carrier, carrier) || !Number.isSafeInteger(control.deadlineMonotonicMs)) fail()
  const deadlineAtMs = performance.now() + control.deadlineMonotonicMs - Number(process.hrtime.bigint() / 1000000n)
  within(signal, deadlineAtMs)
  const captured = await sources(specification, metadata)
  if (!restoreRecoveryStorage(metadata.storage, { check: true, signal, deadlineAtMs }).ready) fail()
  let handle, phase = 'namespace'
  try {
    const namespace = await observeRecoveryNamespace({ operationDirectory: specification.operationDirectory,
      expectedInput: metadata.launch, signal, deadlineAtMs })
    handle = namespace.handle; phase = 'configuration'
    const rebuilt = await rebuildRecoveryRoot(captured, { storagePlanBytes: namespace.storagePlanBytes,
      addresses: specification.addresses, targetDirectory: handle.profileHome })
    phase = 'configuration-validation'
    const actual = await captureRecoveryRoot(handle.profileHome), buffers = Object.values(actual.files)
    if (JSON.stringify(actual.moduleLink) !== JSON.stringify(captured.moduleLink)
      || rebuilt.prepared.files.some(row => !buffers[RECOVERY_ROOT_FILES.indexOf(row.relativePath)].equals(row.bytes)
        || ['uid', 'gid', 'mode'].some(key => actual.fileMetadata[row.relativePath][key] !== row[key]))) fail()
    const verified = { files: rebuilt.prepared.files.map(row => ({ ...row, bytes: buffers[RECOVERY_ROOT_FILES.indexOf(row.relativePath)] })) }
    await validateRecoveryInputs(verified, { installAnchor: metadata.storage.supportScope.installAnchor })
    phase = 'seal'; await sealRecoveryNamespace(handle, verified)
    within(signal, deadlineAtMs)
    if (!sameIdentity(handle, liveApplication(handle.pid, metadata.launch.assets.node.path))) fail()
    return { ready: false, cliRunning: true, inputsValidated: true, smokeStatus: 'not-run', applicationPid: handle.pid,
      namespaceId: handle.namespaceId, appCheckPath: metadata.launch.scripts.steps.path,
      productMount: metadata.storage.support.find(row => row.role === 'products') ?? null }
  } catch (error) {
    handle ??= error?.recoveryHandle
    handle?.closeReady()
    const failure = new CandidateError('冷重建尚未确认；保留原数据、配置和原exec，先核实际终态，不重试。')
    failure.recoveryPhase = phase
    failure.recoveryOutcome = signal.aborted ? 'cancelled' : performance.now() >= deadlineAtMs ? 'timed-out' : 'failed'
    if (handle) failure.recoveryHandle = handle
    throw failure
  }
}

/**
 * Run the private Linux stages from an explicit Root-owned pinned input file; help performs no I/O.
 * @param {string[]} argv - Command plus --input absolute path and --sha256; secrets are accepted only through files.
 * @param {object} options - signal covers the whole original operation; report receives only fixed nonsecret results.
 * @returns {Promise<number>} Zero confirms only this Linux stage. It never reports application readiness or smoke success.
 * The host holds the existing candidate/operation lock and owns normal lifecycle, 401, smoke and final success.
 * These stages never clear native records/locks, restart a carrier, or retire SDK resources.
 */
export async function runRecoveryCommand(argv, { signal = new AbortController().signal, report = console.log } = {}) {
  const startedAtMs = performance.now()
  if (argv.length === 0 || argv.length === 1 && argv[0] === '--help') { report(HELP); return 0 }
  if (argv.length !== 5 || !['snapshot', 'check', 'prepare', 'publish'].includes(argv[0]) || argv[1] !== '--input' || argv[3] !== '--sha256'
    || !/^[a-f0-9]{64}$/.test(argv[4]) || process.platform !== 'linux' || process.getuid() !== 0 || signal.aborted) fail()
  const bytes = readRoot(argv[2]), specification = JSON.parse(bytes)
  if (hash(bytes) !== argv[4] || specification.schema !== 'pe-cloud-cold-recovery-input/v1') fail()
  let result
  if (argv[0] === 'snapshot') result = await snapshot(specification)
  else if (argv[0] === 'check') {
    const metadata = retained(specification), before = liveApplication(metadata.application.pid, metadata.launch.assets.node.path)
    const mountsBefore = fs.readFileSync('/proc/' + before.pid + '/mountinfo')
    const storage = restoreRecoveryStorage(metadata.storage, { check: true })
    const live = await captureRecoveryRoot('/proc/' + before.pid + '/root/run/dsh-feature-root')
    const previous = await sources(specification, metadata)
    const sameFiles = Object.keys(live.files).every(key => live.files[key].equals(previous.files[key]))
    if (!storage.ready || !sameFiles || JSON.stringify(live.fileMetadata) !== JSON.stringify(previous.fileMetadata)
      || JSON.stringify(live.moduleLink) !== JSON.stringify(previous.moduleLink)
      || !mountsBefore.equals(fs.readFileSync('/proc/' + before.pid + '/mountinfo'))
      || !sameIdentity(before, liveApplication(before.pid, metadata.launch.assets.node.path))) fail()
    result = { resourcesReady: true, smokeStatus: 'not-run', ready: false, unchanged: true }
  } else result = argv[0] === 'prepare' ? await prepare(specification, signal, startedAtMs) : await publish(specification, signal)
  signal.throwIfAborted()
  report(JSON.stringify(result))
  return 0
}

if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href) {
  const controller = new AbortController()
  process.once('SIGINT', () => controller.abort()); process.once('SIGTERM', () => controller.abort())
  runRecoveryCommand(process.argv.slice(2), { signal: controller.signal }).then(code => { process.exitCode = code }, error => {
    console.error(JSON.stringify({ ready: false, status: error?.recoveryOutcome ?? (controller.signal.aborted ? 'cancelled' : 'failed'),
      phase: error?.recoveryPhase ?? 'input-or-storage',
      newApplication: error?.recoveryHandle === undefined ? 'not-started' : 'unconfirmed',
      applicationPid: error?.recoveryHandle?.pid ?? null, namespaceId: error?.recoveryHandle?.namespaceId ?? null,
      operationDirectory: error?.recoveryHandle?.operationDirectory ?? null,
      disposition: '私密日志、原数据及原进程责任保留；不重试、不清理。' })); process.exitCode = 1
  })
}
