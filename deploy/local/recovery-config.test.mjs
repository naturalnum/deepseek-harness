import assert from 'node:assert/strict'
import { createHash } from 'node:crypto'
import { test } from 'node:test'
import { CandidateError } from './inspect.mjs'
import {
  rebuildRecoveryFiles, readAndRebuildRecoveryFiles, writeRecoveryFilesBesideSources,
} from './recovery-config.mjs'

const hash = bytes => createHash('sha256').update(bytes).digest('hex')
const paths = [
  'profiles/cloud/cordis.patch.yml', 'rootDeployment.json', 'profiles/cloud/package.json',
  'credentials.json', 'storage-plan.json', 'profiles/cloud/cordis.yml',
]
const secret = 'synthetic-secret-"-\\-\n-do-not-log'

function fixture() {
  const oldPlanHash = 'a'.repeat(64)
  const deploymentBytes = Buffer.from(`{\r\n "plan":"${oldPlanHash}", "server":"http://192.0.2.7:18100", "key":"synthetic-sdk-secret"\r\n}\r\n`)
  const rootBytes = Buffer.from(`\uFEFF# synthetic YAML only; preserve CRLF and Unicode 字节\r\nplan: ${oldPlanHash}\r\ndeployment: ${hash(deploymentBytes)}\r\nlisten: 192.0.2.6\r\ninternal: 192.0.2.6\r\ndatabase-a: 192.0.2.5\r\ndatabase-b: 192.0.2.5\r\norigin: http://127.0.0.1:40000\r\nother: 'unchanged'\r\n`)
  const make = (bytes, slot, expected, value, occurrence = 0) => {
    const token = Buffer.from(expected)
    let offset = -1
    for (let index = 0; index <= occurrence; index++) offset = bytes.indexOf(token, offset + 1)
    return { slot, offset, expected: token, ...(value === undefined ? {} : { value }) }
  }
  return {
    rootBytes, deploymentBytes, packageBytes: Buffer.from('\uFEFF{ "name": "synthetic-only" }\r\n'),
    storagePlanBytes: Buffer.from('{"syntheticMeasurement":true}\n'),
    mutableProfileBytes: Buffer.from('\uFEFF# synthetic mutable profile 字节\r\n- id: personal-setting\r\n  config: { value: untouched }\r\n'),
    authInit: { database: { password: secret }, authSecret: 'synthetic-auth-secret' },
    patches: [
      make(rootBytes, 'root.storagePlanHash', oldPlanHash),
      make(rootBytes, 'root.deploymentHash', hash(deploymentBytes)),
      make(rootBytes, 'root.listenAddress', '192.0.2.6', '192.0.2.16'),
      make(rootBytes, 'root.internalAddress', '192.0.2.6', '192.0.2.16', 1),
      make(rootBytes, 'root.databaseAddress.primary', '192.0.2.5', '192.0.2.15'),
      make(rootBytes, 'root.databaseAddress.secondary', '192.0.2.5', '192.0.2.15', 1),
      make(rootBytes, 'root.publicOrigin', 'http://127.0.0.1:40000', 'http://127.0.0.1:41000'),
      make(deploymentBytes, 'deployment.storagePlanHash', oldPlanHash),
      make(deploymentBytes, 'deployment.backendAddress', 'http://192.0.2.7:18100', 'http://192.0.2.17:18100'),
    ],
    fileMetadata: Object.fromEntries(paths.map(relativePath => [relativePath, { uid: 2000, gid: 2000, mode: '0600' }])),
  }
}

