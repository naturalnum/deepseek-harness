/** Synthetic files and real startup parsers only; no deployed projections, PostgreSQL, Kubernetes or network requests. */
import assert from 'node:assert/strict'
import { createHash, randomBytes, randomUUID } from 'node:crypto'
import { chmod, lstat, mkdir, mkdtemp, readFile, rm, symlink, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { dirname, join } from 'node:path'
import { rootCertificates } from 'node:tls'
import { test } from 'node:test'
import { captureDeploymentPrivate, prepareRestoredDeploymentPrivate, writeRestoredDeploymentPrivate } from './backup-private.mjs'
import { validateAccountStartup } from './accounts.mjs'
import { validateRemoteMcpStartup } from './start.mjs'
import { remoteMcpCaPath, remoteMcpConfigPath, remoteMcpKeyPath } from './remote-mcp.mjs'
import { captureBackupMcpConfiguration } from '../scripts/backup-support.mjs'

const logicalRoot = '/run/power-evolve/private'
const allFeatures = { ssh: true, remoteMcp: true, notesCa: true }
const example = JSON.parse(await readFile(new URL('../platform/remote-mcp.example.json', import.meta.url), 'utf8'))
const management = { maxUsers: 100, models: [{ id: 'fixture-model', label: 'Fixture', maxTokens: 1000 }],
  initialSettings: { model: 'fixture-model', maxTokens: 1000 } }
const ca = Buffer.from(rootCertificates[0] + '\n') // Public bundled trust anchor, never the operator's CA.
const hash = bytes => createHash('sha256').update(bytes).digest('hex')
const json = value => Buffer.from(JSON.stringify(value, null, 2) + '\n')
const missing = path => assert.rejects(lstat(path), { code: 'ENOENT' })

async function put(root, path, bytes) {
  await mkdir(dirname(join(root, path)), { recursive: true, mode: 0o700 })
  await writeFile(join(root, path), bytes, { mode: 0o600 })
}
async function fixture(t) {
  const root = await mkdtemp(join(tmpdir(), 'pe-deployment-private-'))
  t.after(() => rm(root, { recursive: true, force: true }))
  const source = join(root, 'source'), bundle = join(root, 'bundle'), parent = join(root, 'target-parent')
  for (const path of [source, bundle, parent]) await mkdir(path, { mode: 0o700 })
  const config = { ...structuredClone(example), credentialKeyFile: remoteMcpKeyPath, requireOriginException: true,
    internalExceptions: [
      { origin: 'https://fixture.example.test', addresses: ['127.0.0.1'], caFile: remoteMcpCaPath('fixture-ca.pem') },
      { origin: 'http://fixture-http.example.test:18886', addresses: ['127.0.0.1'], allowHttp: true },
    ] }
  const files = new Map([
    ['users.json', json([])], ['worker-token', Buffer.from('synthetic-worker')],
    ['model-key', Buffer.from('synthetic-model')], ['connector-key', Buffer.from('synthetic-connector')],
    ['runner-key', Buffer.from('synthetic-runner')], ['account-management.json', json(management)],
    ['ssh-credential-key', Buffer.from(randomBytes(32).toString('base64url') + '\n')],
    ['remote-mcp/config.json', json(config)],
    ['remote-mcp/credential-key', Buffer.from(randomBytes(32).toString('base64url') + '\n')],
    ['remote-mcp/ca/fixture-ca.pem', ca], ['qa-notes-ca.pem', ca],
  ])
  for (const [path, bytes] of files) await put(source, path, bytes)
  return { root, source, bundle, parent, target: join(parent, 'private'), config, files }
}
const mappedReader = root => path => {
  assert(path.startsWith(logicalRoot + '/'))
  return readFile(join(root, path.slice(logicalRoot.length + 1)), 'utf8')
}

test('captures fixed Deployment bytes and restores them through real startup validators without secrets in metadata', async t => {
  const f = await fixture(t)
  await put(f.source, 'database-url', Buffer.from('synthetic-source-database-url'))
  await put(f.source, 'model.env', Buffer.from('synthetic-legacy-model-environment'))
  const descriptor = await captureDeploymentPrivate(f.source, f.bundle, allFeatures)
  assert.deepEqual(Object.keys(descriptor).sort(), ['features', 'files', 'format', 'kind', 'sourceProjectedRoot'])
  assert.equal(descriptor.kind, 'power-evolve-deployment-private')
  assert.equal(descriptor.format, 1)
  assert.deepEqual(descriptor.features, allFeatures)
  assert.equal(descriptor.sourceProjectedRoot, f.source)
  assert.deepEqual(descriptor.files.map(entry => entry.path).sort(), [...f.files.keys()].sort())
  for (const entry of descriptor.files) {
    const bytes = f.files.get(entry.path)
    assert.deepEqual(Object.keys(entry).sort(), ['file', 'path', 'sha256', 'size'])
    assert.equal(entry.file, 'config/deployment-private/' + entry.path)
    assert.equal(entry.size, bytes.length)
    assert.equal(entry.sha256, hash(bytes))
    assert((await readFile(join(f.bundle, entry.file))).equals(bytes))
  }
  await chmod(f.parent, 0o755) // A non-writable public parent is safe; new private files still stay owner-only.
  const prepared = await prepareRestoredDeploymentPrivate(descriptor, f.bundle, f.target)
  await missing(f.target)
  assert.deepEqual(Object.keys(prepared).sort(), ['files', 'targetRoot'])
  assert(Object.isFrozen(prepared) && Object.isFrozen(prepared.files))
  const metadata = JSON.stringify({ descriptor, prepared })
  for (const path of ['model-key', 'connector-key', 'ssh-credential-key', 'remote-mcp/credential-key']) {
    assert(!metadata.includes(f.files.get(path).toString().trim()))
  }
  const restored = await writeRestoredDeploymentPrivate(prepared)
  assert.deepEqual(restored, { privateRoot: f.target, files: descriptor.files.map(entry => entry.path) })
  for (const [path, bytes] of f.files) {
    assert((await readFile(join(f.target, path))).equals(bytes))
    assert((await readFile(join(f.source, path))).equals(bytes))
    assert.equal((await lstat(join(f.target, path))).mode & 0o777, 0o600)
  }
  for (const path of ['', 'remote-mcp', 'remote-mcp/ca']) assert.equal((await lstat(join(f.target, path))).mode & 0o777, 0o700)
  await missing(join(f.target, 'database-url'))
  await missing(join(f.target, 'model.env'))
  await validateAccountStartup('', mappedReader(f.target))
  await validateRemoteMcpStartup(remoteMcpConfigPath, mappedReader(f.target))
  const { McpCredentialCipher } = await import('../application/lib/platform/mcp-credentials.js')
  const identity = { kind: 'connection', userId: randomUUID(), resourceId: randomUUID(),
    configurationRevision: 2, credentialRevision: 2 }
  const upload = { formatVersion: 1, headers: [{ name: 'authorization', value: 'Bearer synthetic-token' }] }
  const sourceCipher = new McpCredentialCipher(f.files.get('remote-mcp/credential-key').toString())
  const restoredCipher = new McpCredentialCipher(await readFile(join(f.target, 'remote-mcp/credential-key'), 'utf8'))
  assert.deepEqual(restoredCipher.open(identity, sourceCipher.seal(identity, upload)), upload)
  await assert.rejects(writeRestoredDeploymentPrivate(prepared), { message: 'Deployment private restore write failed' })
  await assert.rejects(captureDeploymentPrivate(f.source, f.bundle, allFeatures), { message: 'Deployment private capture failed' })
})

test('disabled optional projections require only the six baseline materials and ignore legacy extras', async t => {
  const f = await fixture(t)
  await put(f.source, 'remote-mcp/config.json', Buffer.from('invalid optional material must not be read'))
  const descriptor = await captureDeploymentPrivate(f.source, f.bundle)
  assert.deepEqual(descriptor.features, { ssh: false, remoteMcp: false, notesCa: false })
  assert.equal(descriptor.files.length, 6)
  assert(descriptor.files.every(entry => !entry.path.startsWith('remote-mcp/') && !entry.path.endsWith('.pem')))
  const prepared = await prepareRestoredDeploymentPrivate(descriptor, f.bundle, f.target)
  await writeRestoredDeploymentPrivate(prepared)
  await missing(join(f.target, 'ssh-credential-key'))
  await missing(join(f.target, 'remote-mcp'))
  await validateAccountStartup('', mappedReader(f.target))
})

test('capture refuses missing, unsafe and parser-invalid source materials before creating backup output', async t => {
  const cases = [
    ['missing required file', f => rm(join(f.source, 'worker-token'))],
    ['readable credential', f => chmod(join(f.source, 'model-key'), 0o644)],
    ['symlink credential', async f => { await rm(join(f.source, 'model-key')); await symlink(join(f.source, 'worker-token'), join(f.source, 'model-key')) }],
    ['invalid account policy', f => put(f.source, 'account-management.json', json({ ...management, maxUsers: 0 }))],
    ['unprojected MCP key', f => put(f.source, 'remote-mcp/config.json', json({ ...f.config, credentialKeyFile: '/unprojected/synthetic-key' }))],
    ['invalid MCP budget', f => put(f.source, 'remote-mcp/config.json', json({ ...f.config, transport: { ...f.config.transport, maxRequestBytes: 0 } }))],
    ['missing declared CA', f => rm(join(f.source, 'remote-mcp/ca/fixture-ca.pem'))],
    ['invalid MCP sealing key', f => put(f.source, 'remote-mcp/credential-key', Buffer.from('synthetic-invalid-key'))],
    ['invalid Notes CA', f => put(f.source, 'qa-notes-ca.pem', Buffer.from('synthetic-invalid-ca'))],
    ['oversized baseline file', f => put(f.source, 'users.json', Buffer.alloc(1024 * 1024 + 1, 65))],
  ]
  for (const [name, change] of cases) await t.test(name, async t => {
    const f = await fixture(t)
    await change(f)
    await assert.rejects(captureDeploymentPrivate(f.source, f.bundle, allFeatures), { message: 'Deployment private capture failed' })
    await missing(join(f.bundle, 'config'))
  })
})

test('restore verifies descriptor and bundle bytes before any destination mutation', async t => {
  const cases = [
    ['tampered byte', async (f, descriptor) => { const entry = descriptor.files.find(entry => entry.path === 'model-key'); await put(f.bundle, entry.file, Buffer.alloc(entry.size, 65)) }],
    ['extra database mapping', async (_f, descriptor) => descriptor.files.push({ path: 'database-url', file: 'config/deployment-private/database-url', size: 1, sha256: 'a'.repeat(64) })],
    ['duplicate file', async (_f, descriptor) => descriptor.files.push({ ...descriptor.files[0] })],
    ['traversal path', async (_f, descriptor) => { descriptor.files[0].file = '../source/worker-token' }],
    ['undeclared CA mapping', async (_f, descriptor) => descriptor.files.push({ path: 'remote-mcp/ca/extra.pem', file: 'config/deployment-private/remote-mcp/ca/extra.pem', size: ca.length, sha256: hash(ca) })],
    ['incomplete feature switches', async (_f, descriptor) => { delete descriptor.features.ssh }],
  ]
  for (const [name, change] of cases) await t.test(name, async t => {
    const f = await fixture(t)
    const descriptor = await captureDeploymentPrivate(f.source, f.bundle, allFeatures)
    await change(f, descriptor)
    await assert.rejects(prepareRestoredDeploymentPrivate(descriptor, f.bundle, f.target),
      { message: 'Deployment private restore preparation failed' })
    await missing(f.target)
  })
})

test('restore refuses existing, overlapping or unsafe destination and rechecks it at publish time', async t => {
  const f = await fixture(t)
  const descriptor = await captureDeploymentPrivate(f.source, f.bundle, allFeatures)
  for (const target of [f.source, join(f.source, 'new-private'), f.bundle, join(f.bundle, 'new-private')]) {
    await assert.rejects(prepareRestoredDeploymentPrivate(descriptor, f.bundle, target),
      { message: 'Deployment private restore preparation failed' })
  }
  await chmod(f.parent, 0o777)
  await assert.rejects(prepareRestoredDeploymentPrivate(descriptor, f.bundle, f.target),
    { message: 'Deployment private restore preparation failed' })
  await missing(f.target)
  await chmod(f.parent, 0o700)
  const prepared = await prepareRestoredDeploymentPrivate(descriptor, f.bundle, f.target)
  await mkdir(f.target, { mode: 0o700 })
  await put(f.target, 'sentinel', Buffer.from('synthetic-existing-target'))
  await assert.rejects(writeRestoredDeploymentPrivate(prepared), { message: 'Deployment private restore write failed' })
  assert.equal(await readFile(join(f.target, 'sentinel'), 'utf8'), 'synthetic-existing-target')
  await assert.rejects(prepareRestoredDeploymentPrivate(descriptor, f.bundle, f.target),
    { message: 'Deployment private restore preparation failed' })
  await missing(join(f.target, 'users.json'))
})

test('legacy trial MCP capture retains its original descriptor and physical paths', async t => {
  const f = await fixture(t), stage = join(f.root, 'trial-bundle')
  await mkdir(stage, { mode: 0o700 })
  await mkdir(join(stage, 'config'), { mode: 0o700 })
  const configuration = { ...f.config, credentialKeyFile: join(f.source, 'remote-mcp/credential-key'),
    internalExceptions: f.config.internalExceptions.map(item => ({ ...item,
      ...(item.caFile ? { caFile: join(f.source, 'remote-mcp/ca/fixture-ca.pem') } : {}) })) }
  await put(f.source, 'trial-mcp.json', json(configuration))
  const descriptor = await captureBackupMcpConfiguration(join(f.source, 'trial-mcp.json'), stage)
  assert.deepEqual(descriptor, { format: 1, configFile: 'config/remote-mcp/configuration.json',
    credentialKeyFile: 'config/remote-mcp/credential-key', caFiles: [{ index: 0, file: 'config/remote-mcp/ca-0.pem' }] })
  assert((await readFile(join(stage, descriptor.configFile))).equals(json(configuration)))
  assert((await readFile(join(stage, descriptor.credentialKeyFile))).equals(f.files.get('remote-mcp/credential-key')))
})
