/** Fail-closed Profile ownership and exact-child supervision; never reclaims an uncertain lock. */
import { spawnSync } from 'node:child_process'
import { randomUUID } from 'node:crypto'
import { constants } from 'node:fs'
import { lstat, mkdir, open, readFile, rename, rm, rmdir } from 'node:fs/promises'
import { dirname, join } from 'node:path'

/** Identify a process birth without signaling or trusting a reusable PID.
 * @param pid Process to inspect.
 * @returns PID and operating-system birth stamp, or null when definitely absent.
 */
export async function processIdentity(pid) {
  if (!Number.isSafeInteger(pid) || pid < 1) throw new Error('Invalid process identity')
  if (process.platform === 'linux') {
    try {
      const stat = await readFile(`/proc/${pid}/stat`, 'utf8')
      const boot = (await readFile('/proc/sys/kernel/random/boot_id', 'utf8')).trim()
      return { pid, birth: `${boot}:${stat.slice(stat.lastIndexOf(')') + 2).split(' ')[19]}` }
    } catch (error) { if (error.code === 'ENOENT') return null; throw error }
  }
  if (process.platform !== 'darwin') throw new Error('Profile lifecycle requires Linux or macOS process identity')
  const result = spawnSync('/bin/ps', ['-p', String(pid), '-o', 'lstart='], { encoding: 'utf8', env: { PATH: '/usr/bin:/bin', LC_ALL: 'C' } })
  if (result.status === 1 && !result.stdout.trim()) return null
  if (result.error || result.status !== 0 || !result.stdout.trim()) throw new Error('Cannot establish process birth')
  return { pid, birth: result.stdout.trim() }
}

/** Read only a private regular metadata file, refusing symlink aliases.
 * @param path Metadata filename.
 * @returns Parsed JSON, or null when absent.
 */
export async function privateJson(path) {
  let handle
  try {
    handle = await open(path, constants.O_RDONLY | constants.O_NOFOLLOW | constants.O_NONBLOCK)
    const info = await handle.stat()
    if (!info.isFile() || info.mode & 0o077) throw new Error('Metadata must be a private regular file')
    return JSON.parse(await handle.readFile('utf8'))
  } catch (error) { if (error.code === 'ENOENT') return null; throw error }
  finally { await handle?.close() }
}

/** Write and sync metadata atomically in an owned directory.
 * @param path Destination filename.
 * @param value JSON metadata without credential values.
 * @returns Completion after the metadata is atomically published and its directory is synced.
 */
export async function durableJson(path, value) {
  const temporary = `${path}.${randomUUID()}.tmp`
  const file = await open(temporary, 'wx', 0o600)
  try { await file.writeFile(JSON.stringify(value) + '\n'); await file.sync() }
  finally { await file.close() }
  await rename(temporary, path)
  const parent = await open(dirname(path), 'r')
  try { await parent.sync() } finally { await parent.close() }
}

/** Create or verify a private real directory.
 * @param path Directory whose contents belong to this operator.
 * @returns Completion once the path is a private real directory.
 */
export async function privateDirectory(path) {
  await mkdir(path, { recursive: true, mode: 0o700 })
  const info = await lstat(path)
  if (!info.isDirectory() || info.isSymbolicLink() || info.mode & 0o077) throw new Error('Profile directory must be private and real')
}

/** Exclusively reserve one Profile across render and the child's entire lifetime.
 * @param directory Profile directory.
 * @param owner Expected immutable deployment identity.
 * @returns Owned lock with explicit release; an existing lock always requires reconciliation.
 */
export async function reserveProfile(directory, owner) {
  await privateDirectory(dirname(directory))
  const lockPath = `${directory}.lifecycle-lock`
  const token = randomUUID()
  try { await mkdir(lockPath, { mode: 0o700 }) }
  catch (error) { if (error.code === 'EEXIST') throw new Error('Profile is reserved; active or uncertain lifecycle requires reconciliation', { cause: error }); throw error }
  const record = { format: 1, token, owner, parent: await processIdentity(process.pid), phase: 'reserved' }
  await durableJson(join(lockPath, 'instance.json'), record)
  return {
    record,
    async save(fields) { Object.assign(record, fields); await durableJson(join(lockPath, 'instance.json'), record) },
    async release() {
      const current = await privateJson(join(lockPath, 'instance.json'))
      if (current?.token !== token) throw new Error('Profile reservation identity changed')
      await rm(join(lockPath, 'instance.json'))
      await rmdir(lockPath)
    },
  }
}

/** Supervise an already-created exact child and wait for its observed exit.
 * @param child ChildProcess owned by this invocation.
 * @param lock Exclusive lifecycle reservation.
 * @param lifecycleFile Persistent evidence filename inside the Profile.
 * @returns Exit facts; unexpected signals and nonzero exits reject after saving evidence.
 */
export async function superviseChild(child, lock, lifecycleFile) {
  let exited = false, durableStop = false, spawnError, requestedSignal = null, signalFailure
  const done = new Promise((resolve) => {
    child.once('error', (error) => { spawnError = error })
    child.once('close', (code, signal) => { exited = true; resolve({ code, signal }) })
  })
  let identity = null, initialized = false, signalTask = Promise.resolve()
  const forward = async () => {
    if (exited || !requestedSignal || !identity) return
    const current = await processIdentity(child.pid)
    if (exited) return
    if (!current || JSON.stringify(current) !== JSON.stringify(identity)) throw new Error('Child identity is uncertain; refusing signal')
    if (!child.kill(requestedSignal)) throw new Error('Exact child rejected shutdown signal')
  }
  const shutdown = async (signal) => {
    if (exited || requestedSignal) return
    requestedSignal = signal
    if (initialized) signalTask = forward().catch((error) => { signalFailure = error })
  }
  const terminate = () => { void shutdown('SIGTERM') }, interrupt = () => { void shutdown('SIGINT') }
  process.on('SIGTERM', terminate); process.on('SIGINT', interrupt)
  try {
    if (child.pid) identity = await processIdentity(child.pid)
    if (!exited && child.pid && !identity) throw new Error('Cannot establish exact child identity')
    await lock.save({ phase: 'running', child: identity })
    await durableJson(lifecycleFile, lock.record)
    initialized = true
    if (requestedSignal) signalTask = forward().catch((error) => { signalFailure = error })
    const exit = await done
    await signalTask
    const evidence = { ...lock.record, phase: 'stopped', exit, requestedSignal, stoppedAt: Date.now() }
    await durableJson(lifecycleFile, evidence)
    await lock.save(evidence)
    durableStop = true
    if (spawnError || signalFailure || (exit.code !== 0 && !(requestedSignal && exit.signal === requestedSignal))) {
      throw new Error('DSH Profile failed or exited with an unexpected signal', { cause: spawnError ?? signalFailure })
    }
    return exit
  } catch (error) {
    if (!exited) {
      requestedSignal ??= 'SIGTERM'
      initialized = true
      signalTask = forward().catch((failure) => { signalFailure = failure })
      await signalTask
      await done
    }
    throw error
  } finally {
    process.off('SIGTERM', terminate); process.off('SIGINT', interrupt)
    // An incomplete wait retains the reservation; subsequent starts cannot claim it.
    if (exited && durableStop) await lock.release()
  }
}
