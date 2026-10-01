/** Real HTTP/Bash with controlled local-UID spawn; this does not establish production UID1000 or Linux /proc isolation. */
import assert from 'node:assert/strict'
import { spawn } from 'node:child_process'
import { randomBytes, randomUUID } from 'node:crypto'
import { mkdtemp, readFile, realpath, rm, symlink, writeFile, mkdir } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { setTimeout as delay } from 'node:timers/promises'
import test from 'node:test'
import { runnerFileChanges } from '@power-evolve/contracts/execution-files'
import { FileScanner, scanLimits, unavailableChanges } from '../../sandbox/file-scan.mjs'
import { createRunner } from '../../sandbox/runner.mjs'

const nonRoot = { skip: process.getuid?.() === 0 ? 'Local-UID Runner fixture requires a non-root user' : false, timeout: 15000 }
async function eventually(check, timeout = 5000) {
  const deadline = Date.now() + timeout
  do { const value = await check(); if (value) return value; await delay(10) } while (Date.now() < deadline)
  throw new Error('Timed out waiting for the owned Runner fixture')
}

async function fixture(t, modify = () => {}) {
  const root = await mkdtemp(join(await realpath(tmpdir()), 'pe-runner-files-'))
  const children = new Set(), commands = []
  const scanner = new FileScanner(root, scanLimits({}), (file, args, options) => {
    assert.equal(options.uid, 1000); assert.equal(options.gid, 1000); assert.equal(options.cwd, '/')
    assert.deepEqual(Object.keys(options.env).sort(), ['HOME', 'LANG', 'PATH', 'USER'])
    if (options.detached) commands.push(options)
    const child = spawn(file, args, { ...options, uid: process.getuid(), gid: process.getgid(), env: { ...options.env, HOME: root } })
    children.add(child); child.once('close', () => children.delete(child))
    return child
  })
  // Local tests certify only their own known process group. They never enumerate or signal a local UID.
  scanner.cleanup = async group => {
    const deadline = Date.now() + 1000
    do {
      try { process.kill(-group, 0) } catch (error) { return error.code === 'ESRCH' }
      await delay(10)
    } while (Date.now() < deadline)
    return false
  }
  modify(scanner, root)
  const token = randomBytes(32).toString('base64url')
  const runner = createRunner({ token, workspace: root, limits: scanLimits({}) }, { scanner })
  t.after(async () => {
    await runner.shutdown()
    assert.equal(children.size, 0, 'Shutdown must await the actual command and scanner child close events')
    await rm(root, { recursive: true, force: true })
  })
  await new Promise(resolve => runner.server.listen(0, '127.0.0.1', resolve))
  const url = `http://127.0.0.1:${runner.server.address().port}`
  const headers = { 'x-power-evolve-runner-token': token, 'content-type': 'application/json' }
  const health = await (await fetch(`${url}/health`, { headers })).json()
  const request = command => ({ id: randomUUID(), instanceId: health.instanceId, command, cwd: '', timeoutMs: 3000 })
  const post = value => fetch(`${url}/executions`, { method: 'POST', headers, body: JSON.stringify(value) })
  const get = async id => (await fetch(`${url}/executions/${id}`, { headers })).json()
  const terminal = id => eventually(async () => { const value = await get(id); return value.state !== 'running' && value })
  const cancel = id => fetch(`${url}/executions/${id}/cancel`, { method: 'POST', headers })
  return { root, scanner, runner, children, commands, url, headers, request, post, get, terminal, cancel }
}

test('terminal changes come from actual file bytes, preserve exit status and never infer stdout paths', nonRoot, async t => {
  const f = await fixture(t)
  await writeFile(join(f.root, 'unchanged.txt'), 'before')
  await writeFile(join(f.root, 'changed.txt'), 'AAAA')
  const value = f.request("printf 'invented/never-created.txt'; printf BBBB > changed.txt; printf 'report' > '实际报告.txt'; exit 7")
  assert.equal((await f.post(value)).status, 202)
  const result = await f.terminal(value.id)
  assert.equal(result.state, 'failed'); assert.equal(result.exitCode, 7); assert.equal(result.timedOut, false)
  assert.equal(result.stdout, 'invented/never-created.txt')
  const changes = runnerFileChanges.parse(result.fileChanges)
  assert.equal(changes.status, 'complete')
  assert.deepEqual(changes.files.map(file => file.path), ['changed.txt', '实际报告.txt'])
  assert.equal(f.commands.length, 1)
})

