/** One fixed profile bind, retaining the established source, identity and read-only checks. */
const fs = require('node:fs')
const path = require('node:path')
const { createHash } = require('node:crypto')
const { execFileSync } = require('node:child_process')
const { isDeepStrictEqual } = require('node:util')

const ROOT = '/run/dsh-feature-root'
const TARGET = ROOT + '/profiles/cloud/cordis.patch.yml'
const FLAGS = ['ro', 'nosuid', 'nodev', 'noexec']
const HASH = /^[a-f0-9]{64}$/
const INPUTS = [ROOT + '/storage-plan.json', ROOT + '/rootDeployment.json', ROOT + '/credentials.json',
  ROOT + '/profiles/cloud/package.json', '/opt/dsh-features/account-base.yml']
const INTENTS = { unbind: 'profile-unbind-intent', bind: 'profile-bind-intent', seal: 'profile-seal-intent' }
/** A profile result that must retain its Root intent and must not be retried or started. */
class NativeProfileUnconfirmed extends Error {
  constructor(phase, cause) {
    super('单个profile选择未确认；保留当前责任记录，不重试、回退或启动。', { cause })
    this.name = 'NativeProfileUnconfirmed'
    this.code = 'NATIVE_PROFILE_UNCONFIRMED'
    this.phase = phase
  }
}
const need = (value, phase) => { if (!value) throw new NativeProfileUnconfirmed(phase) }
const hash = bytes => createHash('sha256').update(bytes).digest('hex')

function identity(stat) {
  return { device: String(stat.dev), inode: String(stat.ino), uid: stat.uid, gid: stat.gid,
    mode: stat.mode & 0o7777, nlink: stat.nlink }
}

function protect(name, directory = false, io = fs) {
  need(typeof name === 'string' && name.startsWith('/') && path.posix.normalize(name) === name
    && !/[\\\0]/.test(name), 'profile-protected-path')
  for (let item = name; item !== '/'; item = path.posix.dirname(item)) {
    const stat = io.lstatSync(item)
    need(!stat.isSymbolicLink() && stat.uid === 0 && (stat.mode & 0o022) === 0, 'profile-protected-parent')
    if (item === name) need(directory ? stat.isDirectory() : stat.isFile() && stat.nlink === 1, 'profile-single-file')
  }
}

function read(name, maximum, io) {
  if (name === ROOT + '/credentials.json') {
    protect(path.posix.dirname(name), true, io)
    const stat = io.lstatSync(name)
    need(stat.isFile() && !stat.isSymbolicLink() && stat.nlink === 1 && stat.uid === 2000 && stat.gid === 2000
      && (stat.mode & 0o7777) === 0o600, 'profile-original-credentials')
  } else protect(name, false, io)
  const fd = io.openSync(name, io.constants.O_RDONLY | io.constants.O_NOFOLLOW)
  let value, failure
  try {
    const before = io.fstatSync(fd)
    need(before.size > 0 && before.size <= maximum, 'profile-input-size')
    value = io.readFileSync(fd)
    const after = io.fstatSync(fd)
    need(value.length === before.size && before.size === after.size && before.mtimeMs === after.mtimeMs
      && before.ctimeMs === after.ctimeMs && isDeepStrictEqual(identity(before), identity(after)), 'profile-input-changed')
  } catch (error) { failure = error }
  try { io.closeSync(fd) } catch (error) {
    failure = failure === undefined ? error : new AggregateError([failure, error], 'profile read and close failed')
  }
  if (failure !== undefined) throw failure
  return value
}

function mounts(io) {
  return io.readFileSync('/proc/self/mountinfo', 'utf8').trim().split('\n')
    .map(line => line.split(' - ')[0].split(' '))
}