function memoryWriter(prepared, { present = [], failWriteAt } = {}) {
  const files = new Map(present.map(index => {
    const file = prepared.files[index]
    return ['/new-root/' + file.relativePath, { bytes: Buffer.from(file.bytes), uid: file.uid, gid: file.gid,
      mode: 0o100000 | Number.parseInt(file.mode, 8) }]
  }))
  const calls = []
  let writes = 0
  const io = {
    async lstat(path) {
      calls.push(['lstat', path])
      if (['/new-root', '/new-root/profiles', '/new-root/profiles/cloud'].includes(path)) return { isDirectory: () => true }
      const file = files.get(path)
      if (!file) throw Object.assign(new Error('synthetic missing file'), { code: 'ENOENT' })
      return { uid: file.uid, gid: file.gid, mode: file.mode, size: file.bytes.length, isFile: () => true }
    },
    async readFile(path) {
      calls.push(['read', path])
      return Buffer.from(files.get(path).bytes)
    },
    async open(path, flags, mode) {
      calls.push(['open', path, flags, mode])
      assert.equal(flags, 'wx'); assert.equal(mode, 0o600)
      if (files.has(path)) throw Object.assign(new Error('synthetic existing file'), { code: 'EEXIST' })
      const file = { bytes: Buffer.alloc(0), uid: 0, gid: 0, mode: 0o100000 | mode }
      files.set(path, file)
      return {
        async writeFile(bytes) {
          calls.push(['write', path]); writes++
          if (writes === failWriteAt) {
            file.bytes = Buffer.from(bytes.subarray(0, 3))
            throw new Error(secret)
          }
          file.bytes = Buffer.from(bytes)
        },
        async chown(uid, gid) { calls.push(['chown', path, uid, gid]); file.uid = uid; file.gid = gid },
        async chmod(permission) { calls.push(['chmod', path, permission]); file.mode = 0o100000 | permission },
        async sync() { calls.push(['sync', path]) }, async close() { calls.push(['close', path]) },
      }
    },
  }
  return { io, calls, files }
}

function undoSlots(output, patches, values) {
  const ordered = patches.toSorted((a, b) => a.offset - b.offset)
  const parts = []
  let originalOffset = 0, outputOffset = 0
  for (const patch of ordered) {
    const unchangedLength = patch.offset - originalOffset
    parts.push(output.subarray(outputOffset, outputOffset + unchangedLength), patch.expected)
    outputOffset += unchangedLength + Buffer.byteLength(values[patch.slot])
    originalOffset = patch.offset + patch.expected.length
  }
  parts.push(output.subarray(outputOffset))
  return Buffer.concat(parts)
}

test('preserves every original byte outside reviewed slots and computes the dependency hash chain', () => {
  const input = fixture(), originalRoot = Buffer.from(input.rootBytes), originalDeployment = Buffer.from(input.deploymentBytes)
  const result = rebuildRecoveryFiles(input)
  const file = name => result.files.find(row => row.relativePath === name).bytes
  assert.deepEqual(result.files.map(row => row.relativePath), paths)
  const planHash = hash(input.storagePlanBytes), deploymentHash = hash(file('rootDeployment.json'))
  assert.deepEqual(result.hashes, { storagePlan: planHash, deployment: deploymentHash })
  const values = Object.fromEntries(input.patches.map(row => [row.slot,
    row.slot.endsWith('storagePlanHash') ? planHash : row.slot === 'root.deploymentHash' ? deploymentHash : row.value]))
  assert.deepEqual(undoSlots(file(paths[0]), input.patches.filter(row => row.slot.startsWith('root.')), values), originalRoot)
  assert.deepEqual(undoSlots(file(paths[1]), input.patches.filter(row => row.slot.startsWith('deployment.')), values), originalDeployment)
  assert.ok(file(paths[0]).includes(Buffer.from(deploymentHash)))
  assert.ok(file(paths[1]).includes(Buffer.from(planHash)))
  assert.deepEqual(file(paths[2]), input.packageBytes)
  assert.deepEqual(file(paths[4]), input.storagePlanBytes)
  assert.deepEqual(file(paths[5]), input.mutableProfileBytes)
  assert.deepEqual(input.rootBytes, originalRoot)
  assert.deepEqual(input.deploymentBytes, originalDeployment)
  const credentials = JSON.parse(file('credentials.json'))
  assert.deepEqual(Object.keys(credentials), ['version', 'refs'])
  assert.equal(credentials.version, 1)
  assert.deepEqual(Object.keys(credentials.refs), ['DSH_FEATURE_PG_PASSWORD', 'DSH_FEATURE_AUTH_SECRET'])
  assert.equal(credentials.refs.DSH_FEATURE_PG_PASSWORD, secret)
  assert.equal(credentials.refs.DSH_FEATURE_AUTH_SECRET, input.authInit.authSecret)
  assert.ok(result.files.every(row => row.uid === 2000 && row.gid === 2000 && row.mode === '0600'))
})

