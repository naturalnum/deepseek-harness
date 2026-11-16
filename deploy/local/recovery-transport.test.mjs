/** Own Unix listeners and a Node executable fixture; no Docker daemon, application or existing candidate is accessed. */
import assert from 'node:assert/strict'
import { mkdtemp, readFile, writeFile, appendFile, rm, chmod } from 'node:fs/promises'
import { createServer } from 'node:http'
import { join } from 'node:path'
import { setTimeout as delay } from 'node:timers/promises'
import { test } from 'node:test'
import { createRecoveryTransport, RecoveryTransportError } from './recovery-transport.mjs'

const ID = 'a'.repeat(64), container = 'recovery-fixture'
async function recordExit(kind, pid, state) {
  assert.throws(() => process.kill(pid, 0), error => error.code === 'ESRCH')
  if (process.env.PE_RECOVERY_TRANSPORT_EVIDENCE) await appendFile(process.env.PE_RECOVERY_TRANSPORT_EVIDENCE,
    JSON.stringify({ kind, pid, processAbsent: true, state }) + '\n')
}
async function fixture(t, handler) {
  const directory = await mkdtemp('/tmp/pe-recovery-'), socketPath = join(directory, 'engine.sock')
  const server = createServer(handler), sockets = new Set(), closed = []
  server.on('connection', socket => {
    sockets.add(socket)
    closed.push(new Promise(resolve => socket.once('close', () => { sockets.delete(socket); resolve() })))
  })
  await new Promise((resolve, reject) => { server.once('error', reject); server.listen(socketPath, resolve) })
  const signal = new AbortController()
  const transport = createRecoveryTransport({ signal: signal.signal, deadlineAtMs: performance.now() + 10000,
    socketPath, container, dockerPath: process.execPath, maxOutputBytes: 4096 })
  t.after(async () => {
    await transport.close()
    for (const socket of sockets) socket.destroy()
    await new Promise((resolve, reject) => server.close(error => error ? reject(error) : resolve()))
    await Promise.all(closed)
    assert.equal(sockets.size, 0)
    await rm(directory, { recursive: true, force: true })
  })
  return { directory, socketPath, signal, transport }
}

test('fixed Engine requests and exec inspection settle actual local sockets before reporting success', async t => {
  let calls = 0
  const f = await fixture(t, (req, res) => {
    calls++; assert.equal(req.method, 'GET'); assert.equal(req.url, '/exec/' + ID + '/json')
    res.end(JSON.stringify({ ID, Running: true, Pid: 42, ExitCode: null }))
  })
  assert.deepEqual(await f.transport.inspectExec(ID), { execId: ID, running: true, hostPid: 42, exitCode: null })
  assert.deepEqual(f.transport.state(), { unknown: false, pendingCalls: 0, closed: false })
  assert.equal(calls, 1)
  await assert.rejects(f.transport.request('POST', '/containers/other/exec', {}), error => error.unknown === false)
  assert.equal(calls, 1)
})

test('abort fences a submitted call without replay and retains unknown after local sockets close', async t => {
  const entered = Promise.withResolvers(); let calls = 0
  const f = await fixture(t, () => { calls++; entered.resolve() })
  const pending = f.transport.request('POST', '/exec/' + ID + '/start', { Detach: true })
  await entered.promise; f.signal.abort(new Error('private fixture reason'))
  await assert.rejects(pending, error => error instanceof RecoveryTransportError && error.unknown
    && !error.message.includes('private fixture'))
  await f.transport.close()
  assert.deepEqual(f.transport.state(), { unknown: true, pendingCalls: 0, closed: true })
  await assert.rejects(f.transport.inspectExec(ID), error => error.unknown === true)
  assert.equal(calls, 1)
})

test('one response beyond the byte cap and a malformed exec both keep the same transport fenced', async t => {
  for (const mode of ['large', 'wrong-id']) {
    let calls = 0
    const f = await fixture(t, (_req, res) => { calls++; res.end(mode === 'large' ? 'x'.repeat(4097)
      : JSON.stringify({ ID: 'b'.repeat(64), Running: true, Pid: 42, ExitCode: null })) })
    await assert.rejects(f.transport.inspectExec(ID), error => error.unknown === true)
    await assert.rejects(f.transport.inspectExec(ID), error => error.unknown === true)
    assert.equal(f.transport.state().unknown, true); assert.equal(calls, 1)
  }
})