test('accepted ids replay their status, conflicting content is refused and another id cannot overlap the command', nonRoot, async t => {
  const f = await fixture(t)
  const value = f.request('printf once >> once.txt; sleep 0.2')
  assert.equal((await f.post(value)).status, 202)
  assert.equal((await f.post(value)).status, 200)
  assert.equal((await f.post({ ...value, command: 'printf twice >> once.txt' })).status, 409)
  const other = await f.post(f.request('printf overlap > bad.txt'))
  assert.equal(other.status, 409); assert.deepEqual(await other.json(), { error: 'execution_busy' })
  assert.equal((await f.terminal(value.id)).state, 'succeeded')
  assert.equal((await f.post(value)).status, 200)
  assert.equal(await readFile(join(f.root, 'once.txt'), 'utf8'), 'once')
  assert.equal(f.commands.length, 1)
})

test('cwd admission stays unprivileged and preserves invalid, outside and inside-symlink responses', nonRoot, async t => {
  const f = await fixture(t)
  await mkdir(join(f.root, 'inside'))
  await symlink(join(f.root, 'inside'), join(f.root, 'alias'))
  await symlink(await realpath(tmpdir()), join(f.root, 'outside'))
  assert.equal((await f.post({ ...f.request('true'), cwd: 'missing' })).status, 400)
  assert.equal((await f.post({ ...f.request('true'), cwd: '../escape' })).status, 400)
  assert.equal((await f.post({ ...f.request('true'), cwd: 'outside' })).status, 403)
  const value = { ...f.request('printf bytes > output.txt'), cwd: 'alias' }
  assert.equal((await f.post(value)).status, 202)
  const result = await f.terminal(value.id)
  assert.equal(result.state, 'succeeded')
  assert.deepEqual(result.fileChanges.files.map(file => file.path), ['inside/output.txt'])
  await rm(join(f.root, 'alias'))
  assert.equal((await f.post(value)).status, 200, 'Replay must not resolve a cwd or execute the command again')
  assert.equal(f.commands.length, 1)
})

test('a failed before or after scan cannot change success, cause command replay or expose helper errors', nonRoot, async t => {
  const f = await fixture(t, scanner => {
    scanner.snapshot = async () => { throw new Error('private helper details') }
    scanner.changes = async () => { throw new Error('private helper details') }
  })
  const value = f.request('printf once >> side-effect.txt')
  assert.equal((await f.post(value)).status, 202)
  const result = await f.terminal(value.id)
  assert.equal(result.state, 'succeeded'); assert.equal(result.exitCode, 0)
  assert.deepEqual(result.fileChanges, unavailableChanges())
  assert.equal(JSON.stringify(result).includes('private helper details'), false)
  assert.equal((await f.post(value)).status, 200)
  assert.equal(await readFile(join(f.root, 'side-effect.txt'), 'utf8'), 'once')
})

test('postscan cancellation retains the known command fact and rejects another id until scanning exits', nonRoot, async t => {
  let entered, finish
  const started = new Promise(resolve => { entered = resolve })
  const f = await fixture(t, scanner => {
    scanner.changes = async (_before, signal) => {
      entered()
      await new Promise(resolve => { finish = resolve; signal.addEventListener('abort', resolve, { once: true }) })
      await delay(20)
      return unavailableChanges()
    }
  })
  t.after(() => finish?.())
  const value = f.request('printf done > done.txt')
  assert.equal((await f.post(value)).status, 202)
  await started
  assert.equal((await f.get(value.id)).state, 'running')
  assert.equal((await f.post(f.request('true'))).status, 409)
  assert.equal((await f.cancel(value.id)).status, 200)
  const result = await f.terminal(value.id)
  assert.equal(result.state, 'succeeded'); assert.equal(result.exitCode, 0); assert.equal(result.timedOut, false)
  assert.deepEqual(result.fileChanges, unavailableChanges())
  assert.equal(f.commands.length, 1)
})

