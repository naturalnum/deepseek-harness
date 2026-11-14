/** Fixed native/profile or matching-JS sequence; no live environment discovery or generic copier. */
import fs from 'node:fs'
import { randomUUID } from 'node:crypto'
import { join } from 'node:path'
import { isDeepStrictEqual } from 'node:util'
import stateModule from './native-delivery-state.cjs'

const { PROJECTION, NativeDeliveryOwner, NativeDeliveryUnconfirmed, requireNativeContinuation, requireNativePins,
  requireNativeSuccessor } = stateModule
const RELEASE_PENDING = 'native-release.pending'

function parent(directory, io) {
  const before = io.lstatSync(directory)
  if (typeof process.getuid !== 'function' || !before.isDirectory() || before.isSymbolicLink()
    || before.uid !== process.getuid() || (before.mode & 0o7777) !== 0o700) {
    throw new NativeDeliveryUnconfirmed('local-state-directory')
  }
  const fd = io.openSync(directory, io.constants.O_RDONLY | io.constants.O_DIRECTORY | io.constants.O_NOFOLLOW)
  try {
    const current = io.fstatSync(fd)
    if (current.dev !== before.dev || current.ino !== before.ino) {
      throw new NativeDeliveryUnconfirmed('local-state-directory-changed')
    }
  } catch (error) {
    throw new NativeDeliveryUnconfirmed('local-state-directory', close(io, fd, error))
  }
  return fd
}

function close(io, fd, failure) {
  try { io.closeSync(fd) }
  catch (error) { return failure === undefined ? error : new AggregateError([failure, error], 'native operation and close failed') }
  return failure
}

/**
 * Persist the host blocking projection; the Root record remains authoritative.
 * @param {string} directory Existing private controller state directory.
 * @param {object} projection Root-confirmed blocking state, never an ordinary verified state.
 * @param {typeof fs} io Filesystem implementation; omitted uses the host filesystem.
 * @returns {object} The exact projection after sync, readback and close; throws on any unknown outcome.
 */
export function saveNativeProjection(directory, projection, io = fs) {
  if (projection.format !== PROJECTION || projection.phase !== 'native-owned'
    || projection.stopAttempted !== true || projection.recoveredOriginal !== false) {
    throw new NativeDeliveryUnconfirmed('invalid-local-projection')
  }
  return saveControllerFile(directory, 'latest.json', projection, io)
}

/**
 * Persist only this operation's private normal-controller inputs; no Root/profile body is accepted here.
 * @param {string} directory Existing private controller state directory.
 * @param {string} operation Native operation UUID.
 * @param {object} input Fixed native input and current prepared lifecycle state.
 * @param {typeof fs} io Filesystem implementation; omitted uses the host filesystem.
 * @returns {object} The exact input after sync/readback/close, or an unconfirmed error.
 */
export function saveNativeInput(directory, operation, input, io = fs) {
  if (!/^[a-f0-9]{8}-[a-f0-9]{4}-[a-f0-9]{4}-[a-f0-9]{4}-[a-f0-9]{12}$/.test(operation)
    || input.format !== 'pe-cloud-local-native-input/v1' || input.operation !== operation) {
    throw new NativeDeliveryUnconfirmed('invalid-private-input')
  }
  return saveControllerFile(directory, operation + '.native.json', input, io)
}

function saveControllerFile(directory, filename, projection, io) {
  const bytes = Buffer.from(JSON.stringify(projection) + '\n')
  const dir = parent(directory, io)
  let failure, fd
  const temporary = join(directory, `.native-state-${randomUUID()}`)
  try {
    fd = io.openSync(temporary, 'wx', 0o600)
    io.writeFileSync(fd, bytes)
    io.fsyncSync(fd)
  } catch (error) { failure = error }
  if (fd !== undefined) failure = close(io, fd, failure)
  fd = undefined
  try {
    if (failure !== undefined) throw failure
    io.renameSync(temporary, join(directory, filename))
    io.fsyncSync(dir)
    fd = undefined
    fd = io.openSync(join(directory, filename), io.constants.O_RDONLY | io.constants.O_NOFOLLOW)
    const info = io.fstatSync(fd)
    if (!info.isFile() || info.uid !== process.getuid() || info.nlink !== 1 || (info.mode & 0o7777) !== 0o600
      || info.size !== bytes.length || !io.readFileSync(fd).equals(bytes)) throw new NativeDeliveryUnconfirmed('local-projection-readback')
  } catch (error) { failure = error }
  if (fd !== undefined) failure = close(io, fd, failure)
  failure = close(io, dir, failure)
  if (failure !== undefined) throw new NativeDeliveryUnconfirmed('local-projection', failure)
  return structuredClone(projection)
}