test('cancelled Docker client remains owned until actual close and never confirms the remote exec stopped', async t => {
  const f = await fixture(t, (_req, res) => res.end('{}'))
  const ready = join(f.directory, 'ready'), executable = join(f.directory, 'fixture.mjs')
  await writeFile(executable, `#!${process.execPath}\nimport {writeFileSync} from 'node:fs';
process.on('SIGTERM',()=>setTimeout(()=>process.exit(0),250));
writeFileSync(${JSON.stringify(ready)},JSON.stringify({pid:process.pid}));setInterval(()=>{},1000);\n`)
  await chmod(executable, 0o700)
  const signal = new AbortController(), transport = createRecoveryTransport({ signal: signal.signal,
    deadlineAtMs: performance.now() + 10000, socketPath: f.socketPath, container, dockerPath: executable, maxOutputBytes: 4096 })
  t.after(() => transport.close())
  const pending = transport.runDocker(['exec', '--interactive', '--user', '0', container, '/approved/program'], { input: 'fixture' })
  const deadline = performance.now() + 3000; let pid
  for (;;) {
    try { pid = JSON.parse(await readFile(ready, 'utf8')).pid; if (Number.isInteger(pid) && pid > 0) break }
    catch (error) { if (error.code !== 'ENOENT') throw error }
    assert.ok(performance.now() < deadline); await delay(10)
  }
  signal.abort()
  await assert.rejects(pending, error => error.unknown === true)
  assert.equal(transport.state().pendingCalls, 1)
  await transport.close()
  assert.deepEqual(transport.state(), { unknown: true, pendingCalls: 0, closed: true })
  await recordExit('cancelled-client', pid, transport.state())
})

test('a finite executable fixture returns only complete bounded stdout after its actual close', async t => {
  const f = await fixture(t, (_req, res) => res.end('{}')), executable = join(f.directory, 'complete.mjs')
  const pidFile = join(f.directory, 'complete.pid')
  await writeFile(executable, `#!${process.execPath}\nimport {writeFileSync} from 'node:fs';
writeFileSync(${JSON.stringify(pidFile)},JSON.stringify({pid:process.pid,args:process.argv.slice(2)}));
process.stdin.resume();process.stdin.on('end',()=>process.stdout.write('complete\\n'));\n`)
  await chmod(executable, 0o700)
  const transport = createRecoveryTransport({ signal: f.signal.signal, deadlineAtMs: performance.now() + 10000,
    socketPath: f.socketPath, container, dockerPath: executable, maxOutputBytes: 4096 })
  t.after(() => transport.close())
  assert.equal(await transport.runDocker(['exec', '--interactive', '--user', '0', container, '/approved/program']), 'complete\n')
  assert.equal(transport.state().pendingCalls, 0); assert.equal(transport.state().unknown, false)
  const actual = JSON.parse(await readFile(pidFile, 'utf8'))
  assert.deepEqual(actual.args, ['--host', 'unix://' + f.socketPath, 'exec', '--interactive', '--user', '0', container, '/approved/program'])
  await recordExit('normal-client', actual.pid, transport.state())
})

test('an elapsed operation deadline rejects a held response without granting the next call a fresh budget', async t => {
  const entered = Promise.withResolvers(); let calls = 0
  const f = await fixture(t, () => { calls++; entered.resolve() })
  const transport = createRecoveryTransport({ signal: f.signal.signal, deadlineAtMs: performance.now() + 1000,
    socketPath: f.socketPath, container, dockerPath: process.execPath, maxOutputBytes: 4096 })
  t.after(() => transport.close())
  const pending = transport.request('POST', '/exec/' + ID + '/start', { Detach: true })
  await entered.promise
  await assert.rejects(pending, error => error.unknown === true)
  await assert.rejects(transport.inspectExec(ID), error => error.unknown === true)
  await transport.close(); assert.equal(calls, 1)
})