test('rejects missing, unknown, duplicate and overlapping reviewed slots', () => {
  const variations = [
    input => { input.patches.pop() },
    input => { input.patches[0].slot = 'root.unapproved' },
    input => { input.patches.push({ ...input.patches[0] }) },
    input => { input.patches[2].offset = input.patches[0].offset },
    input => { input.patches[2].replacement = Buffer.from('not a supported field') },
    input => { input.patches[2].value = '192.0.2.1\nplugin: unexpected' },
    input => { input.patches[0].value = '0'.repeat(64) },
  ]
  for (const change of variations) {
    const input = fixture(); change(input)
    assert.throws(() => rebuildRecoveryFiles(input), CandidateError)
  }
})

test('rejects stale bytes and an inconsistent original hash chain', () => {
  const variations = [
    input => { input.rootBytes[input.patches[2].offset] = 120 },
    input => { input.deploymentBytes = Buffer.concat([input.deploymentBytes, Buffer.from(' ')]) },
    input => { input.patches[0].expected = Buffer.from('b'.repeat(64)) },
  ]
  for (const change of variations) {
    const input = fixture(); change(input)
    assert.throws(() => rebuildRecoveryFiles(input), CandidateError)
  }
})

test('preserves unrelated same-IP comments and an internal URL containing the listen address', () => {
  const input = fixture(), comment = '# unrelated 192.0.2.5 and 192.0.2.6\r\n'
  input.rootBytes = Buffer.from(input.rootBytes.toString('utf8')
    .replace('internal: 192.0.2.6', 'internal: http://192.0.2.6:18920') + comment)
  const labels = {
    'root.storagePlanHash': 'plan: ', 'root.deploymentHash': 'deployment: ', 'root.listenAddress': 'listen: ',
    'root.internalAddress': 'internal: ', 'root.databaseAddress.primary': 'database-a: ',
    'root.databaseAddress.secondary': 'database-b: ', 'root.publicOrigin': 'origin: ',
  }
  for (const patch of input.patches.filter(row => row.slot.startsWith('root.'))) {
    if (patch.slot === 'root.internalAddress') {
      patch.expected = Buffer.from('http://192.0.2.6:18920'); patch.value = 'http://192.0.2.16:18920'
    }
    patch.offset = input.rootBytes.indexOf(labels[patch.slot]) + Buffer.byteLength(labels[patch.slot])
  }
  const output = rebuildRecoveryFiles(input).files[0].bytes
  assert.ok(output.subarray(-Buffer.byteLength(comment)).equals(Buffer.from(comment)))
  assert.ok(output.includes(Buffer.from('internal: http://192.0.2.16:18920\r\n')))
  assert.ok(output.includes(Buffer.from('database-a: 192.0.2.15\r\ndatabase-b: 192.0.2.15\r\n')))
})

test('rejects empty credential values, extra input and incomplete ownership instead of inventing defaults', () => {
  for (const change of [
    input => { input.authInit.database.password = '' },
    input => { input.authInit.authSecret = '' },
    input => { input.credentialsTemplate = {} },
    input => { delete input.fileMetadata[paths[0]].mode },
    input => { input.fileMetadata['unexpected.json'] = { uid: 0, gid: 0, mode: '0644' } },
    input => { input.authInit = { database: {} } },
  ]) {
    const input = fixture(); change(input)
    assert.throws(() => rebuildRecoveryFiles(input), CandidateError)
  }
})

test('private input read failure cannot trigger a write and does not expose external error text', async () => {
  let writes = 0
  const input = fixture()
  const sources = { root: '/synthetic/root', deployment: '/synthetic/deployment', package: '/synthetic/package',
    authInit: '/synthetic/auth-init', storagePlan: '/synthetic/measurement', mutableProfile: '/synthetic/mutable-profile' }
  await assert.rejects(readAndRebuildRecoveryFiles({ patches: input.patches, fileMetadata: input.fileMetadata, sources }, {
    readFile: async () => { throw new Error(secret) },
    open: async () => { writes++; throw new Error('must not write') },
  }), error => error instanceof CandidateError && !error.message.includes(secret))
  assert.equal(writes, 0)
})