function binding(spec, selected, sealed, io) {
  const source = io.lstatSync(selected.source), target = io.lstatSync(TARGET)
  need(source.isFile() && target.isFile() && !source.isSymbolicLink() && !target.isSymbolicLink()
    && source.nlink === 1 && target.nlink === 1 && source.dev === target.dev && source.ino === target.ino,
  'profile-source-target-inode')
  need(isDeepStrictEqual(identity(source), selected.identity) && source.uid === 0 && source.gid === 0
    && (source.mode & 0o7777) === 0o444 && hash(read(selected.source, spec.maxProfileBytes, io)) === selected.sha256
    && hash(read(TARGET, spec.maxProfileBytes, io)) === selected.sha256, 'profile-source-target-bytes')
  const rows = mounts(io).filter(row => row[4] === TARGET)
  need(rows.length === 1 && rows[0][3] === selected.source, 'profile-single-bind')
  if (sealed) need(FLAGS.every(flag => rows[0][5].split(',').includes(flag))
    && !rows[0][5].split(',').includes('rw'), 'profile-bind-readonly')
  return { source: selected.source, sha256: selected.sha256, identity: identity(target),
    mount: { id: rows[0][0], root: rows[0][3], flags: rows[0][5].split(',') } }
}

function otherInputs(spec, io) {
  const rows = mounts(io)
  for (const input of spec.protectedInputs) {
    need(hash(read(input.path, spec.maxProfileBytes, io)) === input.sha256
      && isDeepStrictEqual(identity(io.lstatSync(input.path)), input.identity), 'profile-other-input-changed')
    if (input.path === '/opt/dsh-features/account-base.yml') continue
    const selected = rows.filter(row => row[4] === input.path)
    need(selected.length === 1 && FLAGS.every(flag => selected[0][5].split(',').includes(flag))
      && !selected[0][5].split(',').includes('rw'), 'profile-other-input-readonly')
  }
}

/**
 * Capture the normal controller's private before-state for this operation; never export it as a public report.
 * @param {number} maximum Existing bounded profile/input byte limit.
 * @param {object} io Root filesystem; omitted uses the current namespace.
 * @returns {object[]} Fixed original input identities/hashes, without any configuration or credential bytes.
 */
function readProtectedInputs(maximum, io = fs) {
  need(Number.isSafeInteger(maximum) && maximum > 0 && maximum <= 1048576, 'profile-input-limit')
  const protectedInputs = INPUTS.map(name => ({ path: name, sha256: hash(read(name, maximum, io)),
    identity: identity(io.lstatSync(name)) }))
  otherInputs({ maxProfileBytes: maximum, protectedInputs }, io)
  return protectedInputs
}

function helperToken(text) {
  let parsed
  try { parsed = JSON.parse(text) }
  catch (error) { throw new NativeProfileUnconfirmed('profile-json-format', error) }
  need(Array.isArray(parsed), 'profile-json-patch-array')
  const selected = []
  for (const [operation, value] of parsed.entries()) {
    need(value !== null && typeof value === 'object' && !Array.isArray(value), 'profile-json-operation')
    if (!Object.hasOwn(value, 'insert')) continue
    need(Array.isArray(value.insert), 'profile-json-insert-array')
    for (const [index, row] of value.insert.entries()) {
      if (row?.id === 'files-root') selected.push({ row, path: [operation, 'insert', index, 'config', 'helperPath'] })
    }
  }
  need(selected.length === 1, 'profile-single-files-root')
  const { row, path: selectedPath } = selected[0]
  need(row.config !== null && typeof row.config === 'object' && !Array.isArray(row.config)
    && Object.hasOwn(row.config, 'helperPath') && typeof row.config.helperPath === 'string', 'profile-files-root-helper')

  // JSON.parse owns syntax validation. This scan retains token offsets and rejects duplicate decoded keys.
  let cursor = 0, token
  const space = () => { while (/\s/.test(text[cursor] ?? '')) cursor++ }
  const string = () => {
    const start = cursor
    need(text[cursor++] === '"', 'profile-json-string')
    while (cursor < text.length) {
      const character = text[cursor++]
      if (character === '\\') cursor++
      else if (character === '"') return { start, end: cursor, value: JSON.parse(text.slice(start, cursor)) }
    }
    throw new NativeProfileUnconfirmed('profile-json-string')
  }
  const value = path => {
    space()
    if (text[cursor] === '"') {
      const current = string()
      if (isDeepStrictEqual(path, selectedPath)) token = current
    } else if (text[cursor] === '{') {
      cursor++; space()
      const keys = new Set()
      while (text[cursor] !== '}') {
        const key = string().value
        need(!keys.has(key), 'profile-json-duplicate-key'); keys.add(key)
        space(); need(text[cursor++] === ':', 'profile-json-colon')
        value([...path, key]); space()
        if (text[cursor] === '}') break
        need(text[cursor++] === ',', 'profile-json-comma'); space()
      }
      cursor++
    } else if (text[cursor] === '[') {
      cursor++; space()
      let index = 0
      while (text[cursor] !== ']') {
        value([...path, index++]); space()
        if (text[cursor] === ']') break
        need(text[cursor++] === ',', 'profile-json-comma'); space()
      }
      cursor++
    } else {
      const start = cursor
      while (cursor < text.length && !/[\s,\]}]/.test(text[cursor])) cursor++
      need(cursor > start, 'profile-json-value')
    }
  }
  value([]); space()
  need(cursor === text.length && token !== undefined && token.value === row.config.helperPath, 'profile-helper-token')
  return { ...token, parsed, path: selectedPath }
}

