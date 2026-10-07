/** Actual native Scheduler/AgentLoop/Scope/Session/persistence composition; Platform and model adapters are in-memory fixtures. */
import assert from 'node:assert/strict'
import test from 'node:test'
import { randomUUID } from 'node:crypto'
import { Context, Service } from '@deepseek-ai/cordis'
import AgentRegistry from '@deepseek-ai/dsh-agent'
import SessionStore, { SESSION_FORMAT_VERSION } from '@deepseek-ai/dsh-session'
import SessionProjectionRegistry from '@deepseek-ai/dsh-session-projection'
import SystemPrompt from '@deepseek-ai/dsh-system-prompt'
import ToolRuntime from '@deepseek-ai/dsh-tools'
import SkillRegistry from '@deepseek-ai/dsh-skill'
import LlmRuntime, { LlmAdapter, ToolCallId } from '@deepseek-ai/dsh-llm'
import AgentLoop from '../../../../packages/core/agent-loop/lib/index.js'
import { grant as grantSchema, PlatformError } from '../lib/contracts.js'
import PlatformPersistence from '../lib/host/persistence.js'
import { Scheduler } from '../lib/host/scheduler.js'
import { parseEvents } from '../lib/session-records.js'
import { compileStdioOperationToolsV2 } from '../lib/stdio-v2-model-tools.js'
import { stdioCatalogFingerprintV2, stdioSha256V2 } from '@power-evolve/connector-runner/stdio-v2-digest'

const limits = { runtimeMs: 2000, requestMs: 1000, stdinGraceMs: 100, terminateGraceMs: 100, killGraceMs: 100,
  maxInputBytes: 65536, maxMessageBytes: 8192, maxProtocolBytes: 65536, maxProtocolMessages: 100,
  maxJsonDepth: 40, maxJsonNodes: 10000, maxPages: 4, maxTools: 10, maxCatalogBytes: 8192,
  maxToolBytes: 4096, maxResultBytes: 8192, maxStderrBytes: 4096 }
const admission = { maxConnections: 4, maxTools: 10, maxSnapshotBytes: 262144, maxDescriptionBytes: 8192 }
const budget = { maxDepth: 40, maxNodes: 10000, maxBytes: 65536 }, sha = (domain, value) => stdioSha256V2(domain, value, budget)
const id = n => `00000000-0000-4000-8000-${n.toString(16).padStart(12, '0')}`

function selection(userId) {
  const configuration = { name: 'Original frozen connection', invocation: { program: 'node', argv: ['never-executed.mjs'], cwd: '.' } }
  const rawCatalog = [{ name: 'echo', description: 'Original raw descriptor', inputSchema: { type: 'object',
    properties: { text: { type: 'string' } }, required: ['text'], additionalProperties: false } }]
  const pin = { kind: 'cloud', deploymentId: id(50), protocolVersion: 2, platform: { os: 'linux', architecture: 'arm64' },
    imageReference: `synthetic.invalid/runner@sha256:${'b'.repeat(64)}`, configImageId: `sha256:${'c'.repeat(64)}`,
    runtimeImageIds: ['containerd://synthetic-original'] }
  return compileStdioOperationToolsV2([{ formatVersion: 2, connectionId: id(10), configRevision: 1,
    configDigest: sha('configuration', configuration), configuration, limits,
    scopeBinding: { kind: 'cloud', userId, workspaceId: id(20), bindingGeneration: 1,
      target: { spaceId: id(30), rootRelativePath: 'synthetic-owned' }, home: { kind: 'user', userId } },
    expectedDeploymentPin: pin, catalogId: id(40), catalogDigest: stdioCatalogFingerprintV2(rawCatalog, limits), rawCatalog,
    catalogImageExpectation: { kind: 'cloud', platform: pin.platform, imageReference: pin.imageReference, runtimeImageId: pin.runtimeImageIds[0] },
  }], limits, admission, [])
}
const text = value => [{ type: 'block-start', index: 0, blockType: 'text' }, { type: 'text-delta', index: 0, text: value },
  { type: 'block-end', index: 0, block: { type: 'text', text: value } }, { type: 'finish', reason: { kind: 'stop' } }]
const tool = (name, callId) => {
  const args = JSON.stringify({ text: 'original\0model arguments' }), key = ToolCallId(callId)
  return [{ type: 'block-start', index: 0, blockType: 'tool-call' },
    { type: 'tool-call-delta', index: 0, id: key, name, argumentsDelta: args },
    { type: 'block-end', index: 0, block: { type: 'tool-call', id: key, name, arguments: args } },
    { type: 'finish', reason: { kind: 'tool-calls' } }]
}

