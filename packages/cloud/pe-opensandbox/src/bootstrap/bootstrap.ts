/** Root-private fixed SDK bootstrap. A stopped allocation never gains another privileged start. */
import { AsyncLocalStorage } from 'node:async_hooks'
import { createHash, randomBytes } from 'node:crypto'
import { open } from 'node:fs/promises'
import { constants } from 'node:fs'
import { join } from 'node:path'
import { ConnectionConfig, createDefaultAdapterFactory, type AdapterFactory, type Endpoint } from '@alibaba-group/opensandbox'
import { BOOTSTRAP_PINS } from './payload-pins.ts'
import { SOURCE_DIGEST, SOURCES } from './asset-manifest.ts'
import { RootAgentProxyTransport } from './agent-proxy.ts'
import { createOwnedSdkTransport, type OwnedTransportLimits } from '../sdk-transport.ts'
import type { AgentSelection, OwnedSdkTransport, SdkLifecycleConfig } from '../lifecycle-types.ts'
import type { AgentDataClient, ClientOptions, RootGrant } from '../agent-data/types.ts'
import { DataClient } from '../agent-data/client-internal.ts'
import { AGENT_SOURCE_SHA256, BWRAP_SHA256, digest, expectedWorldHash } from '../agent-data/index.ts'
import { checkOptions } from '../agent-data/validate.ts'

const IMAGE = 'sha256:3a1883e6bd3272095de9407f33bcb0119dcc664e6cff2952cd0931caa8e0bf9f'

/** Failure messages stay secret-free; only Root's private cause retains bounded tagged HTTP diagnostics. */
export class BootstrapFailure extends Error {
  /** @param code Stable private handling classification. @param cause Retained private cause, never account output. */
  constructor(readonly code: 'closed' | 'binding' | 'bounds' | 'wire-unknown' | 'command-unknown' | 'endpoint-unrepresentable', cause?: unknown) {
    super(`Trusted bootstrap ${code}; Root retains the original allocation.`, { cause })
  }
}
function need(value: boolean, code: ConstructorParameters<typeof BootstrapFailure>[0]): asserts value {
  if (!value) throw new BootstrapFailure(code)
}
const hash = (data: Uint8Array): string => createHash('sha256').update(data).digest('hex')
type ExecdStack = ReturnType<AdapterFactory['createExecdStack']>
async function pinnedFile(path: string, size: number, digest: string): Promise<Buffer> {
  const file = await open(path, constants.O_RDONLY | constants.O_NOFOLLOW)
  try {
    const info = await file.stat()
    need(info.isFile() && info.size === size && size <= 65536, 'binding')
    const data = Buffer.alloc(size + 1)
    let offset = 0
    while (offset < data.length) {
      const { bytesRead } = await file.read(data, offset, data.length - offset, offset)
      if (!bytesRead) break
      offset += bytesRead
    }
    need(offset === size && hash(data.subarray(0, offset)) === digest, 'binding')
    return data.subarray(0, offset)
  } finally { await file.close() }
}

/** Frozen nonsecret bytes loaded and verified before any per-allocation remote effect. */
export interface BootstrapPayload {
  readonly prep: string
  readonly loader: string
  readonly uploads: readonly Readonly<{ name: string; data: Uint8Array }>[]
}

/**
 * Verify fixed helper and agent bytes before per-allocation remote effects.
 * @param bootstrapDirectory This frozen helper directory.
 * @param agentDirectory Root-approved six-file source directory.
 * @returns Fixed, individually verified source bytes; configuration and tokens are never part of this payload.
 */
export async function loadBootstrapPayload(bootstrapDirectory: string, agentDirectory: string): Promise<BootstrapPayload> {
  const helpers = new Map<string, Buffer>()
  for (const [name, pin] of Object.entries(BOOTSTRAP_PINS)) {
    const data = await pinnedFile(join(bootstrapDirectory, name), pin.bytes, pin.sha256)
    helpers.set(name, data)
  }
  const uploads: { name: string; data: Uint8Array }[] = []
  for (const [name, pin] of Object.entries(SOURCES)) {
    const data = await pinnedFile(join(agentDirectory, name), pin[1], pin[0])
    uploads.push({ name, data })
  }
  const prep = helpers.get('prep.py'), loader = helpers.get('loader.py'), publisher = helpers.get('publisher.py')
  if (prep === undefined || loader === undefined || publisher === undefined) throw new BootstrapFailure('binding')
  uploads.push({ name: 'publisher.py', data: publisher })
  return { prep: prep.toString('utf8'), loader: loader.toString('utf8'), uploads }
}

