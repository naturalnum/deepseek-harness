/** Authenticated, bounded HTTP protocol for one isolated Connector Runner. */
import { createServer, type IncomingMessage, type Server, type ServerResponse } from 'node:http'
import { randomUUID, timingSafeEqual } from 'node:crypto'
import { EgressGate } from './egress.ts'
import { CallValidationError, MAX_CALL_BODY_BYTES, destinationKey, parseCallInput, validCallDigest,
  type CallInput, type CallResult } from './protocol.ts'
import { SshFailure, type SshTransport } from './transport.ts'
import { StdioFailure, StdioMcpTransport } from './stdio.ts'

type CallState = 'running' | 'succeeded' | 'failed'
interface CallRecord {
  readonly callId: string
  readonly digest: string
  state: CallState
  result?: CallResult
  errorCode?: string
  effectMayHaveOccurred?: boolean
}

export interface RunnerOptions {
  readonly token: string
  readonly allowlist: ReadonlySet<string>
  readonly egress: EgressGate
  readonly transport: SshTransport
  readonly stdioTransport?: StdioMcpTransport
  readonly instanceId?: string
  readonly maxConcurrent?: number
  readonly maxStored?: number
}

export interface ConnectorRunner {
  readonly instanceId: string
  readonly server: Server
  close(): Promise<void>
}