test('cancel and timeout preserve real command outcomes and await their command process group cleanup', nonRoot, async t => {
  const f = await fixture(t)
  const cancelled = f.request('printf started > cancelled.txt; sleep 60')
  assert.equal((await f.post(cancelled)).status, 202)
  await eventually(async () => { try { return await readFile(join(f.root, 'cancelled.txt'), 'utf8') === 'started' } catch { return false } })
  await f.cancel(cancelled.id)
  const stopped = await f.terminal(cancelled.id)
  assert.equal(stopped.state, 'cancelled'); assert.equal(stopped.timedOut, false)
  assert.equal(stopped.exitCode, null)
  const timed = { ...f.request('printf started > timed.txt; sleep 60'), timeoutMs: 1000 }
  assert.equal((await f.post(timed)).status, 202)
  const timeout = await f.terminal(timed.id)
  assert.equal(timeout.state, 'failed'); assert.equal(timeout.timedOut, true); assert.equal(timeout.exitCode, null)
  assert.equal(f.children.size, 0)
  assert.equal(f.commands.length, 2)
})

test('leader exit kills an inherited-output background group before final scanning and shutdown awaits scanners', nonRoot, async t => {
  const f = await fixture(t)
  const value = f.request('(sleep 60; printf late > late.txt) & printf early > early.txt')
  assert.equal((await f.post(value)).status, 202)
  const result = await f.terminal(value.id)
  assert.equal(result.state, 'succeeded'); assert.equal(result.exitCode, 0); assert.equal(result.timedOut, false)
  assert.deepEqual(result.fileChanges.files.map(file => file.path), ['early.txt'])
  assert.equal(f.children.size, 0)
  await f.runner.shutdown()
  assert.equal(f.children.size, 0)
})

function blockedScan(scanner, method, entered) {
  const originalSpawn = scanner.spawnChild
  let armed = false
  scanner.spawnChild = (file, args, options) => {
    if (!armed) return originalSpawn(file, args, options)
    armed = false
    const child = originalSpawn(file, ['-I', '-B', '-c',
      'import signal,sys,time; signal.signal(signal.SIGTERM,signal.SIG_IGN); sys.stdout.write("ready"); sys.stdout.flush(); time.sleep(60)'], options)
    child.stdout.once('data', entered)
    return child
  }
  scanner[method] = async (...args) => {
    armed = true
    const signal = method === 'snapshot' ? args[0] : args[1]
    await scanner.run({ mode: 'snapshot', limits: scanner.limits }, signal)
    return method === 'snapshot' ? { status: 'unavailable', records: [], reasons: ['scan_unavailable'] } : unavailableChanges()
  }
}

test('cancelling a real prescan child waits for close, keeps admission fenced and never starts the command', nonRoot, async t => {
  let entered
  const started = new Promise(resolve => { entered = resolve })
  const f = await fixture(t, scanner => blockedScan(scanner, 'snapshot', entered))
  const value = f.request('printf unexpected > unexpected.txt')
  assert.equal((await f.post(value)).status, 202)
  await started
  assert.equal(f.children.size, 1)
  assert.equal((await f.post(f.request('true'))).status, 409)
  await f.cancel(value.id)
  assert.equal((await f.post(f.request('true'))).status, 409, 'Admission remains closed until the scan child closes')
  const result = await f.terminal(value.id)
  assert.equal(result.state, 'cancelled'); assert.equal(result.exitCode, null); assert.equal(result.timedOut, false)
  assert.deepEqual(result.fileChanges, unavailableChanges())
  assert.equal(f.children.size, 0); assert.equal(f.commands.length, 0)
})

test('shutdown during a real postscan waits for the TERM-resistant helper close', nonRoot, async t => {
  let entered
  const started = new Promise(resolve => { entered = resolve })
  const f = await fixture(t, scanner => blockedScan(scanner, 'changes', entered))
  const value = f.request('printf complete > complete.txt')
  assert.equal((await f.post(value)).status, 202)
  await started
  assert.equal(f.children.size, 1); assert.equal(f.commands.length, 1)
  let closed = false
  const child = [...f.children][0]
  child.once('close', () => { closed = true })
  await f.runner.shutdown()
  assert.equal(closed, true); assert.equal(f.children.size, 0)
  assert.equal(await readFile(join(f.root, 'complete.txt'), 'utf8'), 'complete')
})

