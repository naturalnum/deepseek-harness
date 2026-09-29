/** The native SSH tool forwards only an exact proposal under one pinned cloud grant. */
import assert from 'node:assert/strict'
import { randomUUID } from 'node:crypto'
import test from 'node:test'
import { installSshExecuteTool } from '../lib/host/ssh-execute.js'

function agentTools() {
  const registered = [], prompts = []
  const agent = { ctx: {
    tools: { register(value) { registered.push(value); return () => {} } },
    systemPrompt: { section(value) { prompts.push(value); return () => {} } },
    effect(start) { start() },
  } }
  return { agent, registered, prompts }
}

test('only a pinned user cloud grant proposes the exact command with its native tool ID', async () => {
  const connectionId = randomUUID(), token = 'operation-token', actionId = randomUUID()
  const selected = { connectionId, revision: 4, credentialRevision: 2,
    displayName: 'QA', host: 'fixture.example.test', port: 2222, username: 'alice' }
  const grant = { source: 'user', target: { kind: 'cloud' }, token, sshConnections: [selected] }
  const calls = [], runtime = { config: { platformUrl: 'https://platform.example.test' },
    async call(path, supplied, body) {
      calls.push({ path, supplied, body })
      return { actionId, state: 'pending', fingerprint: 'a'.repeat(64) }
    } }
  const { agent, registered, prompts } = agentTools()
  installSshExecuteTool(agent, grant, runtime)
  assert.deepEqual(registered.map(value => value.name), ['ssh_execute_propose'])
  assert.equal(prompts.length, 1)
  assert.match(prompts[0].text, /fixture\.example\.test:2222/u)
  const value = await registered[0].execute({ connectionId, command: 'printf exact' },
    { callId: 'native-call-42' })
  assert.deepEqual(value, { actionId, state: 'pending', fingerprint: 'a'.repeat(64),
    approvalUrl: 'https://platform.example.test/approval' })
  assert.deepEqual(calls, [{ path: '/runtime/ssh-execute/propose', supplied: token,
    body: { callKey: 'native-call-42', connectionId, connectionRevision: 4,
      credentialRevision: 2, command: 'printf exact' } }])
  await assert.rejects(registered[0].execute({ connectionId: randomUUID(), command: 'echo no' },
    { callId: 'other' }))
  await assert.rejects(registered[0].execute({ connectionId, command: 'x'.repeat(16_385) },
    { callId: 'oversized' }))
  assert.equal(calls.length, 1)
  for (const variant of [
    { ...grant, sshConnections: [] },
    { ...grant, source: 'ssh_execute_result' },
    { ...grant, target: { kind: 'desktop' } },
  ]) {
    const next = agentTools()
    installSshExecuteTool(next.agent, variant, runtime)
    assert.equal(next.registered.length, 0)
  }
})

test('Host refuses malformed platform receipts before presenting them to the model', async () => {
  const connectionId = randomUUID()
  const grant = { source: 'user', target: { kind: 'cloud' }, token: 'grant',
    sshConnections: [{ connectionId, revision: 1, credentialRevision: 1 }] }
  let result
  const runtime = { config: { platformUrl: 'https://platform.example.test' },
    async call() { return result } }
  const { agent, registered } = agentTools()
  installSshExecuteTool(agent, grant, runtime)
  for (result of [
    { actionId: randomUUID(), state: 'pending', fingerprint: 'a'.repeat(64), credential: 'secret' },
    { actionId: randomUUID(), state: 'pending', fingerprint: 'plain-sha256' },
    { actionId: randomUUID(), state: 'unknown', fingerprint: 'a'.repeat(64) },
  ]) await assert.rejects(registered[0].execute({ connectionId, command: 'whoami' }, { callId: 'same' }))
})
