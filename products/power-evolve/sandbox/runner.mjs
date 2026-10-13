/** Per-Sandbox command runner. The trusted platform reaches it through Kubernetes service proxy. */
import { createServer } from 'node:http'
import { readFileSync } from 'node:fs'
import { createHash, randomUUID, timingSafeEqual } from 'node:crypto'
import { pathToFileURL } from 'node:url'
import { StringDecoder } from 'node:string_decoder'
import { CommandChildren } from './command-children.mjs'

const maximumOutput = 65_536

function managedEnvironment(value) {
  return value && typeof value === 'object'
    && Object.keys(value).sort().join(',') === 'DSH_HOME,DSH_SESSION_ID,DSH_SHELL'
    && value.DSH_HOME === '/home/agent/.dsh' && value.DSH_SHELL === '1'
    && typeof value.DSH_SESSION_ID === 'string'
    && /^[a-f0-9]{8}-[a-f0-9]{4}-[a-f0-9]{4}-[a-f0-9]{4}-[a-f0-9]{12}$/u.test(value.DSH_SESSION_ID)
}

/** Compose the image's HTTP Runner with credential-free command children.
 * @param config Private token, Workspace root, retained receipt ceiling and optional STDIO budgets.
 * @param providers Dropped-privilege child provider, process-group signal and optional STDIO factory.
 * @returns {{server: import('node:http').Server, shutdown: () => Promise<{writerStopConfirmed: boolean}>}}
 * Authenticated server and observed shutdown.
 */
