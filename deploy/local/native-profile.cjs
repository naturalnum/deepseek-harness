/** One fixed profile bind, retaining the established source, identity and read-only checks. */
const fs = require('node:fs')
const path = require('node:path')
const { createHash } = require('node:crypto')
const { execFileSync, spawnSync } = require('node:child_process')
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

/** Prove selected config data has no Loader expression node before using fields or schema defaults. */
function requireDirectoryLiteral(value) {
  const active = new Set()
  let nodes = 0
  const visit = (current, depth) => {
    need(depth <= 128 && ++nodes <= 65536, 'profile-directory-literal-bounds')
    // Matches loader/config/utils.ts:isJsExpr, including inherited keys and non-string payloads.
    need(!(current instanceof Object && '__jsExpr' in current), 'profile-directory-config-expression')
    if (current === null || typeof current !== 'object') return
    need(!active.has(current), 'profile-directory-literal-cycle')
    active.add(current)
    for (const key of Object.keys(current)) visit(current[key], depth + 1)
    active.delete(current)
  }
  visit(value, 0)
}

function helperToken(text, literal = false) {
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
  if (literal) requireDirectoryLiteral(row.config)
  need(row.config !== null && typeof row.config === 'object' && !Array.isArray(row.config)
    && Object.hasOwn(row.config, 'helperPath') && typeof row.config.helperPath === 'string', 'profile-files-root-helper')

  // JSON.parse owns syntax validation. This scan retains token offsets and rejects duplicate decoded keys.
  let cursor = 0, token
  const nodes = []
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
    const start = cursor
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
    nodes.push({ path, start, end: cursor })
  }
  value([]); space()
  need(cursor === text.length && token !== undefined && token.value === row.config.helperPath, 'profile-helper-token')
  return { ...token, parsed, path: selectedPath, nodes }
}

const DIRECTORY_PROTOCOL = 'directory-enumeration-v1'
const DIRECTORY_STREAM = Object.freeze({ endpoint: 'workspaceFiles/listPages', handlerId: 'native:workspaceFiles', guard: 'account-session' })
const PAGING_KEYS = ['idleTimeoutMs', 'totalTimeoutMs', 'maxPages']
const exact = (value, keys) => value && !Array.isArray(value)
  && isDeepStrictEqual(Object.keys(value).sort(), [...keys].sort())
const positive = value => Number.isSafeInteger(value) && value >= 1

/** Validate the original optional paging configuration; never supplies production defaults. */
function directoryPaging(value) {
  need(exact(value, PAGING_KEYS) && PAGING_KEYS.every(key => positive(value[key]) && value[key] <= 2147483647), 'profile-directory-budgets')
  return Object.fromEntries(PAGING_KEYS.map(key => [key, value[key]]))
}