/** Root-selected finite startup limits and original deployment lease assertion, never account configuration. */
export interface BootstrapConfig {
  readonly lifecycle: SdkLifecycleConfig
  readonly execdAccessToken: string
  readonly transport: OwnedTransportLimits
  readonly bootstrapTimeoutMs: number
  readonly requestTimeoutMs: number
  readonly commandTimeoutSeconds: number
  readonly maxRequestBytes: number
  readonly maxReplyBytes: number
  readonly maxAggregateBytes: number
  readonly maxEvents: number
  readonly maxRecords: number
  readonly agentPort: number
  assertDeploymentCurrent(): void
}
interface WireWork { readonly method: string; readonly url: string; requests: number }

/** Every request is one public SDK send on a dedicated no-retry dispatcher; close fences synchronously. */
class BootstrapConnection extends ConnectionConfig {
  private readonly context = new AsyncLocalStorage<WireWork>()
  private readonly pending = new Set<Promise<Response>>()
  private closing = false
  private closed?: Promise<void>
  private attempts = 0
  private bytes = 0
  private failure?: { cause: unknown }

  constructor(private readonly config: BootstrapConfig, private readonly transport: OwnedSdkTransport,
    private readonly deadline: number) {
    super({ domain: config.lifecycle.lifecycleBaseUrl, apiKey: config.lifecycle.apiKey,
      headers: { 'X-EXECD-ACCESS-TOKEN': config.execdAccessToken },
      useServerProxy: true, endpointCacheDisabled: true, disableMetrics: true, debug: false,
      requestTimeoutSeconds: config.requestTimeoutMs / 1000 })
  }
  override get fetch(): typeof globalThis.fetch {
    return (input, init) => {
      if (this.closing) return Promise.reject(new BootstrapFailure('closed'))
      const work = this.context.getStore()
      if (work === undefined) return Promise.reject(new BootstrapFailure('binding'))
      const deferred = Promise.withResolvers<Response>()
      const actual = deferred.promise
      this.pending.add(actual)
      void actual.then(() => this.pending.delete(actual), () => this.pending.delete(actual))
      void this.request(work, input, init).then(deferred.resolve, deferred.reject)
      return actual
    }
  }
  override get sseFetch(): typeof globalThis.fetch { return this.fetch }
  override get ownsTransport(): boolean { return true }
  private assertOpen(): void { if (this.closing) throw new BootstrapFailure('closed') }
  run<T>(method: string, url: string, run: () => Promise<T>): Promise<T> {
    if (this.closing) throw new BootstrapFailure('closed')
    return this.context.run({ method, url, requests: 0 }, run)
  }
  override closeTransport(): Promise<void> {
    this.closing = true
    return this.closed ??= (async () => {
      while (this.pending.size) await Promise.allSettled([...this.pending])
      await this.transport.close()
      if (this.failure !== undefined) throw new BootstrapFailure('wire-unknown', this.failure.cause)
    })()
  }
  private async request(work: WireWork, input: RequestInfo | URL, init?: RequestInit): Promise<Response> {
    const request = new Request(input, init)
    need(request.url === work.url && request.method === work.method && ++work.requests === 1
      && request.headers.get('OPEN-SANDBOX-API-KEY') === this.config.lifecycle.apiKey, 'binding')
    request.headers.set('OpenSandbox-Access-Renew', 'skip')
    need(++this.attempts <= 12, 'bounds')
    const body = request.body === null ? undefined : new Uint8Array(await request.clone().arrayBuffer())
    const size = body?.length ?? 0
    need(size <= this.config.maxRequestBytes, 'bounds')
    this.bytes += size
    need(this.bytes <= this.config.maxAggregateBytes, 'bounds')
    const remaining = Math.min(this.config.requestTimeoutMs, this.deadline - Date.now())
    need(remaining > 0, 'bounds')
    // Body serialization can yield. Recheck the synchronous fence immediately before the only dispatch.
    this.assertOpen()
    this.config.assertDeploymentCurrent()
    this.assertOpen()
    const controller = new AbortController()
    const timer = setTimeout(() => { controller.abort(new BootstrapFailure('bounds')) }, remaining)
    let dispatched = false
    try {
      dispatched = true
      const response = await this.transport.fetch(request, { signal: controller.signal, redirect: 'error' })
      need(!response.redirected && (!response.url || response.url === request.url), 'binding')
      const reader = response.body?.getReader(), chunks: Uint8Array[] = []
      let count = 0
      if (reader !== undefined) {
        try {
          while (true) {
            const chunk = await reader.read()
            if (chunk.done) break
            count += chunk.value.length; this.bytes += chunk.value.length
            need(count <= this.config.maxReplyBytes && this.bytes <= this.config.maxAggregateBytes, 'bounds')
            chunks.push(chunk.value)
          }
        } finally { try { await reader.cancel() } finally { reader.releaseLock() } }
      }
      controller.signal.throwIfAborted()
      need(Date.now() < this.deadline, 'bounds')
      const complete = Buffer.concat(chunks)
      if (response.status < 200 || response.status >= 300) {
        throw new BootstrapFailure('wire-unknown', Object.freeze({
          kind: 'root-bootstrap-http-response', statusCode: response.status,
          requestId: response.headers.get('x-request-id')?.slice(0, this.config.lifecycle.maxFieldBytes),
          bodyEncoding: 'base64', bodyBase64: complete.toString('base64'),
          bodyBytes: complete.length, bodyComplete: true,
        }))
      }
      return new Response(complete.length ? complete : null, { status: response.status, headers: response.headers })
    } catch (cause) {
      if (dispatched) this.failure ??= { cause }
      throw new BootstrapFailure('wire-unknown', cause)
    } finally { clearTimeout(timer); controller.abort() }
  }
}