async function fixture(t) {
  const root = new Context(), requests = [], paths = [], finish = [], entries = new Map(), issued = new Map()
  const sessionId = randomUUID(), userId = id(1), frozen = selection(userId), scripts = []
  const header = { id: sessionId, version: SESSION_FORMAT_VERSION, createdAt: 0, isSeeded: false }
  entries.set(sessionId, { header, events: [] })
  class Runtime extends Service {
    grants = new Map()
    constructor(ctx) { super(ctx, 'powerEvolveRuntime') }
    require(id) {
      const value = this.grants.get(id)
      if (!value) throw new PlatformError(403, 'session_not_leased')
      return value
    }
    async call(path, token, body, signal) {
      paths.push({ path, token, body: structuredClone(body), signal })
      const grant = issued.get(token); assert(grant, 'only the original issued operation token may access this fixture')
      const saved = entries.get(grant.sessionId)
      if (path === '/runtime/renew') return { cancelRequested: false }
      if (path === '/runtime/snapshot') return structuredClone({ ...saved, eventCount: saved.events.length })
      if (path === '/runtime/append') {
        saved.events = parseEvents(saved.header, [...saved.events, ...body.events])
        return { accepted: true }
      }
      if (path === '/runtime/finish') { finish.push({ token, ...body }); return { ok: true } }
      if (path === '/runtime/stdio-v2/calls/propose') {
        assert.equal(body.toolName, grant.stdioV2Connections[0].tools[0].model.name)
        assert.equal(typeof body.callKey, 'string'); assert(signal instanceof AbortSignal)
        assert(saved.events.some(event => event.type === 'tool/call' && event.data.callId === body.callKey), 'native call must be durable before proposing')
        if (grant.source === 'stdio_v2_no_start') throw new PlatformError(409, 'stdio_v2_chain_stopped')
        return { actionId: id(100), executionRef: { kind: 'cloud', executionId: id(101) }, taskDigest: 'a'.repeat(64), state: 'pending' }
      }
      assert.fail(`unexpected API route ${path}`)
    }
  }
  class Model extends LlmAdapter {
    async *stream(options) {
      requests.push(structuredClone({ messages: options.messages, tools: options.tools, sessionId: options.sessionId }))
      const chunks = scripts.shift(); assert(chunks, 'a consumed request must not invoke the model again')
      for (const chunk of chunks) { options.signal?.throwIfAborted(); yield chunk }
    }
  }
  let ctx, scheduler
  t.after(async () => { try { await scheduler?.close() } finally { await root.fiber.dispose() } })
  await root.plugin(Runtime); await root.plugin(LlmRuntime); await root.plugin(SessionStore)
  await root.plugin(SessionProjectionRegistry); await root.plugin(SystemPrompt); await root.plugin(ToolRuntime)
  await root.plugin(AgentRegistry); await root.plugin(SkillRegistry); await root.plugin(PlatformPersistence)
  await root.plugin(AgentLoop, { agents: [] })
  await root.inject(['powerEvolveRuntime', 'sessions', 'sessionPersistence', 'llm', 'agents', 'agentLoop', 'tools'], value => { ctx = value })
  ctx.llm.registerAdapter(['power-evolve'], new Model())
  scheduler = new Scheduler(ctx, { platformOrigin: 'https://trusted.example', concurrency: 1, pollMs: 50,
    renewMs: 8000, operationTimeoutMs: 10000 })
  const makeGrant = source => {
    const original = grantSchema.parse({ operationId: randomUUID(), sessionId, userId, requestId: randomUUID(),
      text: JSON.stringify({ kind: source, actionId: source === 'stdio_v2_no_start' ? id(103) : id(102),
        chainStopped: source === 'stdio_v2_no_start', instruction: source === 'stdio_v2_no_start'
          ? 'Report the exact no-start outcome; do not repeat or recreate this action.' : 'Continue only within current permissions and the original root budget.' }),
      token: randomUUID(), epoch: 1, settings: { model: 'synthetic-no-network', maxTokens: 64, revision: 1 }, source,
      stdioV2Connections: frozen, sourceStdioV2ActionId: source === 'stdio_v2_result' ? id(102) : null,
      sourceStdioV2NoStartActionId: source === 'stdio_v2_no_start' ? id(103) : null,
      sourceStdioV2Phase: source === 'user' ? null : 'call' })
    issued.set(original.token, original); return original
  }
  const released = () => {
    assert.equal(ctx.powerEvolveRuntime.grants.size, 0); assert.equal(ctx.agents.list().length, 0)
    assert.equal(ctx.sessions.get(sessionId), undefined); assert.equal(scheduler.handles.size, 0)
    assert.deepEqual(ctx.tools.schemas(), [])
  }
  return { ctx, scheduler, requests, paths, finish, frozen, scripts, makeGrant, released,
    events: () => structuredClone(entries.get(sessionId).events) }
}

