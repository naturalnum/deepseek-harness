/** Native scoped registry/presenter and real loopback HTTP transport with synthetic Platform receipts; no Agent loop or executor runs. */
import assert from 'node:assert/strict'
import test from 'node:test'
import { createServer } from 'node:http'
import { once } from 'node:events'
import { Context } from '@deepseek-ai/cordis'
import { createScope } from '@deepseek-ai/dsh-scope'
import SystemPrompt from '@deepseek-ai/dsh-system-prompt'
import ToolRuntime from '@deepseek-ai/dsh-tools'
import { ToolCallId } from '@deepseek-ai/dsh-llm/brand'
import RuntimeScope from '../lib/host/scope.js'
import { installStdioOperationToolsV2 } from '../lib/host/stdio-v2.js'
import { compileStdioOperationToolsV2 } from '../lib/stdio-v2-model-tools.js'
import { stdioCatalogFingerprintV2, stdioSha256V2 } from '@power-evolve/connector-runner/stdio-v2-digest'

const limits = { runtimeMs: 2000, requestMs: 1000, stdinGraceMs: 100, terminateGraceMs: 100, killGraceMs: 100,
  maxInputBytes: 65536, maxMessageBytes: 8192, maxProtocolBytes: 65536, maxProtocolMessages: 100,
  maxJsonDepth: 40, maxJsonNodes: 10000, maxPages: 4, maxTools: 10, maxCatalogBytes: 8192,
  maxToolBytes: 4096, maxResultBytes: 8192, maxStderrBytes: 4096 }
const admission = { maxConnections: 4, maxTools: 10, maxSnapshotBytes: 262144, maxDescriptionBytes: 8192 }
const budget = { maxDepth: 40, maxNodes: 10000, maxBytes: 65536 }
const sha = (domain, value) => stdioSha256V2(domain, value, budget)
const id = n => `00000000-0000-4000-8000-${n.toString(16).padStart(12, '0')}`
const receipt = { actionId: id(100), executionRef: { kind: 'cloud', executionId: id(101) }, taskDigest: 'a'.repeat(64), state: 'pending' }
const expectedPrompt = 'STDIO MCP tools return durable acceptance receipts, not provider results. End this turn after a receipt and wait for the trusted Platform continuation in this Session. Do not repeat a pending or uncertain call. If approval is required, show the trusted approval URL and wait; the Host cannot approve or start the provider.'
// Owner-local keyless expected model/user receipt output; no provider output or connector configuration appears.
const expectedText = '{"actionId":"00000000-0000-4000-8000-000000000064","executionRef":{"kind":"cloud","executionId":"00000000-0000-4000-8000-000000000065"},"taskDigest":"aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa","state":"pending","approvalUrl":"https://trusted.example/approval"}'

function groups(owner = 1) {
  const userId = id(owner), connectionId = id(owner + 10), workspaceId = id(owner + 20)
  const configuration = { name: `Owner ${owner}`, invocation: { program: 'node', argv: ['never-executed.mjs'], cwd: '.' } }
  const rawCatalog = JSON.parse('[{"name":"echo","description":"literal\\u0000{{untrusted}}","inputSchema":{"type":"object","properties":{"text":{"type":"string"}},"required":["text"],"additionalProperties":{},"default":{"__proto__":{"annotation":true}}},"_meta":{"__proto__":{"retained":true}},"extension":{"raw":true}}]')
  const pin = { kind: 'cloud', deploymentId: id(50), protocolVersion: 2, platform: { os: 'linux', architecture: 'arm64' },
    imageReference: `synthetic.invalid/runner@sha256:${'b'.repeat(64)}`, configImageId: `sha256:${'c'.repeat(64)}`,
    runtimeImageIds: ['containerd://synthetic-original'] }
  return compileStdioOperationToolsV2([{ formatVersion: 2, connectionId, configRevision: 1,
    configDigest: sha('configuration', configuration), configuration, limits,
    scopeBinding: { kind: 'cloud', userId, workspaceId, bindingGeneration: 1,
      target: { spaceId: id(owner + 30), rootRelativePath: `owned-${owner}` }, home: { kind: 'user', userId } },
    expectedDeploymentPin: pin, catalogId: id(owner + 40), catalogDigest: stdioCatalogFingerprintV2(rawCatalog, limits), rawCatalog,
    catalogImageExpectation: { kind: 'cloud', platform: pin.platform, imageReference: pin.imageReference, runtimeImageId: pin.runtimeImageIds[0] },
  }], limits, admission, [])
}

