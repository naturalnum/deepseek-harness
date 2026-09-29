/** Fixed MCP tool boundary: only an accepted connection identity crosses the Host. */
import test from 'node:test'
import assert from 'node:assert/strict'
import { randomUUID } from 'node:crypto'
import { installPersonalMcpTool } from '../lib/host/mcp.js'

function agentTools() {
  const registered = []
  const agent = { ctx: {
    tools: { register(definition) { registered.push(definition); return () => {} } },
    effect(start) { start() },
  } }
  return { agent, registered }
}

test('only one frozen cloud connection appears on its own user turn and reaches Platform', async () => {
  const connectionId = randomUUID(), token = 'operation-grant-only'
  const grant = { source: 'user', target: { kind: 'cloud' }, token,
    mcpConnections: [{ connectionId, revision: 7 }] }
  const calls = []
  const runtime = { async call(path, supplied, body) {
    calls.push({ path, supplied, body })
    return { toolName: 'mcp__personal__whoami', result: 'user:alice' }
  } }
  const { agent, registered } = agentTools()
  installPersonalMcpTool(agent, grant, runtime)
  assert.deepEqual(registered.map(tool => tool.name), ['mcp__personal__whoami'])
  assert.deepEqual(await registered[0].execute({}, {}), { result: 'user:alice' })
  assert.deepEqual(calls, [{ path: '/runtime/mcp/call', supplied: token,
    body: { connectionId, revision: 7 } }])
  assert.deepEqual(registered[0].output.render({}, { result: 'user:alice' }),
    [{ type: 'text', text: 'user:alice' }])

  for (const variant of [
    { ...grant, mcpConnections: [] },
    { ...grant, source: 'platform_action' },
    { ...grant, target: { kind: 'desktop', deviceId: randomUUID(), directoryId: randomUUID() } },
  ]) {
    const next = agentTools()
    installPersonalMcpTool(next.agent, variant, runtime)
    assert.equal(next.registered.length, 0)
  }
})

test('malformed and oversized platform results never become model-visible content', async () => {
  const grant = { source: 'user', target: { kind: 'cloud' }, token: 'operation-grant-only',
    mcpConnections: [{ connectionId: randomUUID(), revision: 1 }] }
  let value
  const runtime = { async call() { return value } }
  const { agent, registered } = agentTools()
  installPersonalMcpTool(agent, grant, runtime)
  const tool = registered[0]
  for (value of [
    { toolName: 'mcp__personal__write', result: 'unexpected' },
    { toolName: 'mcp__personal__whoami', result: 'secret', bearer: 'must-not-pass' },
    { toolName: 'mcp__personal__whoami', result: '界'.repeat(3000) },
  ]) await assert.rejects(tool.execute({}, {}))
})