/**
 * Reject the independent release guard before any default entry inspects or changes the candidate.
 * @param {string} directory Existing private controller state directory.
 * @param {typeof fs} io Filesystem implementation; omitted uses the host filesystem.
 * @param {string} operation Previous native operation; absent checks only the pending fence before first ownership.
 * @returns {void} Returns with no pending fence and, when supplied, the exact release receipt; never clears a fence.
 */
export function requireNativeReleaseComplete(directory, io = fs, operation) {
  let pending = true
  try { io.lstatSync(join(directory, RELEASE_PENDING)) }
  catch (error) {
    if (error.code !== 'ENOENT') throw new NativeDeliveryUnconfirmed('release-unconfirmed', error)
    pending = false
  }
  if (pending) throw new NativeDeliveryUnconfirmed('release-unconfirmed')
  if (operation === undefined) return
  if (!/^[a-f0-9]{8}-[a-f0-9]{4}-[a-f0-9]{4}-[a-f0-9]{4}-[a-f0-9]{12}$/.test(operation)) {
    throw new NativeDeliveryUnconfirmed('release-receipt-operation')
  }
  const bytes = Buffer.from(JSON.stringify({ format: 'pe-cloud-native-release/v1', operation }) + '\n')
  let fd, failure
  try {
    fd = io.openSync(join(directory, 'native-release-' + operation + '.json'), io.constants.O_RDONLY | io.constants.O_NOFOLLOW)
    const stat = io.fstatSync(fd)
    if (!stat.isFile() || stat.uid !== process.getuid() || stat.nlink !== 1 || (stat.mode & 0o7777) !== 0o600
      || stat.size !== bytes.length || !io.readFileSync(fd).equals(bytes)) {
      throw new NativeDeliveryUnconfirmed('release-receipt-readback')
    }
  } catch (error) { failure = error }
  if (fd !== undefined) failure = close(io, fd, failure)
  if (failure !== undefined) throw new NativeDeliveryUnconfirmed('release-unconfirmed', failure)
}

function prepareReleaseGuard(directory, operation, dir, io) {
  const bytes = Buffer.from(JSON.stringify({ format: 'pe-cloud-native-release/v1', operation }) + '\n')
  const filename = join(directory, RELEASE_PENDING)
  const fd = io.openSync(filename, 'wx', 0o600)
  let failure
  try { io.writeFileSync(fd, bytes); io.fsyncSync(fd) } catch (error) { failure = error }
  failure = close(io, fd, failure)
  if (failure !== undefined) throw failure
  io.fsyncSync(dir)
  const read = io.openSync(filename, io.constants.O_RDONLY | io.constants.O_NOFOLLOW)
  try {
    const stat = io.fstatSync(read)
    if (!stat.isFile() || stat.uid !== process.getuid() || stat.nlink !== 1 || (stat.mode & 0o7777) !== 0o600
      || stat.size !== bytes.length || !io.readFileSync(read).equals(bytes)) {
      throw new NativeDeliveryUnconfirmed('release-guard-readback')
    }
  } catch (error) { failure = error }
  failure = close(io, read, failure)
  if (failure !== undefined) throw failure
}

/**
 * Release the ordinary lock only behind a durable guard; publish completion after all sync/close acknowledgements.
 * @param {string} directory Existing private controller state directory.
 * @param {string} operation Pinned native operation UUID.
 * @param {Function} action Fixed native delivery inside this operation lock.
 * @param {typeof fs} io Filesystem implementation; omitted uses the host filesystem.
 * @returns {Promise<unknown>} Result after confirmed release; failures retain the lock or independent pending guard.
 */
export async function withNativeOperationLock(directory, operation, action, io = fs) {
  return nativeOperationLock(directory, operation, action, io, false)
}

/**
 * Hold this same pre-existing lock read-only; only a verified result reaches the original release protocol.
 * @param {string} directory Existing private controller state directory.
 * @param {string} operation Original native operation UUID.
 * @param {Function} action Same-operation continuation returning the authoritative verified record.
 * @param {typeof fs} io Filesystem implementation; omitted uses the host filesystem.
 * @returns {Promise<object>} Verified record after confirmed release; unknown outcomes retain the blocking responsibility.
 */
