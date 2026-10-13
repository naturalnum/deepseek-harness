/** Real ordinary-role remote MCP import with retained current catalogs, accepted tools and historical facts. */
import { randomUUID, scryptSync } from 'node:crypto'
import { once } from 'node:events'
import { createServer, type IncomingMessage, type ServerResponse } from 'node:http'
import { mkdtemp, mkdir, readFile, rm, writeFile, lstat } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { isDeepStrictEqual } from 'node:util'
import { gzipSync } from 'node:zlib'
import { Pool } from 'pg'
import { expect, test, vi, type Mocked } from 'vitest'
import { LEGACY_SOURCE_LAYOUT, LEGACY_SQL_DIGESTS } from '../src/platform/legacy-import-layout.ts'
import { LegacyImportError, legacyDigest, legacyRowDigest, type LegacyBundle, type LegacyImportLimits, type LegacyJson, type LegacySourceRow } from '../src/platform/legacy-import-codec.ts'
import { preflightLegacyImport, legacyInsertionOrder, type LegacyImportOwners, type LegacyOwnerContext } from '../src/platform/legacy-import-preflight.ts'
import { writeLegacyImport } from '../src/platform/legacy-import-write.ts'
import type { LegacyStorageOptions } from '../src/platform/legacy-import-storage.ts'
import { NativeSessionRead } from '../src/platform/native-session-read.ts'
import { identity, PlatformError, sessionId, userId } from '../src/contracts.ts'
import { mcpResourceId, mcpConnectionId, mcpCatalogId, mcpDiscoveredTool, mcpCheckId, mcpLeaseOwnerId,
  type McpCheck, type McpCheckLease, type McpPrivateSnapshot } from '../src/mcp-contracts.ts'
import { mcpOperationTools, mcpOperationTool } from '../src/mcp-operation-contracts.ts'
import { compileMcpModelTool } from '../src/mcp-model-tools.ts'
import { mcpCatalogTools, mcpCatalogDigest } from '../src/platform/mcp-catalog.ts'
import { McpCredentialCipher, mcpCanonicalJson } from '../src/platform/mcp-credentials.ts'
import { McpConnectionService } from '../src/platform/mcp-connections.ts'
import { legacyMcpJsonReferences } from '../src/platform/legacy-import-owner-references.ts'
import { compileMcpJsonSchema } from '../src/mcp-json-schema.ts'
import { McpCheckWorker, type McpCheckWorkerOptions, type McpCheckWorkerStore } from '../src/platform/mcp-check-worker.ts'
import { McpActionWorker, type McpActionWorkerOptions, type McpActionWorkerStore } from '../src/platform/mcp-action-worker.ts'
import { McpNetworkOperation, type McpTransportBudgets } from '../src/platform/mcp-network.ts'
import { mcpActionId, mcpActionReceipt, type McpActionLease, type McpActionReceipt } from '../src/mcp-action-contracts.ts'
import type { discoverMcp } from '../src/platform/mcp-transport.ts'
import type { CallToolResult } from '@modelcontextprotocol/client'
import { z } from 'zod'
import type { McpActionPreparation } from '../src/platform/mcp-actions.ts'

const limits: LegacyImportLimits = { maxBundleBytes: 2_097_152, maxRows: 1000, maxCellBytes: 65_536,
  maxJsonDepth: 32, maxJsonNodes: 20_000, maxFiles: 100, maxFileBytes: 65_536, maxStorageBytes: 262_144 }
const time = '2025-01-02T03:04:05.123456Z'
const cut = '2025-02-02T03:04:05.123456Z'
const payload = Buffer.from('旧包文件 😀\0\n')
const passwordSalt = '01'.repeat(16)
const passwordHash = `${passwordSalt}:${scryptSync('owned-fixture-password', passwordSalt, 64).toString('hex')}`

const qualityBudgets: McpTransportBudgets = { timeoutMs: 5000, idleTimeoutMs: 1000,
  maxRequestBytes: 65_536, maxResponseBytes: 65_536, maxTotalResponseBytes: 262_144,
  maxResponseHeaderBytes: 16_384, maxRequests: 16, maxHeaderBytes: 16_384, maxHeaders: 16,
  maxPages: 8, maxTools: 64, maxCatalogBytes: 65_536 }

async function qualityMcpHttpServer(handle: (request: IncomingMessage, response: ServerResponse) => void) {
  const server = createServer(handle)
  const close = () => new Promise<void>((resolve, reject) => {
    server.close((error) => { if (error) reject(error); else resolve() })
    server.closeAllConnections()
  })
  try {
    server.listen(0, '127.0.0.1')
    await once(server, 'listening')
    const address = server.address()
    if (!address || typeof address === 'string') throw new Error('Expected owned MCP HTTP listener')
    const origin = `http://127.0.0.1:${address.port}`
    return { endpoint: `${origin}/mcp`,
      policy: { internalExceptions: [{ origin, addresses: ['127.0.0.1'], allowHttp: true }] }, close }
  } catch (error) {
    if (server.listening) await close()
    throw error
  }
}

/** Real SDK-compatible legacy MCP wire with typed public store ports; no PG or private method mocks. */
async function qualityActionFixture(result: CallToolResult, permission?: Promise<boolean>) {
  const raw = mcpDiscoveredTool.parse({ name: 'owned_action_echo', description: 'Owned worker echo',
    inputSchema: { type: 'object', properties: { text: { type: 'string' } }, required: ['text'], additionalProperties: false } })
  const connectionId = mcpConnectionId.parse(randomUUID()), owner = { userId: userId.parse(randomUUID()) }
  const lease: McpActionLease = { actionId: mcpActionId.parse(randomUUID()), ownerId: mcpLeaseOwnerId.parse(randomUUID()), epoch: 1 }
  const catalog = mcpCatalogTools(mcpResourceId.parse(connectionId), [raw])[0]
  if (!catalog) throw new Error('Owned action catalog is empty')
  const model = compileMcpModelTool(catalog, { maxToolBytes: 16_384, maxDescriptionBytes: 4096 })
  const preparation: McpActionPreparation = { lease, owner, arguments: { text: 'owned request 中文' },
    tool: mcpOperationTool.parse({ formatVersion: 1, connectionId, connectionRevision: 1,
      configurationRevision: 1, credentialRevision: null, catalogId: randomUUID(), toolId: catalog.toolId,
      descriptorDigest: catalog.descriptorDigest, raw, model, modelDigest: legacyDigest(mcpCanonicalJson(model)) }) }
  const calls: { name: string; arguments: Record<string, unknown> }[] = [], methods: string[] = [], protocolErrors: unknown[] = []
  const streamOpened = Promise.withResolvers<undefined>(), streamClosed = Promise.withResolvers<undefined>()
  const server = await qualityMcpHttpServer((request, response) => {
    if (request.method === 'GET') {
      if (permission) {
        response.once('close', () => { streamClosed.resolve(undefined) })
        response.writeHead(200, { 'content-type': 'text/event-stream' })
        response.write(': owned stream ready\n\n')
        streamOpened.resolve(undefined)
      } else { response.writeHead(405); response.end() }
      return
    }
    if (request.method === 'DELETE') { response.writeHead(204); response.end(); return }
    const chunks: Buffer[] = []
    request.on('data', (chunk: Buffer) => { chunks.push(chunk) })
    request.once('end', () => {
      try {
        const decoded: unknown = JSON.parse(Buffer.concat(chunks).toString('utf8'))
        const message = z.object({ jsonrpc: z.literal('2.0'), id: z.union([z.string(), z.number()]).optional(),
          method: z.string(), params: z.unknown().optional() }).strict().parse(decoded)
        methods.push(message.method)
        if (message.id === undefined) { response.writeHead(202); response.end(); return }
        let value: unknown
        if (message.method === 'initialize') {
          const input = z.object({ protocolVersion: z.string() }).loose().parse(message.params)
          value = { protocolVersion: input.protocolVersion, capabilities: { tools: {} },
            serverInfo: { name: 'owned-action-peer', version: '1.0.0' } }
        } else if (message.method === 'tools/list') value = { tools: [raw] }
        else if (message.method === 'tools/call') {
          const input = z.object({ name: z.literal(raw.name), arguments: z.record(z.string(), z.json()) })
            .loose().parse(message.params)
          calls.push({ name: input.name, arguments: input.arguments }); value = result
        } else if (message.method === 'ping') value = {}
        else {
          // SDK auto negotiation probes server/discover; this genuine legacy peer does not implement it.
          response.writeHead(200, { 'content-type': 'application/json' })
          response.end(JSON.stringify({ jsonrpc: '2.0', id: message.id,
            error: { code: -32601, message: 'Method not found' } }))
          return
        }
        response.writeHead(200, { 'content-type': 'application/json' })
        response.end(JSON.stringify({ jsonrpc: '2.0', id: message.id, result: value }))
      } catch (error) {
        protocolErrors.push(error)
        response.writeHead(400); response.end()
      }
    })
  })
  try {
    const snapshot: McpPrivateSnapshot = { userId: owner.userId, resourceId: mcpResourceId.parse(connectionId),
      configurationRevision: 1, credentialRevision: null, serverUrl: server.endpoint,
      serverName: 'owned-action-peer', authentication: 'none', headers: {} }
    const permissionEntered = Promise.withResolvers<undefined>()
    const finished = Promise.withResolvers<{
      outcome: Parameters<McpActionWorkerStore['finish']>[1]
      receipt: McpActionReceipt
    }>()
    let permitted = false
    const store: Mocked<McpActionWorkerStore> = {
      claim: vi.fn<McpActionWorkerStore['claim']>().mockResolvedValueOnce(lease).mockResolvedValue(null),
      renew: vi.fn<McpActionWorkerStore['renew']>().mockResolvedValue(undefined),
      preparation: vi.fn<McpActionWorkerStore['preparation']>().mockResolvedValue(preparation),
      authorizeDispatch: vi.fn<McpActionWorkerStore['authorizeDispatch']>(async () => {
        permissionEntered.resolve(undefined); permitted = permission ? await permission : true; return permitted
      }),
      finish: vi.fn<McpActionWorkerStore['finish']>(async (_lease, outcome) => {
        const toolFailed = 'result' in outcome && typeof outcome.result === 'object' && outcome.result !== null
          && 'isError' in outcome.result && outcome.result.isError === true
        const state = 'errorCode' in outcome ? permitted ? 'uncertain' : 'failed' : toolFailed ? 'failed' : 'succeeded'
        const errorCode = 'errorCode' in outcome ? outcome.errorCode : toolFailed ? 'mcp_tool_error' : null
        const receipt = mcpActionReceipt.parse({ actionId: lease.actionId, state, fingerprint: 'a'.repeat(64), errorCode })
        finished.resolve({ outcome, receipt }); return receipt
      }),
    }
    const snapshotPort = vi.fn<McpActionWorkerOptions['snapshot']>(() => Promise.resolve(snapshot))
    const worker = new McpActionWorker(store, { ownerId: lease.ownerId, pollMs: 1000, renewMs: 1000,
      budgets: qualityBudgets, networkPolicy: server.policy, snapshot: snapshotPort })
    return { ...server, raw, calls, methods, protocolErrors, lease, preparation, store, snapshotPort, worker,
      permissionEntered, finished, streamOpened, streamClosed, catalogDigest: 'fcebb36bac3b49f4e6962deab1140dc48cd8e5981b8c4567087ca348b06c5647' }
  } catch (error) { await server.close(); throw error }
}