const escapeCommand = code => `/usr/bin/python3 -I -B <<'PY'
import os,time
r,w=os.pipe()
pid=os.fork()
if pid==0:
 os.close(r)
 os.setsid()
 with open('escape.pid','w') as target: target.write(str(os.getpid()))
 output=os.open('escaped-write.txt',os.O_WRONLY|os.O_CREAT|os.O_APPEND,0o600)
 os.write(output,b'first'+bytes([10]))
 os.write(w,b'ready');os.close(w)
 while True:
  os.write(output,b'continued'+bytes([10]));time.sleep(0.02)
else:
 os.close(w);os.read(r,5);os.close(r);os._exit(${code})
PY`

async function escapedFixture(t, cleanup) {
  let ownedPid, entered
  const cleaning = new Promise(resolve => { entered = resolve })
  const f = await fixture(t, (scanner, root) => {
    // Only this fixture's forked PID is ever signalled; production namespace sweeps are not used on macOS.
    t.after(async () => {
      if (!ownedPid) return
      try { process.kill(ownedPid, 'SIGKILL') } catch (error) { if (error.code !== 'ESRCH') throw error }
      await eventually(() => { try { process.kill(ownedPid, 0); return false } catch (error) { return error.code === 'ESRCH' } })
    })
    scanner.cleanup = async () => {
      ownedPid = Number(await readFile(join(root, 'escape.pid'), 'utf8'))
      assert.ok(Number.isSafeInteger(ownedPid) && ownedPid > 1)
      entered()
      const quiet = await cleanup(ownedPid)
      if (quiet) ownedPid = undefined
      return quiet
    }
  })
  return { ...f, cleaning }
}

test('setsid descendants holding output are terminated before pipe close and another execution is admitted', nonRoot, async t => {
  const f = await escapedFixture(t, async pid => {
    await delay(1100) // Cleanup must not rewrite the known exit with the command's one-second timeout.
    process.kill(pid, 'SIGKILL')
    await eventually(() => { try { process.kill(pid, 0); return false } catch (error) { return error.code === 'ESRCH' } })
    return true
  })
  const value = { ...f.request(escapeCommand(7)), timeoutMs: 1000 }
  assert.equal((await f.post(value)).status, 202)
  await f.cleaning
  assert.equal((await f.post(f.request('true'))).status, 409)
  const result = await f.terminal(value.id)
  assert.equal(result.state, 'failed'); assert.equal(result.exitCode, 7); assert.equal(result.timedOut, false)
  assert.notEqual(result.fileChanges.status, 'unavailable')
  const size = (await readFile(join(f.root, 'escaped-write.txt'))).length
  await delay(60)
  assert.equal((await readFile(join(f.root, 'escaped-write.txt'))).length, size, 'The escaped writer must be dead before scanning')
  // Restore the fixture's ordinary group-only cleanup proof for a subsequent non-escaping command.
  f.scanner.cleanup = async () => true
  const next = f.request('printf safe > next.txt')
  assert.equal((await f.post(next)).status, 202)
  assert.equal((await f.terminal(next.id)).state, 'succeeded')
})

test('a cleanup which cannot certify an escaped writer converges within its deadline and keeps the execution fence', nonRoot, async t => {
  const f = await escapedFixture(t, () => new Promise(() => {}))
  const value = f.request(escapeCommand(0))
  assert.equal((await f.post(value)).status, 202)
  await f.cleaning
  const started = Date.now()
  const result = await f.terminal(value.id)
  assert.ok(Date.now() - started < 4800, 'An inherited output pipe must not prevent bounded terminal status')
  assert.equal(result.state, 'succeeded'); assert.equal(result.exitCode, 0); assert.equal(result.timedOut, false)
  assert.deepEqual(result.fileChanges, unavailableChanges())
  assert.equal(result.stdoutTruncated, true); assert.equal(result.stderrTruncated, true)
  assert.equal((await f.post(f.request('printf unsafe > unsafe.txt'))).status, 409)
  assert.equal(f.commands.length, 1)
  await f.runner.shutdown()
  assert.equal(f.children.size, 0)
})

test('shutdown while an escaped writer holds output also converges within the cleanup deadline', nonRoot, async t => {
  const f = await escapedFixture(t, () => new Promise(() => {}))
  assert.equal((await f.post(f.request(escapeCommand(0)))).status, 202)
  await f.cleaning
  const started = Date.now()
  await f.runner.shutdown()
  assert.ok(Date.now() - started < 4800, 'Shutdown must not wait indefinitely for escaped output holders')
  assert.equal(f.children.size, 0); assert.equal(f.runner.server.listening, false)
  assert.equal(f.commands.length, 1)
})
