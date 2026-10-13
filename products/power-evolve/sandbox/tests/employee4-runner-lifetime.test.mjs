/** Local HTTP and owned POSIX fault carriers; excludes production UID1000, PID1 cleanup, gVisor and Platform acceptance. */
import assert from 'node:assert/strict'
import { spawn } from 'node:child_process'
import { randomBytes, randomUUID } from 'node:crypto'
import { mkdir, mkdtemp, readFile, realpath, rm } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { setTimeout as delay } from 'node:timers/promises'
import test from 'node:test'
import { CommandChildren } from '../command-children.mjs'
import { createRunner } from '../runner.mjs'

async function observed(check, timeout = 10000) {
  const deadline = Date.now() + timeout
  for (;;) {
    const value = await check()
    if (value) return value
    if (Date.now() >= deadline) throw new Error('Owned Runner fixture state was not observed')
    await delay(10)
  }
}

const resistantHelper = `import json,os,signal,sys,time
request=json.load(sys.stdin)
def term(signum,frame):
    os.write(1,b'{"termObserved":true}\\n')
signal.signal(signal.SIGTERM,term)
with open(os.path.join(request['root'],'helper.ready'),'w') as ready:
    ready.write('ready')
while True:
    time.sleep(1)
`

async function fixture(t, options = {}) {
  assert.equal(typeof process.getuid, 'function', 'This fixture requires POSIX process ownership')
  assert.notEqual(process.getuid(), 0, 'This fixture requires an unprivileged local owner')
  assert.notEqual(process.pid, 1, 'Local cleanup rejection must never authorize a PID1 UID sweep')
  const root = await mkdtemp(join(await realpath(tmpdir()), 'pe-employee4-runner-'))
  const records = [], open = new Set()
  let commandCount = 0, runSettled = false
  /** @type {{ runner?: ReturnType<typeof createRunner> }} */
  const resources = {}
  const term = Promise.withResolvers()
  t.after(async () => {
    const failures = []
    try { if (resources.runner) await resources.runner.shutdown() }
    catch (error) { failures.push(error) }
    for (const record of records) {
      if (record.closed || record.child.exitCode !== null || record.child.signalCode !== null) continue
      try {
        if (record.detached && record.child.pid) process.kill(-record.child.pid, 'SIGKILL')
        else record.child.kill('SIGKILL')
      } catch (error) {
        if (error.code !== 'ESRCH') failures.push(error)
        record.child.kill('SIGKILL')
      }
    }
    await Promise.all(records.map(record => record.done))
    try { assert.equal(open.size, 0, 'Every owned helper and command must reach actual close') }
    catch (error) { failures.push(error) }
    try { await rm(root, { recursive: true, force: true }) }
    catch (error) { failures.push(error) }
    if (failures.length) throw new AggregateError(failures, 'Owned Runner fixture cleanup failed')
  })
  const scanner = new CommandChildren(root, (file, args, settings) => {
    assert.equal(settings.uid, 1000); assert.equal(settings.gid, 1000)
    assert.deepEqual(Object.keys(settings.env).toSorted(), ['HOME', 'LANG', 'PATH', 'USER'])
    const detached = settings.detached === true
    if (detached) commandCount++
    const carrier = detached ? options.commandCarrier : options.helperCarrier
    const absent = options.absentHelper && !detached || options.firstCommandMissing && detached && commandCount === 1
    const child = spawn(absent ? join(root, 'absent-executable') : file,
      carrier ? ['-I', '-B', '-c', carrier] : args,
      { ...settings, uid: process.getuid(), gid: process.getgid(), env: { ...settings.env, HOME: root } })
    const record = { child, detached, closed: false, close: null, errors: [], stdinErrors: [] }
    open.add(child); records.push(record)
    record.done = new Promise(resolve => child.once('close', (code, signal) => {
      record.closed = true; record.close = { code, signal }; open.delete(child); resolve(record.close)
    }))
    child.once('error', error => record.errors.push(error.code))
    child.stdin.on('error', error => record.stdinErrors.push(error.code))
    child.stdout.on('data', (bytes) => {
      if (bytes.toString('utf8').includes('termObserved')) {
        term.resolve({ closedAtObservation: record.closed, settledAtObservation: runSettled })
      }
    })
    if (options.closeHelperInput && !detached) child.stdin.destroy()
    return child
  })
  if (!options.nativeCleanup) {
    // Only this fixture's detached group is observed; no local UID namespace is scanned.
    scanner.cleanup = async group => observed(() => {
      try { process.kill(-group, 0); return false }
      catch (error) { if (error.code === 'ESRCH') return true; throw error }
    }, 1500).catch(() => false)
  }
  if (options.removeCommandCwd) {
    const check = scanner.cwd.bind(scanner)
    scanner.cwd = async (cwd, signal) => {
      const admitted = await check(cwd, signal)
      if (admitted.valid && cwd === options.removeCommandCwd) await rm(join(root, cwd), { recursive: true })
      return admitted
    }
  }
  const token = randomBytes(32).toString('base64url')
  const runner = createRunner({ token, workspace: root }, { scanner })
  resources.runner = runner
  await new Promise(resolve => runner.server.listen(0, '127.0.0.1', resolve))
  const url = `http://127.0.0.1:${runner.server.address().port}`
  const headers = { 'x-power-evolve-runner-token': token, 'content-type': 'application/json' }
  const health = await (await fetch(`${url}/health`, { headers })).json()
  const request = command => ({ id: randomUUID(), instanceId: health.instanceId, command, cwd: '', timeoutMs: 3000 })
  const post = value => fetch(`${url}/executions`, { method: 'POST', headers, body: JSON.stringify(value) })
  const get = async id => (await fetch(`${url}/executions/${id}`, { headers })).json()
  const terminal = id => observed(async () => {
    const value = await get(id)
    return value.state !== 'running' && value
  })
  const ready = () => observed(async () => {
    try { return await readFile(join(root, 'helper.ready'), 'utf8') === 'ready' }
    catch (error) { if (error.code === 'ENOENT') return false; throw error }
  })
  return { root, records, open, scanner, runner, request, post, get, terminal, ready, term: term.promise,
    settled() { runSettled = true } }
}