async function fixture(t) {
  const ctx = new Context(); t.after(() => ctx.fiber.dispose())
  await ctx.plugin(SystemPrompt); await ctx.plugin(ToolRuntime)
  async function agent(n) {
    const key = { id: id(n + 200) }; let scope
    await ctx.plugin(Object.assign(inner => { scope = createScope(inner, key); key.ctx = scope.ctx }, { inject: ['tools', 'systemPrompt'] }))
    return { agent: key, scope }
  }
  return { ctx, agent }
}
const run = (ctx, agent, name, args = { text: 'literal' }, signal = new AbortController().signal, callKey = 'native-stable-call') =>
  ctx.tools.execute({ agent, name, arguments: args, signal, callId: ToolCallId(callKey) })

async function httpFixture(t, responder) {
  const requests = [], signals = [], server = createServer(async (request, response) => {
    const chunks = []; for await (const chunk of request) chunks.push(chunk)
    const value = { path: request.url, method: request.method, authorization: request.headers.authorization,
      body: JSON.parse(Buffer.concat(chunks).toString('utf8')) }
    requests.push(value); responder(response, value)
  })
  server.listen(0, '127.0.0.1'); await once(server, 'listening')
  t.after(async () => { server.closeAllConnections(); await new Promise((resolve, reject) => server.close(error => error ? reject(error) : resolve())) })
  const port = server.address().port, config = { platformUrl: `http://127.0.0.1:${port}`, timeoutMs: 1000, maxResponseBytes: 16384 }
  const runtime = { call(path, token, input, signal) {
    signals.push(signal)
    return RuntimeScope.prototype.call.call({ config }, path, token, input, signal)
  } }
  return { runtime, requests, signals }
}

test('two Agent scopes expose only their frozen model declarations and disposal removes tools and waiting instructions', async t => {
  const { ctx, agent } = await fixture(t), alice = await agent(1), bob = await agent(2), a = groups(1), b = groups(2)
  const calls = [], runtime = { async call(path, token, input, signal) { calls.push({ path, token, input, signal }); return receipt } }
  installStdioOperationToolsV2(alice.agent, { target: { kind: 'cloud' }, token: 'alice-fixture' }, a, runtime, 'https://trusted.example')
  installStdioOperationToolsV2(bob.agent, { target: { kind: 'cloud' }, token: 'bob-fixture' }, b, runtime, 'https://trusted.example')
  assert.deepEqual(ctx.tools.schemas(alice.agent), a.flatMap(group => group.tools.map(tool => tool.model)))
  assert.deepEqual(ctx.tools.schemas(bob.agent), b.flatMap(group => group.tools.map(tool => tool.model)))
  assert.deepEqual(ctx.tools.schemas(), [])
  assert.equal(Object.hasOwn(ctx.tools.schemas(alice.agent)[0].parameters.default, '__proto__'), true)
  assert.equal((await run(ctx, bob.agent, a[0].tools[0].model.name)).isError, true); assert.equal(calls.length, 0)
  assert.equal((await run(ctx, alice.agent, a[0].tools[0].model.name)).isError, false)
  assert.equal((await run(ctx, bob.agent, b[0].tools[0].model.name)).isError, false)
  assert.deepEqual(calls.map(value => value.token), ['alice-fixture', 'bob-fixture'])
  const instruction = (await ctx.systemPrompt.assemble({ scope: alice.agent })).sections.find(section => section.name === 'power-evolve:stdio-v2-result')
  assert.deepEqual(instruction, { name: 'power-evolve:stdio-v2-result', text: expectedPrompt, interpolate: false })
  await alice.scope.dispose(); assert.deepEqual(ctx.tools.schemas(alice.agent), [])
  assert.equal((await ctx.systemPrompt.assemble({ scope: alice.agent })).sections.some(section => section.name === 'power-evolve:stdio-v2-result'), false)
  assert.equal(ctx.tools.schemas(bob.agent).length, 1)
})

test('desktop and empty selections register no Cloud fallback or prompt', async t => {
  const { ctx, agent } = await fixture(t)
  for (const [n, target, selected] of [[1, { kind: 'desktop', deviceId: id(70), directoryId: id(71) }, groups()], [2, { kind: 'cloud' }, []]]) {
    const f = await agent(n)
    installStdioOperationToolsV2(f.agent, { target, token: 'fixture' }, selected, { call() { assert.fail('no Cloud request') } }, 'https://trusted.example')
    assert.deepEqual(ctx.tools.schemas(f.agent), [])
    assert.equal((await ctx.systemPrompt.assemble({ scope: f.agent })).sections.some(section => section.name === 'power-evolve:stdio-v2-result'), false)
  }
})