test('all private inputs are read before rebuilding, with no default source paths', async () => {
  const input = fixture()
  const sources = { root: '/synthetic/root', deployment: '/synthetic/deployment', package: '/synthetic/package',
    authInit: '/synthetic/auth-init', storagePlan: '/synthetic/measurement', mutableProfile: '/synthetic/mutable-profile' }
  const contents = { root: input.rootBytes, deployment: input.deploymentBytes, package: input.packageBytes,
    authInit: Buffer.from(JSON.stringify(input.authInit)), storagePlan: input.storagePlanBytes, mutableProfile: input.mutableProfileBytes }
  const result = await readAndRebuildRecoveryFiles({ patches: input.patches, fileMetadata: input.fileMetadata, sources }, { readFile: async path => {
    const key = Object.keys(sources).find(name => sources[name] === path)
    assert.ok(key)
    return contents[key]
  } })
  assert.equal(result.files.length, 6)
})

test('writes only exclusive new files with explicit ownership and permissions and never logs secrets', async () => {
  const prepared = rebuildRecoveryFiles(fixture()), storage = memoryWriter(prepared), { calls } = storage
  const originals = ['/original/root', '/original/deployment']
  const savedConsole = Object.fromEntries(['log', 'warn', 'error'].map(name => [name, console[name]]))
  try {
    for (const name of Object.keys(savedConsole)) console[name] = () => { throw new Error('unexpected logging') }
    const written = await writeRecoveryFilesBesideSources(prepared, {
      targetDirectory: '/new-root', originalPaths: originals,
    }, storage.io)
    assert.equal(written.length, 6)
    assert.ok(calls.filter(row => row[0] === 'open').every(row => row[2] === 'wx' && row[3] === 0o600))
    assert.equal(calls.filter(row => row[0] === 'chown' && row[2] === 2000 && row[3] === 2000).length, 6)
    assert.equal(calls.filter(row => row[0] === 'chmod' && row[2] === 0o600).length, 6)
    const firstOpen = calls.findIndex(row => row[0] === 'open')
    assert.equal(calls.slice(0, firstOpen).filter(row => row[0] === 'lstat').length, 9)
    assert.doesNotMatch(JSON.stringify(written), /synthetic-secret|synthetic-sdk-secret/)
  } finally { for (const [name, value] of Object.entries(savedConsole)) console[name] = value }
})

test('an intermediate output symlink prevents all reads below it and every write', async () => {
  const prepared = rebuildRecoveryFiles(fixture()), storage = memoryWriter(prepared), lstat = storage.io.lstat
  storage.io.lstat = async path => path === '/new-root/profiles'
    ? { isDirectory: () => false, isSymbolicLink: () => true } : lstat(path)
  await assert.rejects(writeRecoveryFilesBesideSources(prepared, {
    targetDirectory: '/new-root', originalPaths: ['/original/root'],
  }, storage.io), CandidateError)
  assert.equal(storage.calls.some(row => row[1]?.startsWith('/new-root/profiles/cloud')), false)
  assert.equal(storage.calls.some(row => row[0] === 'open'), false)
})

test('preflights invalid prepared files and original path conflicts before opening anything', async () => {
  for (const change of [
    (prepared, destination) => { destination.originalPaths = ['/new-root/rootDeployment.json'] },
    prepared => { prepared.files[1].relativePath = '../escape' },
    prepared => { delete prepared.files[1].mode },
  ]) {
    const prepared = rebuildRecoveryFiles(fixture()), destination = { targetDirectory: '/new-root', originalPaths: ['/original/root'] }
    change(prepared, destination)
    const storage = memoryWriter(prepared)
    await assert.rejects(writeRecoveryFilesBesideSources(prepared, destination, storage.io), CandidateError)
    assert.equal(storage.calls.filter(row => row[0] === 'open').length, 0)
  }
})

test('write errors close the private handle and expose only a fixed diagnostic', async () => {
  const prepared = rebuildRecoveryFiles(fixture()), storage = memoryWriter(prepared, { failWriteAt: 1 })
  await assert.rejects(writeRecoveryFilesBesideSources(prepared, {
    targetDirectory: '/new-root', originalPaths: ['/original/root'],
  }, storage.io), error => error instanceof CandidateError && !error.message.includes(secret))
  assert.equal(storage.calls.filter(row => row[0] === 'close').length, 1)
  assert.equal(storage.files.size, 1)
})

