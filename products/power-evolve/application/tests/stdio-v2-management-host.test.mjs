/** Real native Host, BrowserAgentAuth and Typert Registry/Gateway; all Platform/SDK/identity records are bounded substitutes. */
import assert from 'node:assert/strict'
import { randomBytes, randomUUID } from 'node:crypto'
import { mkdtemp, rm } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import test from 'node:test'
import { Context } from '@deepseek-ai/cordis'
import WebServer from '@deepseek-ai/dsh-host-webserver'
import TypertRegistry from '@deepseek-ai/dsh-typert-registry'
import TypertGateway from '@deepseek-ai/dsh-api-gateway'
import { apply, Config } from '../lib/host/index.js'
import { PlatformError } from '../lib/contracts.js'
import { stdioManagementEndpointsV2 } from '../lib/stdio-v2-management-rpc.js'

const limits = { runtimeMs: 2000, requestMs: 1000, stdinGraceMs: 100, terminateGraceMs: 100, killGraceMs: 100,
  maxInputBytes: 65536, maxMessageBytes: 16384, maxProtocolBytes: 262144, maxProtocolMessages: 100,
  maxJsonDepth: 40, maxJsonNodes: 10000, maxPages: 4, maxTools: 10, maxCatalogBytes: 32768,
  maxToolBytes: 16384, maxResultBytes: 16384, maxStderrBytes: 4096 }
const publicConfig = { formatVersion: 2, available: true, limits,
  management: { maxNameBytes: 100, pageItems: 2, maxConnections: 100 }, maxReplyBytes: 131072 }
const invocation = { program: 'node', argv: ['synthetic-not-executed.mjs', '', 'quoted space', 'literal;$(unused)'], cwd: '.' }
const digest = 'a'.repeat(64), now = new Date(0).toISOString()