function qualityCheckStore(): Mocked<McpCheckWorkerStore> {
  return { claimCheck: vi.fn<McpCheckWorkerStore['claimCheck']>(),
    renewCheck: vi.fn<McpCheckWorkerStore['renewCheck']>(),
    checkSnapshot: vi.fn<McpCheckWorkerStore['checkSnapshot']>(),
    finishCheck: vi.fn<McpCheckWorkerStore['finishCheck']>() }
}

function qualityCheckOptions(): McpCheckWorkerOptions {
  return { ownerId: mcpLeaseOwnerId.parse(randomUUID()), pollMs: 1000, renewMs: 1000,
    budgets: qualityBudgets, networkPolicy: {},
    toolLimits: { maxToolBytes: 16_384, maxDescriptionBytes: 4096 } }
}

test('MCP quality check cancellation during claim settles before stop and cannot start discovery', async () => {
  const entered = Promise.withResolvers<undefined>(), claimed = Promise.withResolvers<McpCheckLease | null>()
  const store = qualityCheckStore(), options = qualityCheckOptions()
  store.claimCheck = vi.fn(() => { entered.resolve(undefined); return claimed.promise })
  const worker = new McpCheckWorker(store, options), supervisor = new AbortController()
  const running = worker.run(supervisor.signal)
  await entered.promise
  await expect(worker.run(supervisor.signal)).rejects.toMatchObject({ code: 'mcp_check_worker_running' })
  supervisor.abort()
  let stopped = false
  const stopping = worker.stop().then(() => { stopped = true })
  await Promise.resolve()
  expect(stopped).toBe(false)
  claimed.resolve({ checkId: mcpCheckId.parse(randomUUID()), ownerId: options.ownerId, epoch: 1 })
  await Promise.all([running, stopping])
  expect(store.checkSnapshot.mock.calls).toHaveLength(0)
  expect(store.finishCheck.mock.calls).toHaveLength(0)
})

test('MCP quality action cancellation during claim cannot prepare or finish the returned lease', async () => {
  const entered = Promise.withResolvers<undefined>(), claimed = Promise.withResolvers<McpActionLease | null>()
  const store: McpActionWorkerStore = {
    claim: vi.fn(() => { entered.resolve(undefined); return claimed.promise }),
    renew: vi.fn<McpActionWorkerStore['renew']>(), preparation: vi.fn<McpActionWorkerStore['preparation']>(),
    authorizeDispatch: vi.fn<McpActionWorkerStore['authorizeDispatch']>(), finish: vi.fn<McpActionWorkerStore['finish']>(),
  }
  const ownerId = mcpLeaseOwnerId.parse(randomUUID()), supervisor = new AbortController()
  const snapshot = vi.fn<McpActionWorkerOptions['snapshot']>()
  const worker = new McpActionWorker(store, { ownerId, pollMs: 1000, renewMs: 1000,
    budgets: qualityBudgets, networkPolicy: {}, snapshot })
  const running = worker.run(supervisor.signal)
  await entered.promise
  await expect(worker.run(supervisor.signal)).rejects.toMatchObject({ code: 'mcp_action_worker_running' })
  const stopping = worker.stop()
  claimed.resolve({ actionId: mcpActionId.parse(randomUUID()), ownerId, epoch: 1 })
  await Promise.all([running, stopping])
  expect(store.preparation).not.toHaveBeenCalled()
  expect(store.authorizeDispatch).not.toHaveBeenCalled()
  expect(store.finish).not.toHaveBeenCalled()
  expect(snapshot).not.toHaveBeenCalled()
})

test('MCP quality check cancellation during discovery fences the later successful result', async () => {
  const entered = Promise.withResolvers<undefined>(), discovered = Promise.withResolvers<Awaited<ReturnType<typeof discoverMcp>>>()
  const store = qualityCheckStore(), options = qualityCheckOptions()
  const lease: McpCheckLease = { checkId: mcpCheckId.parse(randomUUID()), ownerId: options.ownerId, epoch: 1 }
  const snapshot: McpPrivateSnapshot = { userId: userId.parse(randomUUID()), resourceId: mcpResourceId.parse(randomUUID()),
    configurationRevision: 1, credentialRevision: null, serverUrl: 'https://example.invalid/mcp',
    serverName: 'owned-fixture', authentication: 'none', headers: {} }
  store.claimCheck = vi.fn<McpCheckWorkerStore['claimCheck']>().mockResolvedValueOnce(lease).mockResolvedValue(null)
  store.checkSnapshot = vi.fn<McpCheckWorkerStore['checkSnapshot']>().mockResolvedValue(snapshot)
  const discover = vi.fn<typeof discoverMcp>(() => { entered.resolve(undefined); return discovered.promise })
  const worker = new McpCheckWorker(store, { ...options, discover })
  const running = worker.run(new AbortController().signal)
  await entered.promise
  const stopping = worker.stop()
  discovered.resolve({ tools: [] })
  await Promise.all([running, stopping])
  expect(discover).toHaveBeenCalledOnce()
  expect(store.finishCheck.mock.calls).toHaveLength(0)
})

type QualityCheckDiscovery = Awaited<ReturnType<typeof discoverMcp>>

function qualityCheckFixture(): {
  store: Mocked<McpCheckWorkerStore>
  options: McpCheckWorkerOptions
  lease: McpCheckLease
  snapshot: McpPrivateSnapshot
  supervisor: AbortController
} {
  const store = qualityCheckStore(), options = qualityCheckOptions(), supervisor = new AbortController()
  const lease: McpCheckLease = { checkId: mcpCheckId.parse(randomUUID()), ownerId: options.ownerId, epoch: 1 }
  const snapshot: McpPrivateSnapshot = { userId: userId.parse(randomUUID()), resourceId: mcpResourceId.parse(randomUUID()),
    configurationRevision: 1, credentialRevision: null, serverUrl: 'https://owned-check-worker.invalid/mcp',
    serverName: 'owned-check-worker', authentication: 'none', headers: {} }
  store.claimCheck.mockResolvedValueOnce(lease).mockImplementation(() => {
    // One next idle claim ends this single-check fixture without a timing-dependent stop.
    supervisor.abort()
    return Promise.resolve(null)
  })
  store.renewCheck.mockResolvedValue(undefined)
  store.checkSnapshot.mockResolvedValue(snapshot)
  return { store, options, lease, snapshot, supervisor }
}

function qualityCheckTools(count: number): QualityCheckDiscovery {
  return { tools: Array.from({ length: count }, (_value, index): QualityCheckDiscovery['tools'][number] => ({
    name: 'owned_tool_' + String(index), description: 'Owned complete catalog fixture',
    inputSchema: { type: 'object', properties: {}, additionalProperties: false },
  })) }
}

function qualityCheckTerminal(lease: McpCheckLease, snapshot: McpPrivateSnapshot,
  state: 'succeeded' | 'failed', discoveredTools: number | null, errorCode: string | null): McpCheck {
  return { checkId: lease.checkId, draftId: null, connectionId: mcpConnectionId.parse(snapshot.resourceId),
    sessionId: sessionId.parse(randomUUID()), connectionRevision: 1,
    configurationRevision: snapshot.configurationRevision, credentialRevision: snapshot.credentialRevision,
    state, catalogId: state === 'succeeded' ? mcpCatalogId.parse(randomUUID()) : null,
    discoveredTools, errorCode, cancelRequested: false, createdAt: '2025-01-02T03:04:05.123Z',
    expiresAt: '2030-01-02T03:04:05.123Z' }
}

function qualityCheckBarrier(barrier: Promise<void>, running: Promise<void>): Promise<void> {
  return Promise.race([barrier, running.then(() => { throw new Error('Owned check ended before its phase barrier') })])
}

test('MCP quality check publishes a complete legal catalog once after admission', async () => {
  const { store, options, lease, snapshot, supervisor } = qualityCheckFixture()
  const raw = qualityCheckTools(2), terminal = qualityCheckTerminal(lease, snapshot, 'succeeded', 2, null)
  const discover = vi.fn<typeof discoverMcp>().mockResolvedValue(raw)
  store.finishCheck.mockResolvedValue(terminal)
  const worker = new McpCheckWorker(store, { ...options, discover }), running = worker.run(supervisor.signal)
  const observed = Promise.allSettled([running])
  try {
    await running
    expect(store.claimCheck.mock.calls).toEqual([[options.ownerId], [options.ownerId]])
    expect(store.checkSnapshot.mock.calls).toEqual([[lease]])
    expect(discover).toHaveBeenCalledOnce()
    const discovery = discover.mock.calls[0]
    expect(discovery?.[0]).toEqual({ endpoint: snapshot.serverUrl, headers: snapshot.headers })
    expect(discovery?.[1].signal).toBeInstanceOf(AbortSignal)
    expect(discovery?.[1].budgets).toEqual(options.budgets)
    expect(discovery?.[1].networkPolicy).toEqual(options.networkPolicy)
    expect(store.finishCheck.mock.calls).toEqual([[lease, { tools: raw.tools.map(tool => mcpDiscoveredTool.parse(tool)) }]])
  } finally {
    supervisor.abort()
    await Promise.allSettled([observed, worker.stop()])
  }
})