test('an identical complete side directory succeeds again without opening any file', async () => {
  const prepared = rebuildRecoveryFiles(fixture()), storage = memoryWriter(prepared, { present: [0, 1, 2, 3, 4, 5] })
  const result = await writeRecoveryFilesBesideSources(prepared, {
    targetDirectory: '/new-root', originalPaths: ['/original/root'],
  }, storage.io)
  assert.equal(result.length, 6)
  assert.ok(result.every(row => row.action === 'skip'))
  assert.equal(storage.calls.filter(row => row[0] === 'open').length, 0)
})

test('a trailing separator addresses the same prepared private directory', async () => {
  const prepared = rebuildRecoveryFiles(fixture()), storage = memoryWriter(prepared, { present: [0, 1, 2, 3, 4, 5] })
  const result = await writeRecoveryFilesBesideSources(prepared, {
    targetDirectory: '/new-root/', originalPaths: ['/original/root'],
  }, storage.io)
  assert.ok(result.every(row => row.action === 'skip'))
  assert.equal(storage.calls.some(row => row[0] === 'open'), false)
})

test('matching partial outputs are skipped and only absent files are written exclusively', async () => {
  const prepared = rebuildRecoveryFiles(fixture()), storage = memoryWriter(prepared, { present: [0, 2, 4] })
  const result = await writeRecoveryFilesBesideSources(prepared, {
    targetDirectory: '/new-root', originalPaths: ['/original/root'],
  }, storage.io)
  assert.equal(result.filter(row => row.action === 'skip').length, 3)
  assert.equal(result.filter(row => row.action === 'written').length, 3)
  assert.deepEqual(storage.calls.filter(row => row[0] === 'open').map(row => row[1]),
    [1, 3, 5].map(index => '/new-root/' + prepared.files[index].relativePath))
})

test('any existing mismatch or unknown metadata blocks all writes before the first open', async () => {
  for (const change of [
    file => { file.bytes[0] ^= 1 },
    file => { file.uid = 0 },
    file => { file.gid = 0 },
    file => { file.mode = 0o100644 },
    file => { file.mode = undefined },
  ]) {
    const prepared = rebuildRecoveryFiles(fixture()), storage = memoryWriter(prepared, { present: [5] })
    change(storage.files.get('/new-root/' + paths[5]))
    await assert.rejects(writeRecoveryFilesBesideSources(prepared, {
      targetDirectory: '/new-root', originalPaths: ['/original/root'],
    }, storage.io), CandidateError)
    assert.equal(storage.calls.filter(row => row[0] === 'open').length, 0)
  }
})

test('a file created after preflight still cannot be overwritten because open uses wx', async () => {
  const prepared = rebuildRecoveryFiles(fixture()), storage = memoryWriter(prepared), originalOpen = storage.io.open
  const marker = Buffer.from('synthetic concurrent owner')
  storage.io.open = async (path, flags, mode) => {
    storage.files.set(path, { bytes: Buffer.from(marker), uid: 0, gid: 0, mode: 0o100600 })
    return originalOpen(path, flags, mode)
  }
  await assert.rejects(writeRecoveryFilesBesideSources(prepared, {
    targetDirectory: '/new-root', originalPaths: ['/original/root'],
  }, storage.io), CandidateError)
  assert.deepEqual(storage.files.get('/new-root/' + paths[0]).bytes, marker)
  assert.equal(storage.calls.filter(row => row[0] === 'write').length, 0)
})

