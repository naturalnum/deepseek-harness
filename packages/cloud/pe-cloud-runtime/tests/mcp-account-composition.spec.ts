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
import { AccountMcpConnections } from '../../pe-cloud-api/src/mcp-connection-runtime.ts'

const policy: ApprovedMcpConnections = {
  limits: { maxConnections: 4, maxUrlBytes: 2048, maxHeaderBytes: 4096, maxHeaderCount: 8,
    maxToolCallTimeoutMs: 2000, maxRequestBytes: 20000, maxReplyBytes: 65536 },
  runtime: { maxInstructionBytes: 4096, maxIncomingResponseBytes: 4194304, listMaxPages: 4,
    reconnect: { enabled: true, initialDelayMs: 20, maxDelayMs: 50, maxAttempts: 2 } },
}
const manualRecoveryPolicy: ApprovedMcpConnections = { ...policy, runtime: { ...policy.runtime,
  reconnect: { ...policy.runtime.reconnect, enabled: false } } }

async function account(name: string, selectedPolicy: ApprovedMcpConnections = policy) {
  const uses = new Map<PeerScope, AccountUse>()
  const fixture = policyFixture([{ endpoint: 'cloudMcpConnections/action', handlerId: 'native:cloudMcpConnections', guard: 'authenticated-account' }],
    undefined, name, { selected: [], inspectRootFetch: () => [] }, undefined, undefined, undefined, undefined, [], false, undefined, {
      withPeerUse(peer, consume) {
        const use = uses.get(peer)
        if (use === undefined) throw new Error('Foreign test authentication Peer')
        return consume(use, () => { use.assertCurrent() })
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
            await api.prepareCloudMcpConnections(owner, { files, policy: selectedPolicy,
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
  const start = async (epoch: string) => {
    const graph = await fixture.start(epoch), login = new AbortController()
    const peer: PeerScope = { id: brandString<PeerId>('mcp-peer-' + name + '-' + epoch), ctx: graph.ctx, principal: { kind: 'owner' },
      interactions: 'answer', signal: login.signal, dispose: () => Promise.resolve() }
    const current = (): void => {
      peer.signal.throwIfAborted(); graph.binding.lifetime.throwIfAborted(); graph.ctx.fiber.assertActive()
    }
    uses.set(peer, { binding: graph.binding, context: graph.ctx, assertCurrent: current, release() {} })
    const invoke = (request: CloudMcpConnectionRequest): Promise<CloudMcpConnectionReply> => graph.ctx.typertGateway.invoke({
      namespace: 'cloudMcpConnections', method: 'action', args: { request }, peer,
    }) as Promise<CloudMcpConnectionReply>
    return { ...graph, invokeMcp: invoke, peer, revokeLogin: () => { login.abort() } }
  }
  return { ...await start('1'), coldStart: () => start('2') }
}

it('restores persisted HTTP tools before a cold account Agent assembles its first model request without visiting MCP settings', async () => {
  const external = await startHttpMcpFixture({ requiredAuthorization: 'Bearer synthetic-cold-account-token' })
  try {
    const warm = await account('mcp-cold'), first = await warm.invokeMcp({ action: 'list' })
    await warm.invokeMcp({ action: 'save', version: first.version, connection: { serverName: 'compute', url: external.url,
      enabled: true, toolCallTimeoutMs: 2000, headers: { Authorization: 'Bearer synthetic-cold-account-token' } } })
    await warm.close()
    const cold = await warm.coldStart(), foreign = await account('mcp-cold-foreign')
    expect(cold.ctx.tools.schemas().filter(tool => tool.name.startsWith('mcp__'))).toEqual([])
    const requests = external.authorization.length
    expect((await cold.ctx.systemPrompt.assemble()).tools.filter(tool => tool.name.startsWith('mcp__'))).toEqual([])
    expect(external.authorization).toHaveLength(requests)
    let calls = 0
    vi.spyOn(cold.adapter, 'stream').mockImplementation(async function* (options: GenerateOptions): AsyncIterable<StreamChunk> {
      expect(options.tools?.some(tool => tool.name === 'mcp__compute__ping')).toBe(true)
      if (calls++ === 0) yield* toolCallResponse('cold-first-model-mcp', 'mcp__compute__ping', {})
      else yield* textResponse('The real MCP replied pong.')
    })
    const created = await cold.ctx.sessionController.create({})
    const completed: PromiseWithResolvers<void> = Promise.withResolvers()
    cold.ctx.on('session/event', (session, event) => {
      if (session.id === created.sessionId && event.type === 'turn/end') completed.resolve()
    })
    // No MCP list/test/save is sent to this new account graph before its first model turn.
    await cold.invoke('prompt', { sessionId: created.sessionId, requestId: 'cold-mcp-first-turn', mode: 'followup',
      content: [{ type: 'text', text: 'Use the configured MCP ping tool.' }] })
    await completed.promise; await cold.ctx.sessionPersistence.flush()
    expect(calls).toBe(2)
    expect(external.calls).toEqual(['ping'])
    const history = JSON.stringify(cold.ctx.sessions.get(created.sessionId)?.snapshotEvents())
    expect(history).toContain('cold-first-model-mcp'); expect(history).toContain('pong')
    expect(history).not.toContain('synthetic-cold-account-token')
    const other = await foreign.ctx.sessionController.create({})
    const otherCompleted: PromiseWithResolvers<void> = Promise.withResolvers()
    vi.spyOn(foreign.adapter, 'stream').mockImplementation(async function* (options: GenerateOptions): AsyncIterable<StreamChunk> {
      expect(options.tools?.some(tool => tool.name.startsWith('mcp__')) ?? false).toBe(false)
      yield* textResponse('No MCP tool is configured for this account.')
    })
    foreign.ctx.on('session/event', (session, event) => {
      if (session.id === other.sessionId && event.type === 'turn/end') otherCompleted.resolve()
    })
    await foreign.invoke('prompt', { sessionId: other.sessionId, requestId: 'cold-foreign-first-turn', mode: 'followup',
      content: [{ type: 'text', text: 'Use an MCP tool if configured.' }] })
    await otherCompleted.promise
    expect(external.calls).toEqual(['ping'])
  } finally { await external.close() }
}, 20000)

it('discovers and calls an HTTP MCP tool through an original guarded account Agent and keeps the other account isolated', async () => {
  const external = await startHttpMcpFixture({ requiredAuthorization: 'Bearer synthetic-composition-token' })
  try {
    const a = await account('mcp-a'), b = await account('mcp-b')
    const initial = await a.invokeMcp({ action: 'list' })
    const wrong = await a.invokeMcp({ action: 'test', connection: { serverName: 'compute', url: external.url,
      enabled: true, toolCallTimeoutMs: 2000, headers: { Authorization: 'Bearer synthetic-wrong-token' } } })
    expect(wrong.test).toEqual({ reachable: false, toolCount: 0, failure: 'connection-failed' })
    expect(a.saveBarrier.snapshot().failures).toEqual([])
    const correct = await a.invokeMcp({ action: 'test', connection: { serverName: 'compute', url: external.url,
      enabled: true, toolCallTimeoutMs: 2000, headers: { Authorization: 'Bearer synthetic-composition-token' } } })
    expect(correct.test).toEqual({ reachable: true, toolCount: 1 })
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
      if (options.tools === undefined) throw new Error('The original native model tool list is absent')
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
    await a.invokeMcp({ action: 'enabled', id: row.id, version: disabled.version, enabled: true })
    expect(a.ctx.tools.schemas().some(tool => tool.name === 'mcp__compute__ping')).toBe(true)
    const tools = a.ctx.tools
    a.closeBusiness()
    a.revokeLogin()
    await expect(a.invokeMcp({ action: 'list' })).rejects.toThrow()
    await a.close()
    expect(tools.schemas().some(tool => tool.name === 'mcp__compute__ping')).toBe(false)
    expect(await a.observeNativeDisposal()).toEqual({ status: 'confirmed', errorEvents: 0, warningEvents: 0, overflow: false })
    expect((await b.invokeMcp({ action: 'list' })).connections).toEqual([])
  } finally { await external.close() }
}, 20000)

it('contains an oversized remote HTTP result to its original account and admits later bounded results', async () => {
  const external = await startHttpMcpFixture(), other = await startHttpMcpFixture()
  try {
    const boundedPolicy = { ...policy, runtime: { ...policy.runtime, maxIncomingResponseBytes: 4096 } }
    const a = await account('mcp-byte-a', boundedPolicy), b = await account('mcp-byte-b', boundedPolicy)
    for (const [graph, service] of [[a, external], [b, other]] as const) {
      const initial = await graph.invokeMcp({ action: 'list' })
      await graph.invokeMcp({ action: 'save', version: initial.version, connection: { serverName: 'compute',
        url: service.url, enabled: true, toolCallTimeoutMs: 2000 } })
    }
    const createdA = await a.ctx.sessionController.create({}), createdB = await b.ctx.sessionController.create({})
    const agentA = a.ctx.agents.get(createdA.sessionId), agentB = b.ctx.agents.get(createdB.sessionId)
    if (agentA === undefined || agentB === undefined) throw new Error('Original native Agents absent')
    external.setToolText('x'.repeat(8192))
    const invoke = (graph: typeof a, agent: typeof agentA, id: string) => graph.ctx.tools.execute({ agent,
      name: 'mcp__compute__ping', arguments: {}, callId: ToolCallId(id), signal: new AbortController().signal })
    expect((await invoke(a, agentA, 'oversized-a')).isError).toBe(true)
    expect(await invoke(b, agentB, 'bounded-b')).toMatchObject({ isError: false,
      value: { content: [{ type: 'text', text: 'pong' }] } })
    external.setToolText('pong')
    expect(await invoke(a, agentA, 'recovered-a')).toMatchObject({ isError: false,
      value: { content: [{ type: 'text', text: 'pong' }] } })
    expect(a.saveBarrier.snapshot().failures).toEqual([])
    expect(b.saveBarrier.snapshot().failures).toEqual([])
  } finally { await external.close(); await other.close() }
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

it('reapplies an unchanged saved zero-tool connection after one authenticated probe and serves a new model turn', async () => {
  const external = await startHttpMcpFixture({ requiredAuthorization: 'Bearer synthetic-manual-recovery' })
  const neighbor = await startHttpMcpFixture({ requiredAuthorization: 'Bearer synthetic-neighbor' })
  const apply = vi.spyOn(AccountMcpConnections.prototype, 'apply')
  try {
    external.setAvailable(false)
    // A completed initial refusal is a real zero-tool state without a pending retry that could publish during the probe.
    const a = await account('mcp-manual-recovery', manualRecoveryPolicy), b = await account('mcp-manual-foreign')
    const initial = await a.invokeMcp({ action: 'list' })
    const zero = await a.invokeMcp({ action: 'save', version: initial.version,
      connection: { serverName: 'foo', url: external.url, enabled: true, toolCallTimeoutMs: 1000,
        headers: { Authorization: 'Bearer synthetic-manual-recovery' } } })
    const saved = await a.invokeMcp({ action: 'save', version: zero.version,
      connection: { serverName: 'foo__bar', url: neighbor.url, enabled: true, toolCallTimeoutMs: 1000,
        headers: { Authorization: 'Bearer synthetic-neighbor' } } })
    const row = saved.connections[0], other = saved.connections[1]
    if (row === undefined || other === undefined) throw new Error('Original saved MCP connections absent')
    expect(row.toolCount).toBe(0)
    expect(other.toolCount).toBe(1)
    expect(a.ctx.tools.schemas().filter(tool => tool.name.startsWith('mcp__')).map(tool => tool.name)).toEqual(['mcp__foo__bar__ping'])
    const applications = () => apply.mock.calls.filter(([value]) => value.id === row.id).length
    const neighborApplications = () => apply.mock.calls.filter(([value]) => value.id === other.id).length
    expect(applications()).toBe(1)
    expect(neighborApplications()).toBe(1)
    const definition = { serverName: row.serverName, url: row.url, enabled: row.enabled, toolCallTimeoutMs: row.toolCallTimeoutMs }
    const refused = await a.invokeMcp({ action: 'test', id: row.id, connection: definition })
    expect(refused.test).toEqual({ reachable: false, toolCount: 0, failure: 'connection-failed' })
    expect(refused.connections[0]).toEqual(row)
    expect(applications()).toBe(1)
    expect(a.saveBarrier.snapshot().failures).toEqual([])
    external.setAvailable(true)
    for (const patch of [{ serverName: 'draft' }, { url: row.url + '?draft=1' }, { enabled: false },
      { toolCallTimeoutMs: row.toolCallTimeoutMs + 1 }, { headers: { Authorization: 'Bearer synthetic-manual-recovery' } }]) {
      const probed = await a.invokeMcp({ action: 'test', id: row.id, connection: { ...definition, ...patch } })
      expect(probed.test).toMatchObject({ reachable: true, toolCount: 1 })
      expect(probed.connections[0]).toEqual(row)
      expect(probed.version).toBe(saved.version)
      expect(applications()).toBe(1)
    }
    const transient = await a.invokeMcp({ action: 'test', connection: { ...definition, serverName: 'transient',
      headers: { Authorization: 'Bearer synthetic-manual-recovery' } } })
    expect(transient.test).toMatchObject({ reachable: true, toolCount: 1 })
    expect(transient.connections[0]).toEqual(row)
    expect(applications()).toBe(1)

    const recovered = await a.invokeMcp({ action: 'test', id: row.id, connection: definition })
    expect(recovered.test).toEqual({ reachable: true, toolCount: 1 })
    expect(recovered.connections[0]).toEqual({ ...row, toolCount: 1 })
    expect(recovered.connections[1]).toEqual(other)
    expect(recovered.version).toBe(saved.version)
    expect(applications()).toBe(2)
    expect(neighborApplications()).toBe(1)
    const healthy = await a.invokeMcp({ action: 'test', id: row.id, connection: definition })
    expect(healthy.connections).toEqual(recovered.connections)
    expect(applications()).toBe(2)
    expect(neighborApplications()).toBe(1)

    let requests = 0
    vi.spyOn(a.adapter, 'stream').mockImplementation(async function* (options: GenerateOptions): AsyncIterable<StreamChunk> {
      expect(options.tools?.some(tool => tool.name === 'mcp__foo__ping')).toBe(true)
      expect(options.tools?.some(tool => tool.name === 'mcp__foo__bar__ping')).toBe(true)
      const request = requests++
      if (request === 0) yield* toolCallResponse('recovered-model-mcp', 'mcp__foo__ping', {})
      else if (request === 1) yield* toolCallResponse('unaffected-model-mcp', 'mcp__foo__bar__ping', {})
      else yield* textResponse('Both original MCP connections replied pong.')
    })
    const created = await a.ctx.sessionController.create({}), completed: PromiseWithResolvers<void> = Promise.withResolvers()
    a.ctx.on('session/event', (session, event) => {
      if (session.id === created.sessionId && event.type === 'turn/end') completed.resolve()
    })
    await a.invoke('prompt', { sessionId: created.sessionId, requestId: 'manual-mcp-recovered-turn', mode: 'followup',
      content: [{ type: 'text', text: 'Use the configured MCP ping tool.' }] })
    await completed.promise; await a.ctx.sessionPersistence.flush()
    expect(requests).toBe(3)
    expect(external.calls).toEqual(['ping'])
    expect(neighbor.calls).toEqual(['ping'])
    expect(neighborApplications()).toBe(1)
    const history = JSON.stringify(a.ctx.sessions.get(created.sessionId)?.snapshotEvents())
    expect(history).toContain('recovered-model-mcp'); expect(history).toContain('unaffected-model-mcp')
    expect(history).toContain('pong')
    expect(history).not.toContain('synthetic-manual-recovery'); expect(history).not.toContain('synthetic-neighbor')
    expect(external.authorization.every(value => value === 'Bearer synthetic-manual-recovery')).toBe(true)
    expect(neighbor.authorization.every(value => value === 'Bearer synthetic-neighbor')).toBe(true)
    expect((await b.invokeMcp({ action: 'list' })).connections).toEqual([])
    expect(a.saveBarrier.snapshot().failures).toEqual([])
  } finally { apply.mockRestore(); await external.close(); await neighbor.close() }
}, 20000)

it('keeps a disabled saved connection private after a successful unchanged probe', async () => {
  const external = await startHttpMcpFixture(), apply = vi.spyOn(AccountMcpConnections.prototype, 'apply')
  try {
    const a = await account('mcp-disabled-probe'), initial = await a.invokeMcp({ action: 'list' })
    const connection = { serverName: 'disabled', url: external.url, enabled: false, toolCallTimeoutMs: 1000 }
    const saved = await a.invokeMcp({ action: 'save', version: initial.version, connection }), row = saved.connections[0]
    if (row === undefined) throw new Error('Original disabled MCP connection absent')
    const calls = apply.mock.calls.length
    const probed = await a.invokeMcp({ action: 'test', id: row.id, connection })
    expect(probed.test).toEqual({ reachable: true, toolCount: 1 })
    expect(probed.connections).toEqual(saved.connections)
    expect(probed.version).toBe(saved.version)
    expect(apply).toHaveBeenCalledTimes(calls)
    expect(a.ctx.tools.schemas().filter(tool => tool.name.startsWith('mcp__'))).toEqual([])
  } finally { apply.mockRestore(); await external.close() }
}, 20000)

it('does not replace a saved zero-tool connection after its probing login is revoked', async () => {
  const external = await startHttpMcpFixture(), apply = vi.spyOn(AccountMcpConnections.prototype, 'apply')
  try {
    external.setAvailable(false)
    const a = await account('mcp-saved-probe-cancel', manualRecoveryPolicy), initial = await a.invokeMcp({ action: 'list' })
    const connection = { serverName: 'compute', url: external.url, enabled: true, toolCallTimeoutMs: 1000 }
    const saved = await a.invokeMcp({ action: 'save', version: initial.version, connection }), row = saved.connections[0]
    if (row === undefined) throw new Error('Original saved MCP connection absent')
    external.setAvailable(true)
    const pending = external.holdNextRequest(), calls = apply.mock.calls.length
    try {
      const probing = a.invokeMcp({ action: 'test', id: row.id, connection }).then(() => true, () => false)
      await pending.entered
      const removing = a.invokeMcp({ action: 'remove', id: row.id, version: saved.version }).then(() => true, () => false)
      await vi.waitFor(() => { expect(a.saveBarrier.snapshot().pending).toHaveLength(2) })
      a.revokeLogin()
      expect(await probing).toBe(false)
      expect(await removing).toBe(false)
      expect(apply).toHaveBeenCalledTimes(calls)
      expect(a.ctx.tools.schemas().filter(tool => tool.name.startsWith('mcp__'))).toEqual([])
      expect(a.saveBarrier.snapshot().pending).toEqual([])
      expect(a.saveBarrier.snapshot().failures).toEqual([])
    } finally { pending.release() }
  } finally { apply.mockRestore(); await external.close() }
}, 20000)

it('retains an unconfirmed old connection when a successful saved-connection probe requests replacement', async () => {
  const external = await startHttpMcpFixture(), create = nativeTransport.createTransport
  const originalClosers: Array<() => Promise<void>> = []
  let mountedGenerations = 0
  const transport = vi.spyOn(nativeTransport, 'createTransport').mockImplementation((config, observeIncoming) => {
    const actual = create(config, observeIncoming)
    if (!config.failOnStartupError) {
      mountedGenerations++
      originalClosers.push(actual.close.bind(actual))
      actual.close = () => Promise.reject(new Error('synthetic original connection close failure'))
    }
    return actual
  })
  try {
    external.setAvailable(false)
    const a = await account('mcp-recovery-old-close', manualRecoveryPolicy), initial = await a.invokeMcp({ action: 'list' })
    const connection = { serverName: 'compute', url: external.url, enabled: true, toolCallTimeoutMs: 1000 }
    const saved = await a.invokeMcp({ action: 'save', version: initial.version, connection }), row = saved.connections[0]
    if (row === undefined) throw new Error('Original saved MCP connection absent')
    expect(row.toolCount).toBe(0)
    expect(mountedGenerations).toBe(1)
    external.setAvailable(true)
    await expect(a.invokeMcp({ action: 'test', id: row.id, connection })).rejects.toThrow()
    expect(mountedGenerations).toBe(1)
    expect(a.ctx.tools.schemas().filter(tool => tool.name.startsWith('mcp__'))).toEqual([])
    expect(a.saveBarrier.snapshot().failures).toMatchObject([{ kind: 'mcp-connection', outcome: 'unknown' }])
    a.expectUnknownSave()
    await a.close()
    expect((await a.observeNativeDisposal()).status).toBe('unknown')
  } finally {
    transport.mockRestore()
    for (const close of originalClosers) await close()
    await external.close()
  }
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
  const transport = vi.spyOn(nativeTransport, 'createTransport').mockImplementation((config, observeIncoming) => {
    const actual = create(config, observeIncoming)
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
    const disposal = await a.observeNativeDisposal()
    expect(disposal.status).toBe('unknown')
    expect(disposal.errorEvents).toBeGreaterThan(0)
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