test('native MCP adapter and RuntimeScope HTTP preserve raw NUL and own keys, native call identity, signal and canonical receipt output', { timeout: 10000 }, async t => {
  const { ctx, agent } = await fixture(t), f = await agent(1), selected = groups()
  const transport = await httpFixture(t, response => { response.setHeader('content-type', 'application/json'); response.end(JSON.stringify(receipt)) })
  installStdioOperationToolsV2(f.agent, { target: { kind: 'cloud' }, token: 'operation-only-fixture' }, selected, transport.runtime, 'https://trusted.example/base?ignored=1')
  const args = JSON.parse('{"text":"literal\\u0000😀","__proto__":{"nested":"own\\u0000key"},"10":"ten","2":"two"}')
  const original = structuredClone(args), signal = new AbortController().signal
  const result = await run(ctx, f.agent, selected[0].tools[0].model.name, args, signal, 'native-call-42')
  assert.equal(result.isError, false); assert.deepEqual(args, original)
  assert.deepEqual(transport.requests, [{ path: '/runtime/stdio-v2/calls/propose', method: 'POST', authorization: 'Bearer operation-only-fixture',
    body: { callKey: 'native-call-42', toolName: selected[0].tools[0].model.name, arguments: original } }])
  assert.equal(Object.hasOwn(transport.requests[0].body.arguments, '__proto__'), true)
  assert.equal(transport.signals[0], signal)
  assert.deepEqual(result.value, { content: [{ type: 'text', text: expectedText }] })
  assert.deepEqual(result.content, [{ type: 'text', text: expectedText }])
  assert.deepEqual(ctx.tools.get(selected[0].tools[0].model.name, f.agent).output.render(args, result.value), result.content)
})

test('wrong model arguments reject before the native adapter can substitute an object or send HTTP', async t => {
  const { ctx, agent } = await fixture(t), f = await agent(1), selected = groups()
  let calls = 0
  installStdioOperationToolsV2(f.agent, { target: { kind: 'cloud' }, token: 'fixture' }, selected,
    { async call() { calls++; return receipt } }, 'https://trusted.example')
  for (const args of [null, [], 1, 'not an object', {}, { text: 3 }, { text: 'x'.repeat(limits.maxInputBytes) }]) {
    const result = await run(ctx, f.agent, selected[0].tools[0].model.name, args)
    assert.equal(result.isError, true); assert.equal(result.value, undefined)
  }
  assert.equal(calls, 0)
})

test('strict Cloud receipts reject extra fields, wrong IDs, target, digest and state after exactly one HTTP submission', { timeout: 10000 }, async t => {
  const { ctx, agent } = await fixture(t), f = await agent(1), selected = groups(); let value
  const transport = await httpFixture(t, response => { response.setHeader('content-type', 'application/json'); response.end(JSON.stringify(value)) })
  installStdioOperationToolsV2(f.agent, { target: { kind: 'cloud' }, token: 'fixture' }, selected, transport.runtime, 'https://trusted.example')
  for (value of [null, { ...receipt, program: 'must-not-pass' }, { ...receipt, approvalUrl: 'https://untrusted.invalid/approval' },
    { ...receipt, actionId: 'invalid' }, { ...receipt, executionRef: { kind: 'desktop', executionId: id(101) } },
    { ...receipt, executionRef: { kind: 'cloud', executionId: 'invalid' } }, { ...receipt, taskDigest: 'invalid' },
    { ...receipt, state: 'accepted' }, { ...receipt, state: 'unknown' }]) {
    const before = transport.requests.length
    const result = await run(ctx, f.agent, selected[0].tools[0].model.name)
    assert.equal(result.isError, true); assert.equal(result.value, undefined)
    assert.equal(transport.requests.length, before + 1)
  }
})

test('transport failure never retries, and pre-abort sends no request while in-flight abort reaches the real HTTP transport', { timeout: 10000 }, async t => {
  const { ctx, agent } = await fixture(t), f = await agent(1), selected = groups(); let hold = false, entered
  const transport = await httpFixture(t, response => {
    if (hold) { entered(); return }
    response.writeHead(503, { 'content-type': 'application/json' }); response.end('{"error":"synthetic_transport_failure"}')
  })
  installStdioOperationToolsV2(f.agent, { target: { kind: 'cloud' }, token: 'fixture' }, selected, transport.runtime, 'https://trusted.example')
  const toolName = selected[0].tools[0].model.name
  assert.equal((await run(ctx, f.agent, toolName)).isError, true); assert.equal(transport.requests.length, 1)
  const pre = new AbortController(); pre.abort()
  assert.equal((await run(ctx, f.agent, toolName, { text: 'literal' }, pre.signal)).isError, true)
  assert.equal(transport.requests.length, 1)
  const controller = new AbortController(), arrived = new Promise(resolve => { entered = resolve }); hold = true
  const pending = run(ctx, f.agent, toolName, { text: 'literal' }, controller.signal)
  await arrived; controller.abort()
  assert.equal((await pending).isError, true); assert.equal(transport.requests.length, 2)
  assert.equal(transport.signals.at(-1), controller.signal)
})
