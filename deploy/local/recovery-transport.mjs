/** Recovery-only local transport. Importing or constructing it performs no Docker operation. */
import { spawn } from 'node:child_process'
import { request as httpRequest } from 'node:http'

/** A cancelled or incomplete call never confirms the remote operation's outcome. */
export class RecoveryTransportError extends Error {
  constructor(unknown) {
    super('恢复传输未完成；保留原操作责任，不重试或释放远端资源。')
    this.name = 'RecoveryTransportError'
    this.unknown = unknown
  }
}

/**
 * Bind recovery calls to one explicit local Engine, container and existing operation deadline.
 * @param {object} options - signal is the original operation signal; deadlineAtMs uses performance.now().
 * socketPath and dockerPath select existing local executables/socket; maxOutputBytes bounds complete output.
 * @returns {object} Original namespace transport methods plus close and state. Cancellation fences subsequent
 * calls; local child/socket closure does not establish remote exec termination or authorize resource release.
 */
export function createRecoveryTransport({ signal, deadlineAtMs, socketPath, dockerPath, container, maxOutputBytes }) {
  if (!(signal instanceof AbortSignal) || !Number.isFinite(deadlineAtMs) || deadlineAtMs <= performance.now()
    || deadlineAtMs - performance.now() > 1800000 || typeof socketPath !== 'string' || !socketPath.startsWith('/')
    || socketPath.includes('\0') || typeof dockerPath !== 'string' || !dockerPath.startsWith('/')
    || !/^[A-Za-z0-9][A-Za-z0-9_.-]*$/.test(container)
    || !Number.isSafeInteger(maxOutputBytes) || maxOutputBytes < 1) throw new RecoveryTransportError(false)
  const lifetime = new AbortController(), pending = new Set()
  let unknown = false, closed = false
  const cancel = () => lifetime.abort(new RecoveryTransportError(pending.size > 0))
  const timer = setTimeout(cancel, Math.max(1, Math.ceil(deadlineAtMs - performance.now())))
  timer.unref()
  signal.addEventListener('abort', cancel, { once: true })
  if (signal.aborted) cancel()
  const allowed = (method, route) => method === 'POST' && route === '/containers/' + container + '/exec'
    || method === 'POST' && /^\/exec\/[a-f0-9]{64}\/start$/.test(route)
    || method === 'GET' && /^\/exec\/[a-f0-9]{64}\/json$/.test(route)
  const run = start => {
    if (closed || unknown || lifetime.signal.aborted || performance.now() >= deadlineAtMs) {
      return Promise.reject(new RecoveryTransportError(unknown))
    }
    const result = Promise.withResolvers(), settled = Promise.withResolvers()
    pending.add(settled.promise)
    let terminal = false, stop = () => {}, value, failure
    const abort = () => {
      if (terminal) return
      unknown = true
      stop()
      result.reject(new RecoveryTransportError(true))
    }
    const finish = () => {
      if (terminal) return
      terminal = true
      lifetime.signal.removeEventListener('abort', abort)
      pending.delete(settled.promise)
      settled.resolve()
      if (failure !== undefined || lifetime.signal.aborted || performance.now() >= deadlineAtMs) {
        unknown = true
        result.reject(new RecoveryTransportError(true))
      } else result.resolve(value)
    }
    lifetime.signal.addEventListener('abort', abort, { once: true })
    try {
      stop = start({ result: output => { value = output }, fail: () => { failure = true }, finish })
      if (lifetime.signal.aborted) abort()
    } catch (_error) {
      failure = true
      finish()
    }
    return result.promise
  }
  const request = (method, route, payload) => {
    if (!allowed(method, route)) return Promise.reject(new RecoveryTransportError(false))
    return run(owner => {
      const body = payload === undefined ? undefined : JSON.stringify(payload)
      if (body !== undefined && Buffer.byteLength(body) > maxOutputBytes) throw new RecoveryTransportError(false)
      let response, socket, requestClosed = false, responseClosed = true, socketClosed = true, complete = false
      const chunks = []
      let bytes = 0
      const finish = () => { if (requestClosed && responseClosed && socketClosed) { if (!complete) owner.fail(); owner.finish() } }
      const req = httpRequest({ socketPath, method, path: route, agent: false, maxHeaderSize: maxOutputBytes,
        headers: body === undefined ? {} : { 'Content-Type': 'application/json', 'Content-Length': Buffer.byteLength(body) } }, incoming => {
        response = incoming; responseClosed = false
        bytes = Buffer.byteLength(`HTTP/${incoming.httpVersion} ${incoming.statusCode} ${incoming.statusMessage}\r\n`)
          + incoming.rawHeaders.reduce((total, value) => total + Buffer.byteLength(value) + 2, 2)
        if (bytes > maxOutputBytes) { owner.fail(); req.destroy(); incoming.destroy() }
        incoming.on('data', chunk => {
          bytes += chunk.length
          if (bytes > maxOutputBytes) { owner.fail(); req.destroy(); incoming.destroy() }
          else chunks.push(chunk)
        })
        incoming.on('error', () => owner.fail())
        incoming.once('end', () => {
          if (!incoming.complete || incoming.statusCode < 200 || incoming.statusCode >= 300) { owner.fail(); return }
          try { const raw = Buffer.concat(chunks).toString('utf8'); owner.result(raw ? JSON.parse(raw) : null); complete = true }
          catch (_error) { owner.fail() }
        })
        incoming.once('close', () => { responseClosed = true; finish() })
      })
      req.once('socket', current => { socket = current; socketClosed = false; current.once('close', () => { socketClosed = true; finish() }) })
      req.on('error', () => owner.fail())
      req.once('close', () => { requestClosed = true; finish() })
      req.end(body)
      return () => { req.destroy(); response?.destroy(); socket?.destroy() }
    })
  }
  return {
    runDocker: (argv, { input } = {}) => {
      if (!Array.isArray(argv) || argv.slice(0, 5).join('\0') !== ['exec', '--interactive', '--user', '0', container].join('\0')
        || argv.some(value => typeof value !== 'string' || value.includes('\0'))
        || input !== undefined && (typeof input !== 'string' || Buffer.byteLength(input) > maxOutputBytes)) {
        return Promise.reject(new RecoveryTransportError(false))
      }
      return run(owner => {
        const child = spawn(dockerPath, argv, { stdio: ['pipe', 'pipe', 'pipe'] }), chunks = []
        let bytes = 0, stopping = false
        const stop = () => { if (!stopping) { stopping = true; child.kill('SIGTERM') } }
        child.stdout.on('data', chunk => {
          bytes += chunk.length
          if (bytes > maxOutputBytes) { owner.fail(); stop() }
          else chunks.push(chunk)
        })
        child.stderr.on('data', chunk => { bytes += chunk.length; if (bytes > maxOutputBytes) { owner.fail(); stop() } })
        child.stdout.on('error', () => owner.fail())
        child.stderr.on('error', () => owner.fail())
        child.stdin.on('error', () => owner.fail())
        child.on('error', () => owner.fail())
        child.once('close', (code, exitSignal) => {
          if (code !== 0 || exitSignal !== null) owner.fail()
          owner.result(Buffer.concat(chunks).toString('utf8')); owner.finish()
        })
        child.stdin.end(input)
        return stop
      })
    },
    request,
    inspectExec: async id => {
      if (!/^[a-f0-9]{64}$/.test(id)) throw new RecoveryTransportError(false)
      const value = await request('GET', '/exec/' + id + '/json')
      if (value?.ID !== id || typeof value.Running !== 'boolean' || !Number.isInteger(value.Pid) || value.Pid < 0
        || value.ExitCode !== null && !Number.isInteger(value.ExitCode)) {
        unknown = true
        throw new RecoveryTransportError(true)
      }
      return { execId: value.ID, running: value.Running, exitCode: value.ExitCode, hostPid: value.Pid }
    },
    state: () => ({ unknown, pendingCalls: pending.size, closed }),
    async close() {
      closed = true; cancel(); clearTimeout(timer); signal.removeEventListener('abort', cancel)
      await Promise.all([...pending])
    },
  }
}