function candidateBytes(spec, io) {
  need(spec.original.source.startsWith('/opt/dsh-features/') && HASH.test(spec.original.sha256)
    && typeof spec.originalHelperPath === 'string' && spec.originalHelperPath.startsWith('/opt/dsh-feature-assets/')
    && typeof spec.nextHelperPath === 'string' && /^\/opt\/dsh-feature-assets\/fd-skill-store-v1-[a-f0-9]{64}\.node$/.test(spec.nextHelperPath),
  'profile-helper-paths')
  const bytes = read(spec.original.source, spec.maxProfileBytes, io)
  need(hash(bytes) === spec.original.sha256, 'profile-original-source-changed')
  const text = bytes.toString('utf8')
  need(Buffer.from(text).equals(bytes), 'profile-input-utf8')
  const token = helperToken(text)
  need(token.value === spec.originalHelperPath, 'profile-original-helper-value')
  const replacement = JSON.stringify(spec.nextHelperPath)
  const nextText = text.slice(0, token.start) + replacement + text.slice(token.end)
  const restored = nextText.slice(0, token.start) + text.slice(token.start, token.end)
    + nextText.slice(token.start + replacement.length)
  const nextParsed = JSON.parse(nextText)
  let nextParent = nextParsed
  for (const key of token.path.slice(0, -1)) nextParent = nextParent[key]
  need(nextParent.helperPath === spec.nextHelperPath, 'profile-candidate-helper-value')
  nextParent.helperPath = spec.originalHelperPath
  const next = Buffer.from(nextText)
  need(isDeepStrictEqual(nextParsed, token.parsed) && Buffer.from(restored).equals(bytes)
    && next.length <= spec.maxProfileBytes, 'profile-reverse-bytes')
  return next
}

/**
 * Preview only the unique JSON insert row files-root/config/helperPath token; no profile body is returned.
 * @param {object} spec Current original profile and fixed next asset path.
 * @param {object} io Root filesystem; omitted uses the current namespace.
 * @returns {object} Candidate source path, bytes and hash; duplicate or unsupported JSON rejects unchanged.
 */
function previewProfile(spec, io = fs) {
  need(/^[a-f0-9]{8}-[a-f0-9]{4}-[a-f0-9]{4}-[a-f0-9]{4}-[a-f0-9]{12}$/.test(spec.operation)
    && Number.isSafeInteger(spec.maxProfileBytes)
    && spec.maxProfileBytes > 0 && spec.maxProfileBytes <= 1048576, 'profile-preview-input')
  binding(spec, spec.original, true, io)
  const bytes = candidateBytes(spec, io), sha256 = hash(bytes)
  return { source: '/opt/dsh-features/pe-cloud-delivery/' + spec.operation + '/native-profile-' + sha256 + '.yml',
    sha256, bytes: bytes.length }
}

/**
 * Publish one reversible profile candidate beside its own external Root journal, without changing the live bind.
 * @param {object} spec Previewed current input and its exact candidate path/hash.
 * @param {object} record Same Root record at publish-intent.
 * @param {object} io Root filesystem; omitted uses the current namespace.
 * @returns {object} Root read-only candidate identity after sync/readback/close; partial output is retained on failure.
 */