test('a failed partial write is retained and a later explicit call refuses its unknown contents', async () => {
  const prepared = rebuildRecoveryFiles(fixture()), storage = memoryWriter(prepared, { failWriteAt: 2 })
  const destination = { targetDirectory: '/new-root', originalPaths: ['/original/root'] }
  await assert.rejects(writeRecoveryFilesBesideSources(prepared, destination, storage.io), CandidateError)
  assert.equal(storage.files.size, 2)
  assert.deepEqual(storage.files.get('/new-root/' + paths[0]).bytes, prepared.files[0].bytes)
  const partial = Buffer.from(storage.files.get('/new-root/' + paths[1]).bytes)
  assert.equal(partial.length, 3)
  assert.equal(storage.calls.filter(row => row[0] === 'close').length, 2)
  storage.calls.length = 0
  await assert.rejects(writeRecoveryFilesBesideSources(prepared, destination, storage.io), CandidateError)
  assert.equal(storage.calls.filter(row => row[0] === 'open').length, 0)
  assert.equal(storage.files.size, 2)
  assert.deepEqual(storage.files.get('/new-root/' + paths[1]).bytes, partial)
})

test('incomplete I/O or reviewed metadata fails before reading private sources or writing outputs', async () => {
  const input = fixture(), sources = { root: '/synthetic/root', deployment: '/synthetic/deployment', package: '/synthetic/package',
    authInit: '/synthetic/auth-init', storagePlan: '/synthetic/measurement', mutableProfile: '/synthetic/mutable-profile' }
  const specification = { sources, patches: input.patches, fileMetadata: input.fileMetadata }
  await assert.rejects(readAndRebuildRecoveryFiles(specification, null), CandidateError)
  let read = false
  delete input.fileMetadata[paths[0]].mode
  await assert.rejects(readAndRebuildRecoveryFiles(specification, { readFile: async () => { read = true } }), CandidateError)
  assert.equal(read, false)
  const prepared = rebuildRecoveryFiles(fixture()), destination = { targetDirectory: '/new-root', originalPaths: ['/original/root'] }
  await assert.rejects(writeRecoveryFilesBesideSources(prepared, destination, null), CandidateError)
  const storage = memoryWriter(prepared)
  delete storage.io.readFile
  await assert.rejects(writeRecoveryFilesBesideSources(prepared, destination, storage.io), CandidateError)
  assert.equal(storage.calls.length, 0)
})


test('preserves original mutable profile bytes and content without replacing them with an empty configuration', async () => {
  for (const original of [fixture().mutableProfileBytes, Buffer.alloc(0), Buffer.from('[]\r\n')]) {
    const input = fixture(); input.mutableProfileBytes = Buffer.from(original)
    const result = rebuildRecoveryFiles(input), output = result.files.find(row => row.relativePath === paths[5])
    assert.deepEqual(output.bytes, original)
    input.mutableProfileBytes.fill(0)
    assert.deepEqual(output.bytes, original, 'the result owns a copy of the original bytes')
    const storage = memoryWriter(result)
    await writeRecoveryFilesBesideSources(result, { targetDirectory: '/new-root', originalPaths: ['/original/mutable-profile'] }, storage.io)
    assert.deepEqual(storage.files.get('/new-root/' + paths[5]).bytes, original)
  }
})

test('refuses missing or non-Buffer mutable profile input instead of generating an empty configuration', () => {
  for (const value of [undefined, null, '[]\n']) {
    const input = fixture()
    if (value === undefined) delete input.mutableProfileBytes
    else input.mutableProfileBytes = value
    assert.throws(() => rebuildRecoveryFiles(input), CandidateError)
  }
})

test('missing explicit mutable profile source refuses before any private source read', async () => {
  const input = fixture(), sources = { root: '/synthetic/root', deployment: '/synthetic/deployment',
    package: '/synthetic/package', authInit: '/synthetic/auth-init', storagePlan: '/synthetic/measurement' }
  let reads = 0
  await assert.rejects(readAndRebuildRecoveryFiles({ sources, patches: input.patches, fileMetadata: input.fileMetadata }, {
    readFile: async () => { reads++; return input.rootBytes },
  }), CandidateError)
  assert.equal(reads, 0)
})

test('does not infer current public host or port fields from the nine legacy slot labels', () => {
  for (const slot of ['root.listenHost', 'root.listenPort', 'root.databasePort.primary', 'root.databasePort.secondary']) {
    const input = fixture(), original = Buffer.from(input.rootBytes)
    input.patches[2].slot = slot
    assert.throws(() => rebuildRecoveryFiles(input), CandidateError)
    assert.deepEqual(input.rootBytes, original)
  }
})
