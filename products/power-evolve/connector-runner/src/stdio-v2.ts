/** Disposable STDIO SDK provider for isolated executors; approval and writer ownership remain outside this module. */
import { spawn, type ChildProcessWithoutNullStreams } from 'node:child_process'
import { isAbsolute } from 'node:path'
import { performance } from 'node:perf_hooks'
import { TextDecoder } from 'node:util'
import { Client, parseJSONRPCMessage, serializeMessage, SdkError, SdkErrorCode, SUPPORTED_PROTOCOL_VERSIONS,
  type JSONRPCMessage, type Transport } from '@modelcontextprotocol/client'

/** Complete JSON values, including escaped NUL in descriptors, arguments and results. */
export type StdioV2Json = null | boolean | number | string | StdioV2Json[] | StdioV2Object
/** Original JSON object fields; extension metadata is never flattened. */
export interface StdioV2Object { [key: string]: StdioV2Json }
/** Original tool descriptor; the supplied catalog validator owns complete schema validation. */
export type StdioV2Tool = StdioV2Object & { name: string; inputSchema: StdioV2Object }
/** Literal invocation already selected by the executor; starting it may have effects before any tool call. */
export type StdioV2Input = {
  program: string; argv: readonly string[]; cwd: string
} & ({ phase: 'discover' } | { phase: 'call'; catalogExpectation: readonly StdioV2Tool[];
  rawName: string; arguments: StdioV2Object })
/** Deployment budgets; cleanup waits apply independently of an aborted operation. */
export interface StdioV2Limits {
  runtimeMs: number; requestMs: number
  stdinGraceMs: number; terminateGraceMs: number; killGraceMs: number
  maxInputBytes: number; maxMessageBytes: number; maxProtocolBytes: number; maxProtocolMessages: number
  maxJsonDepth: number; maxJsonNodes: number; maxPages: number; maxTools: number
  maxCatalogBytes: number; maxToolBytes: number; maxResultBytes: number; maxStderrBytes: number
}
/** Executor-owned environment and Root's validator/fingerprint; no parent environment is inherited. */
export interface StdioV2Options {
  env: { HOME: string; PATH: string; LANG: string }
  limits: StdioV2Limits
  /** Validate the entire raw directory and compute the shared frozen catalog digest without mutation.
   * @param tools Complete original descriptors, including schemas and extension fields.
   * @returns The lowercase SHA-256 digest under the outer owner's fixed shared domain.
   */
  fingerprintCatalog: (tools: readonly StdioV2Tool[]) => string
}
/** Direct-child observations only; container, UID descendants and writer release require outer stop evidence. */
export interface StdioV2Facts {
  programStartAttempted: boolean; toolsCallAttempted: boolean; effectMayHaveOccurred: boolean
  childPid: number | null; childExitObserved: boolean; childCloseObserved: boolean
  exitCode: number | null; signal: NodeJS.Signals | null; cleanupConfirmed: boolean
  protocolBytes: number; protocolMessages: number; stderrBytes: number; stderr: string
}
/** Completed RPC results preserve isError; the outer action owner decides the tool outcome. */
export type StdioV2Outcome = ({ state: 'completed'; phase: 'discover'; catalog: StdioV2Tool[];
  pages: StdioV2Object[]; initializeResult: StdioV2Object }
  | { state: 'completed'; phase: 'call'; catalog: StdioV2Tool[]; pages: StdioV2Object[];
    initializeResult: StdioV2Object; result: StdioV2Object }
  | { state: 'failed'; errorCode: string; result?: StdioV2Object }) & { facts: StdioV2Facts }

class Failure extends Error {
  constructor(readonly code: string) { super(code) }
}

function json(value: unknown, limits: StdioV2Limits): asserts value is StdioV2Json {
  const pending: Array<{ value: unknown; depth: number }> = [{ value, depth: 0 }]
  let nodes = 0
  while (pending.length) {
    const next = pending.pop()!
    if (++nodes > limits.maxJsonNodes || next.depth > limits.maxJsonDepth) throw new Failure('json_limit')
    const item = next.value
    if (item === null || typeof item === 'string' || typeof item === 'boolean') continue
    if (typeof item === 'number' && Number.isFinite(item)) continue
    if (!item || typeof item !== 'object' || !Array.isArray(item) && Object.getPrototypeOf(item) !== Object.prototype) {
      throw new Failure('json_invalid')
    }
    for (const child of Object.values(item)) pending.push({ value: child, depth: next.depth + 1 })
  }
}