test('MCP quality check rejects all 65 legal tools at the original catalog budget instead of publishing a subset', async () => {
  const { store, options, lease, snapshot, supervisor } = qualityCheckFixture()
  expect(options.budgets.maxTools).toBe(64)
  const raw = qualityCheckTools(65)
  const discover = vi.fn<typeof discoverMcp>().mockResolvedValue(raw)
  store.finishCheck.mockResolvedValue(qualityCheckTerminal(lease, snapshot, 'failed', null, 'mcp_catalog_limit'))
  const worker = new McpCheckWorker(store, { ...options, discover }), running = worker.run(supervisor.signal)
  const observed = Promise.allSettled([running])
  try {
    await running
    expect(discover).toHaveBeenCalledOnce()
    expect(store.finishCheck.mock.calls).toEqual([[lease, { errorCode: 'mcp_catalog_limit' }]])
    expect(store.claimCheck.mock.calls).toEqual([[options.ownerId], [options.ownerId]])
  } finally {
    supervisor.abort()
    await Promise.allSettled([observed, worker.stop()])
  }
})

test('MCP quality check renewal loss aborts discovery and fences its later valid catalog', async () => {
  const { store, options, lease, snapshot, supervisor } = qualityCheckFixture()
  expect(options.renewMs).toBe(1000)
  const entered = Promise.withResolvers<undefined>(), aborted = Promise.withResolvers<undefined>()
  const discovered = Promise.withResolvers<QualityCheckDiscovery>(), raw = qualityCheckTools(2)
  let discoverySignal: AbortSignal | undefined
  const discover = vi.fn<typeof discoverMcp>((_target, request) => {
    discoverySignal = request.signal
    if (request.signal.aborted) aborted.resolve(undefined)
    else request.signal.addEventListener('abort', () => { aborted.resolve(undefined) }, { once: true })
    entered.resolve(undefined)
    return discovered.promise
  })
  store.renewCheck.mockRejectedValue(new PlatformError(409, 'mcp_check_lease_lost'))
  // An unexpected finish still returns a legal DTO; the zero-call oracle must catch it.
  store.finishCheck.mockResolvedValue(qualityCheckTerminal(lease, snapshot, 'succeeded', 2, null))
  const worker = new McpCheckWorker(store, { ...options, discover }), running = worker.run(supervisor.signal)
  const observed = Promise.allSettled([running])
  try {
    await qualityCheckBarrier(entered.promise, running)
    await qualityCheckBarrier(aborted.promise, running)
    expect(discoverySignal?.aborted).toBe(true)
    discovered.resolve(raw)
    await running
    expect(store.renewCheck.mock.calls).toEqual([[lease]])
    expect(discover).toHaveBeenCalledOnce()
    expect(store.finishCheck.mock.calls).toHaveLength(0)
    expect(store.claimCheck.mock.calls).toEqual([[options.ownerId], [options.ownerId]])
  } finally {
    supervisor.abort()
    discovered.resolve(raw)
    await Promise.allSettled([observed, worker.stop()])
  }
})

test('MCP quality check unknown finish acknowledgement keeps stop pending and never retries its terminal write', async () => {
  const { store, options, lease, supervisor } = qualityCheckFixture()
  const entered = Promise.withResolvers<undefined>(), finish = Promise.withResolvers<McpCheck>()
  const finishObserved = Promise.allSettled([finish.promise])
  const raw = qualityCheckTools(2), diagnostic = new Error('owned finish acknowledgement diagnostic')
  const discover = vi.fn<typeof discoverMcp>().mockResolvedValue(raw)
  store.finishCheck.mockImplementation(() => { entered.resolve(undefined); return finish.promise })
  const worker = new McpCheckWorker(store, { ...options, discover }), running = worker.run(supervisor.signal)
  const expectedError = { name: 'McpCheckWorkerError', code: 'mcp_check_finish_uncertain', message: 'mcp_check_finish_uncertain' }
  const runRefusal = expect(running).rejects.toMatchObject(expectedError)
  // Observe even an unexpected assertion failure immediately; still await the original assertion below.
  void runRefusal.catch(() => { /* The original assertion is still awaited below. */ })
  let stopRefusal: Promise<void> | undefined
  try {
    await qualityCheckBarrier(entered.promise, running)
    const stopping = worker.stop()
    stopRefusal = expect(stopping).rejects.toMatchObject(expectedError)
    void stopRefusal.catch(() => { /* The original assertion is still awaited below. */ })
    let stopped = false
    const stopObserved = stopping.then(() => { stopped = true }, () => { stopped = true })
    await Promise.resolve()
    expect(stopped).toBe(false)
    finish.reject(diagnostic)
    await Promise.all([runRefusal, stopRefusal, stopObserved])
    expect(discover).toHaveBeenCalledOnce()
    expect(store.finishCheck.mock.calls).toEqual([[lease, { tools: raw.tools.map(tool => mcpDiscoveredTool.parse(tool)) }]])
    expect(store.claimCheck.mock.calls).toEqual([[options.ownerId]])
  } finally {
    supervisor.abort()
    finish.reject(diagnostic)
    await Promise.allSettled([running, worker.stop(), finishObserved, runRefusal, ...(stopRefusal ? [stopRefusal] : [])])
  }
})

test('MCP quality check rejects a legal remote external-reference schema without publishing tools', async () => {
  const { store, options, lease, snapshot, supervisor } = qualityCheckFixture()
  const raw: QualityCheckDiscovery = { tools: [{ name: 'owned_external_ref', description: 'Owned remote schema fixture',
    inputSchema: { type: 'object', properties: { value: { $ref: 'https://owned-schema.invalid/value.json' } },
      required: ['value'], additionalProperties: false } }] }
  const discover = vi.fn<typeof discoverMcp>().mockResolvedValue(raw)
  store.finishCheck.mockResolvedValue(qualityCheckTerminal(lease, snapshot, 'failed', null, 'mcp_schema_unsupported'))
  const worker = new McpCheckWorker(store, { ...options, discover }), running = worker.run(supervisor.signal)
  const observed = Promise.allSettled([running])
  try {
    await running
    expect(store.checkSnapshot.mock.calls).toEqual([[lease]])
    expect(discover).toHaveBeenCalledOnce()
    expect(discover.mock.calls[0]?.[0]).toEqual({ endpoint: snapshot.serverUrl, headers: snapshot.headers })
    expect(store.finishCheck.mock.calls).toEqual([[lease, { errorCode: 'mcp_schema_unsupported' }]])
    expect(store.claimCheck.mock.calls).toEqual([[options.ownerId], [options.ownerId]])
  } finally {
    supervisor.abort()
    await Promise.allSettled([observed, worker.stop()])
  }
})

test('MCP quality check keeps a removed connection snapshot refusal redacted and never starts discovery', async () => {
  const { store, options, lease, snapshot, supervisor } = qualityCheckFixture()
  const revoked = new PlatformError(404, 'mcp_connection_not_found')
  // Error.message is public and mutable; the store's diagnostic must not become the durable error category.
  revoked.message = 'owned private snapshot diagnostic'
  store.checkSnapshot.mockRejectedValue(revoked)
  const discover = vi.fn<typeof discoverMcp>().mockResolvedValue(qualityCheckTools(1))
  store.finishCheck.mockResolvedValue(qualityCheckTerminal(lease, snapshot, 'failed', null, 'mcp_connection_not_found'))
  const worker = new McpCheckWorker(store, { ...options, discover }), running = worker.run(supervisor.signal)
  const observed = Promise.allSettled([running])
  try {
    await running
    expect(store.checkSnapshot.mock.calls).toEqual([[lease]])
    expect(discover.mock.calls).toHaveLength(0)
    expect(store.finishCheck.mock.calls).toEqual([[lease, { errorCode: 'mcp_connection_not_found' }]])
    expect(JSON.stringify(store.finishCheck.mock.calls)).not.toContain(revoked.message)
    expect(store.claimCheck.mock.calls).toEqual([[options.ownerId], [options.ownerId]])
  } finally {
    supervisor.abort()
    await Promise.allSettled([observed, worker.stop()])
  }
})

test('MCP quality action worker completes a real MCP call and persists its complete result once', async () => {
  const result: CallToolResult = { content: [{ type: 'text', text: 'owned successful reply' }],
    structuredContent: { value: 'owned-result' }, isError: false, _meta: { owned: 'preserved' } }
  const f = await qualityActionFixture(result), running = f.worker.run(new AbortController().signal)
  void running.catch((error: unknown) => { f.finished.reject(error) })
  try {
    const terminal = await f.finished.promise
    await f.worker.stop(); await running
    expect(f.store.preparation.mock.calls).toEqual([[f.lease]])
    expect(f.snapshotPort.mock.calls).toEqual([[f.preparation]])
    expect(f.store.authorizeDispatch.mock.calls).toEqual([[f.lease, f.catalogDigest]])
    expect(f.store.finish.mock.calls).toEqual([[f.lease, { result }]])
    expect(terminal).toMatchObject({ outcome: { result }, receipt: { state: 'succeeded', errorCode: null } })
    expect(f.methods).toContain('initialize'); expect(f.methods).toContain('tools/list')
    expect(f.calls).toEqual([{ name: f.raw.name, arguments: f.preparation.arguments }])
    expect(f.protocolErrors).toEqual([])
  } finally { try { await f.worker.stop() } finally { await f.close() } }
})

