/** Independently authored wire fixtures; hashes use literal JSON domain envelopes, never production schemas or encoders. */
import { createHash } from 'node:crypto'
import { once } from 'node:events'
import { createServer } from 'node:http'
import { mkdtemp, rm, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { Context } from '@deepseek-ai/cordis'
import WebServer from '@deepseek-ai/dsh-host-webserver'
import TypertRegistry from '@deepseek-ai/dsh-typert-registry'
import TypertGateway from '@deepseek-ai/dsh-api-gateway'
import SessionStore from '@deepseek-ai/dsh-session'
import { vi } from 'vitest'
import { brandString } from '@deepseek-ai/dsh-brand'
import type { StdioActionIdV2, StdioConnectionIdV2, StdioRequestIdV2, StdioSessionIdV2,
  StdioLimitsV2, StdioJsonV2 } from '@power-evolve/contracts/stdio-mcp'
import { apply, Config } from '../../application/src/host/index.ts'
import { Scheduler } from '../../application/src/host/scheduler.ts'
import RuntimeScope from '../../application/src/host/scope.ts'
import { readJson, sendFailure, sendJson } from '../../application/src/http.ts'

export const ids = {
  action: brandString<StdioActionIdV2>('10000000-0000-4000-8000-000000000001'),
  connection: brandString<StdioConnectionIdV2>('10000000-0000-4000-8000-000000000002'),
  request: brandString<StdioRequestIdV2>('10000000-0000-4000-8000-000000000003'),
  session: brandString<StdioSessionIdV2>('10000000-0000-4000-8000-000000000004'),
  execution: '10000000-0000-4000-8000-000000000005',
  runner: '10000000-0000-4000-8000-000000000006',
  user: '10000000-0000-4000-8000-000000000007',
  workspace: '10000000-0000-4000-8000-000000000008',
  pod: '10000000-0000-4000-8000-000000000009',
  other: '20000000-0000-4000-8000-000000000001',
}
export const limits: StdioLimitsV2 = { runtimeMs: 3000, requestMs: 700, stdinGraceMs: 0,
  terminateGraceMs: 100, killGraceMs: 500, maxInputBytes: 65536, maxMessageBytes: 32768,
  maxProtocolBytes: 262144, maxProtocolMessages: 100, maxJsonDepth: 32, maxJsonNodes: 10000,
  maxPages: 8, maxTools: 2, maxCatalogBytes: 16384, maxToolBytes: 8192, maxResultBytes: 8192, maxStderrBytes: 1024 }
export const management = { maxNameBytes: 8, pageItems: 2, maxConnections: 4 }
export const configuration = { name: '中文ab', invocation: { program: 'node', argv: ['', 'literal;$(x)', '中文'], cwd: '.' } }
export const image = { kind: 'cloud' as const, platform: { os: 'linux' as const, architecture: 'arm64' as const },
  imageReference: 'registry.invalid/runner@sha256:' + 'a'.repeat(64), runtimeImageId: 'containerd://original-image' }
export const tools = [{ name: 'write_note', inputSchema: { type: 'object', properties: { text: { type: 'string' } } },
  _meta: { literal: 'raw\0😀', original: [3, 1] }, extension: { retained: true } }]

function canonical(value: StdioJsonV2): string {
  if (value === null || typeof value !== 'object') return JSON.stringify(value)
  if (Array.isArray(value)) return '[' + value.map(canonical).join(',') + ']'
  return '{' + Object.keys(value).sort().map(key => JSON.stringify(key) + ':' + canonical(value[key]!)).join(',') + '}'
}

/** Independently encode and hash a literal fixture's complete original domain envelope.
 * @param domain Explicit fixture purpose.
 * @param value Complete fixture JSON, including extensions and ordered arrays.
 * @returns SHA-256 UTF-8 digest without calling the tested encoder or parser.
 */
export function wireDigest(domain: string, value: StdioJsonV2): string {
  return createHash('sha256').update(canonical({ domain: 'power-evolve-stdio-' + domain + '-v2', value })).digest('hex')
}

/** Create literal discover/call JSON, without constructing values through validation schemas.
 * @param phase Original admitted phase.
 * @returns Complete manually authored task with independently computed catalog identity.
 */
export function wireTask(phase: 'discover' | 'call' = 'call') {
  const base = { formatVersion: 2 as const, actionId: ids.action, userId: ids.user, sessionId: ids.session,
    connectionId: ids.connection, configRevision: 1, configDigest: wireDigest('configuration', configuration),
    scopeBinding: { kind: 'cloud' as const, userId: ids.user, workspaceId: ids.workspace, bindingGeneration: 1,
      target: { spaceId: ids.other, rootRelativePath: 'owned' }, home: { kind: 'user' as const, userId: ids.user } },
    expectedDeploymentPin: { kind: 'cloud' as const, deploymentId: ids.other, protocolVersion: 2 as const,
      platform: { ...image.platform }, imageReference: image.imageReference, configImageId: 'sha256:' + 'b'.repeat(64),
      runtimeImageIds: [image.runtimeImageId] }, invocation: structuredClone(configuration.invocation), limits: { ...limits } }
  return phase === 'discover' ? { ...base, phase, origin: { kind: 'stdio_discovery' as const, requestId: ids.request } }
    : { ...base, phase, origin: { kind: 'operation' as const, operationId: ids.other, rootOperationId: ids.other, callKey: 'original-call' },
      selection: { catalogId: ids.other, catalogDigest: wireDigest('catalog', tools), rawCatalog: structuredClone(tools),
        catalogImageExpectation: structuredClone(image), rawName: 'write_note', rawDescriptor: structuredClone(tools[0]!),
        arguments: { text: 'original\0😀', order: [3, 1] } } }
}

/** Create the original true control reply independently from all consumer parsers.
 * @param phase Original task phase.
 * @param now Trusted fixture clock for the active permit window.
 * @returns Literal dispatch and a separate complete permit copy.
 */
export function wirePacket(phase: 'discover' | 'call' = 'call', now = Date.now()) {
  const task = wireTask(phase), taskDigest = wireDigest('task', task), preparedDigest = 'd'.repeat(64)
  const executionRef = { kind: 'cloud' as const, executionId: ids.execution }
  const permit = { actionId: ids.action, taskDigest, preparedDigest, executionRef: { ...executionRef },
    executorOwner: { kind: 'cloud' as const, runnerInstanceId: ids.runner }, approvalEpoch: 1 as const,
    expiresAt: new Date(now + 60000).toISOString(), issuedAt: new Date(now - 1000).toISOString(),
    permitId: ids.other, authorizationRequestId: ids.request, approvalFingerprint: 'e'.repeat(64) }
  return { dispatch: { formatVersion: 2 as const, task, taskDigest, executionRef, preparedDigest, permit },
    authorization: { grantOnce: true, permit: structuredClone(permit) } }
}

/** Author a nonterminal logical reply independently of the Host's public validators.
 * @param phase Original admitted phase.
 * @returns Full original task, logical status and absent terminal facts.
 */
export function wireDetail(phase: 'discover' | 'call' = 'call') {
  const task = wireTask(phase)
  return { formatVersion: 2 as const, actionId: ids.action, executionRef: { kind: 'cloud' as const, executionId: ids.execution },
    sessionId: ids.session, connectionId: ids.connection, configRevision: 1, phase, taskDigest: wireDigest('task', task),
    state: 'running' as const, executionState: 'running' as const, cancelRequested: false,
    createdAt: '2026-10-09T00:00:00.000Z', updatedAt: '2026-10-09T00:00:00.000Z', task, outcome: null, noStart: null }
}

export interface ManagementWireFixture {
  config: unknown
  reply: unknown
  calls: { readonly url: string; readonly input: unknown; readonly authorization: string | undefined }[]
  request: (method: string, input: unknown) => Promise<{ readonly status: number; readonly value: unknown }>
}

/** Exercise authenticated native management HTTP through actual Host, Typert and RuntimeScope consumers.
 * @param run Checks using an owned loopback Platform whose JSON replies are explicit unit substitutes.
 * @returns Resolves after Host effects, HTTP listeners, pending handlers and owned files are disposed.
 */
export async function managementHost(run: (fixture: ManagementWireFixture) => Promise<void>): Promise<void> {
  const root = await mkdtemp(join(tmpdir(), 'employee1-stdio-management-host-')), context = new Context()
  const token = 'employee1_unit_wire_bearer_'.padEnd(64, 'x')
  // Background scheduling is unrelated to management; native carriers and consumer validators remain active.
  const background = vi.spyOn(Scheduler.prototype, 'start').mockImplementation(() => {})
  let origin = ''
  const fixture: ManagementWireFixture = {
    config: { formatVersion: 2, available: true, limits: { ...limits }, management: { ...management }, maxReplyBytes: 131072 },
    reply: {}, calls: [], async request(method, input) {
      const response = await fetch(origin + '/api/powerEvolve/' + method, { method: 'POST',
        headers: { authorization: 'Bearer ' + token, 'content-type': 'application/json' }, body: JSON.stringify({ request: input }) })
      const value: unknown = await response.json()
      return { status: response.status, value }
    },
  }
  const pending = new Set<Promise<void>>()
  const platform = createServer((request, response) => {
    const handler = (async () => {
      try {
        const url = request.url ?? '', input: unknown = await readJson(request, 262144)
        fixture.calls.push({ url, input, authorization: request.headers.authorization })
        if (url === '/identity/me') sendJson(response, { userId: ids.user, username: 'employee1-unit',
          settings: { model: 'wire-model', maxTokens: 1000, revision: 1 } })
        else if (url === '/stdio-v2/config') sendJson(response, fixture.config)
        else if (url.startsWith('/stdio-v2/')) sendJson(response, fixture.reply)
        else throw new Error('Unmodelled owned endpoint: ' + url)
      } catch (error) { sendFailure(response, error) }
    })().finally(() => { pending.delete(handler) })
    pending.add(handler)
  })
  try {
    await writeFile(join(root, 'worker-token'), 'employee1-unit-worker-token', { mode: 0o600, flag: 'wx' })
    platform.listen(0, '127.0.0.1'); await once(platform, 'listening')
    const address = platform.address()
    if (!address || typeof address === 'string') throw new Error('Owned management Platform did not listen')
    const platformOrigin = `http://127.0.0.1:${address.port}`
    await context.plugin(RuntimeScope, { platformUrl: platformOrigin, workerTokenFile: join(root, 'worker-token'),
      timeoutMs: 2000, maxResponseBytes: 262144 })
    await context.plugin(SessionStore)
    await context.plugin(WebServer, { host: '127.0.0.1', port: 0 })
    await context.plugin(TypertRegistry); await context.plugin(TypertGateway, {})
    await context.inject(['powerEvolveRuntime', 'webServer', 'typert', 'typertGateway', 'sessions'], async (ctx) => {
      origin = `http://127.0.0.1:${ctx.webServer.port}`
      await apply(ctx, Config({ origin, platformOrigin, concurrency: 1, pollMs: 50, renewMs: 100,
        operationTimeoutMs: 1000, maxRequestBytes: 262144, maxStreams: 1,
        fileDownloadTimeoutMs: 2000, readyFile: join(root, 'ready.json') }))
    })
    if (!origin) throw new Error('Actual management Host did not activate')
    await run(fixture)
  } finally {
    background.mockRestore()
    try { await context.fiber.dispose() }
    finally {
      await Promise.allSettled(pending)
      if (platform.listening) await new Promise<void>((resolve, reject) => {
        platform.close((error) => { if (error) reject(error); else resolve() }); platform.closeIdleConnections()
      })
      await rm(root, { recursive: true, force: true })
    }
  }
}
