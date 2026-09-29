/** Approval receipts must expose the public Platform Origin, not the Host's internal Service URL. */
import test from 'node:test'
import assert from 'node:assert/strict'
import { randomUUID } from 'node:crypto'
import { installConnectorTools } from '../lib/host/connectors.js'

test('connector proposal returns a public approval link after an internal authenticated call', async () => {
  const tools = [], calls = []
  const agent = { ctx: { tools: { register(value) { tools.push(value); return () => {} } },
    effect(start) { start() } } }
  const actionId = randomUUID()
  const runtime = { config: { platformUrl: 'http://power-evolve-platform.internal:18881' },
    async call(path, token, body) {
      calls.push({ path, token, body })
      return { actionId, state: 'pending', text: 'exact note' }
    } }
  installConnectorTools(agent, { token: 'scoped-grant' }, runtime, 'https://platform.example.test')
  const proposal = tools.find(tool => tool.name === 'trial_notes_append')
  const result = await proposal.execute({ text: 'exact note' }, { callId: 'stable-call-id' })
  assert.deepEqual(result, { actionId, state: 'pending', text: 'exact note',
    approvalUrl: 'https://platform.example.test/approval' })
  assert.deepEqual(calls, [{ path: '/runtime/connectors/prepare', token: 'scoped-grant',
    body: { callId: 'stable-call-id', text: 'exact note' } }])
})
