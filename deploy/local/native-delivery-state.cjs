/** One fixed FD publication/profile selection and first-launch responsibility. */
const fs = require('node:fs')
const { createHash } = require('node:crypto')
const { isDeepStrictEqual } = require('node:util')

const FORMAT = 'pe-cloud-native-fd-operation/v1'
const PROJECTION = 'pe-cloud-local-native-fd/v1'
const RECORD = 'native-fd.json'
const MAX_RECORD_BYTES = 32768
const SELECT_STEPS = Object.freeze({
  publish: ['guarded', 'publish-intent', 'published'],
  stop: ['published', 'stop-intent', 'stopped'],
  backup: ['stopped', 'backup-intent', 'backed-up'],
  install: ['backed-up', 'install-intent', 'installed'],
  unbind: ['installed', 'profile-unbind-intent', 'profile-unbound'],
  bind: ['profile-unbound', 'profile-bind-intent', 'profile-bound'],
  seal: ['profile-bound', 'profile-seal-intent', 'profile-sealed'],
  start: ['profile-sealed', 'start-intent', 'started'],
  verify: ['started', 'verify-intent', 'verified'],
})
const JS_STEPS = Object.freeze({
  checkPair: ['guarded', 'check-pair-intent', 'paired'],
  stop: ['paired', 'stop-intent', 'stopped'],
  backup: SELECT_STEPS.backup, install: SELECT_STEPS.install,
  start: ['installed', 'start-intent', 'started'], verify: SELECT_STEPS.verify,
})
function steps(kind) { return kind === 'fd-profile' ? SELECT_STEPS : JS_STEPS }
function phases(kind) { return ['reserved', 'guarded', ...Object.values(steps(kind)).flatMap(step => step.slice(1))] }
const HASH = /^[a-f0-9]{64}$/
const UUID = /^[a-f0-9]{8}-[a-f0-9]{4}-[a-f0-9]{4}-[a-f0-9]{4}-[a-f0-9]{12}$/

/** An unknown persistence or external action forbids dependent actions and automatic recovery. */
class NativeDeliveryUnconfirmed extends Error {
  constructor(phase, cause) {
    super('原生交付结果未确认；停止后续动作并保留现状，不启动、重试或自动回退。', { cause })
    this.name = 'NativeDeliveryUnconfirmed'
    this.code = 'NATIVE_DELIVERY_UNCONFIRMED'
    this.phase = phase
  }
}

function requirePins(pins) {
  if (!pins || !['fd-profile', 'matching-js'].includes(pins.kind) || !UUID.test(pins.operation)
    || ![pins.descriptorSha256, pins.originalTupleSha256, pins.targetTupleSha256,
      pins.compatibleTupleSha256].every(value => typeof value === 'string' && HASH.test(value))) {
    throw new NativeDeliveryUnconfirmed('invalid-input')
  }
}

function flags(kind, phase) {
  const list = phases(kind), at = list.indexOf(phase)
  const reached = value => list.indexOf(value) >= 0 && at >= list.indexOf(value)
  return { productMayHaveChanged: reached('install-intent'),
    profileMayHaveChanged: reached('profile-unbind-intent'),
    firstLaunchMayHaveRun: reached('start-intent') }
}

function requireRecord(record) {
  requirePins(record)
  const keys = ['format', 'kind', 'operation', 'descriptorSha256', 'originalTupleSha256',
    'targetTupleSha256', 'compatibleTupleSha256', 'directoryIdentity', 'sequence', 'phase',
    'productMayHaveChanged', 'profileMayHaveChanged', 'firstLaunchMayHaveRun', 'history']
  const list = phases(record.kind), at = list.indexOf(record.phase)
  if (!isDeepStrictEqual(Object.keys(record).sort(), keys.sort())
    || !isDeepStrictEqual(Object.keys(record.directoryIdentity ?? {}).sort(), ['device', 'inode'])) {
    throw new NativeDeliveryUnconfirmed('invalid-record-fields')
  }
  if (record.format !== FORMAT || at < 0 || record.sequence !== at
    || !isDeepStrictEqual(record.history, list.slice(0, at + 1))
    || !record.directoryIdentity || !['device', 'inode'].every(key =>
      typeof record.directoryIdentity[key] === 'string' && /^[0-9]{1,32}$/.test(record.directoryIdentity[key]))
    || Object.entries(flags(record.kind, record.phase)).some(([key, value]) => record[key] !== value)) {
    throw new NativeDeliveryUnconfirmed('invalid-record')
  }
}