test('native Scheduler installs frozen tools on user and real-result continuations, preserves trusted source, and cold recovery never re-proposes consumed input', { timeout: 20000 }, async t => {
  const f = await fixture(t), name = f.frozen[0].tools[0].model.name
  for (const [source, callKey] of [['user', 'native-user-call'], ['stdio_v2_result', 'native-result-call']]) {
    const grant = f.makeGrant(source), firstRequest = f.requests.length
    f.scripts.push(tool(name, callKey), text('Await the trusted continuation.'))
    await f.scheduler.run(grant); f.released()
    const declaration = f.requests[firstRequest].tools.find(value => value.name === name)
    assert.deepEqual(declaration, f.frozen[0].tools[0].model)
    const consumed = f.events().filter(event => event.type === 'user/message' && event.data.id === grant.requestId)
    assert.equal(consumed.length, 1)
    assert.deepEqual(consumed[0].data.source, source === 'user' ? { kind: 'user', rpcId: grant.requestId }
      : { kind: 'power-evolve-stdio-v2-result', actionId: grant.sourceStdioV2ActionId, phase: 'call' })
    assert(f.requests[firstRequest].messages.some(message => message.role === 'user' && message.source?.kind === consumed[0].data.source.kind))
    const proposed = f.paths.filter(value => value.path === '/runtime/stdio-v2/calls/propose' && value.token === grant.token)
    assert.equal(proposed.length, 1); assert.deepEqual(proposed[0].body, { callKey, toolName: name, arguments: { text: 'original\0model arguments' } })
    assert.equal(f.finish.at(-1).outcome, 'completed')
    const requestCount = f.requests.length, before = f.events()
    await f.scheduler.run(grant); f.released()
    assert.equal(f.requests.length, requestCount); assert.deepEqual(f.events().slice(0, before.length), before)
    // Session cold reconstruction may append its native seed boundary, never another consumed input or turn.
    assert.deepEqual(f.events().slice(before.length).map(event => event.type), ['session/end-seed'])
    assert.equal(f.paths.filter(value => value.path === '/runtime/stdio-v2/calls/propose' && value.token === grant.token).length, 1)
  }
  assert(f.paths.every(value => ['/runtime/renew', '/runtime/snapshot', '/runtime/append', '/runtime/finish', '/runtime/stdio-v2/calls/propose'].includes(value.path)))
})

test('native no-start continuation retains its distinct action source and original tools without bypassing the Platform chain fence', { timeout: 20000 }, async t => {
  const f = await fixture(t), grant = f.makeGrant('stdio_v2_no_start'), name = f.frozen[0].tools[0].model.name
  f.scripts.push(tool(name, 'native-denied-call'), text('The provider never started; this chain is stopped.'))
  await f.scheduler.run(grant); f.released()
  assert.deepEqual(f.requests[0].tools.find(value => value.name === name), f.frozen[0].tools[0].model)
  const message = f.events().find(event => event.type === 'user/message' && event.data.id === grant.requestId)
  assert.deepEqual(message.data.source, { kind: 'power-evolve-stdio-v2-no-start', actionId: grant.sourceStdioV2NoStartActionId, phase: 'call' })
  assert(f.requests[0].messages.some(value => value.source?.kind === 'power-evolve-stdio-v2-no-start'))
  const denied = f.events().find(event => event.type === 'tool/result' && event.data.message.source.callId === 'native-denied-call')
  assert.equal(denied.data.message.isError, true); assert.match(JSON.stringify(denied.data.message.content), /stdio_v2_chain_stopped/u)
  assert.equal(f.paths.filter(value => value.path === '/runtime/stdio-v2/calls/propose').length, 1)
  assert(f.paths.every(value => !/authorize|approval|discover|check|catalog|start/u.test(value.path)))
  const before = f.events(), count = f.requests.length
  await f.scheduler.run(grant); f.released(); assert.deepEqual(f.events().slice(0, before.length), before)
  assert.deepEqual(f.events().slice(before.length).map(event => event.type), ['session/end-seed'])
  assert.equal(f.requests.length, count)
})