function object(value: unknown, limits: StdioV2Limits): StdioV2Object {
  json(value, limits)
  if (value === null || typeof value !== 'object' || Array.isArray(value)) throw new Failure('json_object_invalid')
  return value
}

function bytes(value: unknown, limits: StdioV2Limits, maximum: number, code: string): number {
  json(value, limits)
  const size = Buffer.byteLength(JSON.stringify(value), 'utf8')
  if (size > maximum) throw new Failure(code)
  return size
}

function tool(value: unknown, limits: StdioV2Limits): StdioV2Tool {
  const raw = object(value, limits)
  if (typeof raw.name !== 'string' || !raw.name) throw new Failure('catalog_invalid')
  object(raw.inputSchema, limits)
  bytes(raw, limits, limits.maxToolBytes, 'tool_limit')
  return raw as StdioV2Tool
}

const budgetFields: ReadonlyArray<keyof StdioV2Limits> = ['runtimeMs', 'requestMs', 'stdinGraceMs',
  'terminateGraceMs', 'killGraceMs', 'maxInputBytes', 'maxMessageBytes', 'maxProtocolBytes',
  'maxProtocolMessages', 'maxJsonDepth', 'maxJsonNodes', 'maxPages', 'maxTools', 'maxCatalogBytes',
  'maxToolBytes', 'maxResultBytes', 'maxStderrBytes']

function validate(input: StdioV2Input, options: StdioV2Options): void {
  if (Object.keys(options.limits).length !== budgetFields.length
    || budgetFields.some(name => !Object.hasOwn(options.limits, name))) throw new Failure('configuration_invalid')
  for (const [name, value] of Object.entries(options.limits)) {
    if (!Number.isSafeInteger(value) || value < (name === 'stdinGraceMs' || name === 'terminateGraceMs' ? 0 : 1)
      || name.endsWith('Ms') && value > 2_147_483_647) throw new Failure('configuration_invalid')
  }
  if (Object.keys(options.env).sort().join(',') !== 'HOME,LANG,PATH'
    || Object.values(options.env).some(value => !value || value.includes('\u0000'))
    || input.phase !== 'discover' && input.phase !== 'call'
    || !input.program || input.program.includes('\u0000') || !isAbsolute(input.cwd)
    || input.cwd.includes('\u0000') || input.argv.some(value => value.includes('\u0000'))) throw new Failure('invocation_invalid')
  bytes({ input, env: options.env }, options.limits, options.limits.maxInputBytes, 'input_limit')
  if (input.phase === 'call') {
    if (!input.rawName) throw new Failure('tool_unavailable')
    object(input.arguments, options.limits)
  }
}

function fingerprint(tools: readonly StdioV2Tool[], options: StdioV2Options): string {
  try { return options.fingerprintCatalog(tools) }
  catch (_catalogRejected) { throw new Failure('catalog_invalid') }
}

function emptyFacts(): StdioV2Facts {
  return { programStartAttempted: false, toolsCallAttempted: false, effectMayHaveOccurred: false,
    childPid: null, childExitObserved: false, childCloseObserved: false, exitCode: null, signal: null,
    cleanupConfirmed: false, protocolBytes: 0, protocolMessages: 0, stderrBytes: 0, stderr: '' }
}

class ChildTransport implements Transport {
  onclose?: () => void
  onerror?: (error: Error) => void
  onmessage?: (message: JSONRPCMessage) => void
  readonly facts = emptyFacts()
  private child?: ChildProcessWithoutNullStreams
  private buffer = Buffer.alloc(0)
  private stderr: Buffer[] = []
  private closing?: Promise<void>
  private closingStarted = false
  private notifiedClose = false
  private closed: Promise<void>
  private resolveClosed!: () => void
  private requests = new Map<string | number, string>()
  private reply: { method: string; result: StdioV2Object } | undefined

  constructor(private readonly input: StdioV2Input, private readonly options: StdioV2Options,
    private readonly fail: (code: string) => void) {
    this.closed = new Promise(resolve => { this.resolveClosed = resolve })
  }