/** Only this original, not-yet-mutating publish intent may make one new read-only loading attempt. */
function requireNativePublishIntent(pins, record) {
  requirePins(pins)
  requireRecord(record)
  if (pins.kind !== 'fd-profile' || record.phase !== 'publish-intent' || record.sequence !== 2
    || ['kind', 'operation', 'descriptorSha256', 'originalTupleSha256', 'targetTupleSha256', 'compatibleTupleSha256']
      .some(key => record[key] !== pins[key])) throw new NativeDeliveryUnconfirmed('continuation-original-intent')
}

/** Block all previously shipped ordinary entry predicates without claiming a stop actually ran. */
function legacyBarrier(record) {
  requireRecord(record)
  return { format: PROJECTION, operation: record.operation, phase: 'native-owned',
    stopAttempted: true, recoveredOriginal: false,
    nativeAuthority: { format: FORMAT, operation: record.operation,
      descriptorSha256: record.descriptorSha256, directoryIdentity: record.directoryIdentity },
    nativePhase: record.phase }
}

/** Every default update/start/rollback must refuse native, unknown and mixed state before side effects. */
function requireOrdinaryUpdateState(state) {
  if (state === undefined) return
  if (!state || state.format !== 'pe-cloud-local-update/v1' || state.nativeAuthority !== undefined) {
    throw new NativeDeliveryUnconfirmed(state?.phase ?? 'invalid-state')
  }
}

function closeAfter(io, fd, action) {
  let failure, value
  try { value = action() } catch (error) { failure = error }
  try { io.closeSync(fd) } catch (error) {
    failure = failure === undefined ? error : new AggregateError([failure, error], 'native record write/read and close failed')
  }
  if (failure !== undefined) throw failure
  return value
}

/** Root-side fixed-file store; the normal namespace bridge retains the approved directory FD. */
class NativeRecordStore {
  constructor(directoryFd, io = fs) {
    this.fd = directoryFd
    this.io = io
    this.directory = `/proc/self/fd/${directoryFd}`
    const info = this.parent()
    this.identity = { device: String(info.dev), inode: String(info.ino) }
  }

  parent() {
    const value = this.io.fstatSync(this.fd)
    if (!value.isDirectory() || value.uid !== 0 || value.gid !== 0 || (value.mode & 0o7777) !== 0o700) {
      throw new NativeDeliveryUnconfirmed('record-directory')
    }
    if (this.identity && (String(value.dev) !== this.identity.device || String(value.ino) !== this.identity.inode)) {
      throw new NativeDeliveryUnconfirmed('record-directory-changed')
    }
    return value
  }

  read() {
    this.parent()
    const fd = this.io.openSync(`${this.directory}/${RECORD}`, this.io.constants.O_RDONLY | this.io.constants.O_NOFOLLOW)
    return closeAfter(this.io, fd, () => {
      const stat = this.io.fstatSync(fd)
      if (!stat.isFile() || stat.uid !== 0 || stat.gid !== 0 || stat.nlink !== 1
        || (stat.mode & 0o7777) !== 0o600 || stat.size < 1 || stat.size > MAX_RECORD_BYTES) {
        throw new NativeDeliveryUnconfirmed('record-file')
      }
      const bytes = this.io.readFileSync(fd)
      if (bytes.length !== stat.size) throw new NativeDeliveryUnconfirmed('record-read')
      const record = JSON.parse(bytes)
      requireRecord(record)
      if (!isDeepStrictEqual(record.directoryIdentity, this.identity)) throw new NativeDeliveryUnconfirmed('record-directory')
      return record
    })
  }

