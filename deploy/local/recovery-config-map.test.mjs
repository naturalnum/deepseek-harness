import assert from 'node:assert/strict'
import { createHash } from 'node:crypto'
import { test } from 'node:test'
import { mapRecoveryConfiguration } from './recovery-config-map.mjs'
import { rebuildRecoveryFiles, readAndRebuildRecoveryFiles, RECOVERY_ROOT_FILES } from './recovery-config.mjs'

const hash = bytes => createHash('sha256').update(bytes).digest('hex')
// Public generate-feature-root-profile-v3.mjs emits one insert group with these unique ids/fields.
function fixture() {
  const oldPlan = 'a'.repeat(64)
  const deploymentBytes = Buffer.from(JSON.stringify({ schema: 'pe-opensandbox-root-deployment-v2',
    storage: { plan: { sha256: oldPlan } }, lifecycle: { lifecycleBaseUrl: 'http://192.0.2.7:18100/v1' },
    retained: { endpoint: 'http://192.0.2.7:18100/v1', value: 'synthetic-secret' } }, null, 2) + '\r\n')
  const rootBytes = Buffer.from('\uFEFF' + JSON.stringify([{ insert: [
    { id: 'webserver', config: { host: '192.0.2.6', port: 18920 } },
    { id: 'files-root', config: { staticStorage: { planSha256: oldPlan } } },
    { id: 'execution-root', config: { rootDeployment: { sha256: hash(deploymentBytes) } } },
    { id: 'runtime-root', config: { internalAddress: 'http://192.0.2.6:18920', database: { host: '192.0.2.5', port: 5432 } } },
    { id: 'access-root', config: { publicOrigin: 'http://127.0.0.1:41000', database: { host: '192.0.2.5', port: 5432 } } },
    { id: 'untouched-字节', config: { port: 5432, host: '192.0.2.5', quoted: '"\\x', sha256: oldPlan } },
  ] }], null, 2).replaceAll('\n', '\r\n') + '\r\n')
  const addresses = { listenHost: '192.0.2.16', listenPort: 18921, internalAddress: 'http://192.0.2.16:18921',
    databaseHost: '192.0.2.15', databasePort: 5544, publicOrigin: 'http://127.0.0.1:42000', lifecycleBaseUrl: 'http://192.0.2.17:18101/v1' }
  return { rootBytes, deploymentBytes, addresses }
}

test('current JSON fields replace twelve exact tokens and retain every other byte', () => {
  const input = fixture(), patches = mapRecoveryConfiguration(input)
  assert.equal(patches.length, 12)
  const prepared = rebuild(input, patches), rootBytes = prepared.files[0].bytes, deploymentBytes = prepared.files[1].bytes
  const rows = JSON.parse(rootBytes.toString('utf8').replace(/^\uFEFF/, ''))[0].insert
  const config = id => rows.find(row => row.id === id).config
  assert.deepEqual(config('webserver'), { host: input.addresses.listenHost, port: input.addresses.listenPort })
  assert.equal(config('runtime-root').internalAddress, input.addresses.internalAddress)
  for (const id of ['runtime-root', 'access-root']) {
    assert.deepEqual(config(id).database, { host: input.addresses.databaseHost, port: input.addresses.databasePort })
  }
  assert.equal(config('access-root').publicOrigin, input.addresses.publicOrigin)
  assert.equal(config('files-root').staticStorage.planSha256, hash(prepared.files[4].bytes))
  assert.equal(config('execution-root').rootDeployment.sha256, hash(deploymentBytes))
  assert.equal(JSON.parse(deploymentBytes).lifecycle.lifecycleBaseUrl, input.addresses.lifecycleBaseUrl)
  assert.equal(JSON.parse(deploymentBytes).retained.endpoint, 'http://192.0.2.7:18100/v1')
  for (const [source, output, prefix] of [[input.rootBytes, rootBytes, 'root.'], [input.deploymentBytes, deploymentBytes, 'deployment.']]) {
    let before = 0, after = 0
    for (const patch of patches.filter(row => row.slot.startsWith(prefix)).sort((a, b) => a.offset - b.offset)) {
      const length = patch.offset - before
      assert.deepEqual(source.subarray(before, patch.offset), output.subarray(after, after + length))
      const replacementLength = patch.slot.endsWith('Hash') ? 64 : Buffer.byteLength(patch.value)
      before = patch.offset + patch.expected.length; after += length + replacementLength
    }
    assert.deepEqual(source.subarray(before), output.subarray(after))
  }
})