/** Conservative complete-frame/resident proof from unchanged actual files-root values. */
function directoryCapacity(config, paging, readerMaxEntries) {
  directoryPaging(paging)
  const c = config.content, x = config.maxPathBytes
  need(positive(readerMaxEntries), 'profile-directory-reader-facts')
  need(c && ['maxEntries', 'maxNameBytes', 'maxReplyBytes', 'operationTimeoutMs'].every(key =>
    positive(c[key]) && c[key] <= 2147483647) && positive(x) && x <= 16384 && c.maxNameBytes <= x
    && Number.isSafeInteger(paging.maxPages * c.maxEntries)
    && Number.isSafeInteger(paging.maxPages * c.maxReplyBytes), 'profile-directory-content')
  for (const key of ['workerCount', 'workerReservationBytes', 'maxLanes', 'maxResidentBytes',
    'maxResidentBytesPerLane', 'replyOverheadBytes']) need(positive(config[key]), 'profile-directory-capacity-facts')
  const v = config.skillVersions, p = config.skillProjection, b = config.skillBundles
  let metadata = 0
  if (v !== undefined) {
    need(positive(v.maxVersions), 'profile-directory-skill-facts')
    if (b !== undefined) need(positive(b.maxManifestBytes), 'profile-directory-bundle-facts')
    metadata = v.maxVersions * (2048 + (b === undefined ? 0 : 8 * b.maxManifestBytes))
    if (p !== undefined) {
      for (const key of ['maxProjects', 'maxRecordBytes', 'maxCopiesPerProject', 'maxParentBorrows',
        'maxOperationBorrows', 'maxCopiesPerOperation']) need(positive(p[key]), 'profile-directory-projection-facts')
      metadata += p.maxProjects * (8 * p.maxRecordBytes + 8192 + p.maxCopiesPerProject * 4096)
        + 4096 * (p.maxParentBorrows + p.maxOperationBorrows * (p.maxCopiesPerOperation + 1))
    }
  }
  const storage = config.staticStorage
  if (storage !== undefined) need(positive(storage.rootProbeReservationBytes), 'profile-directory-storage-facts')
  const rootReserved = config.workerCount * config.workerReservationBytes
    + (storage === undefined ? 0 : storage.rootProbeReservationBytes) + config.maxLanes * metadata
  const rootAvailable = config.maxResidentBytes - rootReserved, laneAvailable = config.maxResidentBytesPerLane - metadata
  // Both root/project/relative paths are bounded by x; an admitted mount id has at most twenty digits.
  const pageEntries = Math.min(readerMaxEntries, c.maxEntries)
  const reservation = 4 * x + 80 + 4 * x + 12 * (x + 1) + 8 * c.maxReplyBytes
    + (pageEntries + 1) * (2048 + 8 * (2 * x + 128)) + 4 * config.replyOverheadBytes
    + 8 * (256 + 128 + c.maxNameBytes)
  // Covers original C charge, JSON escaping, opaque version/cursor, and all complete control/page envelopes.
  const frame = 4096 + 6 * x + pageEntries * (512 + 6 * c.maxNameBytes)
  const requiredPages = Math.ceil(129 / pageEntries) + 1
  need([metadata, rootReserved, rootAvailable, laneAvailable, reservation, frame].every(Number.isSafeInteger)
    && rootAvailable > 0 && laneAvailable > 0 && reservation <= rootAvailable && reservation <= laneAvailable
    && frame <= c.maxReplyBytes && paging.maxPages >= requiredPages, 'profile-directory-capacity-unavailable')
  return { content: Object.fromEntries(['maxEntries', 'maxNameBytes', 'maxReplyBytes', 'operationTimeoutMs'].map(key => [key, c[key]])), maxPathBytes: x, pageEntriesUpper: pageEntries,
    readerMaxEntries, minimumEntriesPerNonemptyPage: pageEntries, acceptanceEntries: 129,
    requiredPagesUpper: requiredPages, completeFrameBytesUpper: frame, reservationBytesUpper: reservation,
    skillMetadataBytes: metadata, rootReservedBytes: rootReserved, rootAvailableBytes: rootAvailable,
    laneAvailableBytes: laneAvailable, configSha256: hash(Buffer.from(JSON.stringify(config))) }
}

function literalEntries(rows, prefix = [], ancestors = [], seen = new Set()) {
  need(Array.isArray(rows) && prefix.length <= 128, 'profile-directory-entry-array')
  const result = []
  for (const [index, row] of rows.entries()) {
    need(row && typeof row === 'object' && !Array.isArray(row) && !seen.has(row) && seen.size < 65536, 'profile-directory-entry-data')
    seen.add(row)
    const path = [...prefix, index], parents = [...ancestors, row]
    if (row.group === true) result.push(...literalEntries(row.config, [...path, 'config'], parents, seen))
    else result.push({ row, path, ancestors: parents })
  }
  return result
}
const entryEnabled = row => row.disabled === undefined || row.disabled === false || row.disabled === null