  write(expected, next) {
    requireRecord(next)
    this.parent()
    if (!isDeepStrictEqual(next.directoryIdentity, this.identity)) throw new NativeDeliveryUnconfirmed(next.phase)
    if (expected === undefined) {
      if (next.sequence !== 0 || this.io.readdirSync(this.directory).length !== 0) {
        throw new NativeDeliveryUnconfirmed('record-not-new')
      }
    } else {
      requireRecord(expected)
      if (!isDeepStrictEqual(this.read(), expected) || next.sequence !== expected.sequence + 1
        || ['kind', 'operation', 'descriptorSha256', 'originalTupleSha256', 'targetTupleSha256', 'compatibleTupleSha256']
          .some(key => next[key] !== expected[key])) throw new NativeDeliveryUnconfirmed(next.phase)
    }
    const bytes = Buffer.from(JSON.stringify(next) + '\n')
    if (bytes.length > MAX_RECORD_BYTES) throw new NativeDeliveryUnconfirmed('record-size')
    const temporary = `${this.directory}/native-fd-${next.sequence}.pending`
    const fd = this.io.openSync(temporary, 'wx', 0o600)
    closeAfter(this.io, fd, () => { this.io.writeFileSync(fd, bytes); this.io.fsyncSync(fd) })
    this.io.renameSync(temporary, `${this.directory}/${RECORD}`)
    this.io.fsyncSync(this.fd)
    const observed = this.read()
    if (!isDeepStrictEqual(observed, next)) throw new NativeDeliveryUnconfirmed(next.phase)
    return observed
  }

  reserve(pins) {
    requirePins(pins)
    const record = { format: FORMAT, kind: pins.kind, operation: pins.operation, descriptorSha256: pins.descriptorSha256,
      originalTupleSha256: pins.originalTupleSha256, targetTupleSha256: pins.targetTupleSha256,
      compatibleTupleSha256: pins.compatibleTupleSha256, directoryIdentity: this.identity,
      sequence: 0, phase: 'reserved', ...flags(pins.kind, 'reserved'), history: ['reserved'] }
    return this.write(undefined, record)
  }

  advance(expected, next) { return this.write(expected, next) }

  /** Persist the fixed one-use evidence files; a partial file permanently fences another attempt. */
  publishContinuationFile(kind, expected, value) {
    requireNativePublishIntent(expected, this.read())
    if (!isDeepStrictEqual(this.read(), expected) || !['intent', 'receipt'].includes(kind)) {
      throw new NativeDeliveryUnconfirmed('continuation-record-changed')
    }
    const name = 'native-publish-continuation.' + kind + '.json'
    const bytes = Buffer.from(JSON.stringify(value) + '\n')
    // The bounded load output is private evidence, not part of the small authoritative phase record.
    if (bytes.length > 1048576) throw new NativeDeliveryUnconfirmed('continuation-evidence-size')
    const fd = this.io.openSync(this.directory + '/' + name, 'wx', 0o600)
    closeAfter(this.io, fd, () => {
      this.io.writeFileSync(fd, bytes)
      this.io.fsyncSync(fd)
    })
    this.io.fsyncSync(this.fd)
    const read = this.io.openSync(this.directory + '/' + name, this.io.constants.O_RDONLY | this.io.constants.O_NOFOLLOW)
    const identity = closeAfter(this.io, read, () => {
      const stat = this.io.fstatSync(read)
      if (!stat.isFile() || stat.uid !== 0 || stat.gid !== 0 || stat.nlink !== 1
        || (stat.mode & 0o7777) !== 0o600 || stat.size !== bytes.length
        || !this.io.readFileSync(read).equals(bytes)) throw new NativeDeliveryUnconfirmed('continuation-evidence-readback')
      return { device: String(stat.dev), inode: String(stat.ino), bytes: stat.size }
    })
    this.parent()
    return { name, sha256: createHash('sha256').update(bytes).digest('hex'), identity }
  }
}