  async start(): Promise<void> {
    if (this.facts.programStartAttempted || this.closingStarted) throw new Failure('restart_denied')
    this.facts.programStartAttempted = true
    this.facts.effectMayHaveOccurred = true
    // SDK's stock STDIO transport merges ambient variables and skips malformed JSON lines.
    // This public Transport adapter owns raw-byte budgets and direct-child termination only.
    const child = spawn(this.input.program, [...this.input.argv], {
      cwd: this.input.cwd, env: { ...this.options.env }, shell: false, stdio: 'pipe', detached: false,
    })
    this.child = child
    child.once('exit', (code, signal) => {
      this.facts.childExitObserved = true; this.facts.exitCode = code; this.facts.signal = signal
    })
    child.once('close', () => {
      this.facts.childCloseObserved = true
      this.resolveClosed()
      this.notifyClose()
    })
    child.on('error', () => { this.fail('process_failed') })
    child.stdin.on('error', () => { if (!this.closingStarted) this.fail('process_failed') })
    child.stdout.on('error', () => { this.fail('protocol_failed') })
    child.stderr.on('error', () => { this.fail('stderr_failed') })
    child.stdout.on('data', (chunk: Buffer) => this.read(chunk))
    child.stdout.on('end', () => { if (this.buffer.length) this.fail('protocol_invalid') })
    child.stderr.on('data', (chunk: Buffer) => {
      this.facts.stderrBytes += chunk.length
      if (this.facts.stderrBytes > this.options.limits.maxStderrBytes) this.fail('stderr_limit')
      else this.stderr.push(chunk)
    })
    await new Promise<void>((resolve, reject) => {
      child.once('spawn', () => { this.facts.childPid = child.pid ?? null; resolve() })
      child.once('error', reject)
    })
  }

  private count(size: number, message = false): void {
    this.facts.protocolBytes += size
    if (this.facts.protocolBytes > this.options.limits.maxProtocolBytes) throw new Failure('protocol_bytes_limit')
    if (message && ++this.facts.protocolMessages > this.options.limits.maxProtocolMessages) throw new Failure('protocol_messages_limit')
  }

  private read(chunk: Buffer): void {
    try {
      this.count(chunk.length)
      this.buffer = Buffer.concat([this.buffer, chunk])
      while (true) {
        const end = this.buffer.indexOf(10)
        const size = end < 0 ? this.buffer.length : end
        if (size > this.options.limits.maxMessageBytes) throw new Failure('protocol_message_limit')
        if (end < 0) return
        const line = this.buffer.subarray(0, end)
        this.buffer = this.buffer.subarray(end + 1)
        this.count(0, true)
        const raw = object(JSON.parse(new TextDecoder('utf-8', { fatal: true }).decode(line)), this.options.limits)
        const message = parseJSONRPCMessage(raw)
        if ((typeof raw.id === 'string' || typeof raw.id === 'number') && raw.result !== undefined) {
          const method = this.requests.get(raw.id)
          if (method) {
            if (method === 'initialize' && (typeof raw.result !== 'object' || raw.result === null
              || Array.isArray(raw.result) || typeof raw.result.protocolVersion !== 'string'
              || !SUPPORTED_PROTOCOL_VERSIONS.includes(raw.result.protocolVersion))) throw new Failure('protocol_unsupported')
            this.requests.delete(raw.id)
            this.reply = { method, result: object(raw.result, this.options.limits) }
          }
        }
        this.onmessage?.(message)
      }
    } catch (error) { this.fail(error instanceof Failure ? error.code : 'protocol_invalid') }
  }

  takeReply(method: string): StdioV2Object {
    if (!this.reply || this.reply.method !== method) throw new Failure('reply_missing')
    const result = this.reply.result
    this.reply = undefined
    return result
  }