/** Token edits retain every byte outside the fixed helper/paging/exposure fields. */
function directoryCandidate(text, spec, resolveModule, readerMaxEntries) {
  const token = helperToken(text, true), paging = directoryPaging(spec.directoryPaging)
  need(token.value === spec.originalHelperPath && spec.nativeProtocol === DIRECTORY_PROTOCOL, 'profile-directory-selection')
  const configPath = token.path.slice(0, -1), at = path => token.nodes.find(row => isDeepStrictEqual(row.path, path))
  const get = path => path.reduce((value, key) => value[key], token.parsed)
  const config = get(configPath), capacity = directoryCapacity(config, paging, readerMaxEntries), providers = []
  const expectedModule = resolveModule('@deepseek-ai/dsh-pe-cloud-api/root'), exposureAncestors = []
  const filesRow = get(configPath.slice(0, -1))
  need(entryEnabled(filesRow) && filesRow.group !== true && typeof filesRow.name === 'string'
    && resolveModule(filesRow.name) === resolveModule('@deepseek-ai/dsh-pe-cloud-files/root')
    && token.parsed[configPath[0]].id === undefined
    && Buffer.byteLength(spec.nextHelperPath) <= config.maxPathBytes, 'profile-directory-root-files-entry')
  for (const [op, operation] of token.parsed.entries()) for (const entry of literalEntries(operation.insert ?? [], [op, 'insert'])) {
    if (typeof entry.row.name !== 'string') continue
    let module
    try { module = resolveModule(entry.row.name) } catch (error) { continue } // Unrelated module names do not select exposure.
    if (module === expectedModule) {
      need(operation.id === undefined && entry.ancestors.every(entryEnabled), 'profile-directory-active-root-exposure')
      providers.push([...entry.path, 'config']); exposureAncestors.push(...entry.ancestors.map(row => row.id))
    }
  }
  need(providers.length === 1, 'profile-directory-exposure-provider')
  const selectedIds = [filesRow.id, ...exposureAncestors]
  need(selectedIds.every(id => typeof id === 'string' && id.length > 0)
    && !token.parsed.some(operation => operation.id !== undefined && selectedIds.includes(operation.id)), 'profile-directory-entry-override')
  const exposurePath = providers[0], exposure = get(exposurePath)
  requireDirectoryLiteral(exposure)
  need(exposure && typeof exposure.recipeVersion === 'string' && exposure.recipeVersion.length > 0
    && ['rpcEndpoints', 'streamEndpoints', 'exactFetchRoutes', 'allowedSettings'].every(key => Array.isArray(exposure[key]))
    && !exposure.rpcEndpoints.some(row => row?.endpoint === DIRECTORY_STREAM.endpoint), 'profile-directory-exposure-fields')
  const same = exposure.streamEndpoints.filter(row => row?.endpoint === DIRECTORY_STREAM.endpoint)
  need(same.length <= 1 && same.every(row => isDeepStrictEqual(row, DIRECTORY_STREAM)), 'profile-directory-exact-stream')
  const edits = [{ start: token.start, end: token.end, text: JSON.stringify(spec.nextHelperPath) }]
  const expected = structuredClone(token.parsed), expectedConfig = configPath.reduce((value, key) => value[key], expected)
  expectedConfig.helperPath = spec.nextHelperPath
  const replace = (path, value) => { const node = at(path); need(node, 'profile-directory-token'); edits.push({ ...node, text: JSON.stringify(value) }) }
  if (Object.hasOwn(config, 'directoryPaging')) { directoryPaging(config.directoryPaging); replace([...configPath, 'directoryPaging'], paging) }
  else { const node = at(configPath); need(node, 'profile-directory-config-token'); edits.push({ start: node.end - 1, end: node.end - 1,
    text: (Object.keys(config).length ? ',' : '') + '"directoryPaging":' + JSON.stringify(paging) }) }
  expectedConfig.directoryPaging = paging
  if (!same.length) {
    const node = at([...exposurePath, 'streamEndpoints']); need(node, 'profile-directory-stream-token')
    edits.push({ start: node.end - 1, end: node.end - 1, text: (exposure.streamEndpoints.length ? ',' : '') + JSON.stringify(DIRECTORY_STREAM) })
    exposurePath.reduce((value, key) => value[key], expected).streamEndpoints.push({ ...DIRECTORY_STREAM })
  }
  edits.sort((a, b) => a.start - b.start)
  let next = '', cursor = 0
  const inverse = []
  for (const edit of edits) {
    need(edit.start >= cursor, 'profile-directory-overlap')
    next += text.slice(cursor, edit.start)
    inverse.push({ start: next.length, end: next.length + edit.text.length, text: text.slice(edit.start, edit.end) })
    next += edit.text
    cursor = edit.end
  }
  next += text.slice(cursor)
  let restored = next
  for (const edit of inverse.reverse()) restored = restored.slice(0, edit.start) + edit.text + restored.slice(edit.end)
  need(restored === text && isDeepStrictEqual(JSON.parse(next), expected), 'profile-directory-reverse-bytes')
  const facts = { format: 'pe-cloud-directory-profile-facts/v1', nativeProtocol: DIRECTORY_PROTOCOL,
    directoryPaging: paging, stream: { ...DIRECTORY_STREAM }, exposureModule: expectedModule,
    exposureConfigPath: exposurePath, capacity, originalSha256: hash(Buffer.from(text)), candidateSha256: hash(Buffer.from(next)) }
  return { bytes: Buffer.from(next), facts }
}