/** Read the already-created fixed module and its exact original source record through FD10, without publishing. */
function inspectPublishedFdAsset(directoryFd, expected, io = fs) {
  if (!HASH.test(expected.sha256) || !HASH.test(expected.sourceSha256)
    || !Number.isSafeInteger(expected.bytes) || expected.bytes < 1 || expected.bytes > expected.maxAssetBytes
    || !Number.isSafeInteger(expected.maxAssetBytes) || !Number.isSafeInteger(expected.maxPathBytes)) {
    throw new NativeDeliveryUnconfirmed('continuation-asset-input')
  }
  const parent = () => {
    const stat = io.fstatSync(directoryFd)
    if (!stat.isDirectory() || stat.uid !== 0 || (stat.mode & 0o022) !== 0
      || String(stat.dev) !== expected.parentDevice || String(stat.ino) !== expected.parentInode) {
      throw new NativeDeliveryUnconfirmed('continuation-asset-parent')
    }
    return { device: String(stat.dev), inode: String(stat.ino) }
  }
  const name = 'fd-skill-store-v1-' + expected.sha256 + '.node'
  if (Buffer.byteLength('/opt/dsh-feature-assets/' + name + '.source.json') > expected.maxPathBytes) {
    throw new NativeDeliveryUnconfirmed('continuation-asset-path')
  }
  const read = (suffix, mode, maximum) => {
    parent()
    const fd = io.openSync('/proc/self/fd/' + directoryFd + '/' + name + suffix,
      io.constants.O_RDONLY | io.constants.O_NOFOLLOW)
    return closeAfter(io, fd, () => {
      const before = io.fstatSync(fd)
      if (!before.isFile() || before.uid !== 0 || before.gid !== 0 || before.nlink !== 1
        || (before.mode & 0o7777) !== mode || before.size < 1 || before.size > maximum) {
        throw new NativeDeliveryUnconfirmed('continuation-asset-file')
      }
      const bytes = io.readFileSync(fd), after = io.fstatSync(fd)
      if (bytes.length !== before.size || before.dev !== after.dev || before.ino !== after.ino
        || before.size !== after.size || before.mtimeMs !== after.mtimeMs || before.ctimeMs !== after.ctimeMs
        || before.mode !== after.mode || before.nlink !== after.nlink || before.uid !== after.uid || before.gid !== after.gid) {
        throw new NativeDeliveryUnconfirmed('continuation-asset-file')
      }
      return { bytes, sha256: createHash('sha256').update(bytes).digest('hex'),
        identity: { device: String(before.dev), inode: String(before.ino), bytes: before.size, mode } }
    })
  }
  const asset = read('', 0o444, expected.maxAssetBytes), source = read('.source.json', 0o600, MAX_RECORD_BYTES)
  const value = { format: 'pe-cloud-skill-fd-asset/v1', name, sha256: expected.sha256, bytes: expected.bytes,
    sourceSha256: expected.sourceSha256, parent: parent(), identity: asset.identity }
  if (asset.identity.bytes !== expected.bytes || asset.sha256 !== expected.sha256
    || !source.bytes.equals(Buffer.from(JSON.stringify(value) + '\n'))) {
    throw new NativeDeliveryUnconfirmed('continuation-asset-source')
  }
  return { name, sha256: expected.sha256, sourceSha256: expected.sourceSha256, parent: value.parent,
    identity: asset.identity, source: { sha256: source.sha256, identity: source.identity } }
}

/**
 * Publish exactly one approved FD module under an already-authorized Root directory capability.
 * No archive, arbitrary destination, overwrite, remount or old-file mutation is supported.
 */
