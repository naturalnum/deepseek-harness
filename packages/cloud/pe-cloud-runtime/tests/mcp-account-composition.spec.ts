/** Real native Loader, AccountPolicy, Gateway, Agent and HTTP MCP composition; authentication uses one synthetic Peer edge. */
import type { Context } from '@deepseek-ai/cordis'
import { brandString } from '@deepseek-ai/dsh-brand'
import { ToolCallId, type GenerateOptions, type StreamChunk } from '@deepseek-ai/dsh-llm'
import type { CloudMcpConnectionReply, CloudMcpConnectionRequest, ApprovedMcpConnections } from '@deepseek-ai/dsh-pe-cloud-api'
import type { AccountUse } from '../src/types.ts'
import type { PeerId, PeerScope } from '@deepseek-ai/dsh-typert-protocol'
import { expect, it, vi } from 'vitest'
import { textResponse, toolCallResponse } from '../../../core/agent-loop/tests/mock-adapter.ts'
import { policyFixture } from './account-policy-fixture.ts'
import { startHttpMcpFixture } from '../../../mcp/mcp-client/tests/http-fixture.ts'
import * as nativeTransport from '../../../mcp/mcp-client/src/transport.ts'
import Credentials from '@deepseek-ai/dsh-credentials-local'

const policy: ApprovedMcpConnections = {
  limits: { maxConnections: 4, maxUrlBytes: 2048, maxHeaderBytes: 4096, maxHeaderCount: 8,
    maxToolCallTimeoutMs: 2000, maxRequestBytes: 20000, maxReplyBytes: 65536 },
  runtime: { maxInstructionBytes: 4096, reconnect: { enabled: true, initialDelayMs: 20, maxDelayMs: 50, maxAttempts: 2 } },
}

async function account(name: string) {
  const login = new AbortController()
  const fixture = policyFixture([{ endpoint: 'cloudMcpConnections/action', handlerId: 'native:cloudMcpConnections', guard: 'authenticated-account' }],
    undefined, name, { selected: [], inspectRootFetch: () => [] }, undefined, undefined, undefined, undefined, [], false, undefined, {
      withPeerUse(peer, consume) {
        if (peer !== authenticated) throw new Error('Foreign test authentication Peer')
        const current = (): void => {
          peer.signal.throwIfAborted(); graph.binding.lifetime.throwIfAborted(); graph.ctx.fiber.assertActive()
        }
        const use: AccountUse = { binding: graph.binding, context: graph.ctx, assertCurrent: current, release() {} }
        return consume(use, current)
      },
      defaultId: 'cloud-chat', declarations: [{ entryId: 'cloud-preset', selectable: true, config: { id: 'cloud-chat', plugins: [
        { id: 'persona', name: 'cordis:m8z-persona', config: { prefix: 'Reply briefly.', complete: true, includeRuntimeContext: false } },
      ] } }],
      extraEntries: [{ id: 'mcp-connections', name: 'cordis:fixture-mcp-connections' }],
      prepare(ctx, binding, guards) {
        ctx.loader.builtins['fixture-mcp-connections'] = {
          inject: ['peCloudApi', 'peCloudFiles', 'workspaceRegistry', 'typertGateway', 'tools', 'storageDomain', 'credentials'],
          async apply(owner: Context) {
            const api = owner.get('peCloudApi'), files = owner.get('peCloudFiles')
            if (api === undefined || files === undefined) throw new Error('Original account providers are absent')
            await api.prepareCloudMcpConnections(owner, { files, policy,
              assertBusinessCurrent: () => { owner.fiber.assertActive(); binding.lifetime.throwIfAborted(); api.requireRpc('session/create') },
              assertToolCurrent: (exec) => {
                if (exec.agent === undefined) throw new Error('Native MCP requires the original Agent')
                guards.projectForAgent(exec.agent)
              },
            })
          },
        }
      },
    })
  const graph = await fixture.start()
  const authenticated: PeerScope = { id: brandString<PeerId>('mcp-peer-' + name), ctx: graph.ctx, principal: { kind: 'owner' },
    interactions: 'answer', signal: login.signal, dispose: () => Promise.resolve() }
  const peer = authenticated
  const invoke = (request: CloudMcpConnectionRequest): Promise<CloudMcpConnectionReply> => graph.ctx.typertGateway.invoke({
    namespace: 'cloudMcpConnections', method: 'action', args: { request }, peer,
  }) as Promise<CloudMcpConnectionReply>
  return { ...graph, invokeMcp: invoke, peer, revokeLogin: () => { login.abort() } }
}