test('MCP quality action worker cancellation waits for a pending permit and cannot dispatch its late true', async () => {
  const permission = Promise.withResolvers<boolean>()
  const result: CallToolResult = { content: [{ type: 'text', text: 'must not execute' }], isError: false }
  const f = await qualityActionFixture(result, permission.promise), running = f.worker.run(new AbortController().signal)
  void running.catch((error: unknown) => { f.finished.reject(error) })
  try {
    await Promise.race([Promise.all([f.permissionEntered.promise, f.streamOpened.promise]),
      f.finished.promise.then(() => { throw new Error('Action ended before reaching its pending permit') })])
    let stopped = false
    const stopping = f.worker.stop().then(() => { stopped = true })
    await f.streamClosed.promise
    expect(stopped).toBe(false)
    expect(f.store.finish.mock.calls).toEqual([])
    expect(f.calls).toEqual([])
    permission.resolve(true)
    await Promise.all([running, stopping])
    const terminal = await f.finished.promise
    expect(stopped).toBe(true)
    expect(f.store.authorizeDispatch.mock.calls).toEqual([[f.lease, f.catalogDigest]])
    expect(f.store.finish.mock.calls).toEqual([[f.lease, { errorCode: 'mcp_aborted' }]])
    expect(terminal.receipt).toMatchObject({ state: 'uncertain', errorCode: 'mcp_aborted' })
    expect(f.methods).toContain('tools/list')
    expect(f.calls).toEqual([])
    expect(f.protocolErrors).toEqual([])
  } finally {
    permission.resolve(true)
    try { await f.worker.stop() } finally { await f.close() }
  }
})

test('MCP quality action worker preserves an executor isError result and accepts its failed terminal receipt', async () => {
  const result: CallToolResult = { content: [{ type: 'text', text: 'owned executor failure' }],
    structuredContent: { status: 'failed' }, isError: true, _meta: { owned: 'preserved' } }
  const f = await qualityActionFixture(result), running = f.worker.run(new AbortController().signal)
  void running.catch((error: unknown) => { f.finished.reject(error) })
  try {
    const terminal = await f.finished.promise
    await f.worker.stop(); await running
    expect(f.store.authorizeDispatch.mock.calls).toEqual([[f.lease, f.catalogDigest]])
    expect(f.store.finish.mock.calls).toEqual([[f.lease, { result }]])
    expect(terminal).toMatchObject({ outcome: { result }, receipt: { state: 'failed', errorCode: 'mcp_tool_error' } })
    expect(f.methods).toContain('tools/list')
    expect(f.calls).toEqual([{ name: f.raw.name, arguments: f.preparation.arguments }])
    expect(f.protocolErrors).toEqual([])
  } finally { try { await f.worker.stop() } finally { await f.close() } }
})

test('MCP quality transport cancellation during permission blocks the POST and any subsequent retry', async () => {
  const entered = Promise.withResolvers<undefined>(), permission = Promise.withResolvers<undefined>()
  const supervisor = new AbortController(), operation = new McpNetworkOperation(qualityBudgets, supervisor.signal)
  const endpoint = 'http://127.0.0.1:9/mcp'
  const beforeCall = vi.fn(() => { entered.resolve(undefined); return permission.promise })
  try {
    const controlled = await operation.fetchFor(endpoint,
      { internalExceptions: [{ origin: 'http://127.0.0.1:9', addresses: ['127.0.0.1'], allowHttp: true }] }, beforeCall)
    const input = { method: 'POST', body: JSON.stringify({ jsonrpc: '2.0', id: 1, method: 'tools/call' }) }
    const sending = controlled.fetch(endpoint, input)
    const refusal = expect(sending).rejects.toMatchObject({ code: 'aborted' })
    await entered.promise
    supervisor.abort()
    await refusal
    permission.resolve(undefined)
    await expect(controlled.fetch(endpoint, input)).rejects.toMatchObject({ code: 'aborted' })
    expect(beforeCall).toHaveBeenCalledOnce()
  } finally { permission.resolve(undefined); await operation.dispose() }
})

test('MCP quality transport still rejects a mixed public and private DNS answer', async () => {
  const operation = new McpNetworkOperation(qualityBudgets, new AbortController().signal)
  try {
    await expect(operation.fetchFor('https://owned.invalid/mcp', { resolve: () => Promise.resolve([
      { address: '8.8.8.8', family: 4 }, { address: '127.0.0.1', family: 4 },
    ]) }, () => Promise.resolve())).rejects.toMatchObject({ code: 'address_denied' })
  } finally { await operation.dispose() }
})

test('MCP quality required origin exception rejects before DNS or permission work', async () => {
  const operation = new McpNetworkOperation(qualityBudgets, new AbortController().signal)
  const resolve = vi.fn(() => Promise.resolve([{ address: '8.8.8.8', family: 4 }]))
  const beforeCall = vi.fn(() => Promise.resolve())
  try {
    await expect(operation.fetchFor('https://owned-origin-gate.invalid/mcp',
      { requireOriginException: true, resolve }, beforeCall)).rejects.toMatchObject({
      code: 'address_denied', dispatched: false, phase: 'before-dispatch',
    })
    expect(resolve).not.toHaveBeenCalled()
    expect(beforeCall).not.toHaveBeenCalled()
  } finally { await operation.dispose() }
})

test('MCP quality DNS failure exposes only the safe category before dispatch', async () => {
  const operation = new McpNetworkOperation(qualityBudgets, new AbortController().signal)
  const resolve = vi.fn(() => Promise.reject(new Error('owned resolver diagnostic detail')))
  const beforeCall = vi.fn(() => Promise.resolve())
  try {
    await expect(operation.fetchFor('https://owned-dns-failure.invalid/mcp', { resolve }, beforeCall))
      .rejects.toMatchObject({ name: 'McpTransportError', message: 'dns_failed', code: 'dns_failed',
        dispatched: false, phase: 'before-dispatch' })
    expect(resolve).toHaveBeenCalledOnce()
    expect(resolve).toHaveBeenCalledWith('owned-dns-failure.invalid')
    expect(beforeCall).not.toHaveBeenCalled()
  } finally { await operation.dispose() }
})

test('MCP quality transport rejects a redirect without forwarding the credential', async () => {
  const received: { url: string | undefined; authorization: string | undefined }[] = []
  const server = await qualityMcpHttpServer((request, response) => {
    received.push({ url: request.url, authorization: request.headers.authorization })
    response.writeHead(307, { location: '/redirected' })
    response.end()
  })
  const operation = new McpNetworkOperation(qualityBudgets, new AbortController().signal)
  const beforeCall = vi.fn(() => Promise.resolve())
  try {
    const controlled = await operation.fetchFor(server.endpoint, server.policy, beforeCall)
    await expect(controlled.fetch(server.endpoint, { method: 'GET',
      headers: { authorization: 'Bearer owned-mcp-transport-test' } })).rejects.toMatchObject({
      code: 'redirect_denied', dispatched: false, phase: 'before-dispatch',
    })
    expect(received).toEqual([{ url: '/mcp', authorization: 'Bearer owned-mcp-transport-test' }])
    expect(beforeCall).not.toHaveBeenCalled()
  } finally {
    try { await operation.dispose() } finally { await server.close() }
  }
})

test('MCP quality transport keeps a received call uncertain after disconnect and blocks replay', async () => {
  const received: { method: string | undefined; url: string | undefined; body: string }[] = []
  const server = await qualityMcpHttpServer((request, response) => {
    let body = ''
    request.setEncoding('utf8')
    request.on('data', (chunk: string) => { body += chunk })
    request.once('end', () => {
      received.push({ method: request.method, url: request.url, body })
      response.destroy()
    })
  })
  const operation = new McpNetworkOperation(qualityBudgets, new AbortController().signal)
  const beforeCall = vi.fn(() => {
    // The caller records dispatch once its durable permission gate succeeds.
    operation.dispatched = true
    return Promise.resolve()
  })
  const body = JSON.stringify({ jsonrpc: '2.0', id: 1, method: 'tools/call',
    params: { name: 'owned-tool', arguments: {} } })
  const input = { method: 'POST', headers: { 'content-type': 'application/json' }, body }
  try {
    const controlled = await operation.fetchFor(server.endpoint, server.policy, beforeCall)
    await expect(controlled.fetch(server.endpoint, input)).rejects.toMatchObject({
      code: 'transport_error', dispatched: true, phase: 'after-dispatch',
    })
    await expect(controlled.fetch(server.endpoint, input)).rejects.toMatchObject({
      code: 'transport_error', dispatched: true, phase: 'after-dispatch',
    })
    expect(beforeCall).toHaveBeenCalledOnce()
    expect(received).toEqual([{ method: 'POST', url: '/mcp', body }])
  } finally {
    try { await operation.dispose() } finally { await server.close() }
  }
})

test('MCP quality response header overflow blocks later permission and dispatch', async () => {
  const received: string[] = []
  const server = await qualityMcpHttpServer((request, response) => {
    received.push(request.method ?? '')
    response.writeHead(200, { 'x-owned-metadata': 'x'.repeat(2048) })
    response.end('{}')
  })
  const operation = new McpNetworkOperation({ ...qualityBudgets, maxResponseHeaderBytes: 1024 },
    new AbortController().signal)
  const beforeCall = vi.fn(() => Promise.resolve())
  try {
    const controlled = await operation.fetchFor(server.endpoint, server.policy, beforeCall)
    await expect(controlled.fetch(server.endpoint)).rejects.toMatchObject({
      code: 'response_limit', message: 'response_limit', dispatched: false, phase: 'before-dispatch',
    })
    await expect(controlled.fetch(server.endpoint, { method: 'POST', headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ jsonrpc: '2.0', id: 1, method: 'tools/call',
        params: { name: 'owned-tool', arguments: {} } }) })).rejects.toMatchObject({
      code: 'response_limit', dispatched: false,
    })
    expect(beforeCall).not.toHaveBeenCalled()
    expect(received).toEqual(['GET'])
  } finally {
    try { await operation.dispose() } finally { await server.close() }
  }
})

test('MCP quality transport refuses a gzip response before exposing its body', async () => {
  const server = await qualityMcpHttpServer((_request, response) => {
    response.writeHead(200, { 'content-encoding': 'gzip' })
    response.end(gzipSync(Buffer.from('{"owned":"reply"}')))
  })
  const operation = new McpNetworkOperation(qualityBudgets, new AbortController().signal)
  try {
    const controlled = await operation.fetchFor(server.endpoint, server.policy, () => Promise.resolve())
    await expect(controlled.fetch(server.endpoint)).rejects.toMatchObject({
      code: 'unsupported_response', dispatched: false, phase: 'before-dispatch',
    })
  } finally {
    try { await operation.dispose() } finally { await server.close() }
  }
})