function publishProfile(spec, record, io = fs) {
  need(record.operation === spec.operation && record.descriptorSha256 === spec.descriptorSha256
    && record.phase === 'publish-intent', 'profile-publication-intent')
  const candidate = previewProfile(spec, io)
  otherInputs(spec, io)
  need(candidate.source === spec.candidate.source && candidate.sha256 === spec.candidate.sha256
    && io.readlinkSync('/proc/self/fd/9') === '/opt/dsh-features/pe-cloud-delivery/' + spec.operation + '/native-record',
  'profile-candidate-pin')
  const parent = io.openSync('/proc/self/fd/9/..', io.constants.O_RDONLY | io.constants.O_DIRECTORY | io.constants.O_NOFOLLOW)
  let failure, value, file
  try {
    const stat = io.fstatSync(parent)
    need(stat.isDirectory() && stat.uid === 0 && stat.gid === 0 && (stat.mode & 0o7777) === 0o700, 'profile-candidate-parent')
    const bytes = candidateBytes(spec, io)
    const name = '/proc/self/fd/' + parent + '/native-profile-' + candidate.sha256 + '.yml'
    file = io.openSync(name, 'wx', 0o600)
    io.writeFileSync(file, bytes)
    io.fchownSync(file, 0, 0)
    io.fchmodSync(file, 0o600)
    io.fsyncSync(file)
    io.fchmodSync(file, 0o444)
    io.fsyncSync(file)
    io.closeSync(file)
    file = undefined
    io.fsyncSync(parent)
    const check = read(candidate.source, spec.maxProfileBytes, io)
    const actual = io.lstatSync(candidate.source)
    need(check.equals(bytes) && actual.uid === 0 && actual.gid === 0 && actual.nlink === 1
      && (actual.mode & 0o7777) === 0o444, 'profile-candidate-readback')
    value = { ...candidate, identity: identity(actual) }
    otherInputs(spec, io)
  } catch (error) { failure = error }
  for (const fd of [file, parent]) if (fd !== undefined) {
    try { io.closeSync(fd) } catch (error) {
      failure = failure === undefined ? error : new AggregateError([failure, error], 'profile publication and close failed')
    }
  }
  if (failure !== undefined) throw failure
  return value
}

/**
 * Load the published single-line module as the normal UID with the existing capability/seccomp restrictions.
 * @param {object} asset Just-published immutable FD metadata, including its expected identity.
 * @param {object} current Current normal Node and seccomp paths, without Root/configuration bytes.
 * @param {object} runtime Root filesystem and original argv executor; omitted uses actual current operations.
 * @returns {object} Read-only export and kernel identity receipt; does not invoke account or file operations.
 */
function loadPublishedAsset(asset, current, { io = fs, execute = execFileSync } = {}) {
  const name = '/opt/dsh-feature-assets/' + asset.name
  need(current.nodePath === '/dsh-tools/node24' && current.seccompPath === '/opt/dsh-feature-assets/app-seccomp.bpf'
    && Number.isSafeInteger(current.shutdownTimeoutMs) && current.shutdownTimeoutMs > 0
    && asset.name === 'fd-skill-store-v1-' + asset.sha256 + '.node', 'profile-load-input')
  const stat = io.lstatSync(name)
  need(String(stat.dev) === asset.identity.device && String(stat.ino) === asset.identity.inode
    && stat.uid === 0 && stat.gid === 0 && stat.nlink === 1 && (stat.mode & 0o7777) === 0o444
    && hash(read(name, asset.identity.bytes, io)) === asset.sha256
    && mounts(io).filter(row => row[4] === name).length === 0, 'profile-load-view')
  const program = `const fs=require('node:fs'),status=fs.readFileSync('/proc/self/status','utf8');
if(process.platform!=='linux'||process.arch!=='arm64'||process.version!=='v24.19.0'
||process.getuid()!==2000||process.getgid()!==2000
||!['CapInh','CapPrm','CapEff','CapBnd','CapAmb'].every(name=>new RegExp('^'+name+':\\\\s+0+$','m').test(status))
||!/^NoNewPrivs:\\s+1$/m.test(status)||!/^Seccomp:\\s+2$/m.test(status))throw Error('native-load-identity-rejected');
const addon=require(process.argv[1]);
const versions=['projectMetadataVersion','environmentLayoutVersion','skillVersionsVersion','skillProjectionVersion',
'skillBundleVersion','skillBundleProjectionVersion','skillBundleReclaimVersion'];
const methods=['openAnchor','openRead','closeRead','openMetadata','closeAnchor','canonicalPath','probeKernel',
'prepareLeaf','removeEmptyLeaf','prepareExt4Leaf','removeExt4Leaf','writeText','prepareEnvironmentLayout',
'prepareProjectMetadata','openPathMetadata','verifyContentAnchor','listDirectory','skillBundleOperation',
'projectSkillVersion','prepareSkillStore','verifySkillStore','inspectSkillStore','prepareSkillParent',
'verifySkillParent','prepareSkillVersion','retireSkillVersions'];
if(addon.abiVersion!==8||versions.some(name=>addon[name]!==1)
||methods.some(name=>typeof addon[name]!=='function')||addon.directoryListingVersion!==undefined)throw Error('native-load-rejected');
console.log(JSON.stringify({loaded:true,uid:2000,gid:2000,node:process.version,abiVersion:addon.abiVersion,
inspectSkillStore:true,capabilities:'all-zero',noNewPrivileges:true,seccomp:2}));`
  const script = `set -eu
exec 3>&- 4>&- 5>&- 9>&- 10>&-
exec /usr/bin/env -i PATH=/dsh-tools:/usr/local/sbin:/usr/local/bin:/usr/sbin:/usr/bin:/sbin:/bin \\
 HOME=/tmp/dsh-feature-home XDG_CACHE_HOME=/tmp/dsh-feature-cache TMPDIR=/tmp \\
 DSH_TELEMETRY_DISABLED=1 NARB_DISABLE_NATIVE_CACHE=1 \\
 setpriv --no-new-privs --bounding-set=-all --inh-caps=-all --ambient-caps=-all \\
 --reuid 2000 --regid 2000 --clear-groups --seccomp-filter "$2" "$1" -e "$3" "$4"`
  const result = JSON.parse(execute('/bin/sh', ['-c', script, 'pe-cloud-native-load',
    current.nodePath, current.seccompPath, program, name], { encoding: 'utf8', maxBuffer: 131072,
    stdio: ['ignore', 'pipe', 'pipe'], timeout: current.shutdownTimeoutMs, killSignal: 'SIGTERM' }))
  need(result.loaded === true && result.uid === 2000 && result.gid === 2000 && result.abiVersion === 8
    && result.inspectSkillStore === true && result.capabilities === 'all-zero'
    && result.noNewPrivileges === true && result.seccomp === 2, 'profile-load-receipt')
  return result
}

