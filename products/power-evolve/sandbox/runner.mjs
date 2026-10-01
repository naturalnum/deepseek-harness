/** Per-Sandbox command runner. The trusted platform reaches it through Kubernetes service proxy. */
import { createServer } from 'node:http'
import { readFileSync } from 'node:fs'
import { createHash, randomUUID, timingSafeEqual } from 'node:crypto'
import { pathToFileURL } from 'node:url'
import { FileScanner, scanLimits, unavailableChanges } from './file-scan.mjs'

const maximumOutput = 65_536

/** Compose the existing HTTP Runner with an unprivileged scanner; filesystem inputs remain child-owned. */
export function createRunner({ token, workspace = '/workspace', limits = scanLimits() },
  { scanner = new FileScanner(workspace, limits), signalGroup = (pid, signal) => process.kill(-pid, signal) } = {}) {
  const executions = new Map()
  const instanceId = randomUUID()
  let active = null, admission = null, shuttingDown = false

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
      stderrTruncated: entry.stderr.truncated, timedOut: entry.timedOut, instanceId,
      ...(entry.state !== 'running' && entry.fileChanges ? { fileChanges: entry.fileChanges } : {}) }
  }
  function stop(entry, reason) {
    if (entry.state !== 'running') return
    if (entry.phase === 'before' || entry.phase === 'command') {
      if (reason === 'cancel') entry.cancelled = true
      if (reason === 'timeout') entry.timedOut = true
    }
    entry.scanAbort?.abort()
    if (!entry.child?.pid) return
    try { signalGroup(entry.child.pid, 'SIGTERM') } catch (error) { if (error.code !== 'ESRCH') throw error }
    entry.killTimer ??= setTimeout(() => {
      if (!entry.child?.pid) return
      try { signalGroup(entry.child.pid, 'SIGKILL') } catch (_signalUnavailable) { /* Cleanup retains the active fence. */ }
    }, 3000)
    entry.killTimer.unref()
  }
  function start(value) {
    const entry = { id: value.id, digest: createHash('sha256').update(JSON.stringify(value)).digest('hex'),
      state: 'running', exitCode: null, stdout: { text: '', truncated: false },
      stderr: { text: '', truncated: false }, cancelled: false, timedOut: false, child: null, phase: 'before' }
    executions.set(value.id, entry)
    active = entry
    entry.finished = execute(value, entry)
    return entry
  }
  async function execute(value, entry) {
    let commandFailed = false, quiet = true
    try {
      entry.scanAbort = new AbortController()
      let before
      try { before = await scanner.snapshot(entry.scanAbort.signal) }
      catch (_scanUnavailable) { before = { status: 'unavailable', records: [], reasons: ['scan_unavailable'] } }
      if (entry.cancelled || shuttingDown) { entry.fileChanges = unavailableChanges(); commandFailed = true; return }
      entry.phase = 'command'
      const child = scanner.command(value)
      entry.child = child
      child.stdout.on('data', chunk => output(entry.stdout, chunk))
      child.stderr.on('data', chunk => output(entry.stderr, chunk))
      child.once('error', () => {
        commandFailed = true; entry.stderr.text = 'command_start_failed'
      })
      let timer
      child.once('exit', () => {
        clearTimeout(timer)
        entry.phase = 'cleanup'
        // Leader exit precedes pipe close; background group members cannot keep the command's output pipes alive.
        try { signalGroup(child.pid, 'SIGKILL') } catch (error) { if (error.code !== 'ESRCH') quiet = false }
      })
      timer = setTimeout(() => {
        if (entry.phase === 'command') { try { stop(entry, 'timeout') } catch (_signalUnavailable) { quiet = false } }
      }, value.timeoutMs)
      timer.unref()
      entry.exitCode = await new Promise(resolve => child.once('close', resolve))
      clearTimeout(timer); clearTimeout(entry.killTimer)
      entry.child = null
      entry.phase = 'cleanup'
      if (child.pid) {
        try { signalGroup(child.pid, 0); quiet = await scanner.groupQuiet(child.pid) && quiet }
        catch (error) { if (error.code !== 'ESRCH') quiet = false }
      }
      if (!quiet || shuttingDown) { entry.fileChanges = unavailableChanges(); return }
      entry.phase = 'after'
      entry.scanAbort = new AbortController()
      try { entry.fileChanges = await scanner.changes(before, entry.scanAbort.signal) }
      catch (_scanUnavailable) { entry.fileChanges = unavailableChanges() }
    } catch (_commandStartFailed) {
      commandFailed = true; entry.stderr.text ||= 'command_start_failed'
      entry.fileChanges = unavailableChanges()
    } finally {
      entry.phase = 'done'
      entry.state = entry.cancelled ? 'cancelled' : entry.timedOut || commandFailed || entry.exitCode !== 0 ? 'failed' : 'succeeded'
      // An unverified surviving group prevents another execution from contaminating its files.
      if (quiet && active === entry) active = null
    }
  }

  const server = createServer(async (request, response) => {
    if (!authorized(request)) { reply(response, 401, { error: 'unauthorized' }); return }
    try {
      const path = new URL(request.url, 'http://localhost').pathname
      if (request.method === 'GET' && path === '/health') {
        reply(response, 200, { ready: !shuttingDown, instanceId }); return
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
        const digest = createHash('sha256').update(JSON.stringify(value)).digest('hex')
        const prior = executions.get(value.id)
        if (prior) { reply(response, prior.digest === digest ? 200 : 409,
          prior.digest === digest ? view(prior) : { error: 'execution_conflict' }); return }
        if (value.instanceId !== instanceId) { reply(response, 409, { error: 'runner_instance_changed' }); return }
        if (shuttingDown) { reply(response, 503, { error: 'runner_unavailable' }); return }
        if (active || admission) { reply(response, 409, { error: 'execution_busy' }); return }
        const check = { abort: new AbortController() }
        admission = check
        try {
          check.finished = scanner.cwd(value.cwd, check.abort.signal)
          const valid = await check.finished
          if (shuttingDown) { reply(response, 503, { error: 'runner_unavailable' }); return }
          if (!valid.valid) { reply(response, valid.status, { error: 'invalid_cwd' }); return }
          reply(response, 202, view(start(value))); return
        } finally { if (admission === check) admission = null }
      }
      reply(response, 404, { error: 'not_found' })
    } catch (error) { reply(response, 500, { error: error.message === 'request_too_large' ? 'request_too_large' : 'execution_error' }) }
  })

  async function shutdown() {
    shuttingDown = true
    const checking = admission
    checking?.abort.abort()
    for (const entry of executions.values()) stop(entry, 'shutdown')
    const closed = new Promise(resolve => server.close(resolve))
    await Promise.allSettled([checking?.finished, ...[...executions.values()].map(entry => entry.finished)])
    server.closeAllConnections()
    await closed
  }
  return { server, shutdown }
}

if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href) {
  const runner = createRunner({ token: readFileSync('/run/power-evolve/runner-token', 'utf8').trim() })
  runner.server.listen(8080, '0.0.0.0')
  process.once('SIGTERM', () => { void runner.shutdown().then(() => process.exit(0)) })
}