test('MCP quality declared response length rejects before waiting for the body', async () => {
  const server = await qualityMcpHttpServer((_request, response) => {
    response.writeHead(200, { 'content-length': '33' })
    response.flushHeaders()
  })
  const operation = new McpNetworkOperation({ ...qualityBudgets, maxResponseBytes: 32 },
    new AbortController().signal)
  try {
    const controlled = await operation.fetchFor(server.endpoint, server.policy, () => Promise.resolve())
    await expect(controlled.fetch(server.endpoint)).rejects.toMatchObject({
      code: 'response_limit', dispatched: false, phase: 'before-dispatch',
    })
  } finally {
    try { await operation.dispose() } finally { await server.close() }
  }
})

test('MCP quality streaming response admits its byte limit and rejects the next byte', async () => {
  const reply = Promise.withResolvers<ServerResponse>()
  const server = await qualityMcpHttpServer((_request, response) => {
    response.writeHead(200)
    response.flushHeaders()
    reply.resolve(response)
  })
  const operation = new McpNetworkOperation({ ...qualityBudgets, maxResponseBytes: 4 },
    new AbortController().signal)
  try {
    const controlled = await operation.fetchFor(server.endpoint, server.policy, () => Promise.resolve())
    const response = await controlled.fetch(server.endpoint)
    if (!response.body) throw new Error('Expected owned MCP response body')
    const reader = response.body.getReader(), peer = await reply.promise
    try {
      peer.write('A☃')
      const chunks: Buffer[] = []
      while (Buffer.concat(chunks).length < 4) {
        const part = await reader.read()
        if (part.done) throw new Error('Owned reply ended before its allowed bytes')
        chunks.push(Buffer.from(part.value))
      }
      expect(Buffer.concat(chunks).toString('utf8')).toBe('A☃')
      peer.end('x')
      await expect(reader.read()).rejects.toMatchObject({
        code: 'response_limit', dispatched: false, phase: 'before-dispatch',
      })
    } finally { reader.releaseLock() }
  } finally {
    try { await operation.dispose() } finally { await server.close() }
  }
})

test('MCP quality cumulative response bytes stop dispatch after individually bounded replies', async () => {
  const received: string[] = []
  const server = await qualityMcpHttpServer((request, response) => {
    received.push(request.method ?? '')
    response.end('abc')
  })
  const operation = new McpNetworkOperation({ ...qualityBudgets, maxResponseBytes: 4, maxTotalResponseBytes: 5 },
    new AbortController().signal)
  const beforeCall = vi.fn(() => Promise.resolve())
  try {
    const controlled = await operation.fetchFor(server.endpoint, server.policy, beforeCall)
    const first = await controlled.fetch(server.endpoint)
    expect(await first.text()).toBe('abc')
    const second = await controlled.fetch(server.endpoint)
    await expect(second.text()).rejects.toMatchObject({
      code: 'response_limit', dispatched: false, phase: 'before-dispatch',
    })
    await expect(controlled.fetch(server.endpoint, { method: 'POST', headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ jsonrpc: '2.0', id: 1, method: 'tools/call',
        params: { name: 'owned-tool', arguments: {} } }) })).rejects.toMatchObject({
      code: 'response_limit', dispatched: false,
    })
    expect(beforeCall).not.toHaveBeenCalled()
    expect(received).toEqual(['GET', 'GET'])
  } finally {
    try { await operation.dispose() } finally { await server.close() }
  }
})

test('MCP quality a stalled reply times out after dispatch and cannot replay the call', async () => {
  const received: string[] = []
  const server = await qualityMcpHttpServer((request, _response) => {
    let body = ''
    request.setEncoding('utf8')
    request.on('data', (chunk: string) => { body += chunk })
    request.once('end', () => { received.push(body) })
  })
  const operation = new McpNetworkOperation(qualityBudgets, new AbortController().signal)
  const beforeCall = vi.fn(() => {
    // Match the caller's conservative flag while a dispatch permit may have committed.
    operation.dispatched = true
    return Promise.resolve()
  })
  const body = JSON.stringify({ jsonrpc: '2.0', id: 1, method: 'tools/call',
    params: { name: 'owned-tool', arguments: {} } })
  const input = { method: 'POST', headers: { 'content-type': 'application/json' }, body }
  try {
    const controlled = await operation.fetchFor(server.endpoint, server.policy, beforeCall)
    await expect(controlled.fetch(server.endpoint, input)).rejects.toMatchObject({
      code: 'timeout', dispatched: true, phase: 'after-dispatch',
    })
    await expect(controlled.fetch(server.endpoint, input)).rejects.toMatchObject({
      code: 'timeout', dispatched: true, phase: 'after-dispatch',
    })
    expect(beforeCall).toHaveBeenCalledOnce()
    expect(received).toEqual([body])
  } finally {
    try { await operation.dispose() } finally { await server.close() }
  }
})

test('MCP quality HTTP 401 preserves authentication refusal before compression and blocks dispatch', async () => {
  const received: string[] = []
  const server = await qualityMcpHttpServer((request, response) => {
    received.push(request.method ?? '')
    response.writeHead(401, { 'www-authenticate': 'Bearer realm="owned-mcp"', 'content-encoding': 'gzip' })
    response.end(gzipSync(Buffer.from('{"error":"owned authentication detail"}')))
  })
  const operation = new McpNetworkOperation(qualityBudgets, new AbortController().signal)
  const beforeCall = vi.fn(() => Promise.resolve())
  try {
    const controlled = await operation.fetchFor(server.endpoint, server.policy, beforeCall)
    await expect(controlled.fetch(server.endpoint)).rejects.toMatchObject({
      code: 'auth_rejected', message: 'auth_rejected', dispatched: false, phase: 'before-dispatch',
    })
    await expect(controlled.fetch(server.endpoint, { method: 'POST', headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ jsonrpc: '2.0', id: 1, method: 'tools/call',
        params: { name: 'owned-tool', arguments: {} } }) })).rejects.toMatchObject({
      code: 'auth_rejected', message: 'auth_rejected', dispatched: false, phase: 'before-dispatch',
    })
    expect(beforeCall).not.toHaveBeenCalled()
    expect(received).toEqual(['GET'])
  } finally {
    try { await operation.dispose() } finally { await server.close() }
  }
})

test('MCP quality HTTP 403 preserves authentication refusal before body limits and blocks dispatch', async () => {
  const received: string[] = []
  const server = await qualityMcpHttpServer((request, response) => {
    received.push(request.method ?? '')
    response.writeHead(403, { 'content-length': String(qualityBudgets.maxResponseBytes + 1) })
    response.flushHeaders()
  })
  const operation = new McpNetworkOperation(qualityBudgets, new AbortController().signal)
  const beforeCall = vi.fn(() => Promise.resolve())
  try {
    const controlled = await operation.fetchFor(server.endpoint, server.policy, beforeCall)
    await expect(controlled.fetch(server.endpoint)).rejects.toMatchObject({
      code: 'auth_rejected', message: 'auth_rejected', dispatched: false, phase: 'before-dispatch',
    })
    await expect(controlled.fetch(server.endpoint, { method: 'POST', headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ jsonrpc: '2.0', id: 1, method: 'tools/call',
        params: { name: 'owned-tool', arguments: {} } }) })).rejects.toMatchObject({
      code: 'auth_rejected', message: 'auth_rejected', dispatched: false, phase: 'before-dispatch',
    })
    expect(beforeCall).not.toHaveBeenCalled()
    expect(received).toEqual(['GET'])
  } finally {
    try { await operation.dispose() } finally { await server.close() }
  }
})

test('MCP quality a reply interrupted after readable bytes stays uncertain and cannot replay', async () => {
  const peer = Promise.withResolvers<ServerResponse>()
  const received: { method: string | undefined; url: string | undefined; body: string }[] = []
  const prefix = '{"jsonrpc":"2.0","id":1,"result":{"content":['
  const complete = `${prefix}{"type":"text","text":"owned reply"}]}}`
  const server = await qualityMcpHttpServer((request, response) => {
    let body = ''
    request.setEncoding('utf8')
    request.on('data', (chunk: string) => { body += chunk })
    request.once('end', () => {
      received.push({ method: request.method, url: request.url, body })
      response.writeHead(200, { 'content-type': 'application/json', 'content-length': String(Buffer.byteLength(complete)) })
      response.write(prefix)
      peer.resolve(response)
    })
  })
  const operation = new McpNetworkOperation(qualityBudgets, new AbortController().signal)
  const beforeCall = vi.fn(() => {
    // Match the caller's conservative flag once a dispatch permit may have committed.
    operation.dispatched = true
    return Promise.resolve()
  })
  const body = JSON.stringify({ jsonrpc: '2.0', id: 1, method: 'tools/call',
    params: { name: 'owned-tool', arguments: {} } })
  const input = { method: 'POST', headers: { 'content-type': 'application/json' }, body }
  try {
    const controlled = await operation.fetchFor(server.endpoint, server.policy, beforeCall)
    const response = await controlled.fetch(server.endpoint, input), remote = await peer.promise
    if (!response.body) throw new Error('Expected owned MCP response body')
    const reader = response.body.getReader()
    try {
      const chunks: Buffer[] = []
      let bytes = 0
      while (bytes < Buffer.byteLength(prefix)) {
        const part = await reader.read()
        if (part.done) throw new Error('Owned reply ended before its announced prefix')
        const chunk = Buffer.from(part.value)
        chunks.push(chunk); bytes += chunk.length
      }
      expect(Buffer.concat(chunks).toString('utf8')).toBe(prefix)
      const interrupted = expect(reader.read()).rejects.toMatchObject({
        code: 'transport_error', dispatched: true, phase: 'after-dispatch',
      })
      remote.destroy()
      await interrupted
      await expect(controlled.fetch(server.endpoint, input)).rejects.toMatchObject({
        code: 'transport_error', dispatched: true, phase: 'after-dispatch',
      })
      expect(beforeCall).toHaveBeenCalledOnce()
      expect(received).toEqual([{ method: 'POST', url: '/mcp', body }])
    } finally { reader.releaseLock() }
  } finally {
    try { await operation.dispose() } finally { await server.close() }
  }
})