export function createRunner(config, providers = {}) {
  const { token, workspace = '/workspace', maxExecutions = 4096, stdio } = config
  const { scanner = new CommandChildren(workspace), signalGroup = (pid, signal) => process.kill(-pid, signal),
    createStdioRuntime } = providers
  if (typeof token !== 'string' || token.length < 16 || !Number.isSafeInteger(maxExecutions)
    || maxExecutions < 1 || maxExecutions > 65536) throw new Error('runner_configuration_invalid')
  const executions = new Map()
  const instanceId = randomUUID()
  let active = null, admission = null, shuttingDown = false
  if (stdio !== undefined && (typeof createStdioRuntime !== 'function'
    || !stdio || Object.keys(stdio).sort().join(',') !== 'limits,maxReplyBytes')) {
    throw new Error('stdio_v2_configuration_invalid')
  }
  const stdioRuntime = stdio === undefined ? undefined : createStdioRuntime({ ...stdio,
    environment: { workspaceRoot: workspace, env: { HOME: '/home/agent', PATH: '/usr/local/bin:/usr/bin:/bin', LANG: 'C.UTF-8' },
      identity: { kind: 'unix', uid: 1000, gid: 1000 } }, executorOwner: { kind: 'cloud', runnerInstanceId: instanceId },
    authorizeCwd: async (cwd, signal) => (await scanner.cwd(cwd === '.' ? '' : cwd, signal)).valid,
    cleanup: () => scanner.cleanup(),
  })

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
  async function body(request, maximum = 16_384) {
    const chunks = []; let bytes = 0
    for await (const chunk of request) {
      bytes += chunk.length
      if (bytes > maximum) throw new Error('request_too_large')
      chunks.push(chunk)
    }
    return JSON.parse(Buffer.concat(chunks).toString('utf8'))
  }
  function appendOutput(stream, text) {
    if (text.length === 0) return
    if (stream.outputMode === 'tail') {
      const bytes = Buffer.from(stream.text + text)
      let start = Math.max(0, bytes.length - maximumOutput)
      while (start < bytes.length && (bytes[start] & 0xc0) === 0x80) start++
      stream.text = bytes.subarray(start).toString('utf8')
      if (start > 0) stream.truncated = true
      return
    }
    const remaining = maximumOutput - Buffer.byteLength(stream.text)
    if (remaining <= 0) { stream.truncated = true; return }
    const bytes = Buffer.from(text)
    // Keep complete code points so JSON expansion never exceeds the fixed stream byte ceiling.
    let end = Math.min(bytes.length, remaining)
    while (end < bytes.length && end > 0 && (bytes[end] & 0xc0) === 0x80) end--
    stream.text += bytes.subarray(0, end).toString('utf8')
    if (bytes.length > remaining) stream.truncated = true
  }
  function view(entry) {
    return { id: entry.id, state: entry.state, digest: entry.digest, exitCode: entry.exitCode,
      stdout: entry.stdout.text, stderr: entry.stderr.text, stdoutTruncated: entry.stdout.truncated,
      stderrTruncated: entry.stderr.truncated, timedOut: entry.timedOut, instanceId }
  }
  function stop(entry, reason) {
    if (entry.state !== 'running') return
    if (entry.phase === 'command') {
      entry.stopCause ??= reason
      if (entry.stopCause === 'cancel') entry.cancelled = true
      if (entry.stopCause === 'timeout') entry.timedOut = true
    }
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
      state: 'running', exitCode: null, stdout: { text: '', truncated: false, outputMode: value.outputMode, decoder: new StringDecoder('utf8') },
      stderr: { text: '', truncated: false, outputMode: value.outputMode, decoder: new StringDecoder('utf8') }, cancelled: false, timedOut: false, child: null, phase: 'command' }
    executions.set(value.id, entry)
    active = entry
    entry.finished = execute(value, entry)
    return entry
  }
  async function execute(value, entry) {
    let commandFailed = false, quiet = true
    try {
      if (entry.cancelled || shuttingDown) { commandFailed = true; return }
      entry.phase = 'command'
      const child = scanner.command(value)
      entry.child = child
      child.stdout.on('data', chunk => appendOutput(entry.stdout, entry.stdout.decoder.write(chunk)))
      child.stderr.on('data', chunk => appendOutput(entry.stderr, entry.stderr.decoder.write(chunk)))
      child.once('error', () => {
        commandFailed = true; entry.stderr.text = 'command_start_failed'
      })
      const closed = new Promise(resolve => child.once('close', resolve))
      const exited = new Promise((resolve) => {
        child.once('error', () => resolve(null))
        child.once('exit', (code) => {
          clearTimeout(timer)
          entry.phase = 'cleanup'
          resolve(code)
        })
      })
      const timer = setTimeout(() => {
        if (entry.phase === 'command') { try { stop(entry, 'timeout') } catch (_signalUnavailable) { quiet = false } }
      }, value.timeoutMs)
      timer.unref()
      entry.exitCode = await exited
      clearTimeout(timer); clearTimeout(entry.killTimer)
      entry.phase = 'cleanup'
      if (child.pid) {
        try { signalGroup(child.pid, 'SIGKILL') } catch (error) { if (error.code !== 'ESRCH') quiet = false }
        let cleanupTimer
        try {
          quiet = await Promise.race([scanner.cleanup(child.pid), new Promise((resolve) => {
            cleanupTimer = setTimeout(() => resolve(false), 4000)
            cleanupTimer.unref()
          })]) && quiet
        } catch (_cleanupUnavailable) { quiet = false }
        finally { clearTimeout(cleanupTimer) }
      }
      // Cleanup runs before waiting on inherited pipes, including descendants which called setsid().
      // If verification fails, close transport only after cleanup attempts and retain the admission fence.
      const closeOutput = () => {
        if (!child.stdout.readableEnded) entry.stdout.truncated = true
        if (!child.stderr.readableEnded) entry.stderr.truncated = true
        child.stdout.destroy(); child.stderr.destroy()
      }
      if (!quiet) closeOutput()
      const pipeTimer = setTimeout(() => {
        quiet = false
        closeOutput()
      }, 500)
      pipeTimer.unref()
      await closed
      clearTimeout(pipeTimer)
      entry.child = null
    } catch (_commandStartFailed) {
      commandFailed = true; entry.stderr.text ||= 'command_start_failed'
    } finally {
      appendOutput(entry.stdout, entry.stdout.decoder.end())
      appendOutput(entry.stderr, entry.stderr.decoder.end())
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
      const stdioMatch = /^\/stdio\/v2\/executions\/([a-f0-9-]{36})(\/cancel)?$/.exec(path)
      if (path === '/stdio/v2/executions' || stdioMatch) {
        if (!stdioRuntime) { reply(response, 404, { error: 'stdio_v2_disabled', instanceId }); return }
        if (request.method === 'GET' && stdioMatch && !stdioMatch[2]) {
          const value = stdioRuntime.get(stdioMatch[1])
          reply(response, value ? 200 : 404, value ?? { error: 'execution_not_found', instanceId }); return
        }
        if (request.method === 'POST' && stdioMatch?.[2]) {
          const value = stdioRuntime.cancel(stdioMatch[1])
          reply(response, value ? 200 : 404, value ?? { error: 'execution_not_found', instanceId }); return
        }
        if (request.method === 'POST' && path === '/stdio/v2/executions') {
          const value = await body(request, stdio.limits.maxInputBytes)
          const id = value?.dispatch?.executionRef?.executionId
          const retained = typeof id === 'string' && stdioRuntime.get(id) !== undefined
          if (!retained && shuttingDown) { reply(response, 503, { error: 'runner_unavailable', instanceId }); return }
          // UID cleanup covers the entire namespace, so both protocols share the same writer gate.
          if (!retained && (active || admission)) { reply(response, 409, { error: 'execution_busy', instanceId }); return }
          try {
            const result = await stdioRuntime.start(value)
            reply(response, result.state === 'running' ? 202 : 200, result)
          } catch (error) {
            const code = typeof error.code === 'string' && /^stdio_v2_[a-z0-9_]+$/u.test(error.code)
              ? error.code : 'stdio_v2_start_invalid'
            const status = code === 'stdio_v2_runtime_closed' ? 503
              : ['stdio_v2_runtime_busy', 'stdio_v2_dispatch_conflict', 'stdio_v2_executor_owner_mismatch'].includes(code) ? 409
                : ['stdio_v2_start_denied', 'stdio_v2_start_expired'].includes(code) ? 403 : 400
            reply(response, status, { error: code, instanceId })
          }
          return
        }
        reply(response, 404, { error: 'not_found', instanceId }); return
      }
      const match = /^\/executions\/([a-f0-9-]{36})(\/cancel)?$/.exec(path)
      if (request.method === 'GET' && match && !match[2]) {
        const entry = executions.get(match[1])
        reply(response, entry ? 200 : 404, entry ? view(entry) : { error: 'execution_not_found', instanceId }); return
      }
      if (request.method === 'POST' && match?.[2]) {
        const entry = executions.get(match[1])
        if (!entry) { reply(response, 404, { error: 'execution_not_found', instanceId }); return }
        let reason = 'cancel'
        if (Number(request.headers['content-length'] ?? 0) > 0 || request.headers['transfer-encoding'] !== undefined) {
          const value = await body(request, 1024)
          if (!value || typeof value !== 'object' || Array.isArray(value)
            || Object.keys(value).length > 0 && (Object.keys(value).join(',') !== 'cause'
              || !['timeout', 'abort'].includes(value.cause))) {
            reply(response, 400, { error: 'invalid_cancel_request', instanceId }); return
          }
          reason = value.cause === 'timeout' ? 'timeout' : 'cancel'
        }
        stop(entry, reason); reply(response, 200, view(entry)); return
      }
      if (request.method === 'POST' && path === '/executions') {
        const value = await body(request)
        if (!value || typeof value !== 'object'
          || !['command,cwd,id,instanceId,timeoutMs', 'command,cwd,id,instanceId,outputMode,timeoutMs',
            'command,cwd,dshEnv,id,instanceId,outputMode,timeoutMs'].includes(Object.keys(value).sort().join(','))
          || (Object.hasOwn(value, 'outputMode') && value.outputMode !== 'tail')
          || (Object.hasOwn(value, 'dshEnv') && !managedEnvironment(value.dshEnv))
          || typeof value.id !== 'string' || !/^[a-f0-9-]{36}$/.test(value.id)
          || typeof value.instanceId !== 'string' || !/^[a-f0-9-]{36}$/.test(value.instanceId)
          || typeof value.command !== 'string' || value.command.length < 1 || value.command.length > 8192
          || typeof value.cwd !== 'string' || (value.outputMode === 'tail'
          ? value.cwd.length > 256 || value.cwd.startsWith('/') || /[\u0000-\u001f\u007f\\]/u.test(value.cwd)
          : !/^(?:|[A-Za-z0-9._/-]{1,256})$/.test(value.cwd))
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
        if (executions.size >= maxExecutions) { reply(response, 429, { error: 'runner_receipt_limit' }); return }
        if (active || admission || stdioRuntime?.busy()) { reply(response, 409, { error: 'execution_busy' }); return }
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
    } catch (error) { reply(response, error.message === 'request_too_large' ? 413 : 500,
      { error: error.message === 'request_too_large' ? 'request_too_large' : 'execution_error' }) }
  })

  async function shutdown() {
    shuttingDown = true
    const checking = admission
    checking?.abort.abort()
    for (const entry of executions.values()) stop(entry, 'shutdown')
    const closed = new Promise(resolve => server.close(resolve))
    const stopping = stdioRuntime?.close()
    await Promise.allSettled([checking?.finished, ...[...executions.values()].map(entry => entry.finished)])
    const stdioStopped = stopping === undefined ? true : await stopping
    server.closeAllConnections()
    await closed
    return { writerStopConfirmed: stdioStopped && active === null && admission === null }
  }
  return { server, shutdown }
}

if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href) {
  const stdioPath = process.env.PE_RUNNER_STDIO_V2_CONFIG_FILE
  const stdio = stdioPath === undefined ? undefined : JSON.parse(readFileSync(stdioPath, 'utf8'))
  // This is a private library in the existing image, never a second application launcher.
  const runtime = stdio === undefined ? undefined : await import('./lib/stdio-v2-runtime.mjs')
  const maxExecutions = process.env.PE_RUNNER_MAX_EXECUTIONS === undefined ? 4096 : Number(process.env.PE_RUNNER_MAX_EXECUTIONS)
  const runner = createRunner({ token: readFileSync('/run/power-evolve/runner-token', 'utf8').trim(), maxExecutions, stdio },
    runtime === undefined ? {} : { createStdioRuntime: options => new runtime.StdioCloudRuntimeV2(options) })
  runner.server.listen(8080, '0.0.0.0')
  process.once('SIGTERM', () => { void runner.shutdown().then(result => process.exit(result.writerStopConfirmed ? 0 : 1)) })
}