async function fixture(t) {
  const ctx = new Context(), directory = await mkdtemp(join(tmpdir(), 'pe-stdio-management-host-'))
  t.after(async () => { await ctx.fiber.dispose(); await rm(directory, { recursive: true, force: true }) })
  await ctx.plugin(WebServer, { host: '127.0.0.1', port: 0 })
  await ctx.plugin(TypertRegistry)
  await ctx.plugin(TypertGateway)
  const origin = `http://127.0.0.1:${ctx.webServer.port}`, platformOrigin = 'https://platform.example.test'
  const owners = ['alice', 'bob'].map(username => ({ userId: randomUUID(), username, token: randomBytes(32).toString('base64url'),
    sessionId: randomUUID(), connectionId: randomUUID(), actionId: randomUUID(), executionId: randomUUID(), spaceId: randomUUID(), workspaceId: randomUUID() }))
  const wrongAudience = ['approval', 'operation', 'device'].map(audience => ({ audience, token: randomBytes(32).toString('base64url') }))
  const connections = new Map(owners.map(o => [o.connectionId, { connectionId: o.connectionId, revision: 1, enabled: false,
    configuration: { name: `${o.username} synthetic`, invocation }, catalogId: null, catalogDigest: null, createdAt: now, updatedAt: now }]))
  const summaries = new Map(owners.map(o => [o.actionId, { formatVersion: 2, actionId: o.actionId,
    executionRef: { kind: 'cloud', executionId: o.executionId }, sessionId: o.sessionId, connectionId: o.connectionId,
    configRevision: 1, phase: 'discover', taskDigest: digest, state: 'queued', executionState: 'queued',
    cancelRequested: false, createdAt: now, updatedAt: now }]))
  const task = o => ({ formatVersion: 2, actionId: o.actionId, userId: o.userId, sessionId: o.sessionId, connectionId: o.connectionId,
    configRevision: 1, configDigest: digest, phase: 'discover', origin: { kind: 'stdio_discovery', requestId: randomUUID() }, invocation, limits,
    scopeBinding: { kind: 'cloud', userId: o.userId, workspaceId: o.workspaceId, bindingGeneration: 1,
      target: { spaceId: o.spaceId, rootRelativePath: '' }, home: { kind: 'user', userId: o.userId } },
    expectedDeploymentPin: { kind: 'cloud', deploymentId: randomUUID(), protocolVersion: 2, platform: { os: 'linux', architecture: 'arm64' },
      imageReference: `synthetic.invalid/runner@sha256:${digest}`, configImageId: `sha256:${digest}`, runtimeImageIds: [`containerd://sha256:${digest}`] } })
  const details = new Map(owners.map(o => [o.actionId, { ...summaries.get(o.actionId), task: task(o), outcome: null, noStart: null }]))
  const receipts = new Map(), calls = [], overrides = new Map(), lost = new Set(), inactive = new Set()
  let config = publicConfig
  ctx.provide('powerEvolveRuntime', {
    claim: async () => null,
    call: async (path, token, input) => {
      const owner = owners.find(o => o.token === token)
      if (!owner || inactive.has(token)) throw new PlatformError(401, 'account_unauthorized')
      if (path === '/identity/me') return { userId: owner.userId, username: owner.username, settings: { model: 'synthetic', maxTokens: 64, revision: 1 } }
      if (path === '/identity/exchange') return { token }
      calls.push({ path, owner: owner.username, input: structuredClone(input) })
      if (path === '/stdio-v2/config') return config
      if (!config.available) throw new PlatformError(503, 'stdio_v2_unavailable')
      if (overrides.has(path)) {
        const value = overrides.get(path)
        if (value instanceof Error) throw value
        return value
      }
      if (path === '/stdio-v2/connections/list') return { items: [connections.get(owner.connectionId)], next: null }
      if (input.connectionId !== undefined && input.connectionId !== owner.connectionId) throw new PlatformError(404, 'stdio_v2_connection_not_found')
      if (input.sessionId !== undefined && input.sessionId !== owner.sessionId) throw new PlatformError(404, 'session_not_found')
      if (path === '/stdio-v2/actions/list') return { items: [summaries.get(owner.actionId)], nextOffset: null }
      if (path === '/stdio-v2/actions/detail' || path === '/stdio-v2/actions/cancel') {
        if (input.actionId !== owner.actionId) throw new PlatformError(404, 'stdio_v2_action_not_found')
        if (path.endsWith('/detail')) return details.get(owner.actionId)
        const value = { ...summaries.get(owner.actionId), cancelRequested: true }; summaries.set(owner.actionId, value)
        return value
      }
      if (path === '/stdio-v2/connections/receipt') {
        const prior = receipts.get(`${token}:${input.requestId}`)
        if (!prior) throw new PlatformError(404, 'stdio_v2_request_not_found')
        return prior.receipt
      }
      const purpose = path.split('/').at(-1), key = `${token}:${input.requestId}`
      const prior = receipts.get(key)
      if (prior) {
        if (prior.path !== path || !assertionEqual(prior.input, input)) throw new PlatformError(409, 'stdio_v2_request_conflict')
        return prior.receipt
      }
      let receipt
      if (purpose === 'check') receipt = { requestId: input.requestId, purpose, connectionId: owner.connectionId, revision: input.expectedRevision,
        actionId: owner.actionId, executionRef: { kind: 'cloud', executionId: owner.executionId } }
      else {
        const current = connections.get(owner.connectionId)
        if (purpose !== 'create' && input.expectedRevision !== current.revision) throw new PlatformError(409, 'stdio_v2_revision_conflict')
        const revision = purpose === 'update' ? current.revision + 1 : current.revision
        receipt = { requestId: input.requestId, purpose, connectionId: owner.connectionId, revision,
          enabled: purpose === 'toggle' ? input.enabled : false, deleted: purpose === 'delete' }
        connections.set(owner.connectionId, { ...current, revision, enabled: receipt.enabled,
          ...(input.configuration === undefined ? {} : { configuration: input.configuration }) })
      }
      receipts.set(key, { receipt, path, input: structuredClone(input) })
      if (lost.delete(path)) throw new PlatformError(503, 'synthetic_lost_reply')
      return receipt
    },
  })
  await ctx.plugin({ inject: ['webServer', 'typert', 'typertGateway', 'powerEvolveRuntime'],
    apply: ctx => apply(ctx, Config({ origin, platformOrigin, deviceOrigin: 'http://127.0.0.1:29999',
      concurrency: 1, pollMs: 100, renewMs: 100, operationTimeoutMs: 1000,
      maxRequestBytes: 262144, maxStreams: 1, readyFile: join(directory, 'ready.json') })) })
  const rpc = async (method, request = {}, owner = owners[0], extraHeaders = {}, envelope = undefined) => {
    const response = await fetch(`${origin}/api/powerEvolve/${method}`, { method: 'POST',
      headers: { origin, cookie: `pe_agent=${owner.token}`, 'content-type': 'application/json', ...extraHeaders },
      body: JSON.stringify(envelope ?? { request }), signal: AbortSignal.timeout(3000) })
    return { status: response.status, body: await response.json() }
  }
  return { ctx, rpc, calls, owners, wrongAudience, connections, summaries, details, receipts, overrides, lost, inactive,
    origin, platformOrigin, setConfig: value => { config = value } }
}
function assertionEqual(left, right) {
  try { assert.deepEqual(left, right); return true }
  catch (_differentOriginal) { return false }
}