  async send(message: JSONRPCMessage): Promise<void> {
    try {
      if (this.closingStarted || !this.child) throw new Failure('transport_closed')
      const data = Buffer.from(serializeMessage(message), 'utf8')
      if (data.length - 1 > this.options.limits.maxMessageBytes) throw new Failure('protocol_message_limit')
      this.count(data.length, true)
      if ('method' in message && 'id' in message && message.id !== undefined) {
        this.requests.set(message.id, message.method)
        if (message.method === 'tools/call') {
          if (this.facts.toolsCallAttempted) throw new Failure('call_replay_denied')
          this.facts.toolsCallAttempted = true
        }
      }
      await new Promise<void>((resolve, reject) => {
        this.child!.stdin.write(data, error => { if (error) reject(error); else resolve() })
      })
    } catch (error) {
      this.fail(error instanceof Failure ? error.code : 'process_failed')
      throw error
    }
  }

  close(): Promise<void> {
    if (!this.closing) {
      this.closingStarted = true
      this.closing = Promise.resolve().then(() => this.dispose())
    }
    return this.closing
  }

  private notifyClose(): void {
    if (!this.notifiedClose) {
      this.notifiedClose = true
      try { this.onclose?.() }
      catch (_callbackFailed) { this.fail('protocol_failed') }
    }
  }

  private async wait(ms: number): Promise<boolean> {
    if (this.facts.childCloseObserved) return true
    if (ms === 0) return false
    let timer: ReturnType<typeof setTimeout> | undefined
    try {
      await Promise.race([this.closed, new Promise<void>(resolve => { timer = setTimeout(resolve, ms) })])
      return this.facts.childCloseObserved
    } finally { clearTimeout(timer) }
  }

  private async dispose(): Promise<void> {
    this.notifyClose()
    const child = this.child
    if (!child) { this.facts.cleanupConfirmed = true; return }
    try { child.stdin.end() }
    catch (_stdinUnavailable) { /* Signals and actual close still determine cleanup. */ }
    if (!await this.wait(this.options.limits.stdinGraceMs)) {
      if (!this.facts.childExitObserved) {
        try { child.kill('SIGTERM') }
        catch (_termUnconfirmed) { /* Wait for the owned child's actual close. */ }
      }
      if (!await this.wait(this.options.limits.terminateGraceMs)) {
        if (!this.facts.childExitObserved) {
          try { child.kill('SIGKILL') }
          catch (_killUnconfirmed) { /* Missing close retains unconfirmed cleanup. */ }
        }
        await this.wait(this.options.limits.killGraceMs)
      }
    }
    this.facts.cleanupConfirmed = this.facts.childCloseObserved
    this.facts.stderr = Buffer.concat(this.stderr).toString('utf8')
  }
}

/** Start one literal program, initialize once, read every tool page and optionally issue one tools/call.
 * @param input Original invocation and, for calls, the frozen full raw directory and arguments.
 * @param options Trusted environment, every deployment budget and Root's complete catalog validator/digest.
 * @param signal Caller cancellation; cleanup still waits its independent configured deadlines.
 * @returns Complete raw JSON or a redacted failure with direct-child cleanup facts; never writer-release authority.
 */
