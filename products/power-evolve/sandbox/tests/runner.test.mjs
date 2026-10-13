/** Real local HTTP/POSIX command tests; production UID1000 and PID1 cleanup require Linux image acceptance. */
import assert from 'node:assert/strict'
import { spawn } from 'node:child_process'
import { randomBytes, randomUUID } from 'node:crypto'
import { mkdir, mkdtemp, readFile, realpath, rm, symlink } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { setTimeout as delay } from 'node:timers/promises'
import test from 'node:test'
import { CommandChildren } from '../command-children.mjs'
import { createRunner } from '../runner.mjs'

async function eventually(check, timeout = 5000) {
  const deadline = Date.now() + timeout
  do { const value = await check(); if (value) return value; await delay(10) } while (Date.now() < deadline)
  throw new Error('Owned Runner did not settle')
}

async function fixture(t, config = {}, modify = () => {}) {
  assert.equal(typeof process.getuid, 'function', 'These command tests require a POSIX runtime')
  assert.notEqual(process.getuid(), 0, 'The local fixture requires an unprivileged owner')
  const root = await mkdtemp(join(await realpath(tmpdir()), 'pe-dsh-runner-'))
  const children = new Set(), commands = []
  const scanner = new CommandChildren(root, (file, args, options) => {
    assert.equal(options.uid, 1000); assert.equal(options.gid, 1000)
    assert.deepEqual(Object.keys(options.env).sort(), Object.hasOwn(options.env, 'DSH_SHELL')
      ? ['DSH_HOME', 'DSH_SESSION_ID', 'DSH_SHELL', 'HOME', 'LANG', 'PATH', 'USER'] : ['HOME', 'LANG', 'PATH', 'USER'])
    if (options.detached) commands.push(options)
    const child = spawn(file, args, { ...options, uid: process.getuid(), gid: process.getgid(),
      env: { ...options.env, HOME: root } })
    children.add(child); child.once('close', () => children.delete(child))
    return child
  })
  // The local fixture only observes its own known process group; it never sweeps a local UID.
  scanner.cleanup = async group => eventually(() => {
    try { process.kill(-group, 0); return false } catch (error) { return error.code === 'ESRCH' }
  }, 1000).catch(() => false)
  modify(scanner, root)
  const token = randomBytes(32).toString('base64url')
  const runner = createRunner({ token, workspace: root, ...config }, { scanner })
  t.after(async () => {
    await runner.shutdown()
    assert.equal(children.size, 0, 'Shutdown must await every actual child close')
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
  return { root, scanner, children, commands, runner, url, headers, request, post, get, terminal, cancel }
}

test('authenticated command output and exit are real and do not expose artifact observations', { timeout: 10000 }, async (t) => {
  const f = await fixture(t)
  assert.equal((await fetch(`${f.url}/health`)).status, 401)
  const value = f.request("printf '实际输出'; printf 'bytes' > report.txt; exit 7")
  assert.equal((await f.post(value)).status, 202)
  const result = await f.terminal(value.id)
  assert.equal(result.state, 'failed'); assert.equal(result.exitCode, 7)
  assert.equal(result.stdout, '实际输出'); assert.equal(result.timedOut, false)
  assert.equal('fileChanges' in result, false)
  assert.equal(await readFile(join(f.root, 'report.txt'), 'utf8'), 'bytes')
})

test('accepted receipts replay once, conflict fails and another command cannot overlap', { timeout: 10000 }, async (t) => {
  const f = await fixture(t)
  const value = f.request('printf once >> once.txt; sleep 0.2')
  assert.equal((await f.post(value)).status, 202)
  assert.equal((await f.post(value)).status, 200)
  assert.equal((await f.post({ ...value, command: 'printf twice >> once.txt' })).status, 409)
  assert.equal((await f.post(f.request('printf overlap > bad.txt'))).status, 409)
  assert.equal((await f.terminal(value.id)).state, 'succeeded')
  assert.equal((await f.post(value)).status, 200)
  assert.equal(await readFile(join(f.root, 'once.txt'), 'utf8'), 'once')
  assert.equal(f.commands.length, 1)
})

test('retained receipts are bounded without forgetting an accepted operation', { timeout: 10000 }, async (t) => {
  const f = await fixture(t, { maxExecutions: 1 })
  const value = f.request('true')
  assert.equal((await f.post(value)).status, 202)
  await f.terminal(value.id)
  assert.equal((await f.post(f.request('true'))).status, 429)
  assert.equal((await f.post(value)).status, 200)
  assert.equal((await f.get(value.id)).state, 'succeeded')
  assert.equal(f.commands.length, 1)
})

test('cwd rejects outside links and accepts descriptor-resolved internal links', { timeout: 10000 }, async (t) => {
  const f = await fixture(t)
  await mkdir(join(f.root, 'inside'))
  await symlink(join(f.root, 'inside'), join(f.root, 'alias'))
  await symlink(await realpath(tmpdir()), join(f.root, 'outside'))
  assert.equal((await f.post({ ...f.request('true'), cwd: 'missing' })).status, 400)
  assert.equal((await f.post({ ...f.request('true'), cwd: '../escape' })).status, 400)
  assert.equal((await f.post({ ...f.request('true'), cwd: 'outside' })).status, 403)
  const value = { ...f.request('printf bytes > output.txt'), cwd: 'alias' }
  assert.equal((await f.post(value)).status, 202)
  assert.equal((await f.terminal(value.id)).state, 'succeeded')
  await rm(join(f.root, 'alias'))
  assert.equal((await f.post(value)).status, 200)
  assert.equal(await readFile(join(f.root, 'inside/output.txt'), 'utf8'), 'bytes')
})

test('actual cancellation and timeout close command children before another execution', { timeout: 10000 }, async (t) => {
  const f = await fixture(t)
  const value = f.request('printf started > started.txt; sleep 60')
  assert.equal((await f.post(value)).status, 202)
  await eventually(async () => { try { return await readFile(join(f.root, 'started.txt'), 'utf8') === 'started' } catch { return false } })
  assert.equal((await fetch(`${f.url}/executions/${value.id}/cancel`, {
    method: 'POST', headers: f.headers, body: '{}' })).status, 200)
  const cancelled = await f.terminal(value.id)
  assert.equal(cancelled.state, 'cancelled'); assert.equal(cancelled.timedOut, false)
  const timed = { ...f.request('sleep 60'), timeoutMs: 1000 }
  assert.equal((await f.post(timed)).status, 202)
  const result = await f.terminal(timed.id)
  assert.equal(result.state, 'failed'); assert.equal(result.timedOut, true)
  assert.equal(f.children.size, 0)
})

test('leader exit retires its own background group before allowing new work', { timeout: 10000 }, async (t) => {
  const f = await fixture(t)
  const value = f.request('(sleep 60; printf late > late.txt) & printf early > early.txt')
  assert.equal((await f.post(value)).status, 202)
  const result = await f.terminal(value.id)
  assert.equal(result.state, 'succeeded'); assert.equal(result.exitCode, 0)
  assert.equal(f.children.size, 0)
  assert.equal(await readFile(join(f.root, 'early.txt'), 'utf8'), 'early')
  const next = f.request('printf next')
  assert.equal((await f.post(next)).status, 202)
  assert.equal((await f.terminal(next.id)).stdout, 'next')
})

test('explicit stopping causes preserve the first cause and cannot rewrite a completed receipt', { timeout: 10000 }, async (t) => {
  const f = await fixture(t)
  const cancel = (id, cause) => fetch(`${f.url}/executions/${id}/cancel`, {
    method: 'POST', headers: f.headers, body: JSON.stringify({ cause }) })
  for (const first of ['timeout', 'abort']) {
    const value = f.request("trap 'sleep 0.1; exit 0' TERM; printf ready > ready.txt; while :; do sleep 1; done")
    await rm(join(f.root, 'ready.txt'), { force: true })
    assert.equal((await f.post(value)).status, 202)
    await eventually(async () => { try { return await readFile(join(f.root, 'ready.txt'), 'utf8') === 'ready' } catch { return false } })
    assert.equal((await cancel(value.id, first)).status, 200)
    assert.equal((await cancel(value.id, first === 'abort' ? 'timeout' : 'abort')).status, 200)
    const result = await f.terminal(value.id)
    assert.equal(result.timedOut, first === 'timeout')
    assert.equal(result.state, first === 'timeout' ? 'failed' : 'cancelled')
  }
  const value = f.request('true')
  assert.equal((await f.post(value)).status, 202)
  const before = await f.terminal(value.id)
  assert.deepEqual(await (await cancel(value.id, 'timeout')).json(), before)
  assert.equal((await cancel(value.id, 'unrecognized')).status, 400)
})

test('partial UTF8 chunks survive decoding and truncated streams stay within their byte ceiling', { timeout: 10000 }, async (t) => {
  const f = await fixture(t)
  const value = f.request("/usr/bin/python3 -I -B -c 'import os,time; os.write(1,bytes([228])); time.sleep(0.1); os.write(1,bytes([184,173])); os.write(1,(\"文\"*30000).encode())'")
  assert.equal((await f.post(value)).status, 202)
  const result = await f.terminal(value.id)
  assert.equal(result.state, 'succeeded')
  assert.ok(result.stdout.startsWith('中文'))
  assert.ok(Buffer.byteLength(result.stdout) <= 65536)
  assert.equal(result.stdoutTruncated, true)
  assert.equal(result.stdout.includes('\uFFFD'), false)
})

test('native foreground capture keeps a bounded UTF8 tail while legacy receipts retain their original prefix', { timeout: 10000 }, async (t) => {
  const f = await fixture(t)
  const value = { ...f.request("/usr/bin/python3 -I -B -c 'import os; os.write(1,(\"前\"+\"文\"*30000+\"末尾\").encode()); os.write(2,(\"错\"*30000+\"错误结尾\").encode())'"), outputMode: 'tail' }
  assert.equal((await f.post(value)).status, 202)
  const result = await f.terminal(value.id)
  assert.equal(result.state, 'succeeded')
  assert.equal(result.stdout.endsWith('末尾'), true)
  assert.equal(result.stderr.endsWith('错误结尾'), true)
  assert.equal(result.stdout.includes('前'), false)
  for (const field of ['stdout', 'stderr']) {
    assert.ok(Buffer.byteLength(result[field]) <= 65536)
    assert.equal(result[field].includes('\uFFFD'), false)
    assert.equal(result[field + 'Truncated'], true)
  }
  assert.equal((await f.post({ ...f.request('true'), outputMode: 'head' })).status, 400)
})

test('native managed facts reach commands without copying Host configuration paths or credentials', { timeout: 10000 }, async (t) => {
  const f = await fixture(t), sessionId = randomUUID()
  const value = { ...f.request('printf "%s|%s|%s" "$DSH_SHELL" "$DSH_SESSION_ID" "$DSH_HOME"'), outputMode: 'tail',
    dshEnv: { DSH_SHELL: '1', DSH_HOME: '/home/agent/.dsh', DSH_SESSION_ID: sessionId } }
  assert.equal((await f.post(value)).status, 202)
  assert.equal((await f.terminal(value.id)).stdout, `1|${sessionId}|/home/agent/.dsh`)
  for (const dshEnv of [{ ...value.dshEnv, SECRET_KEY: 'invalid' }, { ...value.dshEnv, DSH_HOME: '/run/host' },
    { ...value.dshEnv, DSH_SESSION_ID: 'foreign' }]) {
    assert.equal((await f.post({ ...value, id: randomUUID(), dshEnv })).status, 400)
  }
})

test('native workdir admits Unicode project directories while preserving physical workspace confinement', { timeout: 10000 }, async (t) => {
  const f = await fixture(t)
  await mkdir(join(f.root, '中文 目录'))
  const value = { ...f.request('printf native > greeting.txt'), cwd: '中文 目录', outputMode: 'tail' }
  assert.equal((await f.post(value)).status, 202)
  assert.equal((await f.terminal(value.id)).exitCode, 0)
  assert.equal(await readFile(join(f.root, '中文 目录/greeting.txt'), 'utf8'), 'native')
  assert.equal((await f.post({ ...f.request('true'), cwd: '../outside', outputMode: 'tail' })).status, 400)
})

test('invalid bodies and stale runner identities never start work, and STDIO disabled is explicit', { timeout: 10000 }, async (t) => {
  const f = await fixture(t)
  assert.equal((await f.post({ ...f.request('true'), unexpected: true })).status, 400)
  assert.equal((await f.post({ ...f.request('true'), instanceId: randomUUID() })).status, 409)
  assert.equal((await fetch(`${f.url}/stdio/v2/executions`, { method: 'POST', headers: f.headers, body: '{}' })).status, 404)
  const oversized = await fetch(`${f.url}/executions`, { method: 'POST', headers: f.headers, body: 'x'.repeat(17000) })
  assert.equal(oversized.status, 413)
  assert.equal(f.commands.length, 0)
})