interface RecordState {
  readonly selection: AgentSelection
  fenced: boolean
  actual?: Promise<ClientOptions>
  connection?: BootstrapConnection
  joined?: Promise<void>
  privilegedFailure?: { cause: unknown }
  closeActual?: Promise<void>
  protected?: Readonly<{ token: string; expected: ClientOptions['expected'] }>
  clientTaken?: boolean
}

/** Original physical allocation only: no list adoption, create, restart, user argv or account SDK access. */
export class TrustedSdkBootstrap {
  private readonly records = new Map<string, RecordState>()
  private readonly options = new WeakMap<ClientOptions, Readonly<{ record: RecordState; endpoint: URL; headers: Record<string, string> }>>()
  private readonly payload: BootstrapPayload
  /** @param config Root's fixed selected deployment. @param payload Verified helper and six-file source payload.
   * @param transportFactory Creates one exclusively owned real dispatcher per started allocation; tests transfer equivalent ownership.
   */
  constructor(private readonly config: BootstrapConfig, payload: BootstrapPayload,
    private readonly transportFactory: () => OwnedSdkTransport = () => createOwnedSdkTransport(config.transport)) {
    for (const n of [config.bootstrapTimeoutMs, config.requestTimeoutMs, config.commandTimeoutSeconds,
      config.maxRequestBytes, config.maxReplyBytes, config.maxAggregateBytes, config.maxEvents, config.maxRecords]) {
      need(Number.isSafeInteger(n) && n > 0 && n <= 2147483647, 'bounds')
    }
    need(config.requestTimeoutMs <= config.bootstrapTimeoutMs && config.commandTimeoutSeconds * 1000 < config.requestTimeoutMs
      && config.maxAggregateBytes >= config.maxRequestBytes && Number.isInteger(config.agentPort)
      && config.agentPort >= 1024 && config.agentPort <= 65535, 'bounds')
    new Headers({ 'X-EXECD-ACCESS-TOKEN': config.execdAccessToken })
    need(config.execdAccessToken.length > 0 && config.execdAccessToken.length <= 1024, 'bounds')
    const selected = config.lifecycle, url = new URL(selected.lifecycleBaseUrl)
    const sourceDigest = digest(Object.fromEntries(Object.entries(SOURCES).map(([name, pin]) => [name, pin[0]])))
    need(url.protocol === 'http:' && !url.username && !url.password && !url.search && !url.hash
      && selected.imageDigest === IMAGE
      && [selected.payloadSha256, AGENT_SOURCE_SHA256, SOURCE_DIGEST].every(pin => pin === sourceDigest)
      && JSON.stringify(selected.entrypoint) === JSON.stringify(['/usr/bin/tail', '-f', '/dev/null']), 'binding')
    need(hash(Buffer.from(payload.prep)) === BOOTSTRAP_PINS['prep.py'].sha256
      && hash(Buffer.from(payload.loader)) === BOOTSTRAP_PINS['loader.py'].sha256 && payload.uploads.length === 7, 'binding')
    this.payload = { prep: payload.prep, loader: payload.loader, uploads: payload.uploads.map(({ name, data }) => {
      const pin = name === 'publisher.py' ? BOOTSTRAP_PINS['publisher.py'] : undefined
      const source = Object.entries(SOURCES).find(([file]) => file === name)?.[1]
      need((pin !== undefined && data.length === pin.bytes && hash(data) === pin.sha256)
        || (source !== undefined && data.length === source[1] && hash(data) === source[0]), 'binding')
      return Object.freeze({ name, data: Uint8Array.from(data) })
    }) }
    need(new Set(this.payload.uploads.map(item => item.name)).size === 7, 'binding')
  }

