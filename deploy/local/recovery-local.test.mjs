import assert from 'node:assert/strict'
import * as fs from 'node:fs/promises'
import { join } from 'node:path'
import { createHash } from 'node:crypto'
import { createServer } from 'node:http'
import { test } from 'node:test'
import { spawn } from 'node:child_process'
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

async function privateFixture(t, terminalExec = false) {
  const directory = await fs.mkdtemp('/tmp/pe-recovery-admission-'), state = join(directory, 'local-state')
  await fs.mkdir(state, { mode: 0o700 })
  const socket = join(directory, 'engine.sock'), requests = [], sockets = new Set()
  const server = createServer((request, response) => {
    requests.push([request.method, request.url])
    if (terminalExec && request.url === '/containers/owned-fixture/json') response.end(JSON.stringify({
      Id: 'a'.repeat(64), Image: 'sha256:' + 'b'.repeat(64), State: { Running: true },
    }))
    else if (terminalExec && request.url === '/exec/' + 'e'.repeat(64) + '/json') response.end(JSON.stringify({
      ID: 'e'.repeat(64), Running: false, ExitCode: 0, Pid: 0,
    }))
    else { response.writeHead(500); response.end('{}') }
  })
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
  return { state, latest, write, requests, log, input, sha, run: () => runLocalRecovery(['--input', input, '--sha256', sha]) }
}

for (const mode of ['live-host', 'stopped-launcher']) {
  test(`verification of an existing publication never creates or starts another launcher (${mode})`, async t => {
    const f = await privateFixture(t, true)
    await f.write(join(f.state, 'latest.json'), f.latest)
    const child = spawn(process.execPath, ['-e', ''], { stdio: 'ignore' }), ended = child.pid
    await new Promise((resolve, reject) => { child.once('error', reject); child.once('close', resolve) })
    const bytes = Buffer.from(JSON.stringify({ format: 'pe-cloud-cold-recovery-operation/v1',
      operation: f.latest.operation, inputSha256: f.sha, pid: mode === 'live-host' ? process.pid : ended })
      + '\n' + JSON.stringify({ createdExecId: 'e'.repeat(64) }) + '\n')
    const lock = join(f.state, 'operation.lock')
    await fs.writeFile(lock, bytes, { flag: 'wx', mode: 0o600 }); await fs.mkdir(f.log, { mode: 0o700 })
    await assert.rejects(runLocalRecovery(['verify-started', '--input', f.input, '--sha256', f.sha]))
    assert.deepEqual(await fs.readFile(lock), bytes)
    assert.ok(f.requests.every(([method]) => method === 'GET'))
    if (mode === 'live-host') assert.deepEqual(f.requests, [])
    else assert.deepEqual(f.requests, [['GET', '/containers/owned-fixture/json'], ['GET', '/exec/' + 'e'.repeat(64) + '/json']])
  })
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

for (const mode of ['terminal-prelaunch', 'live-host', 'live-exec', 'launch-evidence']) {
  test(`explicit failed-preparation disposition retains failure and refuses live or published work (${mode})`, async t => {
    const directory = await fs.mkdtemp('/tmp/pe-retire-prelaunch-'), state = join(directory, 'local-state')
    await fs.mkdir(state, { mode: 0o700 })
    const socket = join(directory, 'engine.sock'), requests = [], sockets = new Set()
    const server = createServer((request, response) => {
      requests.push([request.method, request.url]); response.setHeader('content-type', 'application/json')
      if (request.url === '/containers/owned-fixture/json') response.end(JSON.stringify({
        Id: 'a'.repeat(64), Image: 'sha256:' + 'b'.repeat(64), Path: 'sleep', Args: ['infinity'],
        State: { Running: true, Pid: 123 }, ExecIDs: ['e'.repeat(64)],
      }))
      else if (request.url === '/exec/' + 'e'.repeat(64) + '/json') response.end(JSON.stringify({
        ID: 'e'.repeat(64), Running: mode === 'live-exec', ExitCode: mode === 'live-exec' ? null : 1, Pid: mode === 'live-exec' ? 124 : 0,
      }))
      else { response.writeHead(400); response.end('{}') }
    })
    server.on('connection', socket => { sockets.add(socket); socket.once('close', () => sockets.delete(socket)) })
    await new Promise((resolve, reject) => { server.once('error', reject); server.listen(socket, resolve) })
    t.after(async () => {
      for (const socket of sockets) socket.destroy()
      await new Promise((resolve, reject) => server.close(error => error ? reject(error) : resolve()))
      assert.equal(sockets.size, 0); await fs.rm(directory, { recursive: true })
    })
    const child = spawn(process.execPath, ['-e', ''], { stdio: 'ignore' }), ended = child.pid
    await new Promise((resolve, reject) => { child.once('error', reject); child.once('close', resolve) })
    const write = (path, value) => fs.writeFile(path, JSON.stringify(value) + '\n', { flag: 'wx', mode: 0o600 })
    const docker = join(directory, 'docker'), rootHash = 'c'.repeat(64)
    await fs.writeFile(docker, '#!' + process.execPath + '\n' + (mode === 'launch-evidence' ? 'process.exit(1)' :
      'console.log(JSON.stringify({stage:"staged-before-launch",inputSha256:"' + rootHash + '"}))'), { mode: 0o700 })
    const input = join(directory, 'original.json'), spec = { schema: 'pe-cloud-cold-recovery-local/v1',
      container: 'owned-fixture', containerId: 'a'.repeat(64), imageId: 'sha256:' + 'b'.repeat(64),
      stateDirectory: state, workDirectory: directory, rootInput: '/private/input.json', rootInputSha256: rootHash,
      rootEntry: '/private/recovery.mjs', nodePath: '/dsh-tools/node24', dockerPath: docker, socketPath: socket }
    await write(input, spec)
    const sha = createHash('sha256').update(await fs.readFile(input)).digest('hex')
    const operation = '00000000-0000-4000-8000-000000000014', lock = join(state, 'operation.lock')
    await write(lock, { format: 'pe-cloud-cold-recovery-operation/v1', operation, inputSha256: sha,
      pid: mode === 'live-host' ? process.pid : ended })
    const before = await fs.lstat(lock), original = await fs.readFile(lock), request = join(directory, 'retire.json')
    await write(request, { schema: 'pe-cloud-retire-failed-preparation/v1', originalInput: input, originalInputSha256: sha,
      operation, lockDevice: String(before.dev), lockInode: String(before.ino), budgetMs: 5000 })
    const requestSha = createHash('sha256').update(await fs.readFile(request)).digest('hex'), outputs = []
    const run = () => runLocalRecovery(['retire-prelaunch', '--input', request, '--sha256', requestSha], { report: x => outputs.push(x) })
    if (mode === 'terminal-prelaunch') {
      assert.equal(await run(), 0)
      await assert.rejects(fs.lstat(lock), error => error.code === 'ENOENT')
      const archive = join(state, 'cold-prelaunch-failed-' + operation + '.jsonl')
      assert.deepEqual(await fs.readFile(archive), original)
      assert.equal((await fs.lstat(archive)).ino, before.ino)
      assert.equal(JSON.parse(await fs.readFile(archive + '.receipt.json')).resourcesReleased, false)
      assert.equal(JSON.parse(outputs[0]).status, 'failed-preparation-archived')
    } else {
      await assert.rejects(run())
      assert.deepEqual(await fs.readFile(lock), original)
      if (mode === 'live-host') assert.deepEqual(requests, [])
      assert.deepEqual(outputs, [])
    }
    assert.ok(requests.every(([method]) => method === 'GET'))
  })
}