export async function withRetainedNativePublishLock(directory, operation, action, io = fs) {
  return nativeOperationLock(directory, operation, action, io, true)
}

async function nativeOperationLock(directory, operation, action, io, retained) {
  requireNativeReleaseComplete(directory, io)
  if (!/^[a-f0-9]{8}-[a-f0-9]{4}-[a-f0-9]{4}-[a-f0-9]{4}-[a-f0-9]{12}$/.test(operation)) {
    throw new NativeDeliveryUnconfirmed('invalid-operation')
  }
  const completed = join(directory, 'native-release-' + operation + '.json')
  let reused = false
  try { io.lstatSync(completed); reused = true }
  catch (error) { if (error.code !== 'ENOENT') throw new NativeDeliveryUnconfirmed('release-receipt-read', error) }
  if (reused) throw new NativeDeliveryUnconfirmed('operation-already-completed')
  const dir = parent(directory, io)
  let fd, failure, result, originalLock, unlinked = false
  const checkRetained = () => {
    const stat = io.fstatSync(fd), pathStat = io.lstatSync(join(directory, 'operation.lock'))
    const directoryStat = io.lstatSync(directory), heldDirectory = io.fstatSync(dir)
    const bytes = Buffer.from(JSON.stringify({ format: PROJECTION, operation }) + '\n')
    const actual = Buffer.alloc(bytes.length)
    const length = io.readSync(fd, actual, 0, actual.length, 0)
    if (!stat.isFile() || pathStat.isSymbolicLink() || !pathStat.isFile() || stat.uid !== process.getuid()
      || stat.nlink !== 1 || (stat.mode & 0o7777) !== 0o600 || stat.size !== bytes.length
      || stat.dev !== pathStat.dev || stat.ino !== pathStat.ino
      || directoryStat.dev !== heldDirectory.dev || directoryStat.ino !== heldDirectory.ino
      || directoryStat.isSymbolicLink() || length !== bytes.length || !actual.equals(bytes)
      || originalLock && (stat.dev !== originalLock.dev || stat.ino !== originalLock.ino)) {
      throw new NativeDeliveryUnconfirmed('continuation-original-lock')
    }
    originalLock = stat
  }
  try {
    if (retained) {
      originalLock = io.lstatSync(join(directory, 'operation.lock'))
      fd = io.openSync(join(directory, 'operation.lock'), io.constants.O_RDONLY | io.constants.O_NOFOLLOW)
      checkRetained()
    } else {
      fd = io.openSync(join(directory, 'operation.lock'), 'wx', 0o600)
      io.writeFileSync(fd, JSON.stringify({ format: PROJECTION, operation }) + '\n')
      io.fsyncSync(fd)
      io.fsyncSync(dir)
    }
    result = await action()
    if (retained) {
      if (result?.phase !== 'verified' || result.operation !== operation) {
        throw new NativeDeliveryUnconfirmed('continuation-not-verified')
      }
      checkRetained()
    }
  } catch (error) { failure = error }
  if (fd !== undefined) failure = close(io, fd, failure)
  if (failure === undefined) {
    try {
      prepareReleaseGuard(directory, operation, dir, io)
      io.unlinkSync(join(directory, 'operation.lock'))
      unlinked = true
      io.fsyncSync(dir)
    }
    catch (error) { failure = error }
  }
  failure = close(io, dir, failure)
  if (failure !== undefined) {
    throw new NativeDeliveryUnconfirmed(unlinked ? 'release-unconfirmed' : 'operation-unconfirmed', failure)
  }
  // The already-durable marker is the fence. Only this final atomic rename means all prior release work was confirmed.
  // No fallible sync/close follows it; a crash that loses the rename restores the blocking pending name.
  try { io.renameSync(join(directory, RELEASE_PENDING), completed) }
  catch (error) { throw new NativeDeliveryUnconfirmed('release-commit-unconfirmed', error) }
  return result
}

/**
 * Continue only a freshly confirmed phase2 publication inside its original lock, then use the normal fixed effects.
 * @param {object} input Original pins, authority, private writer and fixed effects; omitted adapters use normal persistence/locking.
 * @returns {Promise<object>} Same-operation verified record; any unknown stops dependent effects without recovery.
 */