  /**
   * Start the original allocation's fixed privileged sequence once.
   * @param selection Original intent and mount objects.
   * @param signal Observer cancellation checked between admitted steps.
   * @returns Sticky original protected endpoint/options; no failed or fenced allocation is replayed.
   */
  bootstrap(selection: AgentSelection, signal: AbortSignal): Promise<ClientOptions> {
    const record = this.record(selection)
    if (record.fenced) return Promise.reject(new BootstrapFailure('closed'))
    if (record.actual !== undefined) return record.actual
    const deferred = Promise.withResolvers<ClientOptions>()
    record.actual = deferred.promise
    void this.start(record, signal).then(deferred.resolve, deferred.reject)
    return record.actual
  }

  /** Pass this original callback as TrustedRuntimeRegistry's third constructor argument.
   * @param options The exact original protected object returned by this bootstrap, never copied or parsed JSON.
   * @returns One original agent client owning its separate ordinary proxy dispatcher; caller owns release/join.
   */
  createAgentDataClient = (options: ClientOptions): AgentDataClient => {
    const selected = this.options.get(options)
    if (selected === undefined) throw new BootstrapFailure('binding')
    const current = (): void => { need(!selected.record.fenced && !selected.record.clientTaken, 'binding') }
    current()
    this.config.assertDeploymentCurrent()
    current()
    selected.record.clientTaken = true
    return new DataClient(options, new RootAgentProxyTransport(selected.endpoint, selected.headers))
  }

  /**
   * Permanently fence privileged starts while retaining their original settlement.
   * @param selection Same original intent/mount, with wrapper identity allowed to differ.
   * @returns Synchronous permanent fence and actual privileged/dispatcher join; zero-work tombstones allocate no transport.
   */
  fence(selection: AgentSelection): { readonly whenJoined: Promise<void>; assertDeploymentCurrent(): void } {
    const record = this.record(selection)
    record.fenced = true
    const closed = record.connection?.closeTransport()
    record.joined ??= (async () => {
      const results = await Promise.allSettled([record.actual ?? Promise.resolve(), closed ?? Promise.resolve()])
      // A reentrant Root callback may fence while transport construction is still returning.
      try { await (record.closeActual ?? record.connection?.closeTransport()) }
      catch (cause) { throw new BootstrapFailure('wire-unknown', cause) }
      const closure = results[1]
      if (closure.status === 'rejected') throw new BootstrapFailure('wire-unknown', closure.reason)
      if (record.privilegedFailure !== undefined) throw new BootstrapFailure('command-unknown', record.privilegedFailure.cause)
    })()
    return Object.freeze({ whenJoined: record.joined,
      assertDeploymentCurrent: () => { this.config.assertDeploymentCurrent() } })
  }