function publishFdAsset(directoryFd, expected, bytes, io = fs) {
  const hash = value => createHash('sha256').update(value).digest('hex')
  const directory = `/proc/self/fd/${directoryFd}`
  if (!Buffer.isBuffer(bytes) || !HASH.test(expected.sha256) || !HASH.test(expected.sourceSha256)
    || !Number.isSafeInteger(expected.bytes) || expected.bytes < 1
    || !Number.isSafeInteger(expected.maxAssetBytes) || expected.bytes > expected.maxAssetBytes
    || bytes.length !== expected.bytes || hash(bytes) !== expected.sha256) {
    throw new NativeDeliveryUnconfirmed('asset-input')
  }
  const checkParent = () => {
    const parent = io.fstatSync(directoryFd)
    if (!parent.isDirectory() || parent.uid !== 0 || (parent.mode & 0o022) !== 0
      || String(parent.dev) !== expected.parentDevice || String(parent.ino) !== expected.parentInode) {
      throw new NativeDeliveryUnconfirmed('asset-parent')
    }
    return { device: String(parent.dev), inode: String(parent.ino) }
  }
  const parent = checkParent()
  const name = `fd-skill-store-v1-${expected.sha256}.node`
  if (!Number.isSafeInteger(expected.maxPathBytes) || expected.maxPathBytes < 1
    || Buffer.byteLength('/opt/dsh-feature-assets/' + name + '.source.json') > expected.maxPathBytes) {
    throw new NativeDeliveryUnconfirmed('asset-path-limit')
  }
  const file = directory + '/' + name
  const fd = io.openSync(file, 'wx', 0o600)
  closeAfter(io, fd, () => {
    io.writeFileSync(fd, bytes)
    io.fchownSync(fd, 0, 0)
    io.fchmodSync(fd, 0o600)
    io.fsyncSync(fd)
    io.fchmodSync(fd, 0o444)
    io.fsyncSync(fd)
  })
  io.fsyncSync(directoryFd)
  const read = io.openSync(file, io.constants.O_RDONLY | io.constants.O_NOFOLLOW)
  const identity = closeAfter(io, read, () => {
    const stat = io.fstatSync(read)
    if (!stat.isFile() || stat.uid !== 0 || stat.gid !== 0 || stat.nlink !== 1
      || (stat.mode & 0o7777) !== 0o444 || stat.size !== bytes.length || !io.readFileSync(read).equals(bytes)) {
      throw new NativeDeliveryUnconfirmed('asset-readback')
    }
    return { device: String(stat.dev), inode: String(stat.ino), bytes: stat.size, mode: 0o444 }
  })
  checkParent()
  const source = Buffer.from(JSON.stringify({ format: 'pe-cloud-skill-fd-asset/v1', name,
    sha256: expected.sha256, bytes: expected.bytes, sourceSha256: expected.sourceSha256, parent, identity }) + '\n')
  const sourceFile = file + '.source.json'
  const record = io.openSync(sourceFile, 'wx', 0o600)
  closeAfter(io, record, () => {
    io.writeFileSync(record, source)
    io.fchownSync(record, 0, 0)
    io.fchmodSync(record, 0o600)
    io.fsyncSync(record)
  })
  io.fsyncSync(directoryFd)
  const verified = io.openSync(sourceFile, io.constants.O_RDONLY | io.constants.O_NOFOLLOW)
  closeAfter(io, verified, () => {
    const stat = io.fstatSync(verified)
    if (!stat.isFile() || stat.uid !== 0 || stat.gid !== 0 || stat.nlink !== 1
      || (stat.mode & 0o7777) !== 0o600 || stat.size !== source.length
      || !io.readFileSync(verified).equals(source)) throw new NativeDeliveryUnconfirmed('asset-source-readback')
  })
  checkParent()
  return { name, sha256: expected.sha256, sourceSha256: expected.sourceSha256, parent, identity }
}

/** Host owner uses one Root authority for bind intents and first launch, including a namespace bridge. */
class NativeDeliveryOwner {
  #authority
  #record
  #projection
  #unknown = false
  #running = false