export async function runNativePublishContinuation({ directory, pins, authority, effects, binding, persistPublication,
  writeProjection = value => saveNativeProjection(directory, value),
  holdOperation = action => withRetainedNativePublishLock(directory, pins.operation, action) }) {
  requireNativePins(pins)
  return holdOperation(async () => {
    const expected = await authority.read()
    stateModule.requireNativePublishIntent(pins, expected)
    if (await effects.observeTuple() !== pins.originalTupleSha256) {
      throw new NativeDeliveryUnconfirmed('continuation-original-group')
    }
    const publication = await authority.continuePublish(expected, binding.groups, binding.controller)
    // No stop until the bridge, the original private input and the Root-derived projection all acknowledged success.
    await persistPublication(publication)
    const owner = await NativeDeliveryOwner.acceptPublishContinuation(pins, authority, publication, writeProjection)
    for (const name of ['stop', 'backup', 'install', 'unbind', 'bind', 'seal', 'start', 'verify']) {
      await owner.run(name, async () => {
        if (name === 'start' && await effects.observeTuple() !== pins.targetTupleSha256) {
          throw new NativeDeliveryUnconfirmed('selected-group-mismatch')
        }
        const value = await effects[name]()
        if (name === 'verify' && await effects.observeTuple() !== pins.targetTupleSha256) {
          throw new NativeDeliveryUnconfirmed('verified-group-mismatch')
        }
        return value
      })
    }
    return owner.record
  })
}

/**
 * Execute only the fixed approved effects supplied by the normal controller and pinned profile binder.
 * The authority adapter writes the same Root file and validates its directory FD on every round trip.
 * @param {object} input Pinned operation, Root authority, fixed lifecycle effects and private state directory.
 * @returns {Promise<object>} Root-confirmed verified record; any unknown effect stops without recovery or retry.
 */
export async function runNativeDelivery({ directory, pins, authority, effects, previousAuthority, successor, confirmPredecessor,
  writeProjection = value => saveNativeProjection(directory, value),
  holdOperation = action => withNativeOperationLock(directory, pins.operation, action) }) {
  requireNativePins(pins)
  const names = pins.kind !== 'fd-profile' ? ['checkPair', 'stop', 'backup', 'install', 'start', 'verify']
    : ['publish', 'stop', 'backup', 'install', 'unbind', 'bind', 'seal', 'start', 'verify']
  if (!['fd-profile', 'matching-js', 'successor-js'].includes(pins.kind)
    || pins.kind === 'successor-js' && (typeof confirmPredecessor !== 'function' || !successor)
    || names.some(name => typeof effects[name] !== 'function') || typeof effects.observeTuple !== 'function') {
    throw new NativeDeliveryUnconfirmed('missing-fixed-effect')
  }
  return holdOperation(async () => {
    // Observe the installed group inside the same operation lock as its next state transition.
    if (pins.kind === 'successor-js') {
      const previous = await confirmPredecessor()
      requireNativeSuccessor(previous, await effects.observeTuple(), pins, successor)
    } else if (pins.kind === 'matching-js') {
      const previous = await previousAuthority.read()
      requireNativeContinuation(previous, await effects.observeTuple(), pins.targetTupleSha256)
      if (pins.descriptorSha256 !== previous.descriptorSha256
        || pins.originalTupleSha256 !== previous.targetTupleSha256
        || !isDeepStrictEqual([pins.targetTupleSha256, pins.compatibleTupleSha256].sort(),
          [previous.targetTupleSha256, previous.compatibleTupleSha256].sort())) {
        throw new NativeDeliveryUnconfirmed('different-native-group')
      }
    } else if (await effects.observeTuple() !== pins.originalTupleSha256) {
      throw new NativeDeliveryUnconfirmed('original-group-mismatch')
    }
    const owner = await NativeDeliveryOwner.reserve(pins, authority)
    await owner.guard(writeProjection)
    for (const name of names) {
      await owner.run(name, async () => {
        if (name === 'start' && await effects.observeTuple() !== pins.targetTupleSha256) {
          throw new NativeDeliveryUnconfirmed('selected-group-mismatch')
        }
        const value = await effects[name]()
        if (name === 'verify' && await effects.observeTuple() !== pins.targetTupleSha256) {
          throw new NativeDeliveryUnconfirmed('verified-group-mismatch')
        }
        return value
      })
    }
    return owner.record
  })
}