it('discovers and calls an HTTP MCP tool through an original guarded account Agent and keeps the other account isolated', async () => {
  const external = await startHttpMcpFixture({ requiredAuthorization: 'Bearer synthetic-composition-token' })
  try {
    const a = await account('mcp-a'), b = await account('mcp-b')
    const initial = await a.invokeMcp({ action: 'list' })
    const wrong = await a.invokeMcp({ action: 'test', connection: { serverName: 'compute', url: external.url,
      enabled: true, toolCallTimeoutMs: 2000, headers: { Authorization: 'Bearer synthetic-wrong-token' } } })
    expect(wrong.test).toEqual({ reachable: false, toolCount: 0, failure: 'connection-failed' })
    expect(a.saveBarrier.snapshot().failures).toEqual([])
    const saved = await a.invokeMcp({ action: 'save', version: initial.version, connection: { serverName: 'compute',
      url: external.url, enabled: true, toolCallTimeoutMs: 2000, headers: { Authorization: 'Bearer synthetic-composition-token' } } })
    expect(saved.connections).toHaveLength(1)
    expect(saved.connections[0]?.toolCount).toBe(1)
    expect(JSON.stringify(saved)).not.toContain('synthetic-composition-token')
    expect((await b.invokeMcp({ action: 'list' })).connections).toEqual([])
    const created = await a.ctx.sessionController.create({}), agent = a.ctx.agents.get(created.sessionId)
    const other = await b.ctx.sessionController.create({}), foreign = b.ctx.agents.get(other.sessionId)
    if (agent === undefined || foreign === undefined) throw new Error('Original native Agents were not created')
    expect(a.guards.projectForAgent(agent)).toBe(a.files.project().workspace)
    const called = await a.ctx.tools.execute({ agent, name: 'mcp__compute__ping', arguments: {},
      callId: ToolCallId('account-mcp'), signal: new AbortController().signal })
    expect(called).toMatchObject({ isError: false, value: { content: [{ type: 'text', text: 'pong' }] } })
    const denied = await a.ctx.tools.execute({ agent: foreign, name: 'mcp__compute__ping', arguments: {},
      callId: ToolCallId('foreign-account-mcp'), signal: new AbortController().signal })
    expect(denied.isError).toBe(true)
    let modelCalls = 0
    vi.spyOn(a.adapter, 'stream').mockImplementation(async function* (options: GenerateOptions): AsyncIterable<StreamChunk> {
      expect(options.tools.some(tool => tool.name === 'mcp__compute__ping')).toBe(true)
      if (modelCalls++ === 0) yield* toolCallResponse('native-mcp-model-call', 'mcp__compute__ping', {})
      else yield* textResponse('MCP replied pong.')
    })
    const finished: PromiseWithResolvers<void> = Promise.withResolvers()
    a.ctx.on('session/event', (session, event) => {
      if (session.id === created.sessionId && event.type === 'turn/end') finished.resolve()
    })
    await expect(a.invoke('prompt', { sessionId: created.sessionId, requestId: 'mcp-native-model-turn', mode: 'followup',
      content: [{ type: 'text', text: 'Call the configured MCP ping tool.' }] })).resolves.toEqual({ accepted: true })
    await finished.promise
    await a.ctx.sessionPersistence.flush()
    const history = JSON.stringify(a.ctx.sessions.get(created.sessionId)?.snapshotEvents())
    expect(modelCalls).toBe(2)
    expect(history).toContain('native-mcp-model-call')
    expect(history).toContain('pong')
    expect(history).not.toContain('synthetic-composition-token')
    const row = saved.connections[0]
    if (row === undefined) throw new Error('Saved connection is absent')
    await expect(a.invokeMcp({ action: 'enabled', id: row.id, version: initial.version, enabled: false }))
      .rejects.toMatchObject({ code: 'cloud/config-conflict' })
    expect(a.saveBarrier.snapshot().failures).toEqual([])
    await expect(a.invokeMcp({ action: 'save', version: saved.version, connection: { serverName: 'compute',
      url: external.url, enabled: true, toolCallTimeoutMs: 2000 } })).rejects.toMatchObject({ code: 'cloud/config-conflict' })
    expect(a.saveBarrier.snapshot().failures).toEqual([])
    const disabled = await a.invokeMcp({ action: 'enabled', id: row.id, version: saved.version, enabled: false })
    expect(disabled.connections[0]?.enabled).toBe(false)
    expect(a.ctx.tools.schemas().some(tool => tool.name === 'mcp__compute__ping')).toBe(false)
    a.closeBusiness()
    await expect(a.invokeMcp({ action: 'list' })).rejects.toThrow()
  } finally { await external.close() }
}, 20000)

