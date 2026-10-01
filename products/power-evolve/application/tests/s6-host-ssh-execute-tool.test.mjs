/** The native SSH tool forwards only an exact proposal under one pinned cloud grant. */
import assert from 'node:assert/strict'
import { randomUUID } from 'node:crypto'
import test from 'node:test'
import { installSshExecuteTool } from '../lib/host/ssh-execute.js'
import { assertModelToolDeclarations, modelMessageTool } from '../lib/mcp-model-tools.js'

function agentTools() {
  const registered = [], prompts = []
  const agent = { ctx: {
    tools: { register(value) { registered.push(value); return () => {} } },
    systemPrompt: { section(value) { prompts.push(value); return () => {} } },
    effect(start) { start() },
  } }
  return { agent, registered, prompts }
}

/** Read the distinct JSONL block without treating its fence or approval instructions as connection metadata. */
function pinnedConnections(prompt) {
  const [instructions, block, extra] = prompt.split('\n\n```jsonl\n')
  assert.match(instructions, /Pinned SSH connections:$/u)
  assert.equal(extra, undefined)
  assert.ok(block?.endsWith('\n```'))
  return block.slice(0, -4).split('\n').map(value => JSON.parse(value))
}

test('only a pinned user cloud grant proposes the exact command with its native tool ID', async () => {
  const connectionId = randomUUID(), token = 'operation-token', actionId = randomUUID()
  const selected = { connectionId, revision: 4, credentialRevision: 2,
    displayName: 'QA', host: 'fixture.example.test', port: 2222, username: 'alice' }
  const grant = { source: 'user', target: { kind: 'cloud' }, token, sshConnections: [selected] }
  const calls = [], runtime = { config: { platformUrl: 'http://platform.internal.test' },
    async call(path, supplied, body) {
      calls.push({ path, supplied, body })
      return { actionId, state: 'pending', fingerprint: 'a'.repeat(64) }
    } }
  const { agent, registered, prompts } = agentTools()
  installSshExecuteTool(agent, grant, runtime, 'https://platform.example.test')
  assert.deepEqual(registered.map(value => value.name), ['ssh_execute_propose'])
  assert.equal(prompts.length, 1)
  const pinned = pinnedConnections(prompts[0].text)
  assert.deepEqual(pinned, [{ connectionId, displayName: 'QA', username: 'alice', host: 'fixture.example.test', port: 2222 }])
  assert.match(registered[0].parameters.properties.connectionId.description, /only that UUID/u)
  const declaration = modelMessageTool.parse({ name: registered[0].name,
    description: registered[0].description, input_schema: registered[0].parameters })
  assertModelToolDeclarations([declaration], [])
  assert.equal(declaration.input_schema.properties.connectionId.type, 'string')
  assert.deepEqual(declaration.input_schema.required, ['connectionId', 'command'])
  const value = await registered[0].execute({ connectionId, command: 'printf exact' },
    { callId: 'native-call-42' })
  assert.deepEqual(value, { actionId, state: 'pending', fingerprint: 'a'.repeat(64),
    approvalUrl: 'https://platform.example.test/approval' })
  assert.deepEqual(calls, [{ path: '/runtime/ssh-execute/propose', supplied: token,
    body: { callKey: 'native-call-42', connectionId, connectionRevision: 4,
      credentialRevision: 2, command: 'printf exact' } }])
  await assert.rejects(registered[0].execute({ connectionId: randomUUID(), command: 'echo no' },
    { callId: 'other' }))
  for (const decorated of [`${connectionId}@alice@fixture.example.test:2222`,
    'alice@fixture.example.test:2222']) {
    await assert.rejects(registered[0].execute({ connectionId: decorated, command: 'echo no' },
      { callId: 'decorated' }), /SSH command or connection invalid/u)
  }
  await assert.rejects(registered[0].execute({ connectionId, command: 'x'.repeat(16_385) },
    { callId: 'oversized' }))
  assert.equal(calls.length, 1)
  for (const variant of [
    { ...grant, sshConnections: [] },
    { ...grant, source: 'ssh_execute_result' },
    { ...grant, target: { kind: 'desktop' } },
  ]) {
    const next = agentTools()
    installSshExecuteTool(next.agent, variant, runtime, 'https://platform.example.test')
    assert.equal(next.registered.length, 0)
  }
})

test('connections sharing a login destination expose distinct pinned names and require their exact UUIDs', async () => {
  const sameTarget = { host: 'fixture.example.test', port: 2222, username: 'alice' }
  const connections = [
    { ...sameTarget, connectionId: randomUUID(), displayName: 'Primary "East"', revision: 7, credentialRevision: 3 },
    { ...sameTarget, connectionId: randomUUID(), displayName: 'Secondary', revision: 2, credentialRevision: 1 },
  ]
  const grant = { source: 'user', target: { kind: 'cloud' }, token: 'operation-token', sshConnections: connections }
  const calls = [], runtime = { async call(_path, _token, body) {
    calls.push(body)
    return { actionId: randomUUID(), state: 'pending', fingerprint: 'a'.repeat(64) }
  } }
  const { agent, registered, prompts } = agentTools()
  installSshExecuteTool(agent, grant, runtime, 'https://platform.example.test')
  const pinned = pinnedConnections(prompts[0].text)
  assert.deepEqual(pinned, connections.map(({ connectionId, displayName, username, host, port }) =>
    ({ connectionId, displayName, username, host, port })))
  assert.equal(calls.length, 0)
  for (const connection of connections) {
    await assert.rejects(registered[0].execute({ connectionId: connection.displayName, command: 'id' },
      { callId: 'name' }), /SSH command or connection invalid/u)
    await registered[0].execute({ connectionId: connection.connectionId, command: 'id' },
      { callId: `selected-${connection.revision}` })
  }
  assert.deepEqual(calls, connections.map(connection => ({ callKey: `selected-${connection.revision}`,
    connectionId: connection.connectionId, connectionRevision: connection.revision,
    credentialRevision: connection.credentialRevision, command: 'id' })))
})

test('Host refuses malformed platform receipts before presenting them to the model', async () => {
  const connectionId = randomUUID()
  const grant = { source: 'user', target: { kind: 'cloud' }, token: 'grant',
    sshConnections: [{ connectionId, revision: 1, credentialRevision: 1 }] }
  let result
  const runtime = { config: { platformUrl: 'http://platform.internal.test' },
    async call() { return result } }
  const { agent, registered } = agentTools()
  installSshExecuteTool(agent, grant, runtime, 'https://platform.example.test')
  for (result of [
    { actionId: randomUUID(), state: 'pending', fingerprint: 'a'.repeat(64), credential: 'secret' },
    { actionId: randomUUID(), state: 'pending', fingerprint: 'plain-sha256' },
    { actionId: randomUUID(), state: 'unknown', fingerprint: 'a'.repeat(64) },
  ]) await assert.rejects(registered[0].execute({ connectionId, command: 'whoami' }, { callId: 'same' }))
})
