/** Production route dispatch with explicit provider substitutes; HTTP authentication and real infrastructure are separate checks. */
import assert from 'node:assert/strict'
import { randomUUID } from 'node:crypto'
import test from 'node:test'
import { routeExecutionResolutionRead, routeExecutionResolutionApproval } from '../lib/platform/execution-resolution-routes.js'
import { EXECUTION_RESOLUTION_ROUTES as read, EXECUTION_RESOLUTION_APPROVAL_ROUTES as approval } from '../../contracts/lib/execution-resolution.js'

const user = { userId: randomUUID(), username: 'fixture-owner' }
const input = { requestId: randomUUID(), executionId: randomUUID(), target: 'cloud', fingerprint: 'a'.repeat(64), note: 'Exact command review' }
const origin = 'http://127.0.0.1:18001'
function provider() {
  const calls = []
  const called = method => async (...args) => { calls.push({ method, args }); return { method } }
  return { calls, listResolutions: called('list'), inspectResolution: called('inspect'),
    resolutionStatus: called('status'), resolveUncertain: called('resolve') }
}

test('the read-only route dispatcher cannot submit or redirect an approval action', async () => {
  const service = provider()
  for (const path of [approval.resolve, '/executions/resolutions/resolve']) {
    await assert.rejects(routeExecutionResolutionRead(service, path, user, input), { code: 'not_found' })
  }
  assert.equal(service.calls.length, 0)
  await routeExecutionResolutionRead(service, read.executionResolutionInspect, user, { executionId: input.executionId })
  assert.deepEqual(service.calls, [{ method: 'inspect', args: [user, input.executionId] }])
})

test('approval confirmation requires an exact independent Origin and rejects browser result assertions', async () => {
  const service = provider()
  for (const value of [undefined, 'null', 'http://127.0.0.1:18002', `${origin}/`, `${origin}.attacker.test`]) {
    await assert.rejects(routeExecutionResolutionApproval(service, approval.resolve, user, input,
      'approval-fixture', value, origin), { code: 'invalid_origin' })
  }
  await assert.rejects(routeExecutionResolutionApproval(service, approval.resolve, user,
    { ...input, result: { state: 'succeeded' } }, 'approval-fixture', origin, origin))
  assert.equal(service.calls.length, 0)
  await routeExecutionResolutionApproval(service, approval.resolve, user, input, 'approval-fixture', origin, origin)
  assert.deepEqual(service.calls, [{ method: 'resolve', args: [user, input, 'approval-fixture'] }])
})

test('an unavailable executor is explicit and never acknowledges confirmation', async () => {
  assert.deepEqual(await routeExecutionResolutionRead(null, read.executionResolutionsList, user, {}), { available: false, items: [] })
  await assert.rejects(routeExecutionResolutionRead(null, read.executionResolutionInspect, user,
    { executionId: input.executionId }), { code: 'sandbox_unavailable' })
  await assert.rejects(routeExecutionResolutionApproval(null, approval.resolve, user,
    input, 'approval-fixture', origin, origin), { code: 'sandbox_unavailable' })
})