  static async reserve(pins, authority) {
    requirePins(pins)
    const owner = new NativeDeliveryOwner()
    owner.#authority = authority
    try {
      owner.#record = await authority.reserve(pins)
      requireRecord(owner.#record)
      if (owner.#record.phase !== 'reserved' || ['kind', 'operation', 'descriptorSha256', 'originalTupleSha256',
        'targetTupleSha256', 'compatibleTupleSha256'].some(key => owner.#record[key] !== pins[key])) {
        throw new NativeDeliveryUnconfirmed('reserve-receipt')
      }
      return owner
    } catch (error) { throw new NativeDeliveryUnconfirmed('reserve', error) }
  }

  /** Attach only within the call that just received the confirmed new publication, never an entry accepting phase3. */
  static async acceptPublishContinuation(pins, authority, publication, writeProjection) {
    requirePins(pins)
    const record = publication.record
    requireRecord(record)
    if (pins.kind !== 'fd-profile' || record.phase !== 'published' || record.sequence !== 3
      || publication.receipt?.name !== 'native-publish-continuation.receipt.json'
      || !HASH.test(publication.receipt.sha256)
      || ['kind', 'operation', 'descriptorSha256', 'originalTupleSha256', 'targetTupleSha256', 'compatibleTupleSha256']
        .some(key => record[key] !== pins[key]) || !isDeepStrictEqual(await authority.read(), record)) {
      throw new NativeDeliveryUnconfirmed('continuation-published-receipt')
    }
    const owner = new NativeDeliveryOwner()
    owner.#authority = authority
    owner.#record = record
    owner.#projection = writeProjection
    const projection = legacyBarrier(record)
    if (!isDeepStrictEqual(await writeProjection(projection), projection)) {
      throw new NativeDeliveryUnconfirmed('continuation-projection')
    }
    return owner
  }

  get record() { return structuredClone(this.#record) }
  get unknown() { return this.#unknown }

  async #advance(phase) {
    const next = { ...this.#record, ...flags(this.#record.kind, phase), phase, sequence: this.#record.sequence + 1,
      history: [...this.#record.history, phase] }
    requireRecord(next)
    const observed = await this.#authority.advance(this.record, structuredClone(next))
    if (!isDeepStrictEqual(observed, next)) throw new NativeDeliveryUnconfirmed(phase)
    this.#record = observed
    if (this.#projection && !isDeepStrictEqual(await this.#projection(legacyBarrier(observed)), legacyBarrier(observed))) {
      throw new NativeDeliveryUnconfirmed(phase)
    }
  }

  /** The normal host operation lock must remain held if this durable projection is unconfirmed. */
  async guard(writeAndReadProjection) {
    if (this.#unknown || this.#running || this.#record.phase !== 'reserved') throw new NativeDeliveryUnconfirmed(this.#record.phase)
    this.#running = true
    try {
      this.#projection = writeAndReadProjection
      const expected = legacyBarrier(this.#record)
      if (!isDeepStrictEqual(await this.#projection(expected), expected)) throw new NativeDeliveryUnconfirmed('legacy-guard')
      await this.#advance('guarded')
    } catch (error) {
      this.#unknown = true
      throw new NativeDeliveryUnconfirmed(this.#record.phase, error)
    } finally { this.#running = false }
  }

  /** Persist and read back intent before submission; an unknown effect cannot advance or retry. */
  async run(name, effect) {
    const step = steps(this.#record.kind)[name]
    if (this.#unknown || this.#running || !this.#projection || !step || this.#record.phase !== step[0]) {
      throw new NativeDeliveryUnconfirmed(this.#record.phase)
    }
    this.#running = true
    try {
      await this.#advance(step[1])
      const result = await effect()
      await this.#advance(step[2])
      return result
    } catch (error) {
      this.#unknown = true
      throw new NativeDeliveryUnconfirmed(this.#record.phase, error)
    } finally { this.#running = false }
  }

  canRecoverOriginal(observedTupleSha256) {
    return !this.#unknown && !this.#running && this.#record.phase === 'stopped'
      && observedTupleSha256 === this.#record.originalTupleSha256
      && !this.#record.productMayHaveChanged && !this.#record.profileMayHaveChanged && !this.#record.firstLaunchMayHaveRun
  }
}

/** Later calls with no native flag still need the actual committed tuple and an allowed matching reader. */
function requireNativeContinuation(record, observedTupleSha256, requestedTupleSha256) {
  requireRecord(record)
  if (record.phase !== 'verified' || observedTupleSha256 !== record.targetTupleSha256
    || ![record.targetTupleSha256, record.compatibleTupleSha256].includes(requestedTupleSha256)) {
    throw new NativeDeliveryUnconfirmed(record.phase)
  }
  return legacyBarrier(record)
}

module.exports = { FORMAT, PROJECTION, NativeDeliveryOwner, NativeRecordStore, NativeDeliveryUnconfirmed,
  legacyBarrier, requireOrdinaryUpdateState, requireNativeContinuation, requireNativePins: requirePins,
  requireNativePublishIntent, inspectPublishedFdAsset, publishFdAsset }