const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[1-8][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/iu

function send(response: ServerResponse, status: number, value: unknown): void {
  const body = JSON.stringify(value)
  response.writeHead(status, { 'content-type': 'application/json', 'content-length': Buffer.byteLength(body),
    'cache-control': 'no-store', 'x-content-type-options': 'nosniff' })
  response.end(body)
}

function authorized(request: IncomingMessage, token: string): boolean {
  const given = request.headers['x-power-evolve-runner-token']
  if (typeof given !== 'string') return false
  const actual = Buffer.from(given), expected = Buffer.from(token)
  return actual.length === expected.length && timingSafeEqual(actual, expected)
}

async function body(request: IncomingMessage): Promise<unknown> {
  if (!/^application\/json(?:;\s*charset=utf-8)?$/iu.test(request.headers['content-type'] ?? '')) {
    throw new CallValidationError('invalid_content_type')
  }
  if (Number(request.headers['content-length'] ?? 0) > MAX_CALL_BODY_BYTES) {
    throw new CallValidationError('request_too_large')
  }
  const chunks: Buffer[] = []
  let length = 0
  for await (const chunk of request) {
    length += chunk.length
    if (length > MAX_CALL_BODY_BYTES) throw new CallValidationError('request_too_large')
    chunks.push(chunk)
  }
  try { return JSON.parse(Buffer.concat(chunks).toString('utf8')) as unknown }
  catch (_invalidJson) { throw new CallValidationError('invalid_json') }
}

/** Create one Runner instance; the platform must compare instanceId and Pod UID on recovery. */
export function createConnectorRunner(options: RunnerOptions): ConnectorRunner {
  if (!options.token || Buffer.byteLength(options.token) < 32 || Buffer.byteLength(options.token) > 256) {
    throw new TypeError('Connector Runner control token length is invalid')
  }
  const instanceId = options.instanceId ?? randomUUID()
  if (!UUID.test(instanceId)) throw new TypeError('Connector Runner instance ID is invalid')
  const records = new Map<string, CallRecord>()
  const active = new Set<Promise<void>>()
  const controllers = new Set<AbortController>()
  const maxConcurrent = options.maxConcurrent ?? 1
  const maxStored = options.maxStored ?? 1
  if (!Number.isSafeInteger(maxConcurrent) || maxConcurrent < 1 || maxConcurrent > 8
    || !Number.isSafeInteger(maxStored) || maxStored < maxConcurrent || maxStored > 1024) {
    throw new TypeError('Connector Runner capacity is invalid')
  }
  let closing = false
  let closingWork: Promise<void> | undefined
  const view = (record: CallRecord) => ({ callId: record.callId, instanceId, digest: record.digest,
    state: record.state, ...(record.result === undefined ? {} : { result: record.result }),
    ...(record.errorCode === undefined ? {} : { errorCode: record.errorCode }),
    ...(record.effectMayHaveOccurred === undefined ? {} : { effectMayHaveOccurred: record.effectMayHaveOccurred }) })
  const run = (record: CallRecord, input: CallInput): void => {
    const controller = new AbortController()
    controllers.add(controller)
    const call = input.kind === 'mcp.stdio.whoami'
      ? (options.stdioTransport ?? new StdioMcpTransport()).call(input, controller.signal)
      : Promise.resolve().then(() => options.transport.call(input, controller.signal))
    const work = call.then(result => {
      record.state = 'succeeded'; record.result = result
    }, error => {
      record.state = 'failed'
      record.errorCode = error instanceof SshFailure || error instanceof StdioFailure ? error.code
        : input.kind === 'mcp.stdio.whoami' ? 'mcp_process_failed' : 'ssh_network_error'
      if (input.kind !== 'mcp.stdio.whoami') {
        record.effectMayHaveOccurred = error instanceof SshFailure ? error.effectMayHaveOccurred
          : input.kind === 'ssh.execute'
      }
    }).finally(() => { controllers.delete(controller); active.delete(work) })
    active.add(work)
  }
  const server = createServer(async (request, response) => {
    if (!authorized(request, options.token)) { send(response, 401, { error: 'unauthorized' }); return }
    try {
      const path = new URL(request.url ?? '/', 'http://runner').pathname
      if (request.method === 'GET' && path === '/health') {
        send(response, options.egress.ready && !closing ? 200 : 503,
          { ready: options.egress.ready && !closing, instanceId })
        return
      }
      const match = /^\/calls\/([0-9a-f-]{36})$/iu.exec(path)
      if (request.method === 'GET' && match) {
        const record = UUID.test(match[1]!) ? records.get(match[1]!) : undefined
        send(response, record ? 200 : 404, record ? view(record) : { error: 'call_not_found', instanceId })
        return
      }
      if (request.method === 'POST' && path === '/calls') {
        if (!options.egress.ready || closing) { send(response, 503, { error: 'egress_not_ready', instanceId }); return }
        const input = parseCallInput(await body(request))
        if (input.instanceId !== instanceId) { send(response, 409, { error: 'instance_changed', instanceId }); return }
        if (!validCallDigest(input, options.token)) { send(response, 400, { error: 'invalid_digest' }); return }
        const prior = records.get(input.callId)
        if (prior) {
          send(response, prior.digest === input.digest ? 200 : 409,
            prior.digest === input.digest ? view(prior) : { error: 'call_id_conflict', instanceId })
          return
        }
        if (input.kind !== 'mcp.stdio.whoami'
          && !options.allowlist.has(destinationKey(input.destination.host, input.destination.port))) {
          send(response, 403, { error: 'destination_denied', instanceId }); return
        }
        if (active.size >= maxConcurrent || records.size >= maxStored) {
          send(response, 429, { error: 'runner_capacity', instanceId }); return
        }
        const record: CallRecord = { callId: input.callId, digest: input.digest, state: 'running' }
        records.set(input.callId, record)
        run(record, input)
        send(response, 202, view(record))
        return
      }
      send(response, 404, { error: 'not_found', instanceId })
    } catch (error) {
      const code = error instanceof CallValidationError ? error.code : 'invalid_request'
      send(response, code === 'request_too_large' ? 413 : 400, { error: code, instanceId })
    }
  })
  options.egress.start()
  return {
    instanceId, server,
    async close() {
      closingWork ??= (async () => {
        closing = true
        await options.egress.close()
        for (const controller of controllers) controller.abort()
        server.closeAllConnections()
        await Promise.allSettled(active)
        await new Promise<void>((resolve, reject) => server.close(error => error ? reject(error) : resolve()))
      })()
      await closingWork
    },
  }
}
