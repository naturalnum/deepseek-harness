/** Native account ZIP export through the Loader, JSONL, local attachments and Host Connection; no Target calls. */
import { mkdtempSync, readFileSync, realpathSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { FiberState, type Context } from '@deepseek-ai/cordis'
import { boot } from '@deepseek-ai/dsh-app-boot'
import * as Connection from '@deepseek-ai/dsh-client-connection'
import { LocalCredentialProvider } from '@deepseek-ai/dsh-credentials-local'
import { LocalAttachmentStore } from '@deepseek-ai/dsh-attachment-local'
import type { FileAttachmentRef } from '@deepseek-ai/dsh-attachment'
import Gateway from '@deepseek-ai/dsh-api-gateway'
import RemoteAccess from '@deepseek-ai/dsh-api-remote-access'
import Typert from '@deepseek-ai/dsh-typert-registry'
import { mountAgentLoopTestDependencies, mountAgentLoopTestHarness } from '@deepseek-ai/dsh-agent-loop-testkit'
import { SessionId } from '@deepseek-ai/dsh-session'
import * as Jsonl from '@deepseek-ai/dsh-session-persistence-jsonl'
import { SessionQueryEngine } from '@deepseek-ai/dsh-session-query'
import type { SessionEventSearchPage, SessionSearchHit, SessionSearchPage } from '@deepseek-ai/dsh-session-query'
import { Config as ExportConfig, SESSION_LOG_EXPORT_PATH, SESSION_LOG_FILENAME } from '@deepseek-ai/dsh-session-log-export'
import { createUserMessage } from '@deepseek-ai/dsh-llm'
import { brandString } from '@deepseek-ai/dsh-brand'
import type { AccountBinding, AccountId, OwnerEpoch } from '@deepseek-ai/dsh-pe-cloud-runtime/types'
import { strFromU8, unzipSync } from 'fflate'
import { afterEach, expect, it, onTestFinished, vi } from 'vitest'
import { createNativeCommands, type NativeCommands } from '../src/native-commands.ts'
import { createNativeSessionExport, type NativeSessionExport } from '../src/native-session-export.ts'
import type { NativeSessionGuards } from '../src/native.ts'
import { ExposurePolicy } from '../src/exposure.ts'
import { CloudApiError } from '../src/errors.ts'

afterEach(() => { vi.restoreAllMocks() })

/** The native query engine owns exact reads and lineage; this fixture never provides indexed search. */
class ExportQuery extends SessionQueryEngine {
  override searchSessions(): Promise<SessionSearchPage<SessionSearchHit>> { return Promise.reject(new Error('Export does not use indexed search.')) }
  override searchEvents(): Promise<SessionEventSearchPage> { return Promise.reject(new Error('Export does not use indexed search.')) }
}

async function fixture(id: string, selected = true) {
  const home = realpathSync(mkdtempSync(join(tmpdir(), 'native-export-'))), sessionId = SessionId('same-local-session')
  const lifetime = new AbortController(), allowed = new Set([sessionId])
  const binding: AccountBinding = { accountId: brandString<AccountId>(id), epoch: brandString<OwnerEpoch>('1'),
    recipeVersion: 'native-export', lifetime: lifetime.signal }
  const manifest = { recipeVersion: binding.recipeVersion,
    rpcEndpoints: ['list', 'execute'].map(method => ({ endpoint: 'commands/' + method, handlerId: 'native:commands', guard: 'account-session' as const })),
    streamEndpoints: [], exactFetchRoutes: selected ? ['GET', 'HEAD'].map(method => ({ method, path: SESSION_LOG_EXPORT_PATH,
      handlerId: 'native:sessionLogDownload', guard: 'account-session' as const })) : [], allowedSettings: [] }
  const policy = new ExposurePolicy(manifest); policy.audit(manifest)
  let owner: Context | undefined, download: NativeSessionExport | undefined, commands: NativeCommands | undefined
  const disposals: Array<() => Promise<void>> = []
  let businessCurrent = true
  const pending: Promise<unknown>[] = [], releases: Array<() => void> = [], responses: Response[] = []
  onTestFinished(async () => {
    for (const release of releases) release()
    lifetime.abort(new Error('Export fixture ended.'))
    await Promise.allSettled(pending)
    await Promise.allSettled(responses.flatMap(response => response.body === null || response.body.locked || response.bodyUsed
      ? [] : [response.body.cancel()]))
    try {
      for (const dispose of disposals.toReversed()) await dispose()
      await owner?.fiber.dispose()
    }
    finally { rmSync(home, { recursive: true, force: true }) }
  })
  const current = (): void => {
    if (!businessCurrent || lifetime.signal.aborted) throw new CloudApiError('cloud/stale-generation', 'Account export admission ended.')
  }
  const own = (sid: SessionId): void => {
    if (!allowed.has(sid)) throw new CloudApiError('cloud/forbidden', 'This Session does not belong to the account.')
  }
  const guards: NativeSessionGuards = {
    projectDirectory: { binding, prepare: async () => {} },
    firstScreen: { maxCollectionItems: 16, maxFrameBytes: 65536, maxQueuedEvents: 16, maxQueuedBytes: 65536, assertSessionRead: own },
    assertHandlerEnabled() {}, resolveCreate: async request => request,
    assertActiveScope(agent) {
      own(agent.session.id)
      if (agent.ctx.get('peAccount') !== binding || agent.session.header.cwd !== '/account-project') {
        throw new CloudApiError('cloud/forbidden', 'This Agent does not belong to the account project.')
      }
    },
    async assertSessionProject(sid) {
      own(sid)
      const root = owner
      if (root === undefined) throw new Error('The original account export root is absent.')
      const header = root.sessions.get(sid)?.header ?? (await root.sessionPersistence.stat(sid))?.header
      if (header?.cwd !== '/account-project') throw new CloudApiError('cloud/forbidden', 'The account Session project is unavailable.')
    },
  }
  const configuration = join(home, 'cordis.yml')
  writeFileSync(configuration, readFileSync(new URL('./fixtures/native-session-export.cordis.yml', import.meta.url), 'utf8')
    .replaceAll('__HOME__', JSON.stringify(home).slice(1, -1)))
  const ctx = await boot('native-account-export', configuration, [], async (ctx) => {
    owner = ctx
    ctx.provide('peAccount', binding)
    await ctx.plugin(Typert); await ctx.plugin(RemoteAccess); await ctx.plugin(Gateway)
    await mountAgentLoopTestDependencies(ctx, { workingDirectory: true })
    await mountAgentLoopTestHarness(ctx)
    Object.assign(ctx.loader.builtins, {
      'export-credentials': LocalCredentialProvider, 'export-jsonl': Jsonl, 'export-attachments': LocalAttachmentStore,
      'export-query': ExportQuery, 'export-connection': Connection,
      'export-commands': { inject: ['agents'], apply(scope: Context) {
        commands = createNativeCommands(scope, binding, current, policy, guards, 128)
      } },
      'export-download': { inject: ['commands', 'connection', 'sessionQuery', 'sessionPersistence', 'attachments', 'sessions'], Config: ExportConfig,
        apply(scope: Context, config: Parameters<typeof createNativeSessionExport>[6]) {
          download = createNativeSessionExport(scope, binding, current, policy, guards, 128, config)
        } },
    })
  })
  if (download === undefined || commands === undefined) throw new Error('The native account export did not mount.')
  const registration = download, registry = commands
  for (const row of ctx.loader.entries()) expect(row.fiber?.state, row.options.id).toBe(FiberState.ACTIVE)
  const handle = await ctx.agents.create({ sessionId, meta: { cwd: '/account-project' } }), agent = handle.agent
  disposals.push(handle.dispose.bind(handle))
  const file = await ctx.attachments.saveFile({ name: 'account.txt', data: new TextEncoder().encode('file-' + id) })
  agent.session.append('turn/start', { turn: 1 })
  agent.session.append('user/message', createUserMessage({ source: { kind: 'user' },
    content: [{ type: 'text', text: 'account-' + id }, { type: 'file', attachment: file }] }), { surfaceOp: 'append' })
  agent.session.append('turn/end', { turn: 1, reason: { kind: 'completed' } })
  expect(await ctx.sessions.flush(agent.session)).toBe(true)
  const connection = ctx.connection, route = connection.createSharedFetchHandler('/api'), peer = connection.browserPeer
  const track = <T>(work: Promise<T>): Promise<T> => { pending.push(work); void work.catch(() => {}); return work }
  const fetch = async (sid = sessionId, options: RequestInit = {}, descendants = false): Promise<Response> => {
    const url = `http://account.invalid${SESSION_LOG_EXPORT_PATH}?sessionId=${encodeURIComponent(sid)}&includeDescendants=${String(descendants)}`
    const response = await route.fetch(new Request(url, options), peer)
    responses.push(response)
    return response
  }
  const command = async (line: string) => {
    const response = await route.fetch(new Request('http://account.invalid/api/commands/execute', { method: 'POST',
      headers: { 'content-type': 'application/json' }, body: JSON.stringify({ type: 'client-request', rpcId: 'export-command',
        method: 'commands/execute', payload: { args: { agentId: agent.id, line, submittedAttachments: [] } } }) }), peer)
    const result: unknown = await response.json()
    return { response, result }
  }
  const gateRootRead = () => {
    const entered = Promise.withResolvers<undefined>(), released = Promise.withResolvers<undefined>()
    const open = ctx.sessionPersistence.open.bind(ctx.sessionPersistence)
    let closes = 0
    releases.push(() => { released.resolve(undefined) })
    vi.spyOn(ctx.sessionPersistence, 'open').mockImplementation(async (...args) => {
      const channel = await open(...args), read = channel.read.bind(channel), close = channel.close.bind(channel)
      vi.spyOn(channel, 'read').mockImplementation(async (...readArgs) => {
        const value = await read(...readArgs)
        entered.resolve(undefined); await released.promise
        return value
      })
      vi.spyOn(channel, 'close').mockImplementation(async () => { closes++; await close() })
      return channel
    })
    return { entered: entered.promise, release() { released.resolve(undefined) }, closes: () => closes }
  }
  const gateFileRead = () => {
    const entered = Promise.withResolvers<undefined>(), settled = Promise.withResolvers<undefined>()
    const read = ctx.attachments.readFileStream.bind(ctx.attachments), signals: AbortSignal[] = []
    vi.spyOn(ctx.attachments, 'readFileStream').mockImplementation(async function* (ref: FileAttachmentRef, signal) {
      if (signal === undefined) throw new Error('The native export lost its producer signal.')
      signals.push(signal); entered.resolve(undefined)
      try {
        await new Promise<undefined>((resolve) => {
          if (signal.aborted) resolve(undefined)
          else signal.addEventListener('abort', () => { resolve(undefined) }, { once: true })
        })
        yield* read(ref, signal)
      } finally { settled.resolve(undefined) }
    })
    return { entered: entered.promise, settled: settled.promise, signals }
  }
  return { ctx, home, agent, sessionId, lifetime, file, policy, registration, registry, fetch, command, gateRootRead, gateFileRead, track,
    async createDescendant() {
      const childId = SessionId('native-export-descendant')
      const child = await ctx.agents.create({ sessionId: childId,
        meta: { cwd: '/account-project', parentSession: sessionId, delegationDepth: 1 } })
      disposals.push(child.dispose.bind(child))
      return childId
    },
    closeBusiness() { businessCurrent = false }, async unload() {
      const row = [...ctx.loader.entries()].find(row => row.options.id === 'download')
      if (row?.fiber === undefined) throw new Error('The original export Loader fiber is absent.')
      await row.fiber.dispose()
    } }
}

it('streams the original ZIP over the exact GET route and discovers /export through native HTTP Gateway', async () => {
  const f = await fixture('zip')
  expect(f.registration.inspect().exactFetchRoutes).toHaveLength(2)
  const command = await f.command('/export')
  expect(command.response.status).toBe(200)
  expect(command.result).toMatchObject({ result: { ok: true, value: { result: { kind: 'success', text: 'Session log download requested.' } } } })
  const refused = await f.command('/export /host/private/file.zip')
  expect(refused.result).toMatchObject({ result: { ok: true, value: { result: { kind: 'error', text: 'The Web /export command does not accept a path.' } } } })
  const response = await f.fetch()
  expect(response.status).toBe(200)
  expect(response.headers.get('content-type')).toBe('application/zip')
  expect(response.headers.get('content-disposition')).not.toContain(f.home)
  const files = unzipSync(new Uint8Array(await response.arrayBuffer()))
  const log = files[SESSION_LOG_FILENAME]
  if (log === undefined) throw new Error('The original ZIP omitted its canonical Session log.')
  expect(strFromU8(log)).toContain('account-zip')
  expect(strFromU8(log)).not.toContain(f.home)
  const archived = Object.entries(files).find(([path]) => path.startsWith('files/'))
  expect(archived?.[0]).toMatch(/\/account\.txt$/u)
  expect(archived === undefined ? undefined : strFromU8(archived[1])).toBe('file-zip')
  const head = await f.fetch(f.sessionId, { method: 'HEAD' })
  expect(head.status).toBe(200); expect(head.body).toBeNull()
  expect(head.headers.get('content-type')).toBe('application/zip')
})

it('includes descendant JSONL chosen by the original lineage query and streams each native log into the ZIP', async () => {
  const f = await fixture('descendants'), child = await f.createDescendant()
  const response = await f.fetch(f.sessionId, {}, true)
  expect(response.status).toBe(200)
  const files = unzipSync(new Uint8Array(await response.arrayBuffer()))
  expect(Object.keys(files).filter(path => path.endsWith(SESSION_LOG_FILENAME)))
    .toEqual([SESSION_LOG_FILENAME, `subagents/${child}/${SESSION_LOG_FILENAME}`])
  const log = files[`subagents/${child}/${SESSION_LOG_FILENAME}`]
  if (log === undefined) throw new Error('The original ZIP omitted its descendant log.')
  expect(strFromU8(log)).toContain(`"parentSession":"${f.sessionId}"`)
  expect(strFromU8(log)).not.toContain(f.home)
})

it('isolates accounts with identical Session ids and rejects foreign sessions, Agents and unselected routes', async () => {
  const [a, b] = await Promise.all([fixture('a'), fixture('b')])
  expect(a.sessionId).toBe(b.sessionId)
  for (const [actual, own, other] of [[a, 'account-a', 'account-b'], [b, 'account-b', 'account-a']] as const) {
    const files = unzipSync(new Uint8Array(await (await actual.fetch()).arrayBuffer())), log = files[SESSION_LOG_FILENAME]
    if (log === undefined) throw new Error('The account ZIP log is missing.')
    expect(strFromU8(log)).toContain(own); expect(strFromU8(log)).not.toContain(other)
  }
  const open = vi.spyOn(a.ctx.sessionPersistence, 'open')
  await expect(a.fetch(SessionId('foreign-account-session'))).rejects.toMatchObject({ code: 'cloud/forbidden' })
  expect(open).not.toHaveBeenCalled()
  await expect(a.registry.value.execute(b.agent, '/export', [], new AbortController().signal))
    .rejects.toMatchObject({ code: 'cloud/forbidden' })
  const closed = await fixture('unselected', false)
  expect(closed.registration.inspect().exactFetchRoutes).toEqual([])
  await expect(closed.fetch()).rejects.toMatchObject({ code: 'cloud/forbidden' })
})

it('rechecks business admission after the actual root read before creating a ZIP without requiring lifetime abort', async () => {
  const f = await fixture('business-read'), gate = f.gateRootRead(), pending = f.track(f.fetch())
  await gate.entered
  f.closeBusiness(); gate.release()
  const response = await pending
  expect(f.lifetime.signal.aborted).toBe(false)
  expect(response.status).toBe(500)
  expect(response.headers.get('content-type')).not.toBe('application/zip')
  expect(await response.text()).toBe('session log export failed to read the stored log')
  expect(gate.closes()).toBe(1)
})

it('closes a root read on generation cancellation and keeps private storage paths out of read failures', async () => {
  const f = await fixture('lifetime-read'), gate = f.gateRootRead(), pending = f.track(f.fetch())
  const rejected = expect(pending).rejects.toThrow('account generation ended')
  await gate.entered
  f.lifetime.abort(new Error('account generation ended')); gate.release()
  await rejected
  expect(gate.closes()).toBe(1)
  const error = await fixture('private-read-error')
  vi.spyOn(error.ctx.sessionPersistence, 'open').mockRejectedValueOnce(new Error(error.home + '/private/session.jsonl'))
  const response = await error.fetch()
  expect(response.status).toBe(500)
  expect(await response.text()).toBe('session log export failed to read the stored log')
})

it.each(['body', 'lifetime', 'unload'] as const)('stops the native attachment stream after %s cancellation', async (end) => {
  const f = await fixture('stream-' + end), gate = f.gateFileRead(), response = await f.fetch()
  const body = response.body
  if (body === null) throw new Error('The native ZIP response did not stream.')
  const reader = body.getReader(), chunks = f.track((async () => { while (!(await reader.read()).done) { /* drain native chunks */ } })())
  const settled = chunks.then(() => 'closed', () => 'rejected')
  await gate.entered
  if (end === 'body') await reader.cancel(new Error('download cancelled'))
  else if (end === 'lifetime') f.lifetime.abort(new Error('account generation ended'))
  else await f.unload()
  await gate.settled
  expect(gate.signals).toHaveLength(1); expect(gate.signals[0]?.aborted).toBe(true)
  expect(await settled).toBe(end === 'body' ? 'closed' : 'rejected')
  reader.releaseLock()
  if (end === 'unload') {
    expect((await f.fetch()).status).toBe(404)
    expect(f.ctx.commands.find(f.agent, 'export')).toBeUndefined()
    expect(() => f.registration.inspect()).toThrow()
  }
})
