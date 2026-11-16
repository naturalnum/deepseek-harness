import assert from 'node:assert/strict'
import * as fs from 'node:fs/promises'
import { join } from 'node:path'
import { createHash } from 'node:crypto'
import { createServer } from 'node:http'
import { test } from 'node:test'
import { runLocalRecovery } from './recovery-local.mjs'

test('host recovery help imports the original lifecycle and smoke parser without accessing a live target', async () => {
  const output = []
  assert.equal(await runLocalRecovery([], { report: value => output.push(value) }), 0)
  assert.equal(await runLocalRecovery(['--help'], { report: value => output.push(value) }), 0)
  assert.equal(output.length, 2)
  assert.match(output[0], /原事务未结清则拒绝/)
})

test('host recovery rejects incomplete or malformed references before opening an input or candidate lock', async () => {
  for (const argv of [['--input'], ['--input', '/must-not-read', '--sha256', 'invalid'], ['--help', '--input', '/must-not-read']]) {
    await assert.rejects(runLocalRecovery(argv), error => error.name === 'CandidateError' && !error.message.includes('must-not-read'))
  }
})

async function privateFixture(t) {
  const directory = await fs.mkdtemp('/tmp/pe-recovery-admission-'), state = join(directory, 'local-state')
  await fs.mkdir(state, { mode: 0o700 })
  const socket = join(directory, 'engine.sock'), requests = [], sockets = new Set()
  const server = createServer((request, response) => { requests.push([request.method, request.url]); response.writeHead(500); response.end('{}') })
  server.on('connection', socket => { sockets.add(socket); socket.once('close', () => sockets.delete(socket)) })
  await new Promise((resolve, reject) => { server.once('error', reject); server.listen(socket, resolve) })
  t.after(async () => {
    for (const socket of sockets) socket.destroy()
    await new Promise((resolve, reject) => server.close(error => error ? reject(error) : resolve()))
    assert.equal(sockets.size, 0)
    await fs.rm(directory, { recursive: true })
  })
  const operation = '00000000-0000-4000-8000-000000000014'
  const latest = { format: 'pe-cloud-local-native-fd/v1', operation, phase: 'native-owned', nativePhase: 'verified' }
  const write = (name, value) => fs.writeFile(name, JSON.stringify(value) + '\n', { mode: 0o600, flag: 'wx' })
  await write(join(state, 'native-release-' + operation + '.json'), { format: 'pe-cloud-native-release/v1', operation })
  const credentials = join(directory, 'credentials.json')
  await write(credentials, { publicOrigin: 'http://127.0.0.1:32802', ordinaryUserC: { email: 'synthetic@example.invalid', password: 'fixture-only' } })
  const input = join(directory, 'input.json'), log = join(directory, 'logs')
  const spec = { schema: 'pe-cloud-cold-recovery-local/v1', container: 'owned-fixture', containerId: 'a'.repeat(64),
    imageId: 'sha256:' + 'b'.repeat(64), resourceId: operation, budgetMs: 5000, dockerPath: process.execPath, socketPath: socket,
    nodePath: '/dsh-tools/node24', rootEntry: '/not-called/recovery.mjs', rootInput: '/not-called/input.json', rootInputSha256: 'c'.repeat(64),
    stateDirectory: state, workDirectory: directory, logDirectory: log, url: 'http://127.0.0.1:32802',
    smoke: { credentialsPath: credentials, account: 'ordinaryUserC', continueSession: 'session:fixture-original', continueMarker: 'fixture-public-marker' } }
  await write(input, spec)
  const sha = createHash('sha256').update(await fs.readFile(input)).digest('hex')
  return { state, latest, write, requests, log, run: () => runLocalRecovery(['--input', input, '--sha256', sha]) }
}

test('an unverified original native phase refuses even with a matching stale release file, before a new lock or Engine request', async t => {
  const f = await privateFixture(t)
  await f.write(join(f.state, 'latest.json'), { ...f.latest, nativePhase: 'verify-intent' })
  await assert.rejects(f.run())
  await assert.rejects(fs.lstat(join(f.state, 'operation.lock')), error => error.code === 'ENOENT')
  await assert.rejects(fs.lstat(f.log), error => error.code === 'ENOENT')
  assert.deepEqual(f.requests, [])
})

test('a pending original native release refuses before any new recovery lock or Engine request', async t => {
  const f = await privateFixture(t)
  await f.write(join(f.state, 'latest.json'), f.latest)
  await f.write(join(f.state, 'native-release.pending'), { format: 'pe-cloud-native-release/v1', operation: f.latest.operation })
  await assert.rejects(f.run())
  await assert.rejects(fs.lstat(join(f.state, 'operation.lock')), error => error.code === 'ENOENT')
  assert.deepEqual(f.requests, [])
})

test('an existing operation lock remains byte-identical and prevents any new Engine request', async t => {
  const f = await privateFixture(t), lock = join(f.state, 'operation.lock'), bytes = Buffer.from('original-unconfirmed-fixture\n')
  await fs.writeFile(lock, bytes, { flag: 'wx', mode: 0o600 })
  await assert.rejects(f.run())
  assert.deepEqual(await fs.readFile(lock), bytes)
  assert.deepEqual(f.requests, [])
})

test('a confirmed normal release reaches only the selected Engine, whose failure retains this recovery lock', async t => {
  const f = await privateFixture(t)
  await f.write(join(f.state, 'latest.json'), f.latest)
  await assert.rejects(f.run(), error => error.recoveryOutcome === 'unconfirmed' && error.recoveryExecId === null)
  assert.deepEqual(f.requests, [['GET', '/containers/owned-fixture/json']])
  const lock = await fs.readFile(join(f.state, 'operation.lock'), 'utf8')
  assert.equal(JSON.parse(lock).format, 'pe-cloud-cold-recovery-operation/v1')
})