it('recovers real HTTP discovery after a temporary outage and reports a bounded native tool timeout', async () => {
  const external = await startHttpMcpFixture({ requiredAuthorization: 'Bearer synthetic-reconnect-token' })
  try {
    external.setAvailable(false)
    const a = await account('mcp-reconnect'), initial = await a.invokeMcp({ action: 'list' })
    const saved = await a.invokeMcp({ action: 'save', version: initial.version,
      connection: { serverName: 'compute', url: external.url, enabled: true, toolCallTimeoutMs: 50,
        headers: { Authorization: 'Bearer synthetic-reconnect-token' } } })
    expect(saved.connections[0]?.toolCount).toBe(0)
    external.setAvailable(true)
    await vi.waitFor(() => { expect(a.ctx.tools.schemas().some(tool => tool.name === 'mcp__compute__ping')).toBe(true) })
    const created = await a.ctx.sessionController.create({}), agent = a.ctx.agents.get(created.sessionId)
    if (agent === undefined) throw new Error('Original native Agent absent')
    external.setToolDelay(150)
    const timeout = await a.ctx.tools.execute({ agent, name: 'mcp__compute__ping', arguments: {},
      callId: ToolCallId('mcp-timeout'), signal: new AbortController().signal })
    expect(timeout.isError).toBe(true)
    external.setToolDelay(0)
    const recovered = await a.ctx.tools.execute({ agent, name: 'mcp__compute__ping', arguments: {},
      callId: ToolCallId('mcp-after-timeout'), signal: new AbortController().signal })
    expect(recovered).toMatchObject({ isError: false, value: { content: [{ type: 'text', text: 'pong' }] } })
    expect(external.authorization.every(header => header === 'Bearer synthetic-reconnect-token')).toBe(true)
    expect(a.saveBarrier.snapshot().failures).toEqual([])
  } finally { await external.close() }
}, 20000)

it('cancels a negotiating HTTP probe on login withdrawal, joins transport disposal and leaves no model-visible tools or failed save', async () => {
  const external = await startHttpMcpFixture(), held = external.holdNextRequest()
  try {
    const a = await account('mcp-probe-cancel'), initial = await a.invokeMcp({ action: 'list' })
    const probing = a.invokeMcp({ action: 'test', connection: {
      serverName: 'transient', url: external.url, enabled: true, toolCallTimeoutMs: 2000 } })
    let settled = false
    const outcome = probing.then(() => ({ ok: true as const }), () => ({ ok: false as const }))
      .finally(() => { settled = true })
    await held.entered
    const queued = a.invokeMcp({ action: 'save', version: initial.version, connection: {
      serverName: 'must-not-publish', url: external.url, enabled: true, toolCallTimeoutMs: 2000,
      headers: { Authorization: 'Bearer synthetic-revoked-token' } } }).then(() => true, () => false)
    a.revokeLogin()
    await vi.waitFor(() => { expect(settled).toBe(true) }, { timeout: 2000 })
    expect(await outcome).toEqual({ ok: false })
    expect(await queued).toBe(false)
    expect(await a.ctx.credentials.listRecords()).toEqual([])
    expect(a.ctx.tools.schemas().filter(tool => tool.name.startsWith('mcp__'))).toEqual([])
    expect(a.saveBarrier.snapshot().pending).toEqual([])
    expect(a.saveBarrier.snapshot().failures).toEqual([])
  } finally { held.release(); await external.close() }
}, 20000)

