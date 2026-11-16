/** Real local sockets and relay processes only; no Docker daemon or existing project resource is accessed. */
import assert from 'node:assert/strict'
import * as fs from 'node:fs/promises'
import { join } from 'node:path'
import { createServer } from 'node:http'
import { test } from 'node:test'
import { createRecoveryEngine } from './recovery-engine.mjs'

const id = 'a'.repeat(64)
async function fixture(t, handler) {
  const directory = await fs.mkdtemp('/tmp/pe-recovery-engine-'), socketPath = join(directory, 'inner.sock')
  const server = createServer(handler), sockets = new Set()
  server.on('connection', socket => { sockets.add(socket); socket.once('close', () => sockets.delete(socket)) })
  await new Promise((resolve, reject) => { server.once('error', reject); server.listen(socketPath, resolve) })
  const dockerPath = join(directory, 'outer-docker')
  const pidFile = join(directory, 'relay.pid')
  // Preserve the actual client PID when invoking the real relay, as Docker would preserve its owned command.
  await fs.writeFile(dockerPath, '#!/bin/sh\nset -eu\ntest "$1" = --host && test "$3" = exec && test "$7" = owned-backend\n'
    + 'printf "%s" "$$" > ' + "'" + pidFile.replaceAll("'", "'\\''") + "'" + '\nshift 7\nexec "$@"\n', { mode: 0o700 })
  const controller = new AbortController()
  const engine = createRecoveryEngine({ signal: controller.signal, deadlineAtMs: performance.now() + 5000,
    dockerPath, socketPath: join(directory, 'outer.sock'), container: 'owned-runtime', maxOutputBytes: 65536,
    via: { container: 'owned-backend', nodePath: process.execPath, relayEntry: new URL('./recovery-engine.mjs', import.meta.url).pathname,
      socketPath, dockerPath: process.execPath } })
  t.after(async () => {
    await engine.close()
    const pid = Number(await fs.readFile(pidFile, 'utf8'))
    assert.throws(() => process.kill(pid, 0), error => error.code === 'ESRCH')
    if (process.env.PE_RECOVERY_ENGINE_EVIDENCE) await fs.appendFile(process.env.PE_RECOVERY_ENGINE_EVIDENCE,
      JSON.stringify({ kind: 'actual-relay-closed', pid, processAbsent: true, state: engine.state() }) + '\n')
    for (const socket of sockets) socket.destroy()
    await new Promise((resolve, reject) => server.close(error => error ? reject(error) : resolve()))
    assert.equal(sockets.size, 0)
    await fs.rm(directory, { recursive: true })
  })
  return { engine, controller }
}

test('the existing-backend relay actually reaches its selected inner socket and preserves the original exec result', async t => {
  let calls = 0
  const f = await fixture(t, (request, response) => {
    calls++; assert.equal(request.url, '/exec/' + id + '/json')
    response.end(JSON.stringify({ ID: id, Running: true, Pid: 42, ExitCode: null }))
  })
  assert.deepEqual(await f.engine.inspectExec(id), { execId: id, running: true, hostPid: 42, exitCode: null })
  assert.equal(calls, 1); assert.equal(f.engine.state().pendingCalls, 0)
})

test('cancellation closes the actual relay/socket and fences dependent calls without declaring the inner exec stopped', async t => {
  const entered = Promise.withResolvers(); let calls = 0
  const f = await fixture(t, () => { calls++; entered.resolve() })
  const pending = f.engine.request('POST', '/exec/' + id + '/start', { Detach: true, Tty: false })
  await entered.promise; f.controller.abort()
  await assert.rejects(pending, error => error.unknown === true)
  await f.engine.close()
  assert.equal(f.engine.state().pendingCalls, 0); assert.equal(f.engine.state().unknown, true)
  await assert.rejects(f.engine.inspectExec(id), error => error.unknown === true)
  assert.equal(calls, 1)
})