export async function runStdioV2(input: StdioV2Input, options: StdioV2Options, signal: AbortSignal): Promise<StdioV2Outcome> {
  const stopped = new AbortController()
  let failure: string | undefined, result: StdioV2Object | undefined
  const fail = (code: string) => { failure ??= code; stopped.abort() }
  let transport: ChildTransport | undefined
  const client = new Client({ name: 'power-evolve-stdio-v2', version: '0.1.0' }, {
    capabilities: {}, versionNegotiation: { mode: 'legacy' }, supportedProtocolVersions: [...SUPPORTED_PROTOCOL_VERSIONS],
  })
  client.onerror = () => { if (!stopped.signal.aborted) fail('protocol_failed') }
  const onAbort = () => { fail('aborted') }
  signal.addEventListener('abort', onAbort, { once: true })
  let timer: ReturnType<typeof setTimeout> | undefined
  let completed: Extract<StdioV2Outcome, { state: 'completed' }> | undefined
  try {
    validate(input, options)
    // Snapshot the approved values for this invocation before yielding to child startup or RPC.
    input = structuredClone(input)
    options = { ...options, env: { ...options.env }, limits: { ...options.limits } }
    transport = new ChildTransport(input, options, fail)
    if (signal.aborted) throw new Failure('aborted')
    const deadline = performance.now() + options.limits.runtimeMs
    const check = () => {
      if (performance.now() >= deadline) fail('runtime_timeout')
      if (stopped.signal.aborted) throw new Failure(failure ?? 'aborted')
    }
    timer = setTimeout(() => fail('runtime_timeout'), options.limits.runtimeMs)
    const request = { signal: stopped.signal, timeout: options.limits.requestMs, resetTimeoutOnProgress: false }
    let expected: string | undefined
    if (input.phase === 'call') {
      if (input.catalogExpectation.length > options.limits.maxTools) throw new Failure('tools_limit')
      input.catalogExpectation.forEach(value => tool(value, options.limits))
      bytes(input.catalogExpectation, options.limits, options.limits.maxCatalogBytes, 'catalog_limit')
      expected = fingerprint(input.catalogExpectation, options)
      if (!/^[a-f0-9]{64}$/u.test(expected)) throw new Failure('catalog_invalid')
    }
    check()
    await client.connect(transport, request)
    const initializeResult = transport.takeReply('initialize')
    const catalog: StdioV2Tool[] = [], pages: StdioV2Object[] = [], cursors = new Set<string>()
    let cursor: string | undefined
    do {
      if (pages.length >= options.limits.maxPages) throw new Failure('pages_limit')
      check()
      await client.request({ method: 'tools/list', params: cursor === undefined ? {} : { cursor } }, request)
      const page = transport.takeReply('tools/list')
      if (!Array.isArray(page.tools)) throw new Failure('catalog_invalid')
      catalog.push(...page.tools.map(value => tool(value, options.limits)))
      if (catalog.length > options.limits.maxTools) throw new Failure('tools_limit')
      bytes(catalog, options.limits, options.limits.maxCatalogBytes, 'catalog_limit')
      pages.push(page)
      bytes(pages, options.limits, options.limits.maxCatalogBytes, 'catalog_limit')
      if (page.nextCursor !== undefined && typeof page.nextCursor !== 'string') throw new Failure('cursor_invalid')
      cursor = page.nextCursor
      if (cursor !== undefined && (!cursor || cursors.has(cursor))) throw new Failure('cursor_repeated')
      if (cursor !== undefined) cursors.add(cursor)
    } while (cursor !== undefined)
    if (new Set(catalog.map(item => item.name)).size !== catalog.length) throw new Failure('tool_duplicate')
    const actualFingerprint = fingerprint(catalog, options)
    if (!/^[a-f0-9]{64}$/u.test(actualFingerprint)) throw new Failure('catalog_invalid')
    check()
    if (input.phase === 'call') {
      if (actualFingerprint !== expected) throw new Failure('catalog_changed')
      const rawName = input.rawName
      if (!catalog.some(item => item.name === rawName)) throw new Failure('tool_unavailable')
      await client.request({ method: 'tools/call', params: { name: input.rawName, arguments: input.arguments } }, request)
      result = transport.takeReply('tools/call')
      bytes(result, options.limits, options.limits.maxResultBytes, 'result_limit')
      check()
      completed = { state: 'completed', phase: 'call', catalog, pages, initializeResult, result, facts: transport.facts }
    } else completed = { state: 'completed', phase: 'discover', catalog, pages, initializeResult, facts: transport.facts }
  } catch (error) {
    fail(error instanceof Failure ? error.code : error instanceof SdkError && error.code === SdkErrorCode.RequestTimeout
      ? 'request_timeout' : 'protocol_failed')
  } finally {
    clearTimeout(timer)
    signal.removeEventListener('abort', onAbort)
    try { await client.close() }
    catch (_closeFailed) { fail('cleanup_unconfirmed') }
    // A failed connect may already have detached the SDK transport; disposal remains owned here.
    try { await transport?.close() }
    catch (_closeFailed) { fail('cleanup_unconfirmed') }
  }
  const facts = transport ? { ...transport.facts } : { ...emptyFacts(), cleanupConfirmed: true }
  if (!facts.cleanupConfirmed) failure ??= 'cleanup_unconfirmed'
  if (failure || !completed) return { state: 'failed', errorCode: failure ?? 'protocol_failed',
    ...(result && Buffer.byteLength(JSON.stringify(result)) <= options.limits.maxResultBytes ? { result } : {}), facts }
  return { ...completed, facts }
}