  private record(selection: AgentSelection): RecordState {
    const original = this.records.get(selection.intent.allocationId)
    if (original !== undefined) {
      const s = original.selection
      need(selection.intent === s.intent && selection.mount === s.mount && selection.sandboxId === s.sandboxId
        && selection.deploymentIdentity === s.deploymentIdentity && selection.imageDigest === s.imageDigest
        && selection.payloadSha256 === s.payloadSha256, 'binding')
      return original
    }
    need(this.records.size < this.config.maxRecords, 'bounds')
    this.assertSelection(selection)
    const record: RecordState = { selection, fenced: false }
    this.records.set(selection.intent.allocationId, record)
    return record
  }
  private assertSelection(selection: AgentSelection): void {
    const selected = this.config.lifecycle
    need(selection.deploymentIdentity === selected.deploymentIdentity && selection.imageDigest === selected.imageDigest
      && selection.payloadSha256 === selected.payloadSha256 && selection.sandboxId.length > 0
      && Buffer.byteLength(selection.sandboxId) <= 256 && !/[\x00-\x1f\x7f]/.test(selection.sandboxId), 'binding')
  }
  private endpoint(selection: AgentSelection, endpoint: Endpoint, port: number): string {
    const base = new URL(this.config.lifecycle.lifecycleBaseUrl)
    need(typeof endpoint.endpoint === 'string' && Buffer.byteLength(endpoint.endpoint) <= 2048, 'binding')
    const expected = new URL(`${base.pathname.replace(/\/$/, '')}/sandboxes/${encodeURIComponent(selection.sandboxId)}/proxy/${port}`, base.origin)
    const url = new URL(`${base.protocol}//${endpoint.endpoint}`)
    need(url.href === expected.href && !url.username && !url.password && !url.search && !url.hash, 'binding')
    const headers: unknown = endpoint.headers
    if (headers !== undefined && headers !== null) {
      need(typeof headers === 'object' && !Array.isArray(headers), 'binding')
      const entries = Object.entries(headers)
      const valid = entries.every(([key, value]: [string, unknown]) => {
        return ['x-execd-access-token', 'open-sandbox-api-key'].includes(key.toLowerCase()) && typeof value === 'string'
          && value.length <= 1024 && /^[\x20-\x7e]+$/.test(value)
          && (key.toLowerCase() !== 'open-sandbox-api-key' || value === this.config.lifecycle.apiKey)
      })
      need(entries.length <= 8 && valid, 'binding')
    }
    return url.href
  }
  private async start(record: RecordState, signal: AbortSignal): Promise<ClientOptions> {
    const { selection } = record
    const assertOpen = (): void => { if (record.fenced) throw new BootstrapFailure('closed') }
    const current = (): void => {
      assertOpen()
      signal.throwIfAborted(); this.config.assertDeploymentCurrent(); this.assertSelection(selection); selection.mount.assertCurrent()
      assertOpen()
      signal.throwIfAborted()
    }
    current()
    const deadline = Date.now() + this.config.bootstrapTimeoutMs
    const transport = this.transportFactory()
    try {
      const connection = new BootstrapConnection(this.config, transport, deadline)
      record.connection = connection
      const factory = createDefaultAdapterFactory()
      const sandboxes = factory.createLifecycleStack({ connectionConfig: connection,
        lifecycleBaseUrl: this.config.lifecycle.lifecycleBaseUrl }).sandboxes
      const path = `/sandboxes/${encodeURIComponent(selection.sandboxId)}/endpoints/`
      const getEndpoint = async (port: number): Promise<Endpoint> => {
        current()
        const url = `${this.config.lifecycle.lifecycleBaseUrl}${path}${port}?use_server_proxy=true`
        return connection.run('GET', url, () => sandboxes.getSandboxEndpoint(selection.sandboxId, port, true))
      }
      const endpoint = await getEndpoint(44772), base = this.endpoint(selection, endpoint, 44772)
      const execd = factory.createExecdStack({ connectionConfig: connection, execdBaseUrl: base,
        ...(endpoint.headers ? { endpointHeaders: endpoint.headers } : {}) })
      const grant = selection.mount.grant
      const root = (value: typeof grant.project | typeof grant.environment): RootGrant => ({
        device: value.rootDevice, inode: value.rootInode,
        maximumBytes: value.quota.maximumBytes, maximumInodes: value.quota.maximumInodes })
      const token = randomBytes(32).toString('hex'), runtimeIdentity = randomBytes(32).toString('hex')
      const expected: ClientOptions['expected'] = { physicalSandboxId: selection.sandboxId, runtimeIdentity,
        projectRoot: grant.project.rootPath, roots: { project: root(grant.project), environment: root(grant.environment) },
        pins: { bwrapSha256: BWRAP_SHA256, agentSourceSha256: AGENT_SOURCE_SHA256,
          userWorldArgvSha256: expectedWorldHash(grant.project.rootPath) }, declaredImageId: selection.imageDigest }
      // Validate full lossless grant/config input before the first Root command or upload.
      const origin = new URL(this.config.lifecycle.lifecycleBaseUrl)
      record.protected = { token,
        expected: checkOptions({ host: origin.hostname, port: Number(origin.port), token, expected }).expected }
      const config = Buffer.from(JSON.stringify({ runtimeIdentity, token, listenAddress: '0.0.0.0',
        port: this.config.agentPort, declaredImageId: selection.imageDigest, projectRoot: grant.project.rootPath,
        envRoot: '/opt/session-env', expectedRoots: Object.fromEntries(Object.entries(expected.roots).map(([name, value]) =>
          [name, { device: value.device, inode: value.inode,
            grant: { maximumBytes: value.maximumBytes, maximumInodes: value.maximumInodes } }])) }))
      need(config.length <= 4096, 'bounds')
      current()
      await this.command(record, execd, connection, base, this.payload.prep, 's4-bootstrap-claimed\n')
      for (const file of [...this.payload.uploads, { name: 'agent.stage', data: config }]) {
        current()
        await connection.run('POST', base + '/files/upload', () => execd.files.writeFiles([{
          path: '/root-secret/.bootstrap/' + file.name, data: file.data, mode: 600, owner: 'root', group: 'root',
        }]))
      }
      current()
      await this.command(record, execd, connection, base, this.payload.loader, 's4-bootstrap-started\n')
      const agent = await getEndpoint(this.config.agentPort)
      const agentUrl = new URL(this.endpoint(selection, agent, this.config.agentPort))
      // ClientOptions retains the private server origin; this exact object grants only the fixed proxy factory above.
      need(agentUrl.protocol === 'http:', 'endpoint-unrepresentable')
      const options: ClientOptions = Object.freeze({ host: agentUrl.hostname, port: Number(agentUrl.port), token,
        expected: record.protected.expected })
      checkOptions(options)
      const headers = new Headers(agent.headers ?? {})
      headers.set('OPEN-SANDBOX-API-KEY', this.config.lifecycle.apiKey)
      need(!['authorization', 'content-type', 'content-length', 'transfer-encoding', 'host'].some(name => headers.has(name))
        && [...headers].reduce((sum, [name, value]) => sum + name.length + value.length + 4, 0) <= 2048, 'binding')
      current()
      this.options.set(options, { record, endpoint: agentUrl, headers: Object.fromEntries(headers) })
      return options
    } finally {
      record.closeActual = record.connection?.closeTransport() ?? transport.close()
      await record.closeActual
    }
  }
  private async command(record: RecordState, execd: ExecdStack, connection: BootstrapConnection,
    base: string, source: string, expectedOutput: string): Promise<void> {
    const admission = { started: false }
    try {
      await connection.run('POST', base + '/command', async () => {
        let complete = false, initialized = false, output = '', count = 0
        admission.started = true
        for await (const event of execd.commands.runStream(['/usr/local/bin/python3', '-I', '-S', '-B', '-c', source],
          { uid: 0, gid: 0, background: false, workingDirectory: '/', timeoutSeconds: this.config.commandTimeoutSeconds })) {
          need(++count <= this.config.maxEvents, 'command-unknown')
          if (event.type === 'ping') {
            need(initialized && event.text === 'pong', 'command-unknown')
            continue
          }
          need(!complete, 'command-unknown')
          if (event.type === 'init') { need(!initialized, 'command-unknown'); initialized = true }
          else if (event.type === 'stdout') {
            need(typeof event.text === 'string', 'command-unknown')
            output += event.text
            need(output.length <= expectedOutput.length, 'command-unknown')
          } else if (event.type === 'execution_complete') complete = true
          else throw new BootstrapFailure('command-unknown')
        }
        need(initialized && complete && output === expectedOutput, 'command-unknown')
      })
    } catch (cause) {
      if (admission.started && !(cause instanceof BootstrapFailure && cause.code === 'closed')) record.privilegedFailure ??= { cause }
      throw cause
    }
  }
}
