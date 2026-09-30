/** JSON byte budgets apply to internal results without relaxing user input admission. */
import test from 'node:test'
import assert from 'node:assert/strict'
import { randomUUID } from 'node:crypto'
import { continuationInput } from '../lib/continuation-input.js'
import { grant, promptRequest } from '../lib/contracts.js'

test('runtime grants distinguish user prompts from platform results', () => {
  const value = { operationId: randomUUID(), sessionId: randomUUID(), userId: randomUUID(),
    requestId: randomUUID(), text: 'office guide '.repeat(4000), token: 'x'.repeat(43), epoch: 1,
    settings: { model: 'fixture', maxTokens: 128, revision: 1 } }
  assert.equal(promptRequest.safeParse({ sessionId: value.sessionId, requestId: value.requestId,
    text: value.text }).success, false)
  assert.equal(grant.safeParse(value).success, false)
  for (const source of ['sandbox_result', 'desktop_result', 'ssh_execute_result', 'stdio_mcp_result', 'platform_action']) {
    assert.equal(grant.parse({ ...value, source }).text, value.text)
  }
  assert.equal(grant.safeParse({ ...value, source: 'sandbox_result', text: '\u0001'.repeat(65536) }).success, false)
})

test('continuations preserve normal output and bound escaped Unicode excerpts', () => {
  const normal = 'office guide '.repeat(4000)
  assert.equal(continuationInput(normal, 524288), normal)
  for (const limit of [1024, 8192, 524288]) {
    const result = continuationInput('begin:' + '\u0001表😀\\"'.repeat(65536) + ':end', limit)
    assert(Buffer.byteLength(JSON.stringify(result)) <= Math.min(262144, limit / 2))
    assert(result.isWellFormed())
    assert.match(result, /Internal result truncated/u)
    assert.match(result, /begin:/u)
    assert(result.endsWith(':end'))
  }
})
