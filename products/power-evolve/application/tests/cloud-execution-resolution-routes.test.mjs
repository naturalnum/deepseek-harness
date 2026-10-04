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

test('explicit Desktop reads and approvals never fall back to Cloud for the same identity', async () => {
  const cloud = provider(), desktop = provider(), request = { ...input, target: 'desktop' }
  await routeExecutionResolutionRead(cloud, read.executionResolutionInspect, user,
    { executionId: input.executionId, target: 'desktop' }, desktop)
  await routeExecutionResolutionRead(cloud, read.executionResolutionStatus, user,
    { requestId: input.requestId, target: 'desktop' }, desktop)
  await routeExecutionResolutionApproval(cloud, approval.resolve, user, request,
    'approval-fixture', origin, origin, desktop)
  assert.deepEqual(cloud.calls, [])
  assert.deepEqual(desktop.calls, [
    { method: 'inspect', args: [user, input.executionId] },
    { method: 'status', args: [user, input.requestId] },
    { method: 'resolve', args: [user, request, 'approval-fixture'] },
  ])
  for (const [path, body] of [[read.executionResolutionInspect, { executionId: input.executionId, target: 'desktop' }],
    [read.executionResolutionStatus, { requestId: input.requestId, target: 'desktop' }]]) {
    await assert.rejects(routeExecutionResolutionRead(cloud, path, user, body), { code: 'device_unavailable' })
  }
  await assert.rejects(routeExecutionResolutionApproval(cloud, approval.resolve, user, request,
    'approval-fixture', origin, origin), { code: 'device_unavailable' })
  assert.deepEqual(cloud.calls, [])
})

test('owner-wide lists merge both providers in bounded acceptance order while preserving targets', async () => {
  const cloud = provider(), desktop = provider()
  const item = (index, target) => ({ executionId: randomUUID(), sessionId: randomUUID(), target,
    executionState: 'uncertain', command: `printf ${index}`, cwd: '.', errorCode: null, resolution: null,
    createdAt: new Date(Date.UTC(2026, 9, 4, 0, 0, index)).toISOString() })
  const cloudItems = Array.from({ length: 100 }, (_, index) => item(index, 'cloud'))
  const desktopItems = Array.from({ length: 100 }, (_, index) => item(index + 100, 'desktop'))
  cloud.listResolutions = async () => ({ available: true, items: cloudItems })
  desktop.listResolutions = async () => ({ available: true, items: desktopItems })
  const result = await routeExecutionResolutionRead(cloud, read.executionResolutionsList, user, {}, desktop)
  assert.equal(result.items.length, 100)
  assert.deepEqual(result.items, [...desktopItems].reverse())
  assert.equal(result.available, true)
  const deviceOnly = await routeExecutionResolutionRead(null, read.executionResolutionsList, user, {}, desktop)
  assert.equal(deviceOnly.available, true)
  assert.equal(deviceOnly.items.length, 100)
})

test('Desktop confirmation retains exact Origin and refuses browser-supplied stop proof', async () => {
  const cloud = provider(), desktop = provider(), request = { ...input, target: 'desktop' }
  await assert.rejects(routeExecutionResolutionApproval(cloud, approval.resolve, user, request,
    'approval-fixture', undefined, origin, desktop), { code: 'invalid_origin' })
  await assert.rejects(routeExecutionResolutionApproval(cloud, approval.resolve, user,
    { ...request, stopConfirmed: true }, 'approval-fixture', origin, origin, desktop))
  await assert.rejects(routeExecutionResolutionRead(cloud, read.executionResolutionInspect, user,
    { executionId: input.executionId, target: 'other' }, desktop))
  assert.deepEqual(cloud.calls, []); assert.deepEqual(desktop.calls, [])
})
