/** Keyless Host transport substitutes; these checks do not run a native application. */
import assert from 'node:assert/strict'
import { test } from 'node:test'
import { ExecutionResolutionClient, ExecutionResolutionHttpError, trustedApprovalUrl } from '../src/client/execution-resolution-client.ts'

const executionId = '00000000-0000-4000-8000-000000000001'
const sessionId = '00000000-0000-4000-8000-000000000002'
const requestId = '00000000-0000-4000-8000-000000000003'
const otherId = '00000000-0000-4000-8000-000000000004'
const item = { executionId, sessionId, target: 'cloud', executionState: 'uncertain',
  command: '<img src=x onerror=attack()>; printf original', cwd: '/workspace',
  createdAt: '2026-10-03T00:00:00Z', errorCode: 'runner_unknown', resolution: null }
const receipt = { executionId, sessionId, requestId, target: 'cloud', state: 'completed',
  finalState: 'closed_unknown', stopConfirmed: true, continuationQueued: true, errorCode: null }
const inspection = { item, fingerprint: 'a'.repeat(64), canStop: true,
  blockedReason: null, runnerObservation: 'not_observed' }
const signal = () => new AbortController().signal

test('only the three read-only Host RPCs use the exact request envelope and matching facts', async () => {
  const calls: { path: string; init?: RequestInit }[] = []
  const client = new ExecutionResolutionClient(async (input, init) => {
    calls.push({ path: String(input), ...(init ? { init } : {}) })
    return Response.json(String(input).endsWith('List') ? { available: true, items: [item] }
      : String(input).endsWith('Inspect') ? inspection : { receipt })
  })
  assert.equal((await client.list(sessionId, signal())).items[0]?.command, item.command)
  assert.equal((await client.inspect(executionId, signal())).fingerprint, inspection.fingerprint)
  assert.equal((await client.status(requestId, signal())).receipt?.finalState, 'closed_unknown')
  assert.deepEqual(calls.map(call => call.path), [
    '/api/powerEvolve/executionResolutionsList', '/api/powerEvolve/executionResolutionInspect',
    '/api/powerEvolve/executionResolutionStatus',
  ])
  assert.deepEqual(calls.map(call => JSON.parse(String(call.init?.body))), [
    { request: { sessionId } }, { request: { executionId } }, { request: { requestId } },
  ])
  for (const call of calls) {
    assert.equal(call.init?.method, 'POST'); assert.equal(call.init?.credentials, 'same-origin')
    assert.equal(call.init?.redirect, 'error'); assert(!JSON.stringify(call.init?.headers).includes('Bearer'))
  }
})

test('shared schemas and identity matching reject malformed or unrelated wire replies', async () => {
  for (const reply of [{ available: true, items: [{ ...item, sessionId: otherId }] },
    { available: true, items: [item, item] }, { available: true, items: [{ ...item, stopProof: {} }] },
    { available: true, items: [{ ...item, executionState: 'closed_unknown', resolution: { ...receipt, stopConfirmed: false } }] }]) {
    await assert.rejects(new ExecutionResolutionClient(async () => Response.json(reply)).list(sessionId, signal()))
  }
  await assert.rejects(new ExecutionResolutionClient(async () => Response.json({ ...inspection,
    item: { ...item, executionId: otherId } })).inspect(executionId, signal()), /Mismatched/)
  await assert.rejects(new ExecutionResolutionClient(async () => Response.json({ receipt: { ...receipt,
    requestId: otherId } })).status(requestId, signal()), /Mismatched/)
})

test('revocation, unavailable status and an aborted or oversized response never become completion', async () => {
  for (const status of [401, 403, 500, 503]) {
    await assert.rejects(new ExecutionResolutionClient(async () => new Response('', { status }))
      .list(sessionId, signal()), error => error instanceof ExecutionResolutionHttpError && error.status === status)
  }
  const controller = new AbortController(); controller.abort()
  await assert.rejects(new ExecutionResolutionClient(async () => Response.json({ available: true, items: [] }))
    .list(sessionId, controller.signal))
  await assert.rejects(new ExecutionResolutionClient(async () => new Response(' '.repeat(2 * 1024 * 1024 + 1)))
    .list(sessionId, signal()), /byte limit/)
})

test('the independent configured approval page is linked without receiving a Host credential', async () => {
  assert.equal(trustedApprovalUrl('https://platform.test/approval', 'https://host.test'), 'https://platform.test/approval')
  assert.equal(trustedApprovalUrl('http://127.0.0.1:3456/approval', 'http://127.0.0.1:3457'), 'http://127.0.0.1:3456/approval')
  for (const value of ['javascript:attack()', 'https://host.test/approval', 'https://x.test/approval/extra',
    'https://user:pass@x.test/approval', 'http://public.test/approval', 'https://x.test/approval?next=evil',
    'https://x.test/approval#evil', '/approval']) assert.throws(() => trustedApprovalUrl(value, 'https://host.test'))
  const client = new ExecutionResolutionClient(async (input, init) => {
    assert.equal(input, '/config'); assert.equal(init?.credentials, 'same-origin')
    assert.equal(init?.headers, undefined)
    return Response.json({ approvalUrl: 'https://platform.test/approval' })
  })
  assert.equal(await client.approvalUrl(signal(), 'https://host.test'), 'https://platform.test/approval')
})
