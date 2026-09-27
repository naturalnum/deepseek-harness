/** Per-Sandbox command runner. The trusted platform reaches it through Kubernetes service proxy. */
import { createServer } from 'node:http'
import { readFileSync, realpathSync } from 'node:fs'
import { createHash, randomUUID, timingSafeEqual } from 'node:crypto'
import { spawn } from 'node:child_process'

const token = readFileSync('/run/power-evolve/runner-token', 'utf8').trim()
const workspace = realpathSync('/workspace')
const maximumOutput = 65_536
const executions = new Map()
const instanceId = randomUUID()

function reply(response, status, value) {
  response.writeHead(status, { 'content-type': 'application/json', 'cache-control': 'no-store' })
  response.end(JSON.stringify(value))
}
function authorized(request) {
  const supplied = request.headers['x-power-evolve-runner-token'] ?? ''
  if (typeof supplied !== 'string') return false
  const expectedBytes = Buffer.from(token), suppliedBytes = Buffer.from(supplied)
  return suppliedBytes.length === expectedBytes.length && timingSafeEqual(suppliedBytes, expectedBytes)
}
async function body(request) {
  const chunks = []; let bytes = 0
  for await (const chunk of request) {
    bytes += chunk.length
    if (bytes > 16_384) throw new Error('request_too_large')
    chunks.push(chunk)
  }
  return JSON.parse(Buffer.concat(chunks).toString('utf8'))
}
function output(stream, chunk) {
  const text = chunk.toString('utf8')
  const remaining = maximumOutput - Buffer.byteLength(stream.text)
  if (remaining <= 0) { stream.truncated = true; return }
  const bytes = Buffer.from(text)
  stream.text += bytes.subarray(0, remaining).toString('utf8')
  if (bytes.length > remaining) stream.truncated = true
}
function view(entry) {
  return { id: entry.id, state: entry.state, digest: entry.digest, exitCode: entry.exitCode,
    stdout: entry.stdout.text, stderr: entry.stderr.text, stdoutTruncated: entry.stdout.truncated,
    stderrTruncated: entry.stderr.truncated, timedOut: entry.timedOut, instanceId }
}
function stop(entry, reason) {
  if (!entry.child || entry.state !== 'running') return
  try { process.kill(-entry.child.pid, 'SIGTERM') } catch (error) { if (error.code !== 'ESRCH') throw error }
  if (reason === 'cancel') entry.cancelled = true
  if (reason === 'timeout') entry.timedOut = true
  setTimeout(() => {
    if (entry.state !== 'running') return
    try { process.kill(-entry.child.pid, 'SIGKILL') } catch (error) { if (error.code !== 'ESRCH') throw error }
  }, 3000).unref()
}
function start(value, cwd) {
  const entry = { id: value.id, digest: createHash('sha256').update(JSON.stringify(value)).digest('hex'),
    state: 'running', exitCode: null, stdout: { text: '', truncated: false },
    stderr: { text: '', truncated: false }, cancelled: false, timedOut: false, child: null }
  executions.set(value.id, entry)
  try {
    const child = spawn('/bin/bash', ['-lc', value.command], {
      cwd, uid: 1000, gid: 1000, detached: true, stdio: ['ignore', 'pipe', 'pipe'],
      env: { PATH: '/usr/local/bin:/usr/bin:/bin', HOME: '/home/agent', USER: 'agent', LANG: 'C.UTF-8' },
    })
    entry.child = child
    child.stdout.on('data', chunk => output(entry.stdout, chunk))
    child.stderr.on('data', chunk => output(entry.stderr, chunk))
    child.once('error', error => {
      entry.state = 'failed'; entry.stderr.text = error.message.slice(0, maximumOutput)
    })
    child.once('close', code => {
      // Bash may have returned after starting a detached background command.
      // The command's process group must not outlive its recorded result.
      try { process.kill(-child.pid, 'SIGKILL') } catch (error) { if (error.code !== 'ESRCH') throw error }
      entry.exitCode = code
      entry.state = entry.cancelled ? 'cancelled' : entry.timedOut ? 'failed' : code === 0 ? 'succeeded' : 'failed'
      entry.child = null
    })
    setTimeout(() => { if (entry.state === 'running') { try { stop(entry, 'timeout') } catch (_signalUnavailable) { /* The platform still sees a running command. */ } } }, value.timeoutMs).unref()
  } catch (error) {
    entry.state = 'failed'; entry.stderr.text = error.message.slice(0, maximumOutput)
  }
  return entry
}

const server = createServer(async (request, response) => {
  if (!authorized(request)) { reply(response, 401, { error: 'unauthorized' }); return }
  try {
    const path = new URL(request.url, 'http://localhost').pathname
    if (request.method === 'GET' && path === '/health') {
      reply(response, 200, { ready: true, instanceId }); return
    }
    const match = /^\/executions\/([a-f0-9-]{36})(\/cancel)?$/.exec(path)
    if (request.method === 'GET' && match && !match[2]) {
      const entry = executions.get(match[1])
      reply(response, entry ? 200 : 404, entry ? view(entry) : { error: 'execution_not_found', instanceId }); return
    }
    if (request.method === 'POST' && match?.[2]) {
      const entry = executions.get(match[1])
      if (!entry) { reply(response, 404, { error: 'execution_not_found', instanceId }); return }
      stop(entry, 'cancel'); reply(response, 200, view(entry)); return
    }
    if (request.method === 'POST' && path === '/executions') {
      const value = await body(request)
      if (!value || typeof value !== 'object' || Object.keys(value).sort().join(',') !== 'command,cwd,id,instanceId,timeoutMs'
        || typeof value.id !== 'string' || !/^[a-f0-9-]{36}$/.test(value.id)
        || typeof value.instanceId !== 'string' || !/^[a-f0-9-]{36}$/.test(value.instanceId)
        || typeof value.command !== 'string' || value.command.length < 1 || value.command.length > 8192
        || typeof value.cwd !== 'string' || !/^(?:|[A-Za-z0-9._/-]{1,256})$/.test(value.cwd)
        || value.cwd.split('/').some(part => part === '..')
        || !Number.isInteger(value.timeoutMs) || value.timeoutMs < 1000 || value.timeoutMs > 300_000) {
        reply(response, 400, { error: 'invalid_execution' }); return
      }
      let cwd
      try { cwd = realpathSync(`${workspace}/${value.cwd}`) }
      catch (error) {
        if (error.code === 'ENOENT' || error.code === 'ENOTDIR' || error.code === 'ELOOP') {
          reply(response, 400, { error: 'invalid_cwd' }); return
        }
        throw error
      }
      if (cwd !== workspace && !cwd.startsWith(`${workspace}/`)) { reply(response, 403, { error: 'invalid_cwd' }); return }
      const digest = createHash('sha256').update(JSON.stringify(value)).digest('hex')
      const prior = executions.get(value.id)
      if (prior) { reply(response, prior.digest === digest ? 200 : 409,
        prior.digest === digest ? view(prior) : { error: 'execution_conflict' }); return }
      if (value.instanceId !== instanceId) { reply(response, 409, { error: 'runner_instance_changed' }); return }
      reply(response, 202, view(start(value, cwd))); return
    }
    reply(response, 404, { error: 'not_found' })
  } catch (error) { reply(response, 500, { error: error.message === 'request_too_large' ? 'request_too_large' : 'execution_error' }) }
})

server.listen(8080, '0.0.0.0')
process.on('SIGTERM', () => {
  for (const entry of executions.values()) stop(entry, 'shutdown')
  server.close()
  setTimeout(() => process.exit(0), 4000).unref()
})