function directoryPreview(spec, io = fs) {
  binding(spec, spec.original, true, io); otherInputs(spec, io)
  const bytes = read(spec.original.source, spec.maxProfileBytes, io), text = bytes.toString('utf8')
  need(hash(bytes) === spec.original.sha256 && Buffer.from(text).equals(bytes), 'profile-directory-original-bytes')
  const resolver = require('node:module').createRequire(ROOT + '/profiles/cloud/package.json')
  const base = read('/opt/dsh-features/account-base.yml', spec.maxProfileBytes, io).toString('utf8')
  const includeRequire = require('node:module').createRequire('/opt/dsh-installed-products/vendor/include/package.json')
  const yaml = includeRequire('js-yaml'), include = includeRequire('./lib/index.js')
  const rows = yaml.load(base, { schema: include.entryListSchema })
  need(Array.isArray(rows), 'profile-directory-account-base-array')
  // This is the original account-native provider name, not a caller-controlled entry id or alias.
  const readers = literalEntries(rows).filter(entry => entry.row.name === 'pe-cloud-workspace-files')
  need(readers.length === 1 && readers[0].ancestors.every(entryEnabled), 'profile-directory-account-reader')
  requireDirectoryLiteral(readers[0].row.config)
  const nativeRequire = require('node:module').createRequire('/opt/dsh-installed-products/packages/cloud/pe-cloud-runtime/package.json')
  const WorkspaceFiles = nativeRequire('@deepseek-ai/dsh-api-workspace-files').default
  const readerConfig = nativeRequire('@deepseek-ai/cordis').resolveConfig(WorkspaceFiles, readers[0].row.config)
  need(positive(readerConfig.maxEntries), 'profile-directory-reader-config')
  const resolveModule = name => resolver.resolve(name.startsWith('file:') ? require('node:url').fileURLToPath(name) : name)
  const result = directoryCandidate(text, spec, resolveModule, readerConfig.maxEntries)
  result.facts.readerConfigSha256 = hash(Buffer.from(JSON.stringify(readerConfig)))
  need(result.bytes.length <= spec.maxProfileBytes, 'profile-directory-output-size')
  return result
}

/** Refuse an occupied content-addressed target before preparing a new responsibility. */
function requireUnpublishedDirectoryAsset(asset, io = fs) {
  need(asset.sha256 && HASH.test(asset.sha256), 'profile-directory-asset-target')
  const name = '/opt/dsh-feature-assets/fd-skill-store-v1-' + asset.sha256 + '.node'
  for (const path of [name, name + '.source.json']) {
    try { io.lstatSync(path) } catch (error) { if (error.code === 'ENOENT') continue; throw error }
    throw new NativeProfileUnconfirmed('profile-directory-asset-already-present')
  }
}