test('TERM-resistant cwd cancellation waits for its real KILL close', { timeout: 15000 }, async (t) => {
  const f = await fixture(t, { helperCarrier: resistantHelper })
  const abort = new AbortController()
  const checking = f.scanner.cwd('', abort.signal).finally(() => f.settled())
  await f.ready(); abort.abort()
  assert.deepEqual(await f.term, { closedAtObservation: false, settledAtObservation: false })
  assert.deepEqual(await checking, { valid: false, status: 400 })
  assert.deepEqual(await f.records[0].done, { code: null, signal: 'SIGKILL' })
  assert.equal(f.open.size, 0)
})

test('cwd deadline waits for a TERM-resistant child close', { timeout: 15000 }, async (t) => {
  const f = await fixture(t, { helperCarrier: resistantHelper })
  const checking = f.scanner.cwd('').finally(() => f.settled())
  await f.ready()
  assert.deepEqual(await f.term, { closedAtObservation: false, settledAtObservation: false })
  assert.deepEqual(await checking, { valid: false, status: 400 })
  assert.deepEqual(await f.records[0].done, { code: null, signal: 'SIGKILL' })
})

test('HTTP shutdown cancels admission and waits for the resistant cwd helper', { timeout: 15000 }, async (t) => {
  const f = await fixture(t, { helperCarrier: resistantHelper })
  const accepting = f.post(f.request('printf forbidden > forbidden.txt'))
  await f.ready()
  const closing = f.runner.shutdown().finally(() => f.settled())
  assert.deepEqual(await f.term, { closedAtObservation: false, settledAtObservation: false })
  assert.equal((await accepting).status, 503)
  assert.deepEqual(await closing, { writerStopConfirmed: true })
  assert.equal(f.records.length, 1); assert.equal(f.records[0].detached, false)
  assert.deepEqual(await f.records[0].done, { code: null, signal: 'SIGKILL' })
  await assert.rejects(readFile(join(f.root, 'forbidden.txt')), { code: 'ENOENT' })
})