test('MCP quality draft07 references retain ignored sibling constraints and literal reference data', () => {
  const schema = { $schema: 'http://json-schema.org/draft-07/schema#', type: 'object',
    definitions: { value: { type: 'string' } },
    properties: { value: { $ref: '#/definitions/value', type: 'string', minLength: 8 },
      literal: { const: { $ref: '#/missing' } } }, required: ['value'] }
  const original = structuredClone(schema), validate = compileMcpJsonSchema(schema, true)
  expect(validate({ value: 'ok', literal: { $ref: '#/missing' } })).toBe(true)
  expect(validate({ value: 5 })).toBe(false)
  expect(validate({ value: 'ok', literal: { $ref: '#/changed' } })).toBe(false)
  expect(schema).toEqual(original)
})

test('MCP quality draft07 references retain original type prechecks and local anchor targets', () => {
  const base = { $schema: 'http://json-schema.org/draft-07/schema#', definitions: { value: true } }
  const typed = compileMcpJsonSchema({ ...base, $ref: '#/definitions/value', type: 'number' })
  expect(typed(2)).toBe(true)
  expect(typed('two')).toBe(false)
  const ignored = compileMcpJsonSchema({ ...base, $ref: '#/definitions/value', type: 'number', minimum: 10 })
  expect(ignored('two')).toBe(true)
  expect(ignored(2)).toBe(true)
  const nullable = compileMcpJsonSchema({ ...base, $ref: '#/definitions/value',
    type: 'number', nullable: true, minimum: 10 })
  expect(nullable(null)).toBe(true)
  expect(nullable('two')).toBe(false)
  const anchored = compileMcpJsonSchema({ $schema: base.$schema, type: 'object',
    definitions: { value: { $anchor: 'named', type: 'integer' } },
    properties: { a: { $ref: '#named' }, b: { $ref: '#na%6ded' } } })
  expect(anchored({ a: 1, b: 2 })).toBe(true)
  expect(anchored({ a: 'one' })).toBe(false)
  expect(() => compileMcpJsonSchema({ ...base, $ref: '#/definitions/value', minLength: 'invalid' })).toThrow('mcp_schema_unsupported')
})

const ids = () => ({ user: randomUUID(), workspace: randomUUID(), session: randomUUID(), operation: randomUUID() })

function records(bundle: LegacyBundle, table: string): LegacySourceRow[] {
  const rows = bundle.tables[table]
  if (!rows) throw new Error('Fixture source table missing')
  return rows
}

const mcpKey = Buffer.alloc(32, 17).toString('base64url')
const mcpOptions = { maxConnections: 16, maxPendingTickets: 8, maxActiveChecks: 4, maxDrafts: 8, maxDraftsPerHour: 16,
  maxTools: 32, maxCatalogBytes: 65536, maxToolBytes: 16384, ticketLifetimeMs: 1000, checkLifetimeMs: 2000,
  draftLifetimeMs: 4000, retentionMs: 8000, checkLeaseMs: 500,
  assertEndpoint: async () => { throw new Error('Import must not admit or contact an endpoint') } }
function remotePacket() {
  const base = packet(), { bundle, alice } = base
  const connection = randomUUID(), currentCatalog = randomUUID(), oldCatalog = randomUUID(), draft = randomUUID()
  const check = randomUUID(), action = randomUUID(), permission = randomUUID(), continuation = randomUUID()
  const cipher = new McpCredentialCipher(mcpKey)
  const raw = mcpDiscoveredTool.parse({ name: 'read_record', description: 'Original business lookup',
    inputSchema: { type: 'object', properties: { sessionId: { type: 'string' } }, required: ['sessionId'],
      additionalProperties: false, examples: [{ sessionId: 'business-session', userId: 'application-owner' }] } })
  const tools = mcpCatalogTools(mcpResourceId.parse(connection), [raw]), tool = tools[0]
  if (!tool) throw new Error('Fixture catalog missing')
  const model = compileMcpModelTool(tool, { maxToolBytes: 16384, maxDescriptionBytes: 4096 },
    { connectionId: mcpConnectionId.parse(connection), displayName: 'Original Remote' })
  const selected = mcpOperationTool.parse({ formatVersion: 1, connectionId: connection, connectionRevision: 5,
    configurationRevision: 2, credentialRevision: 3, catalogId: currentCatalog, toolId: tool.toolId,
    descriptorDigest: tool.descriptorDigest, raw, model, modelDigest: legacyDigest(mcpCanonicalJson(model)) })
  const configuration = { displayName: 'Original Remote', serverUrl: 'https://mcp.invalid/original', serverName: 'retained-remote',
    authentication: 'bearer', headerNames: [], secretConfigured: true }
  records(bundle, 'pe_mcp_remote_connections').push(sourceRow('pe_mcp_remote_connections', { id: connection,
    user_id: alice.user, server_name: 'retained-remote', revision: '5', configuration_revision: '2',
    enabled: 'true', current_catalog_id: currentCatalog }))
  for (const revision of [1, 2]) {
    const credentialRevision = revision === 1 ? 1 : 3
    records(bundle, 'pe_mcp_configuration_versions').push(sourceRow('pe_mcp_configuration_versions', {
      connection_id: connection, user_id: alice.user, configuration_revision: String(revision),
      credential_revision: String(credentialRevision), configuration: JSON.stringify(configuration) }))
    const sealed = cipher.seal({ kind: 'connection', userId: userId.parse(alice.user),
      resourceId: mcpResourceId.parse(connection), configurationRevision: revision, credentialRevision },
    { formatVersion: 1, bearerToken: revision === 1 ? 'old-fixture-secret' : 'current-fixture-secret' })
    records(bundle, 'pe_mcp_credential_versions').push(sourceRow('pe_mcp_credential_versions', {
      connection_id: connection, user_id: alice.user, configuration_revision: String(revision),
      credential_revision: String(credentialRevision), format_version: '1', sealed: `\\x${sealed.toString('hex')}` }))
    records(bundle, 'pe_mcp_catalog_versions').push(sourceRow('pe_mcp_catalog_versions', {
      id: revision === 1 ? oldCatalog : currentCatalog, user_id: alice.user, connection_id: connection,
      configuration_revision: String(revision), credential_revision: String(credentialRevision),
      catalog_digest: mcpCatalogDigest([raw]), tools: JSON.stringify(tools) }))
  }
  records(bundle, 'pe_mcp_drafts').push(sourceRow('pe_mcp_drafts', { id: draft, user_id: alice.user,
    session_id: alice.session, source_connection_id: connection, source_revision: '5',
    configuration: JSON.stringify(configuration), configuration_revision: '1', expires_at: time }))
  const checkRow = sourceRow('pe_mcp_checks', { id: check, user_id: alice.user, session_id: alice.session,
    connection_id: connection, connection_revision: '5', configuration_revision: '2', credential_revision: '3',
    state: 'succeeded', catalog_id: currentCatalog, discovered_tools: '1', lease_epoch: '7', expires_at: time })
  records(bundle, 'pe_mcp_checks').push(checkRow)
  records(bundle, 'pe_mcp_management_requests').push(sourceRow('pe_mcp_management_requests', {
    user_id: alice.user, request_id: randomUUID(), purpose: 'create', metadata_digest: legacyDigest('original metadata'),
    result: JSON.stringify({ purpose: 'create', connection: { connectionId: connection, revision: 5 } }) }))
  records(bundle, 'pe_mcp_permissions').push(sourceRow('pe_mcp_permissions', { id: permission,
    user_id: alice.user, session_id: alice.session, connection_id: connection, connection_revision: '5',
    configuration_revision: '2', credential_revision: '3', catalog_id: currentCatalog, tool_id: tool.toolId }))
  records(bundle, 'pe_mcp_action_chains').push(sourceRow('pe_mcp_action_chains', { root_operation_id: alice.operation,
    user_id: alice.user, session_id: alice.session, calls: '1', max_calls: '4', expires_at: time, stopped_at: time }))
  const args = { sessionId: 'business-session' }
  const requestDigest = cipher.fingerprint('action', { userId: alice.user, sessionId: alice.session,
    operationId: alice.operation, callKey: 'original-call', tool: selected, arguments: args })
  const actionRow = sourceRow('pe_mcp_actions', { id: action, user_id: alice.user, session_id: alice.session,
    operation_id: alice.operation, root_operation_id: alice.operation, call_key: 'original-call',
    tool: JSON.stringify(selected), arguments: JSON.stringify(args), request_digest: requestDigest, state: 'succeeded',
    decision: 'session', permission_id: permission, dispatch_id: randomUUID(), dispatch_at: time, decided_at: time,
    result: '{ "content":[{"type":"text","text":"original result"}],"structuredContent":{"userId":"business-user","sessionId":"business-session"} }',
    lease_epoch: '9', expires_at: time, continuation_request_id: continuation })
  records(bundle, 'pe_mcp_actions').push(actionRow)
  const operation = records(bundle, 'pe_operations')[0]
  if (!operation) throw new Error('Fixture accepted operation missing')
  operation.values.remote_mcp_selection = JSON.stringify([selected])
  records(bundle, 'pe_operations').push(sourceRow('pe_operations', { ...operation.values, id: randomUUID(),
    request_id: continuation, source: 'remote_mcp_result', source_mcp_action_id: action, mcp_root_operation_id: alice.operation }))
  // These independent fixture receipts prove adapter identity matching; they do not claim a real remote effect was stopped.
  const proofs = new Map([checkRow, actionRow].map(row => [row.values.id, {
    kind: 'owned-fixture-original-stop', rowId: row.values.id, ownerId: alice.user,
    connectionId: connection, catalogId: currentCatalog, requestDigest: row.values.request_digest ?? null }]))
  for (const [table, row] of [['pe_mcp_checks', checkRow], ['pe_mcp_actions', actionRow]] as const) {
    bundle.stops.push({ table, rowSha256: row.sha256, evidence: JSON.stringify(proofs.get(row.values.id)) })
  }
  const validateRow = (context: LegacyOwnerContext) => {
    const { row, json } = context
    if (row.table === 'pe_mcp_catalog_versions') {
      const parsed = JSON.parse(row.values.tools ?? '[]') as readonly { raw: unknown }[]
      const originals = parsed.map((entry: { raw: unknown }) => mcpDiscoveredTool.parse(entry.raw))
      if (!isDeepStrictEqual(parsed, mcpCatalogTools(mcpResourceId.parse(row.values.connection_id), originals))
        || row.values.catalog_digest !== mcpCatalogDigest(originals)) throw new Error('Retained descriptor changed')
    }
    if (row.table === 'pe_mcp_remote_connections' && row.values.current_catalog_id !== null) {
      const catalog = context.rows.find(candidate => candidate.table === 'pe_mcp_catalog_versions'
        && candidate.values.id === row.values.current_catalog_id)
      const version = context.rows.find(candidate => candidate.table === 'pe_mcp_configuration_versions'
        && candidate.values.connection_id === row.values.id && candidate.values.user_id === row.values.user_id
        && candidate.values.configuration_revision === row.values.configuration_revision)
      if (!catalog || !version || catalog.values.connection_id !== row.values.id || catalog.values.draft_id !== null
        || catalog.values.user_id !== row.values.user_id || catalog.values.configuration_revision !== row.values.configuration_revision
        || catalog.values.credential_revision !== version.values.credential_revision) throw new Error('Current catalog identity changed')
    }
    if (row.table === 'pe_mcp_credential_versions') cipher.open({
      kind: 'connection', userId: userId.parse(row.values.user_id), resourceId: mcpResourceId.parse(row.values.connection_id),
      configurationRevision: Number(row.values.configuration_revision), credentialRevision: Number(row.values.credential_revision),
    }, Buffer.from(row.values.sealed?.slice(2) ?? '', 'hex'))
    if (row.table === 'pe_operations') mcpOperationTools.parse(json.remote_mcp_selection)
    if (row.table === 'pe_mcp_actions') {
      const parsed = mcpOperationTool.parse(json.tool)
      if (parsed.modelDigest !== legacyDigest(mcpCanonicalJson(parsed.model))
        || row.values.request_digest !== cipher.fingerprint('action', { userId: row.values.user_id, sessionId: row.values.session_id,
          operationId: row.values.operation_id, callKey: row.values.call_key, tool: parsed, arguments: json.arguments })) throw new Error('Accepted action changed')
    }
  }
  const references: LegacyImportOwners['references'] = context =>
    context.row.table === 'pe_operations' || context.row.table === 'pe_mcp_actions' ? legacyMcpJsonReferences(context) : []
  const verifyStopped: LegacyImportOwners['verifyStopped'] = ({ row }, proof) => {
    if (!proofs.has(row.values.id) || !isDeepStrictEqual(proof, proofs.get(row.values.id))) throw new Error('Original stopped receipt changed')
  }
  const plan = () => {
    for (const stop of bundle.stops) {
      const row = records(bundle, stop.table).find(candidate =>
        (JSON.parse(stop.evidence) as { rowId: string }).rowId === candidate.values.id)
      if (!row) throw new Error('Fixture stopped row absent')
      stop.rowSha256 = legacyRowDigest(stop.table, row.values)
    }
    return planned(bundle, limits, { validateRow, references, verifyStopped })
  }
  seal(bundle)
  return { ...base, connection, currentCatalog, oldCatalog, draft, check, action, selected, plan }
}