function rebuildInput(input, patches = mapRecoveryConfiguration(input)) {
  return { rootBytes: input.rootBytes, deploymentBytes: input.deploymentBytes, patches,
    packageBytes: Buffer.from('{"synthetic":true}\n'), storagePlanBytes: Buffer.from('{"freshMeasurement":true}\n'),
    mutableProfileBytes: Buffer.from('\uFEFF# retained mutable profile 字节\r\n'),
    authInit: { database: { password: 'synthetic-db' }, authSecret: 'synthetic-auth' },
    fileMetadata: Object.fromEntries(RECOVERY_ROOT_FILES.map(name => [name, { uid: 2000, gid: 2000, mode: '0600' }])) }
}

const rebuild = (input, patches) => rebuildRecoveryFiles(rebuildInput(input, patches))

test('duplicate entry ids or JSON keys refuse without changing the source buffers', () => {
  const input = fixture(), original = Buffer.from(input.rootBytes)
  input.rootBytes = Buffer.from(input.rootBytes.toString().replace('"id": "untouched-字节"', '"id": "webserver"'))
  assert.throws(() => mapRecoveryConfiguration(input), /字段未唯一确认/)
  input.rootBytes = Buffer.from(original.toString().replace('"port": 18920', '"port": 18920, "port": 18921'))
  assert.throws(() => mapRecoveryConfiguration(input), /字段未唯一确认/)
  assert.deepEqual(fixture().rootBytes, original)
})

test('missing ports, invalid coordinates and escaped tokens refuse without partial output', () => {
  for (const change of [value => delete value.addresses.databasePort, value => value.addresses.databasePort = 65536,
    value => value.addresses.publicOrigin += '/path', value => value.addresses.internalAddress = '192.0.2.6',
    value => value.rootBytes = Buffer.from(value.rootBytes.toString().replace('192.0.2.6', '192.0.2.\\u0036'))]) {
    const input = fixture(); change(input)
    assert.throws(() => mapRecoveryConfiguration(input), /字段未唯一确认/)
  }
})

test('stale ranges and incomplete split-port mappings refuse before rebuilding', () => {
  const input = fixture(), patches = mapRecoveryConfiguration(input)
  input.rootBytes = Buffer.concat([Buffer.from(' '), input.rootBytes])
  assert.throws(() => rebuild(input, patches))
  assert.throws(() => rebuild(fixture(), patches.filter(row => row.slot !== 'root.listenPort')))
})

test('explicit original credentials retain additional references, records, BOM and CRLF byte for byte', () => {
  const input = rebuildInput(fixture())
  delete input.authInit
  input.credentialsBytes = Buffer.from('\uFEFFversion: 1\r\nrefs:\r\n  NEW_DB_REF: synthetic-db\r\n  EXTRA_REF: synthetic-extra\r\nrecords: {}\r\n')
  const output = rebuildRecoveryFiles(input)
  assert.deepEqual(output.files[3].bytes, input.credentialsBytes)
  assert.notEqual(output.files[3].bytes, input.credentialsBytes)
  for (const invalid of [undefined, Buffer.alloc(0), 'not-a-buffer']) {
    assert.throws(() => rebuildRecoveryFiles({ ...input, credentialsBytes: invalid }))
  }
  assert.throws(() => rebuildRecoveryFiles({ ...input, authInit: {} }))
})

test('the retained credential source is explicit and source failure never falls back to auth-init', async () => {
  const input = rebuildInput(fixture()), calls = []
  const sources = Object.fromEntries(['root', 'deployment', 'package', 'credentials', 'storagePlan', 'mutableProfile'].map(name => [name, '/private/' + name]))
  const specification = { sources, patches: input.patches, fileMetadata: input.fileMetadata }
  const contents = { root: input.rootBytes, deployment: input.deploymentBytes, package: input.packageBytes,
    credentials: Buffer.from('{ "version": 1, "refs": { "NEW_DB_REF": "synthetic-only" } }\r\n'),
    storagePlan: input.storagePlanBytes, mutableProfile: input.mutableProfileBytes }
  const result = await readAndRebuildRecoveryFiles(specification, { readFile: async path => {
    calls.push(path); return contents[path.slice('/private/'.length)]
  } })
  assert.deepEqual(result.files[3].bytes, contents.credentials)
  assert.deepEqual(calls, Object.values(sources))
  calls.length = 0
  await assert.rejects(readAndRebuildRecoveryFiles({ ...specification, sources: { ...sources, credentials: undefined } }, {
    readFile: async path => { calls.push(path) },
  }))
  assert.deepEqual(calls, [])
  await assert.rejects(readAndRebuildRecoveryFiles(specification, { readFile: async path => {
    if (path === sources.credentials) throw new Error('synthetic-secret must stay contained')
    return contents[path.slice('/private/'.length)]
  } }), error => !error.message.includes('synthetic-secret'))
})