test('native helper cannot verify a local namespace and the Runner retains its writer fence', { timeout: 15000 }, async (t) => {
  const f = await fixture(t, { nativeCleanup: true })
  const value = f.request('printf completed')
  assert.equal((await f.post(value)).status, 202)
  const receipt = await f.terminal(value.id)
  assert.equal(receipt.state, 'succeeded'); assert.equal(receipt.exitCode, 0)
  assert.equal(receipt.stdout, 'completed')
  const blocked = await f.post(f.request('printf forbidden > forbidden.txt'))
  assert.equal(blocked.status, 409); assert.equal((await blocked.json()).error, 'execution_busy')
  assert.equal((await f.post(value)).status, 200)
  assert.deepEqual(await f.get(value.id), receipt)
  assert.deepEqual(await f.runner.shutdown(), { writerStopConfirmed: false })
  assert.ok(f.records.every(record => record.closed))
  await assert.rejects(readFile(join(f.root, 'forbidden.txt')), { code: 'ENOENT' })
})

for (const scenario of [
  { name: 'invalid JSON', helperCarrier: "import sys;sys.stdin.buffer.read();print('{')", expected: null, exit: { code: 0, signal: null } },
  { name: 'nonzero exit', helperCarrier: "import sys;sys.stdin.buffer.read();print('{\"valid\":true}');sys.exit(23)", expected: null, exit: { code: 23, signal: null } },
  { name: 'oversized stdout', helperCarrier: "import os,signal,sys,time;sys.stdin.buffer.read();signal.signal(signal.SIGTERM,signal.SIG_IGN);os.write(1,b'x'*2048);time.sleep(60)", expected: null, exit: { code: null, signal: 'SIGKILL' } },
  { name: 'drained private stderr', helperCarrier: "import os,sys;sys.stdin.buffer.read();os.write(2,b'private-helper-detail'*2048);print('{\"valid\":true}')", expected: { valid: true }, exit: { code: 0, signal: null } },
]) {
  test(`helper ${scenario.name} settles only after actual close`, { timeout: 15000 }, async (t) => {
    const f = await fixture(t, { helperCarrier: scenario.helperCarrier })
    assert.deepEqual(await f.scanner.run({ mode: 'cwd', cwd: '' }, undefined, 4000), scenario.expected)
    assert.deepEqual(await f.records[0].done, scenario.exit)
    assert.equal(f.open.size, 0)
  })
}

test('already cancelled cwd does not spawn and a missing helper reaches actual error and close', { timeout: 15000 }, async (t) => {
  const f = await fixture(t, { absentHelper: true })
  assert.deepEqual(await f.scanner.cwd('', AbortSignal.abort()), { valid: false, status: 400 })
  assert.equal(f.records.length, 0)
  assert.deepEqual(await f.scanner.cwd(''), { valid: false, status: 400 })
  assert.deepEqual(f.records[0].errors, ['ENOENT'])
  assert.equal(f.records[0].closed, true); assert.equal(f.open.size, 0)
})

test('closed helper input reports no authority and waits for the real helper close', { timeout: 15000 }, async (t) => {
  const f = await fixture(t, { closeHelperInput: true })
  assert.deepEqual(await f.scanner.cwd(''), { valid: false, status: 400 })
  assert.equal(f.records[0].child.stdin.destroyed, true)
  assert.equal(f.records[0].closed, true)
  assert.equal(f.records[0].close.code, 1)
})