test('ordinary PG imports the unchanged remote current catalog cycle with all historical rows and native read consumers', () => freshTarget(async (f) => {
  const fixture = remotePacket(), { bundle, alice } = fixture
  expect((await f.pool.query('SELECT current_user,rolsuper,rolcreatedb,rolcreaterole FROM pg_roles WHERE rolname=current_user')).rows[0])
    .toMatchObject({ rolsuper: false, rolcreatedb: false, rolcreaterole: false })
  const result = await writeLegacyImport(f.pool, fixture.plan(), { expectedDatabase: f.name, storage: f.storage })
  expect(result.tableCounts).toMatchObject({ pe_mcp_catalog_versions: '2', pe_mcp_configuration_versions: '2',
    pe_mcp_credential_versions: '2', pe_mcp_drafts: '1', pe_mcp_checks: '1', pe_mcp_permissions: '1',
    pe_mcp_actions: '1', pe_mcp_action_chains: '1', pe_mcp_management_requests: '1', pe_operations: '3' })
  const keys = (await f.pool.query<{
    conname: string
    convalidated: boolean
    condeferrable: boolean
    condeferred: boolean
    confmatchtype: string
    confupdtype: string
    confdeltype: string
    definition: string
  }>(`SELECT c.conname,c.convalidated,c.condeferrable,c.condeferred,
    c.confmatchtype,c.confupdtype,c.confdeltype,pg_get_constraintdef(c.oid) AS definition
    FROM pg_constraint c JOIN pg_namespace n ON n.oid=c.connamespace WHERE n.nspname='public' AND c.contype='f'`)).rows
  expect(keys).toHaveLength(143)
  expect(keys.every(row => row.convalidated && row.confmatchtype === 's' && row.confupdtype === 'a' && row.confdeltype === 'a')).toBe(true)
  expect(keys.find(row => row.conname === 'pe_mcp_remote_catalog')).toMatchObject({
    convalidated: true, condeferrable: false, condeferred: false,
    definition: 'FOREIGN KEY (current_catalog_id, user_id) REFERENCES pe_mcp_catalog_versions(id, user_id)' })
  const service = new McpConnectionService(f.pool, mcpKey, mcpOptions), owner = { userId: userId.parse(alice.user) }
  expect((await service.get(owner, mcpConnectionId.parse(fixture.connection))).currentCatalogId).toBe(fixture.currentCatalog)
  expect((await service.list(owner)).items).toHaveLength(1)
  expect((await service.getCatalog(owner, mcpCatalogId.parse(fixture.oldCatalog))).configurationRevision).toBe(1)
  expect((await service.getCatalog(owner, mcpCatalogId.parse(fixture.currentCatalog))).tools[0]?.raw.inputSchema.examples)
    .toEqual([{ sessionId: 'business-session', userId: 'application-owner' }])
  const client = await f.pool.connect()
  try {
    await client.query('BEGIN')
    expect(await service.admissionCatalogs(client, owner)).toHaveLength(1)
    expect((await service.runtimeSnapshot(client, owner, { connectionId: mcpConnectionId.parse(fixture.connection),
      revision: 5, configurationRevision: 2, credentialRevision: 3, catalogId: mcpCatalogId.parse(fixture.currentCatalog) })).headers)
      .toMatchObject({ Authorization: 'Bearer current-fixture-secret' })
  } finally {
    try { await client.query('ROLLBACK') }
    finally { client.release() }
  }
  const native = new NativeSessionRead(f.pool)
  expect((await native.list(identity.parse({ userId: alice.user, username: 'import-alice' }))).items[0]?.sessionId).toBe(alice.session)
  expect((await f.pool.query<{ result: string }>('SELECT result::text AS result FROM pe_mcp_actions')).rows[0]?.result)
    .toBe(records(bundle, 'pe_mcp_actions')[0]?.values.result)
  expect((await f.pool.query("SELECT id FROM pe_mcp_actions WHERE state IN ('pending','approved','preparing','dispatch-intent')")).rows).toEqual([])
  expect((await f.pool.query('SELECT grant_digest FROM pe_sessions WHERE grant_digest IS NOT NULL')).rows).toEqual([])
  expect((await f.pool.query('SELECT * FROM pe_native_prompt_inputs')).rows).toEqual([])
  expect((await f.pool.query('SELECT * FROM pe_native_file_receipts')).rows).toEqual([])
  await expect(f.pool.query('UPDATE pe_mcp_catalog_versions SET catalog_digest=$1 WHERE id=$2', ['0'.repeat(64), fixture.currentCatalog]))
    .rejects.toMatchObject({ code: 'P0001' })
}, true))