/** Read only fixed current profile facts; caller cannot supply selectors or configuration bodies. */
function readDirectoryFacts(spec, io = fs) {
  need(spec.target === TARGET && spec.nativeProtocol === DIRECTORY_PROTOCOL
    && positive(spec.maxProfileBytes) && spec.maxProfileBytes <= 1048576
    && Array.isArray(spec.protectedInputs) && spec.protectedInputs.length === 5
    && isDeepStrictEqual(spec.protectedInputs.map(row => row.path).sort(), [...INPUTS].sort()), 'profile-directory-facts-input')
  const result = directoryPreview(spec, io)
  return { ...result.facts, protectedInputsSha256: hash(Buffer.from(JSON.stringify(spec.protectedInputs))) }
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
  if (spec.nativeProtocol !== undefined) {
    const result = directoryPreview(spec, io)
    need(isDeepStrictEqual(readDirectoryFacts(spec, io), spec.directoryFacts), 'profile-directory-facts-changed')
    return result.bytes
  }
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
 * Preview the fixed helper token; directory mode also selects its three budgets and exact stream. No profile body is returned.
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
 * Load as the normal UID with existing capability/seccomp restrictions and no inherited administrator FDs.
 * The fixed env/setpriv argv is spawned directly; stdio slots 3 through 10 are explicitly ignored.
 * @param {object} asset Just-published immutable FD metadata, including its expected identity.
 * @param {object} current Current normal Node and seccomp paths, without Root/configuration bytes.
 * @param {object} runtime Root filesystem and original argv executor; omitted uses actual current operations.
 * @returns {object} Actual load/export identity; directory mode also runs the original read-only openat2 probe, without account data access.
 */
function loadPublishedAsset(asset, current, { io = fs, execute = execFileSync, nativeProtocol } = {}) {
  need(nativeProtocol === undefined || nativeProtocol === DIRECTORY_PROTOCOL, 'profile-native-protocol')
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
||methods.some(name=>typeof addon[name]!=='function')
||(${JSON.stringify(nativeProtocol === DIRECTORY_PROTOCOL)}?addon.directoryListingVersion!==1||addon.directoryPagingVersion!==1
||['openDirectoryEnumeration','pullDirectoryEnumeration','closeDirectoryEnumeration'].some(name=>typeof addon[name]!=='function')
:addon.directoryListingVersion!==undefined))throw Error('native-load-rejected');
if(${JSON.stringify(nativeProtocol === DIRECTORY_PROTOCOL)})addon.probeKernel();
console.log(JSON.stringify({loaded:true,uid:2000,gid:2000,node:process.version,abiVersion:addon.abiVersion,
inspectSkillStore:true,capabilities:'all-zero',noNewPrivileges:true,seccomp:2${nativeProtocol === DIRECTORY_PROTOCOL
  ? ",nativeProtocol:'directory-enumeration-v1',directoryListingVersion:addon.directoryListingVersion,directoryPagingVersion:addon.directoryPagingVersion,napi:process.versions.napi,modules:process.versions.modules,kernel:require('node:os').release(),libc:process.report.getReport().header.glibcVersionRuntime" : ''}}));`
  const result = JSON.parse(execute('/usr/bin/env', ['-i',
    'PATH=/dsh-tools:/usr/local/sbin:/usr/local/bin:/usr/sbin:/usr/bin:/sbin:/bin',
    'HOME=/tmp/dsh-feature-home', 'XDG_CACHE_HOME=/tmp/dsh-feature-cache', 'TMPDIR=/tmp',
    'DSH_TELEMETRY_DISABLED=1', 'NARB_DISABLE_NATIVE_CACHE=1',
    'setpriv', '--no-new-privs', '--bounding-set=-all', '--inh-caps=-all', '--ambient-caps=-all',
    '--reuid', '2000', '--regid', '2000', '--clear-groups', '--seccomp-filter', current.seccompPath,
    current.nodePath, '-e', program, name], { encoding: 'utf8', maxBuffer: 131072,
    stdio: ['ignore', 'pipe', 'pipe', 'ignore', 'ignore', 'ignore', 'ignore', 'ignore', 'ignore', 'ignore', 'ignore'],
    timeout: current.shutdownTimeoutMs, killSignal: 'SIGTERM' }))
  need(result.loaded === true && result.uid === 2000 && result.gid === 2000 && result.abiVersion === 8
    && result.inspectSkillStore === true && result.capabilities === 'all-zero'
    && result.noNewPrivileges === true && result.seccomp === 2, 'profile-load-receipt')
  if (nativeProtocol === DIRECTORY_PROTOCOL) need(result.nativeProtocol === DIRECTORY_PROTOCOL
    && result.node === 'v24.19.0' && result.directoryListingVersion === 1 && result.directoryPagingVersion === 1
    && typeof result.napi === 'string' && typeof result.modules === 'string'
    && typeof result.kernel === 'string' && typeof result.libc === 'string', 'profile-directory-load-receipt')
  return result
}

/** One new load and candidate, fenced by a permanent intent in the original FD9 journal. No asset publication. */
function continueNativePublish(input, current, store, product, nativeState,
  { io = fs, spawn = spawnSync, execute = execFileSync } = {}) {
  const { expected, approved, groups, binding: controller } = input
  need(approved.profile?.nativeProtocol === undefined, 'continuation-legacy-profile-only')
  nativeState.requireNativePublishIntent(expected, store.read())
  need(isDeepStrictEqual(store.read(), expected)
    && isDeepStrictEqual(store.identity, expected.directoryIdentity)
    && approved.journal.path === '/opt/dsh-features/pe-cloud-delivery/' + expected.operation + '/native-record'
    && io.readlinkSync('/proc/self/fd/9') === approved.journal.path
    && /^[a-f0-9]{40}$/.test(controller.commit) && /^[a-f0-9]{40}$/.test(controller.tree)
    && HASH.test(controller.inputSha256) && HASH.test(controller.programSha256)
    && typeof controller.line === 'string' && controller.line.length > 0, 'continuation-binding')
  const original = groups.find(group => group.role === 'original')
  const normal = groups.find(group => group.role === 'normal'), compatible = groups.find(group => group.role === 'compatible')
  need(groups.length === 3 && original && normal && compatible
    && tupleSha256(original) === expected.originalTupleSha256
    && tupleSha256(normal) === expected.targetTupleSha256
    && tupleSha256(compatible) === expected.compatibleTupleSha256, 'continuation-groups')
  const spec = { ...approved.profile, operation: expected.operation, descriptorSha256: expected.descriptorSha256 }
  need(spec.target === TARGET && Array.isArray(spec.protectedInputs)
    && isDeepStrictEqual(spec.protectedInputs.map(value => value.path).sort(), [...INPUTS].sort())
    && spec.protectedInputs.every(value => HASH.test(value.sha256))
    && normal.asset.path === spec.nextHelperPath && normal.asset.sha256 === approved.asset.sha256
    && normal.asset.bytes === approved.asset.bytes && isDeepStrictEqual(normal.asset, compatible.asset)
    && normal.profile.source === spec.candidate.source && normal.profile.sha256 === spec.candidate.sha256
    && isDeepStrictEqual(normal.profile, compatible.profile), 'continuation-approved-pair')
  const same = (a, b, phase) => need(isDeepStrictEqual(a, b), phase)
  const prepared = () => {
    const stage = '/opt/dsh-features/pe-cloud-delivery/' + expected.operation
    const rollback = stage + '/rollback/rollback.json'
    const bytes = read(rollback, 64 * 1024 * 1024, io), plan = JSON.parse(bytes)
    const actualOld = product.collectManagedFiles('/opt/dsh-installed-products', normal.manifest.managedRoots, normal.manifest.files)
    same(plan, { format: 'pe-cloud-product-rollback/v1', oldFiles: actualOld, nextFiles: normal.manifest.files,
      plan: product.planUpdate(actualOld, normal.manifest.files) }, 'continuation-prepared-plan')
    protect(stage + '/rollback/new', true, io)
    same(product.collectManagedFiles(stage + '/rollback/new', normal.manifest.managedRoots, normal.manifest.files),
      [...normal.manifest.files].sort((a, b) => a.path < b.path ? -1 : a.path > b.path ? 1 : 0), 'continuation-prepared-source')
    // Product backups are checked as product artifacts, never compared with running account/session data.
    const oldArchive = io.lstatSync(stage + '/rollback/old.tar.gz')
    need(oldArchive.isFile() && !oldArchive.isSymbolicLink() && oldArchive.uid === 0 && oldArchive.nlink === 1
      && (oldArchive.mode & 0o022) === 0, 'continuation-prepared-backup')
    return { planSha256: hash(bytes), planIdentity: identity(io.lstatSync(rollback)) }
  }
  const noPriorCaller = () => {
    const allowed = new Set([String(process.pid), String(process.ppid)])
    for (const pid of io.readdirSync('/proc').filter(name => /^[0-9]+$/.test(name) && !allowed.has(name))) {
      let descriptors
      try { descriptors = io.readdirSync('/proc/' + pid + '/fd') }
      catch (error) { if (['ENOENT', 'ESRCH'].includes(error.code)) continue; throw error }
      for (const descriptor of descriptors) {
        try {
          const stat = io.statSync('/proc/' + pid + '/fd/' + descriptor)
          need(String(stat.dev) !== store.identity.device || String(stat.ino) !== store.identity.inode,
            'continuation-other-caller')
        } catch (error) { if (!['ENOENT', 'ESRCH', 'EBADF'].includes(error.code)) throw error }
      }
    }
  }
  const before = () => {
    nativeState.requireNativePublishIntent(expected, store.read())
    same(store.read(), expected, 'continuation-record-changed')
    const app = controller.originalApp
    need(Number.isSafeInteger(app.pid) && app.pid > 0 && /^[0-9]+$/.test(app.startTicks)
      && /^[a-f0-9]{64}$/.test(app.execId)
      && io.readlinkSync('/proc/' + app.pid + '/ns/mnt') === current.namespaceId
      && io.readlinkSync('/proc/' + app.pid + '/exe') === current.nodePath, 'continuation-app-identity')
    const appStat = io.readFileSync('/proc/' + app.pid + '/stat', 'utf8')
    need(appStat.slice(appStat.lastIndexOf(')') + 2).trim().split(/\s+/)[19] === app.startTicks,
      'continuation-app-start')
    const appStatus = io.readFileSync('/proc/' + app.pid + '/status', 'utf8')
    need(/^Uid:\s+2000\s+2000\s+2000\s+2000$/m.test(appStatus)
      && /^Gid:\s+2000\s+2000\s+2000\s+2000$/m.test(appStatus)
      && io.readFileSync('/proc/' + app.pid + '/cmdline', 'utf8').split('\0')
        .includes('/opt/dsh-installed-products/apps/cli/lib/bin.js'), 'continuation-app-process')
    const productIdentity = controller.originalProduct
    need(/^\/dev\/[A-Za-z0-9/_-]+$/.test(productIdentity.device), 'continuation-product-device')
    const mounted = JSON.parse(execute('findmnt', ['--json', '--target', '/opt/dsh-installed-products',
      '--output', 'TARGET,SOURCE,FSTYPE,OPTIONS'], { encoding: 'utf8', maxBuffer: 131072,
      stdio: ['ignore', 'pipe', 'pipe'] })).filesystems
    need(mounted.length === 1 && mounted[0].target === '/opt/dsh-installed-products'
      && mounted[0].source === productIdentity.device && mounted[0].fstype === productIdentity.filesystem
      && mounted[0].options.split(',').includes('ro') && !mounted[0].options.split(',').includes('rw')
      && execute('blockdev', ['--getro', productIdentity.device], { encoding: 'utf8', maxBuffer: 131072,
        stdio: ['ignore', 'pipe', 'pipe'] }).trim() === '1', 'continuation-product-readonly')
    same(observeTuple(groups, product.collectManagedFiles, io), expected.originalTupleSha256, 'continuation-original-group')
    otherInputs(spec, io)
    const preview = previewProfile(spec, io)
    need(preview.source === spec.candidate.source && preview.sha256 === spec.candidate.sha256, 'continuation-candidate-pin')
    let absent = false
    try { io.lstatSync(preview.source) }
    catch (error) { if (error.code !== 'ENOENT') throw error; absent = true }
    need(absent, 'continuation-candidate-exists')
    const asset = nativeState.inspectPublishedFdAsset(10, approved.asset, io)
    return { asset, prepared: prepared() }
  }
  noPriorCaller()
  const initial = before()
  const intent = store.publishContinuationFile('intent', expected, {
    format: 'pe-cloud-native-publish-continuation-intent/v1', operation: expected.operation,
    previousLoad: 'unknown', recordSha256: hash(JSON.stringify(expected)), controller,
    originalTupleSha256: expected.originalTupleSha256, targetTupleSha256: expected.targetTupleSha256,
    compatibleTupleSha256: expected.compatibleTupleSha256, ...initial,
  })
  let targetLoad, profile, rawLoad, failure
  try {
    same(before(), initial, 'continuation-input-changed-after-intent')
    targetLoad = loadPublishedAsset(initial.asset, current, { io, execute: (command, args, options) => {
      let result
      try { result = spawn(command, args, { ...options, encoding: undefined }) }
      catch (error) {
        rawLoad = { status: null, signal: null, error: { code: error.code ?? null },
          statusMissing: true, signalMissing: true, timedOut: error.code === 'ETIMEDOUT',
          stdoutBase64: null, stderrBase64: null, outputMissing: true, truncated: false }
        throw error
      }
      rawLoad = { status: result.status ?? null, signal: result.signal ?? null,
        statusMissing: result.status === undefined, signalMissing: result.signal === undefined,
        timedOut: result.error?.code === 'ETIMEDOUT',
        error: result.error === undefined ? null : { code: result.error.code ?? null },
        stdoutBase64: Buffer.isBuffer(result.stdout) ? result.stdout.toString('base64') : null,
        stderrBase64: Buffer.isBuffer(result.stderr) ? result.stderr.toString('base64') : null,
        outputMissing: !Buffer.isBuffer(result.stdout) || !Buffer.isBuffer(result.stderr),
        truncated: result.error?.code === 'ENOBUFS' }
      need(result.error === undefined && result.status === 0 && result.signal === null
        && !rawLoad.outputMissing && !rawLoad.truncated, 'continuation-load-result')
      return result.stdout.toString('utf8')
    } })
    same(before(), initial, 'continuation-input-changed-after-load')
    profile = publishProfile(spec, expected, io)
    same(nativeState.inspectPublishedFdAsset(10, approved.asset, io), initial.asset, 'continuation-asset-changed')
    otherInputs(spec, io)
    same(prepared(), initial.prepared, 'continuation-prepared-changed')
  } catch (error) { failure = error }
  const receipt = store.publishContinuationFile('receipt', expected, {
    format: 'pe-cloud-native-publish-continuation-receipt/v1', operation: expected.operation,
    previousLoad: 'unknown', intent, confirmed: failure === undefined,
    rawLoad: rawLoad ?? { status: null, signal: null, error: null, stdoutBase64: null,
      stderrBase64: null, statusMissing: true, signalMissing: true, timedOut: false, outputMissing: true, truncated: false },
    targetLoad: targetLoad ?? null, profile: profile ?? null,
    candidateOutcome: profile === undefined ? 'unconfirmed' : 'confirmed',
    failurePhase: failure === undefined ? null : failure.phase ?? 'unknown',
  })
  if (failure !== undefined) throw new NativeProfileUnconfirmed('continuation-attempt-unconfirmed', failure)
  const next = { ...expected, phase: 'published', sequence: 3, history: [...expected.history, 'published'] }
  const record = store.advance(expected, next)
  same(record, next, 'continuation-advance-receipt')
  return { ...initial.asset, targetLoad, profile, intent, receipt, record }
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
  loadPublishedAsset, continueNativePublish, NativeProfileUnconfirmed, directoryPaging, directoryCapacity,
  directoryCandidate, readDirectoryFacts, requireUnpublishedDirectoryAsset, DIRECTORY_PROTOCOL, DIRECTORY_STREAM }