test('missing command executable retains its failed receipt and admits a later real command', { timeout: 15000 }, async (t) => {
  const f = await fixture(t, { firstCommandMissing: true })
  const value = f.request('printf first')
  assert.equal((await f.post(value)).status, 202)
  const failed = await f.terminal(value.id)
  assert.equal(failed.state, 'failed'); assert.equal(failed.exitCode, null)
  assert.equal(failed.stderr, 'command_start_failed')
  assert.equal((await f.post(value)).status, 200)
  const next = f.request('printf next')
  assert.equal((await f.post(next)).status, 202)
  assert.equal((await f.terminal(next.id)).stdout, 'next')
  assert.deepEqual(await f.get(value.id), failed)
})

test('command incomplete UTF8 at EOF is retained as a replacement character', { timeout: 15000 }, async (t) => {
  const f = await fixture(t)
  const value = f.request("/usr/bin/python3 -I -B -c 'import os;os.write(1,bytes([228]));os.write(2,bytes([240,159]));open(\"partial.bin\",\"wb\").write(bytes([228]))'")
  assert.equal((await f.post(value)).status, 202)
  const result = await f.terminal(value.id)
  assert.equal(result.state, 'succeeded'); assert.equal(result.exitCode, 0)
  assert.deepEqual(await readFile(join(f.root, 'partial.bin')), Buffer.from([228]))
  t.diagnostic(JSON.stringify({ actualStdout: result.stdout, actualStderr: result.stderr,
    stdoutTruncated: result.stdoutTruncated, stderrTruncated: result.stderrTruncated }))
  assert.equal(result.stdout, Buffer.from([228]).toString('utf8'))
  assert.equal(result.stderr, Buffer.from([240, 159]).toString('utf8'))
})

test('an EOF decoder tail outside the stream byte ceiling reports truncation', { timeout: 15000 }, async (t) => {
  const f = await fixture(t)
  const value = f.request("/usr/bin/python3 -I -B -c 'import os;os.write(1,b\"a\"*65535+bytes([228]))'")
  assert.equal((await f.post(value)).status, 202)
  const result = await f.terminal(value.id)
  assert.equal(result.state, 'succeeded'); assert.equal(result.exitCode, 0)
  assert.equal(result.stdout, 'a'.repeat(65535))
  assert.ok(Buffer.byteLength(result.stdout) <= 65536)
  assert.equal(result.stdoutTruncated, true)
})

test('exact byte ceilings with empty decoder tails do not report truncation', { timeout: 15000 }, async (t) => {
  const f = await fixture(t)
  const value = f.request("/usr/bin/python3 -I -B -c 'import os;os.write(1,b\"a\"*65536);os.write(2,b\"b\"*65536)'")
  assert.equal((await f.post(value)).status, 202)
  const result = await f.terminal(value.id)
  assert.equal(result.state, 'succeeded'); assert.equal(result.exitCode, 0)
  assert.equal(result.stdout, 'a'.repeat(65536)); assert.equal(result.stderr, 'b'.repeat(65536))
  assert.equal(result.stdoutTruncated, false); assert.equal(result.stderrTruncated, false)
})

test('cwd disappearance after admission fails inside the real command helper without writing', { timeout: 15000 }, async (t) => {
  const f = await fixture(t, { removeCommandCwd: 'gone' })
  await mkdir(join(f.root, 'gone'))
  const value = { ...f.request('printf forbidden > forbidden.txt'), cwd: 'gone' }
  assert.equal((await f.post(value)).status, 202)
  const result = await f.terminal(value.id)
  assert.equal(result.state, 'failed'); assert.equal(result.exitCode, 126)
  assert.equal(result.stdout, ''); assert.equal(result.stderr, 'command_start_failed\n')
  await assert.rejects(readFile(join(f.root, 'gone/forbidden.txt')), { code: 'ENOENT' })
  const next = f.request('printf next')
  assert.equal((await f.post(next)).status, 202)
  assert.equal((await f.terminal(next.id)).stdout, 'next')
})