for (const defect of ['missing catalog', 'foreign catalog owner', 'wrong connection', 'wrong configuration', 'wrong credential',
  'descriptor changed', 'key AAD changed', 'accepted action changed', 'missing stop', 'active check', 'typed path foreign owner'] as const) {
  test(`remote MCP ${defect} refuses before target SQL or file publication`, () => freshTarget(async (f) => {
    const fixture = remotePacket(), { bundle, bob } = fixture
    const connection = records(bundle, 'pe_mcp_remote_connections')[0]
    const catalog = records(bundle, 'pe_mcp_catalog_versions').find(row => row.values.id === fixture.currentCatalog)
    const credential = records(bundle, 'pe_mcp_credential_versions')[0], action = records(bundle, 'pe_mcp_actions')[0]
    if (!connection || !catalog || !credential || !action) throw new Error('Fixture MCP closure missing')
    if (defect === 'missing catalog') connection.values.current_catalog_id = randomUUID()
    if (defect === 'foreign catalog owner') catalog.values.user_id = bob.user
    if (defect === 'wrong connection') catalog.values.connection_id = null
    if (defect === 'wrong configuration') catalog.values.configuration_revision = '1'
    if (defect === 'wrong credential') catalog.values.credential_revision = '1'
    if (defect === 'descriptor changed') catalog.values.catalog_digest = '0'.repeat(64)
    if (defect === 'key AAD changed') credential.values.credential_revision = '2'
    if (defect === 'accepted action changed') action.values.arguments = '{"sessionId":"another-business-record"}'
    if (defect === 'missing stop') bundle.stops = []
    if (defect === 'active check') records(bundle, 'pe_mcp_checks')[0]!.values.state = 'running'
    if (defect === 'typed path foreign owner') {
      const operation = records(bundle, 'pe_operations')[1]
      if (!operation) throw new Error('Foreign fixture operation missing')
      operation.values.remote_mcp_selection = JSON.stringify([fixture.selected])
    }
    expect(() => fixture.plan()).toThrow(LegacyImportError)
    expect((await f.pool.query("SELECT tablename FROM pg_tables WHERE schemaname='public'")).rows).toEqual([])
    await expect(lstat(f.storage.candidateRoot)).rejects.toMatchObject({ code: 'ENOENT' })
  }, true))
}
test('unapproved immediate FK cycles remain refused after the exact remote catalog exception', () => {
  const source = sourceRow('pe_operations')
  const operation = randomUUID(), action = randomUUID()
  const rows = [
    { table: 'pe_operations', sourceTable: 'pe_operations', sourceSha256: source.sha256,
      values: { id: operation, session_id: randomUUID(), source_mcp_action_id: action } },
    { table: 'pe_mcp_actions', sourceTable: 'pe_mcp_actions', sourceSha256: source.sha256,
      values: { id: action, operation_id: operation } },
  ]
  expect(() => legacyInsertionOrder(rows)).toThrow('unhandled_immediate_foreign_key_cycle')
})
function sourceRow(table: string, patch: Record<string, string | null> = {}): LegacySourceRow {
  const columns = LEGACY_SOURCE_LAYOUT[table]
  if (!columns) throw new Error('Fixture source table missing')
  const values: Record<string, string | null> = {}
  for (const [column, definition] of Object.entries(columns)) {
    if (definition.nullable) { values[column] = null; continue }
    switch (definition.kind) {
      case 'uuid': values[column] = randomUUID(); break
      case 'text': values[column] = ''; break
      case 'boolean': values[column] = 'false'; break
      case 'json':
      case 'jsonb': values[column] = '{}'; break
      case 'timestamptz': values[column] = time; break
      case 'integer':
      case 'bigint': values[column] = '0'; break
      case 'bytea': values[column] = '\\x'; break
    }
  }
  Object.assign(values, patch)
  return { disposition: table === 'pe_schema' || table === 'pe_file_mutations' ? 'convert' : 'preserve',
    values, sha256: legacyRowDigest(table, values) }
}
function seal(bundle: LegacyBundle): string {
  const counts = { preserve: 0, convert: 0, excluded: 0, rejected: 0 }
  for (const [table, rows] of Object.entries(bundle.tables)) for (const row of rows) {
    row.sha256 = legacyRowDigest(table, row.values); counts[row.disposition]++
  }
  bundle.counts = counts
  return JSON.stringify(bundle)
}
function packet() {
  const alice = ids(), bob = ids()
  const bundle: LegacyBundle = { format: 'power-evolve-legacy-offline', version: 1,
    source: { schema: 37, ddlSha256: LEGACY_SQL_DIGESTS.source37, snapshotId: randomUUID(), codeId: 'reviewed-fixed-fixture', stoppedAt: time, cut },
    tables: Object.fromEntries(Object.keys(LEGACY_SOURCE_LAYOUT).map(table => [table, []])),
    counts: { preserve: 0, convert: 0, excluded: 0, rejected: 0 }, files: [], cutProof: '{"kind":"owned-fixture-cut"}', stops: [] }
  records(bundle, 'pe_schema').push(sourceRow('pe_schema', { version: '37' }))
  for (const [index, id] of [alice, bob].entries()) {
    records(bundle, 'pe_users').push(sourceRow('pe_users', { id: id.user, username: index ? 'import-bob' : 'import-alice',
      password_hash: passwordHash, display_name: index ? 'Bob' : 'Alice', role: 'USER', enabled: 'true',
      account_revision: '7', credential_version: '3', password_change_required: 'false',
      settings: '{ "model": "trial-model", "maxTokens": 1000, "revision": 7 }' }))
    records(bundle, 'pe_workspaces').push(sourceRow('pe_workspaces', { id: id.workspace, user_id: id.user,
      title: index ? 'Bob Home' : 'Alice Home', is_default: 'true', create_request_id: randomUUID(),
      binding_generation: '9', binding_state: 'ready' }))
    records(bundle, 'pe_storage_spaces').push(sourceRow('pe_storage_spaces', { id: id.workspace, user_id: id.user,
      root_key: id.workspace, title: 'retained cloud root', is_default: 'true', root_state: 'ready' }))
    records(bundle, 'pe_workspace_bindings').push(sourceRow('pe_workspace_bindings', { workspace_id: id.workspace,
      user_id: id.user, space_id: id.workspace, root_relative_path: '' }))
    const event = JSON.stringify({ seq: 0, time: 1, type: 'session/title', data: { title: index ? 'Bob old title' : 'Alice old title',
      messageSeqs: [], source: { kind: 'user' } } })
    const ignored = '{ "seq":1, "time":2, "type":"employee5/retained", "ignorable":true, "data":{"value":1e0,"emoji":"\\uD83D\\uDE00"} }'
    const events = index ? [event] : [event, ignored]
    records(bundle, 'pe_sessions').push(sourceRow('pe_sessions', { id: id.session, user_id: id.user, workspace_id: id.workspace,
      create_request_id: randomUUID(), header: JSON.stringify({ id: id.session, version: 4, createdAt: 1, isSeeded: false }),
      event_count: String(events.length),
      event_bytes: String(events.reduce((sum, text) => sum + Buffer.byteLength(JSON.stringify(JSON.parse(text))), 0)),
      lease_epoch: '13' }))
    for (const [seq, text] of events.entries()) records(bundle, 'pe_events').push(sourceRow('pe_events', {
      session_id: id.session, seq: String(seq), event: text }))
    records(bundle, 'pe_operations').push(sourceRow('pe_operations', { id: id.operation, session_id: id.session,
      request_id: randomUUID(), input: index ? 'old bob prompt' : 'old alice prompt', state: 'completed', attempts: '1', completed_at: time,
      settings: '{"model":"trial-model","maxTokens":1000,"revision":7}', source: 'user', execution_target: '{"kind":"cloud"}',
      skill_selection: '[]', mcp_selection: '[]', stdio_mcp_selection: '[]', ssh_selection: '[]', remote_mcp_selection: '[]', stdio_v2_selection: '[]' }))
    records(bundle, 'pe_attempts').push(sourceRow('pe_attempts', { operation_id: id.operation, epoch: '13', worker_id: randomUUID(), ended_at: time }))
    records(bundle, 'pe_credentials').push(sourceRow('pe_credentials', { user_id: id.user, audience: 'agent',
      digest: legacyDigest(`expired-token-${id.user}`), expires_at: time, credential_version: '3' }))
    for (const area of ['workspace', 'home'] as const) bundle.files.push({ area, owner: id.user,
      resource: area === 'workspace' ? id.workspace : id.user, path: '', kind: 'directory', sourcePath: null,
      bytes: null, sha256: null, mode: 0o750, uid: 1000, gid: 1000 })
  }
  bundle.files.push({ area: 'workspace', owner: alice.user, resource: alice.workspace, path: '旧文件.txt', kind: 'file',
    sourcePath: 'payload.bin', bytes: String(payload.length), sha256: legacyDigest(payload), mode: 0o640, uid: 1000, gid: 1000 })
  seal(bundle)
  return { bundle, alice, bob }
}
function jsonObject(value: LegacyJson | undefined): value is Readonly<Record<string, LegacyJson>> {
  return value !== null && value !== undefined && typeof value === 'object' && !Array.isArray(value)
}
function owners(text: string, overrides: Partial<LegacyImportOwners> = {}): LegacyImportOwners {
  const expected = legacyDigest(text)
  return { verifyCut: (source, proof, packetSha256) => {
    if (packetSha256 !== expected || source.codeId !== 'reviewed-fixed-fixture' || proof === null
      || typeof proof !== 'object' || !('kind' in proof) || proof.kind !== 'owned-fixture-cut') throw new Error('unverified cut')
  }, validateRow: () => {}, references: ({ row, json }) => {
    const event = json.event
    if (row.table !== 'pe_events' || !jsonObject(event)
      || event.type !== 'employee5/retained' || !jsonObject(event.data) || !Object.hasOwn(event.data, 'workspaceId')) return []
    return [{ column: 'event', targetTable: 'pe_workspaces', ownership: 'same',
      fields: [{ targetColumn: 'id', value: { kind: 'json', path: ['data', 'workspaceId'] } }] }]
  }, verifyStopped: () => { throw new Error('This fixture supplies no physical stop adapter') },
  verifyFiles: () => {}, ...overrides }
}
function planned(bundle: LegacyBundle, configuration = limits, adapters: Partial<LegacyImportOwners> = {}) {
  const text = seal(bundle)
  return preflightLegacyImport(text, configuration, owners(text, adapters))
}
async function freshTarget(run: (fixture: { pool: Pool; name: string; root: string; storage: LegacyStorageOptions }) => Promise<void>,
  ordinary = false) {
  const file = process.env.PE_TEST_DATABASE_URL_FILE
  if (!file) throw new Error('Legacy import tests require PE_TEST_DATABASE_URL_FILE')
  const address = new URL((await readFile(file, 'utf8')).trim())
  const name = `pe_employee5_import_${randomUUID().replaceAll('-', '')}`
  const role = `pe_employee5_import_role_${randomUUID().replaceAll('-', '')}`
  const admin = new Pool({ connectionString: address.href, max: 1 })
  const target = new URL(address); target.pathname = `/${name}`
  const pool = new Pool({ connectionString: target.href, max: 4, ...(ordinary ? { options: `-c role=${role}` } : {}) })
  const root = await mkdtemp(join(tmpdir(), 'employee5-legacy-import-'))
  const bundleRoot = join(root, 'packet'), candidateRoot = join(root, 'candidate')
  let acquired = false, acquiredRole = false
  try {
    await mkdir(bundleRoot, { mode: 0o700 }); await writeFile(join(bundleRoot, 'payload.bin'), payload, { mode: 0o600 })
    if (ordinary) {
      await admin.query(`CREATE ROLE "${role}" NOLOGIN NOSUPERUSER NOCREATEDB NOCREATEROLE NOINHERIT`); acquiredRole = true
    }
    await admin.query(`CREATE DATABASE "${name}"${ordinary ? ` OWNER "${role}"` : ''}`); acquired = true
    const storage: LegacyStorageOptions = { bundleRoot, candidateRoot, sourceUid: 1000, sourceGid: 1000,
      targetUid: process.getuid?.() ?? 0, targetGid: process.getgid?.() ?? 0 }
    await run({ pool, name, root, storage })
  } finally {
    await pool.end()
    if (acquired) await admin.query(`DROP DATABASE "${name}"`)
    if (acquiredRole) await admin.query(`DROP ROLE "${role}"`)
    await admin.end(); await rm(root, { recursive: true, force: true })
  }
}