/**
 * Perform exactly one profile action after the same Root record has durably confirmed its intent.
 * @param {string} method The fixed unbind, bind or seal action.
 * @param {object} spec Current approved profile and original protected input identities; normal controller owns preflight.
 * @param {object} record The just-read authoritative native operation record.
 * @param {object} runtime Root filesystem and existing argv executor; omitted uses real Root operations.
 * @returns {object} Confirmed selection metadata; unknown results throw without retry, rollback or launch.
 */
function selectProfile(method, spec, record, { io = fs, execute = execFileSync } = {}) {
  need(INTENTS[method] && record.phase === INTENTS[method] && record.operation === spec.operation
    && record.descriptorSha256 === spec.descriptorSha256, 'profile-record-intent')
  need(Number.isSafeInteger(spec.maxProfileBytes) && spec.maxProfileBytes > 0 && spec.maxProfileBytes <= 1048576
    && spec.target === TARGET && HASH.test(spec.original.sha256) && HASH.test(spec.candidate.sha256)
    && spec.original.source.startsWith('/opt/dsh-features/') && spec.candidate.source.startsWith('/opt/dsh-features/')
    && spec.original.source !== spec.candidate.source
    && isDeepStrictEqual(spec.protectedInputs.map(input => input.path).sort(), [...INPUTS].sort())
    && spec.protectedInputs.every(input => HASH.test(input.sha256)), 'profile-fixed-input')
  for (const name of io.readdirSync('/proc')) if (/^[0-9]+$/.test(name)) {
    try { need(!/^Uid:\s+.*\b2000\b/m.test(io.readFileSync('/proc/' + name + '/status', 'utf8')), 'profile-writer-running') }
    catch (error) { if (!['ENOENT', 'ESRCH'].includes(error.code)) throw error }
  }
  otherInputs(spec, io)
  need(hash(read(spec.candidate.source, spec.maxProfileBytes, io)) === spec.candidate.sha256
    && isDeepStrictEqual(identity(io.lstatSync(spec.candidate.source)), spec.candidate.identity), 'profile-candidate-changed')
  if (method === 'unbind') {
    binding(spec, spec.original, true, io)
    execute('/usr/bin/umount', [TARGET], { stdio: 'ignore' })
    need(mounts(io).filter(row => row[4] === TARGET).length === 0, 'profile-still-bound')
  } else if (method === 'bind') {
    need(mounts(io).filter(row => row[4] === TARGET).length === 0, 'profile-target-not-unbound')
    execute('/usr/bin/mount', ['--bind', spec.candidate.source, TARGET], { stdio: 'ignore' })
    binding(spec, spec.candidate, false, io)
  } else {
    binding(spec, spec.candidate, false, io)
    execute('/usr/bin/mount', ['-o', 'remount,bind,ro,nosuid,nodev,noexec', TARGET], { stdio: 'ignore' })
    binding(spec, spec.candidate, true, io)
  }
  otherInputs(spec, io)
  return { method, confirmed: true, otherInputsUnchanged: true, applicationStarted: false }
}