test('native generic STDIO management uses real object Gateway wire and owner cookie admission', { timeout: 30000 }, async t => {
  const f = await fixture(t), [alice, bob] = f.owners
  const read = async (method, request = {}, owner = alice) => {
    const result = await f.rpc(method, request, owner); assert.equal(result.status, 200); return result.body
  }
  await t.test('all eleven native methods dispatch through original Typert registration without command or approval execution', async () => {
    assert.deepEqual(await read('stdioV2Config'), publicConfig)
    for (const owner of f.owners) {
      assert.equal((await read('stdioV2ConnectionsList', {}, owner)).items[0].connectionId, owner.connectionId)
      const configuration = { name: `${owner.username} literal`, invocation }
      const created = await read('stdioV2ConnectionsCreate', { requestId: randomUUID(), configuration }, owner)
      assert.equal(created.purpose, 'create')
      const update = { requestId: randomUUID(), connectionId: owner.connectionId, expectedRevision: 1, configuration }
      const updated = await read('stdioV2ConnectionsUpdate', update, owner); assert.equal(updated.revision, 2)
      const toggle = { requestId: randomUUID(), connectionId: owner.connectionId, expectedRevision: 2, enabled: true }
      const toggled = await read('stdioV2ConnectionsToggle', toggle, owner); assert.equal(toggled.revision, 2)
      assert.deepEqual(await read('stdioV2ConnectionsReceipt', { requestId: toggle.requestId }, owner), toggled)
      const check = { requestId: randomUUID(), connectionId: owner.connectionId, expectedRevision: 2,
        sessionId: owner.sessionId, target: { kind: 'cloud' } }
      assert.equal((await read('stdioV2ConnectionsCheck', check, owner)).actionId, owner.actionId)
      assert.equal((await read('stdioV2ActionsList', { sessionId: owner.sessionId, offset: 0, limit: 2 }, owner)).items[0].actionId, owner.actionId)
      assert.deepEqual((await read('stdioV2ActionsDetail', { actionId: owner.actionId }, owner)).task.invocation, invocation)
      assert.equal((await read('stdioV2ActionsCancel', { actionId: owner.actionId }, owner)).cancelRequested, true)
      assert.equal((await read('stdioV2ConnectionsDelete', { requestId: randomUUID(), connectionId: owner.connectionId, expectedRevision: 2 }, owner)).deleted, true)
    }
    assert.deepEqual(new Set(f.calls.map(c => c.path)), new Set(Object.values(stdioManagementEndpointsV2)))
    const saved = f.calls.find(c => c.path.endsWith('/create')).input.configuration.invocation
    assert.deepEqual(saved, invocation)
    assert.equal(f.calls.some(c => /^\/(runtime|approvals|devices)\//u.test(c.path)), false)
  })
  await t.test('parallel owners retain exact per-peer cookie identity; foreign resource refusals remain 404', async () => {
    const replies = await Promise.all(f.owners.map(o => read('stdioV2ActionsDetail', { actionId: o.actionId }, o)))
    replies.forEach((reply, i) => { assert.equal(reply.task.userId, f.owners[i].userId) })
    for (const method of ['stdioV2ActionsDetail', 'stdioV2ActionsCancel']) {
      assert.equal((await f.rpc(method, { actionId: alice.actionId }, bob)).status, 404)
    }
    assert.equal((await f.rpc('stdioV2ConnectionsCheck', { requestId: randomUUID(), connectionId: bob.connectionId,
      expectedRevision: 2, sessionId: alice.sessionId, target: { kind: 'cloud' } }, bob)).status, 404)
    assert.equal((await f.rpc('stdioV2ConnectionsToggle', { requestId: randomUUID(), connectionId: alice.connectionId,
      expectedRevision: 2, enabled: true }, bob)).status, 404)
  })
  await t.test('wrong audiences, cross-origin, ambiguous credentials and revoked browser fail before management reads', async () => {
    const before = f.calls.length
    for (const wrong of f.wrongAudience) assert.equal((await f.rpc('stdioV2Config', {}, wrong)).status, 401)
    assert.equal((await f.rpc('stdioV2Config', {}, alice, { origin: 'https://foreign.example.test' })).status, 403)
    assert.equal((await f.rpc('stdioV2Config', {}, alice, { authorization: `Bearer ${alice.token}` })).status, 401)
    assert.equal((await f.rpc('stdioV2Config', {}, alice, { cookie: '' })).status, 401)
    f.inactive.add(alice.token)
    assert.equal((await f.rpc('stdioV2Config')).status, 401); f.inactive.delete(alice.token)
    assert.equal(f.calls.length, before)
  })
  await t.test('strict object request wire and trusted factories reject extra authority, invalid argv/cwd and unknown methods', async () => {
    const before = f.calls.filter(c => c.path !== '/stdio-v2/config').length
    const create = { requestId: randomUUID(), configuration: { name: 'valid', invocation } }
    for (const input of [{ ...create, limits }, { ...create, userId: alice.userId },
      { ...create, configuration: { ...create.configuration, invocation: { ...invocation, argv: 'not array' } } },
      { ...create, configuration: { ...create.configuration, invocation: { ...invocation, cwd: '/workspace' } } },
      { ...create, configuration: { ...create.configuration, invocation: { ...invocation, argv: ['bad\0argument'] } } }]) {
      assert.equal((await f.rpc('stdioV2ConnectionsCreate', input)).status, 400)
    }
    assert.equal((await f.rpc('stdioV2Config', { limits })).status, 400)
    for (const envelope of [[{ request: create }], { args: [{ request: create }] }, { request: create, userId: alice.userId }]) {
      assert.equal((await f.rpc('stdioV2ConnectionsCreate', create, alice, {}, envelope)).status, 400)
    }
    assert.equal((await f.rpc('stdioV2ConnectionsCheck', { requestId: randomUUID(), connectionId: alice.connectionId,
      expectedRevision: 2, sessionId: alice.sessionId, target: { kind: 'desktop', deviceId: randomUUID(), directoryId: randomUUID() } })).status, 400)
    assert.equal((await f.rpc('stdioV2ActionsList', { offset: 0, limit: 3 })).status, 400)
    for (const method of ['stdioV2Authorize', 'stdioV2Approve', 'stdioV2Start', 'stdioV2CallsPropose']) assert.equal((await f.rpc(method)).status, 400)
    assert.equal(f.calls.filter(c => c.path !== '/stdio-v2/config').length, before)
  })
  await t.test('changed trusted metadata replaces validators; browser values never override byte/name/page budgets', async () => {
    const before = f.calls.filter(c => c.path !== '/stdio-v2/config').length
    f.setConfig({ ...publicConfig, management: { ...publicConfig.management, maxNameBytes: 3 } })
    assert.equal((await f.rpc('stdioV2ConnectionsCreate', { requestId: randomUUID(), configuration: { name: '界界', invocation } })).status, 400)
    f.setConfig({ ...publicConfig, limits: { ...limits, maxInputBytes: 128 } })
    assert.equal((await f.rpc('stdioV2ConnectionsCreate', { requestId: randomUUID(), configuration: { name: 'a', invocation } })).status, 400)
    f.setConfig(publicConfig)
    assert.equal(f.calls.filter(c => c.path !== '/stdio-v2/config').length, before)
  })
  await t.test('unavailable config remains readable; every other method returns 503 without an operation POST', async () => {
    f.setConfig({ formatVersion: 2, available: false })
    assert.deepEqual(await read('stdioV2Config'), { formatVersion: 2, available: false })
    const before = f.calls.filter(c => c.path !== '/stdio-v2/config').length
    for (const method of Object.keys(stdioManagementEndpointsV2).filter(m => m !== 'stdioV2Config')) {
      const result = await f.rpc(method, {}); assert.equal(result.status, 503); assert.equal(result.body.error, 'stdio_v2_unavailable')
    }
    assert.equal(f.calls.filter(c => c.path !== '/stdio-v2/config').length, before)
    f.setConfig(publicConfig)
  })
  await t.test('lost mutation reply leaves its original receipt; readback never starts another request or silently retries', async () => {
    const input = { requestId: randomUUID(), configuration: { name: 'uncertain', invocation } }
    f.lost.add('/stdio-v2/connections/create')
    const before = f.calls.filter(c => c.path === '/stdio-v2/connections/create').length
    assert.equal((await f.rpc('stdioV2ConnectionsCreate', input)).status, 503)
    const recovered = await read('stdioV2ConnectionsReceipt', { requestId: input.requestId })
    assert.equal(recovered.requestId, input.requestId)
    assert.equal(f.calls.filter(c => c.path === '/stdio-v2/connections/create').length, before + 1)
    const retried = await read('stdioV2ConnectionsCreate', input); assert.deepEqual(retried, recovered)
    assert.equal((await f.rpc('stdioV2ConnectionsReceipt', { requestId: randomUUID() })).status, 404)
    assert.equal(f.calls.filter(c => c.path === '/stdio-v2/connections/create').length, before + 2)
  })
  await t.test('malformed private response fields, receipt identities and action selectors fail closed without mutation retry', async () => {
    const input = { requestId: randomUUID(), configuration: { name: 'a', invocation } }
    const receipt = { requestId: input.requestId, purpose: 'create', connectionId: alice.connectionId, revision: 1, enabled: false, deleted: false }
    for (const reply of [{ ...receipt, capture: {} }, { ...receipt, requestId: randomUUID() }, { ...receipt, purpose: 'update' }]) {
      f.overrides.set('/stdio-v2/connections/create', reply)
      assert.equal((await f.rpc('stdioV2ConnectionsCreate', input)).status, 502)
    }
    f.overrides.delete('/stdio-v2/connections/create')
    f.overrides.set('/stdio-v2/actions/cancel', { ...f.summaries.get(alice.actionId), actionId: bob.actionId })
    assert.equal((await f.rpc('stdioV2ActionsCancel', { actionId: alice.actionId })).status, 502)
    f.overrides.delete('/stdio-v2/actions/cancel')
    f.setConfig({ ...publicConfig, approvalKey: 'synthetic-not-returned' })
    assert.deepEqual(await f.rpc('stdioV2Config'), { status: 502, body: { error: 'stdio_v2_config_invalid' } })
    f.setConfig(publicConfig)
  })
  await t.test('whole replies reject excess bytes without truncating catalog/raw metadata or manufacturing success', async () => {
    const raw = JSON.parse('[{"name":"echo","inputSchema":{"type":"object"},"_meta":{"__proto__":{"literal":"retained\\u0000metadata"}}}]')
    const detail = f.details.get(alice.actionId)
    const completed = { ...detail, state: 'succeeded', executionState: 'succeeded', outcome: { state: 'completed', phase: 'discover',
      catalog: raw, pages: [{ tools: raw }], initializeResult: { protocolVersion: 'synthetic' },
      facts: { programStartAttempted: true, toolsCallAttempted: false, effectMayHaveOccurred: false, childPid: 123,
        childExitObserved: true, childCloseObserved: true, exitCode: 0, signal: null, cleanupConfirmed: true,
        protocolBytes: 400, protocolMessages: 3, stderrBytes: 0, stderr: '' } } }
    f.overrides.set('/stdio-v2/actions/detail', completed)
    assert.deepEqual((await read('stdioV2ActionsDetail', { actionId: alice.actionId })).outcome.catalog, raw)
    f.setConfig({ ...publicConfig, maxReplyBytes: 2000 })
    const excess = { ...completed, outcome: { ...completed.outcome, initializeResult: { literal: '界'.repeat(2000) } } }
    f.overrides.set('/stdio-v2/actions/detail', excess)
    assert.deepEqual(await f.rpc('stdioV2ActionsDetail', { actionId: alice.actionId }), { status: 413, body: { error: 'stdio_v2_reply_limit' } })
    f.overrides.delete('/stdio-v2/actions/detail'); f.setConfig(publicConfig)
  })
  await t.test('formal no-start details carry only logical disposition and cannot add an executor proof', async () => {
    const detail = f.details.get(alice.actionId)
    const closure = { ...detail, state: 'cancelled', executionState: 'cancelled', cancelRequested: true,
      noStart: { kind: 'unstarted_closed', startNeverAuthorized: true, resourceDisposition: 'ready_retained' } }
    f.overrides.set('/stdio-v2/actions/detail', closure)
    assert.deepEqual((await read('stdioV2ActionsDetail', { actionId: alice.actionId })).noStart, closure.noStart)
    f.overrides.set('/stdio-v2/actions/detail', { ...closure, capture: { podUid: randomUUID() } })
    assert.equal((await f.rpc('stdioV2ActionsDetail', { actionId: alice.actionId })).status, 502)
    f.overrides.delete('/stdio-v2/actions/detail')
  })
})
