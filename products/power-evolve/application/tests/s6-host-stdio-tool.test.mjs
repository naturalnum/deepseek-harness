/** A process MCP tool in the shared Host forwards only a stable call reference. */
import assert from 'node:assert/strict'
import { randomUUID } from 'node:crypto'
import test from 'node:test'
import { installStdioMcpTool } from '../lib/host/stdio-mcp.js'

function agentTools() {
  const registered = [], prompts = []
  const agent = { ctx: {
    tools: { register(value) { registered.push(value); return () => {} } },
    systemPrompt: { section(value) { prompts.push(value); return () => {} } },
    effect(start) { start() },
  } }
  return { agent, registered, prompts }
}

test('only a pinned cloud user call reaches Platform with its native tool call ID', async () => {
  const connectionId = randomUUID(), token = 'operation-token'
  const grant = { source: 'user', target: { kind: 'cloud' }, token,
    stdioMcpConnections: [{ connectionId, revision: 4 }] }
  const calls = [], runtime = { async call(path, supplied, body) {
    calls.push({ path, supplied, body })
    return { callId: randomUUID(), state: 'accepted' }
  } }
  const { agent, registered, prompts } = agentTools()
  installStdioMcpTool(agent, grant, runtime)
  assert.deepEqual(registered.map(value => value.name), ['mcp__stdio__whoami'])
  assert.equal(prompts.length, 1)
  const value = await registered[0].execute({}, { callId: 'native-call-42' })
  assert.equal(value.state, 'accepted')
  assert.deepEqual(calls, [{ path: '/runtime/stdio-mcp/call', supplied: token,
    body: { connectionId, revision: 4, callKey: 'native-call-42' } }])
  for (const variant of [
    { ...grant, stdioMcpConnections: [] },
    { ...grant, source: 'stdio_mcp_result' },
    { ...grant, target: { kind: 'desktop' } },
  ]) {
    const next = agentTools()
    installStdioMcpTool(next.agent, variant, runtime)
    assert.equal(next.registered.length, 0)
  }
})

test('Host rejects malformed Runner receipts before they reach the model', async () => {
  const grant = { source: 'user', target: { kind: 'cloud' }, token: 'grant',
    stdioMcpConnections: [{ connectionId: randomUUID(), revision: 1 }] }
  let result
  const runtime = { async call() { return result } }
  const { agent, registered } = agentTools()
  installStdioMcpTool(agent, grant, runtime)
  for (result of [
    { callId: randomUUID(), state: 'accepted', bearer: 'secret' },
    { callId: randomUUID(), state: 'succeeded', result: '界'.repeat(3000) },
    { callId: randomUUID(), state: 'unknown' },
  ]) await assert.rejects(registered[0].execute({}, { callId: 'same-call' }))
})