/**
 * Derive the fixed JS/FD/profile identity from its approved product manifest and selected paths.
 * @param {object} group Approved artifact manifest, immutable FD and profile source metadata.
 * @returns {string} SHA-256 of the exact three-part identity.
 */
function tupleSha256(group) {
  return hash(JSON.stringify({ format: 'pe-cloud-js-fd-profile/v1',
    manifestSha256: hash(JSON.stringify(group.manifest)),
    fd: { path: group.asset.path, sha256: group.asset.sha256, bytes: group.asset.bytes },
    profile: { source: group.profile.source, sha256: group.profile.sha256 } }))
}

/**
 * Read the installed product bytes, FD and unique sealed profile bind before reporting a group identity.
 * @param {object[]} groups Only the approved original, normal and compatible group descriptors.
 * @param {Function} managedFiles Existing product-files collectManagedFiles, without write operations.
 * @param {object} io Root filesystem; omitted uses the actual current namespace.
 * @returns {string} The one actual approved tuple; ambiguity, mismatch or unknown I/O rejects continuation.
 */
function observeTuple(groups, managedFiles, io = fs) {
  need(Array.isArray(groups) && groups.length >= 2 && groups.length <= 3, 'profile-fixed-groups')
  const profileBytes = read(TARGET, 1048576, io), profileSha = hash(profileBytes), matches = []
  for (const group of groups) {
    need(group.productRoot === '/opt/dsh-installed-products' && HASH.test(group.profile.sha256)
      && HASH.test(group.asset.sha256) && group.asset.path.startsWith('/opt/dsh-feature-assets/')
      && path.posix.normalize(group.asset.path) === group.asset.path && !/[\\\0]/.test(group.asset.path)
      && Number.isSafeInteger(group.asset.bytes) && group.asset.bytes > 0
      && Number.isSafeInteger(group.asset.maxAssetBytes) && group.asset.bytes <= group.asset.maxAssetBytes
      && Number.isSafeInteger(group.asset.maxPathBytes)
      && Buffer.byteLength(group.asset.path) <= group.asset.maxPathBytes
      && [0o444, 0o555].includes(group.asset.mode), 'profile-group-input')
    if (profileSha !== group.profile.sha256) continue
    binding({ maxProfileBytes: 1048576 }, group.profile, true, io)
    const stat = io.lstatSync(group.asset.path)
    need(stat.isFile() && !stat.isSymbolicLink() && stat.nlink === 1 && stat.uid === 0 && stat.gid === 0
      && (stat.mode & 0o7777) === group.asset.mode && stat.size === group.asset.bytes, 'profile-group-fd-metadata')
    need(hash(read(group.asset.path, group.asset.maxAssetBytes, io)) === group.asset.sha256, 'profile-group-fd-bytes')
    const actual = managedFiles(group.productRoot, group.manifest.managedRoots, group.manifest.files)
    const expected = [...group.manifest.files]
    const ordered = values => values.map(value => ({ path: value.path, size: value.size, mode: value.mode,
      sha256: value.sha256 })).sort((a, b) => a.path.localeCompare(b.path))
    if (isDeepStrictEqual(ordered(actual), ordered(expected))) matches.push(tupleSha256(group))
  }
  const unique = [...new Set(matches)]
  need(unique.length === 1, 'profile-group-mismatch')
  return unique[0]
}

module.exports = { selectProfile, tupleSha256, observeTuple, previewProfile, publishProfile, readProtectedInputs,
  loadPublishedAsset, NativeProfileUnconfirmed }