it('retains a real native HTTP probe whose transport rejects closure and refuses to treat a resolved fiber disposer as release', async () => {
  const external = await startHttpMcpFixture(), create = nativeTransport.createTransport
  const originalClosers: Array<() => Promise<void>> = []
  const transport = vi.spyOn(nativeTransport, 'createTransport').mockImplementation((config) => {
    const actual = create(config)
    originalClosers.push(actual.close.bind(actual))
    actual.close = () => Promise.reject(new Error('synthetic transport close failure'))
    return actual
  })
  try {
    const a = await account('mcp-probe-unknown')
    await expect(a.invokeMcp({ action: 'test', connection: {
      serverName: 'transient', url: external.url, enabled: true, toolCallTimeoutMs: 2000 } })).rejects.toThrow()
    expect(originalClosers.length).toBeGreaterThan(0)
    expect(a.ctx.tools.schemas().filter(tool => tool.name.startsWith('mcp__'))).toEqual([])
    expect(a.saveBarrier.snapshot().failures).toMatchObject([{ kind: 'mcp-connection', outcome: 'unknown' }])
    a.expectUnknownSave()
    await a.close()
  } finally {
    transport.mockRestore()
    for (const close of originalClosers) await close()
    await external.close()
  }
}, 20000)

it('rechecks the original login inside the actual native credential mutation and certifies a revoked zero-write refusal', async () => {
  const external = await startHttpMcpFixture()
  try {
    const a = await account('mcp-credential-revoke'), initial = await a.invokeMcp({ action: 'list' })
    // oxlint-disable-next-line typescript/unbound-method -- Invoked below with the original provider as explicit receiver.
    const modify = Credentials.prototype.modifyRecord
    const gate = vi.spyOn(Credentials.prototype, 'modifyRecord').mockImplementation(function (this: Credentials, key, mutate) {
      a.revokeLogin()
      return modify.call(this, key, mutate)
    })
    try {
      await expect(a.invokeMcp({ action: 'save', version: initial.version, connection: {
        serverName: 'must-not-publish', url: external.url, enabled: true, toolCallTimeoutMs: 2000,
        headers: { Authorization: 'Bearer synthetic-revoked-before-commit' } } })).rejects.toThrow()
      expect(gate).toHaveBeenCalledOnce()
      expect(await a.ctx.credentials.listRecords()).toEqual([])
      expect(a.ctx.tools.schemas().filter(tool => tool.name.startsWith('mcp__'))).toEqual([])
      expect(external.authorization).toEqual([])
      expect(a.saveBarrier.snapshot().failures).toEqual([])
    } finally { gate.mockRestore() }
  } finally { await external.close() }
}, 20000)

it('serializes competing edit/toggle/remove operations with the provider apply and rejects the stale version without retaining failure', async () => {
  const external = await startHttpMcpFixture()
  try {
    const a = await account('mcp-concurrent'), initial = await a.invokeMcp({ action: 'list' })
    const saved = await a.invokeMcp({ action: 'save', version: initial.version,
      connection: { serverName: 'compute', url: external.url, enabled: true, toolCallTimeoutMs: 2000 } })
    const row = saved.connections[0]
    if (row === undefined) throw new Error('Native MCP connection is absent')
    const edited = a.invokeMcp({ action: 'save', id: row.id, version: saved.version,
      connection: { serverName: 'renamed', url: external.url, enabled: true, toolCallTimeoutMs: 2000 } })
    const toggled = a.invokeMcp({ action: 'enabled', id: row.id, version: saved.version, enabled: false })
    const first = await Promise.allSettled([edited, toggled])
    expect(first.filter(value => value.status === 'fulfilled')).toHaveLength(1)
    expect(first.filter(value => value.status === 'rejected')).toHaveLength(1)
    const current = await a.invokeMcp({ action: 'list' })
    expect(a.ctx.tools.schemas().filter(tool => tool.name.startsWith('mcp__')).map(tool => tool.name)).toEqual(['mcp__renamed__ping'])
    const removal = a.invokeMcp({ action: 'remove', id: row.id, version: current.version })
    const enable = a.invokeMcp({ action: 'enabled', id: row.id, version: current.version, enabled: true })
    const second = await Promise.allSettled([removal, enable])
    expect(second.filter(value => value.status === 'fulfilled')).toHaveLength(1)
    expect(second.filter(value => value.status === 'rejected')).toHaveLength(1)
    expect((await a.invokeMcp({ action: 'list' })).connections).toEqual([])
    expect(a.ctx.tools.schemas().filter(tool => tool.name.startsWith('mcp__'))).toEqual([])
    expect(a.saveBarrier.snapshot().failures).toEqual([])
  } finally { await external.close() }
}, 20000)
