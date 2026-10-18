/** Actual unpublished native graph audit; no storage owner, PG claim, Root seal or AccountUse is manufactured. */
import { expect, it, vi } from 'vitest'
import { policyFixture } from './account-policy-fixture.ts'

it('audits actual guarded native handlers before publication using the original policy and native Gateway', async () => {
  const graph = await policyFixture().start()
  const calls = graph.directoryCalls.length
  const writes = vi.spyOn(graph.ctx.sessionPersistence, 'create')
  graph.api.invalidate()
  expect(() => graph.api.requireRpc('session/create')).toThrow(expect.objectContaining({ code: 'cloud/account-unavailable' }))
  await expect(graph.api.auditPrepared(graph.ctx)).resolves.toBeUndefined()
  expect(graph.api.requireRpc('session/create').handlerId).toBe('native:sessionController')
  expect(graph.api.requireStream('session/follow').guard).toBe('account-session')
  expect(() => graph.api.requireRpc('session/fork')).toThrow(expect.objectContaining({ code: 'cloud/forbidden' }))
  expect(graph.directoryCalls.length).toBe(calls)
  expect(writes).not.toHaveBeenCalled()
  expect(graph.ctx.sessions.list()).toEqual([])
  expect(graph.adapter.calls).toBe(0)
})

it('rejects an inherited unguarded native endpoint even when the deployment manifest names a real Remote marker', async () => {
  const graph = await policyFixture([{ endpoint: 'session/modelCatalog', handlerId: 'native:sessionController', guard: 'account-session' }]).start()
  await expect(graph.api.auditPrepared(graph.ctx)).rejects.toMatchObject({ code: 'cloud/invalid-config' })
  expect(() => graph.api.requireRpc('session/create')).toThrow(expect.objectContaining({ code: 'cloud/account-unavailable' }))
  expect(graph.adapter.calls).toBe(0)
})

it('rejects a replaced guarded implementation without invoking it or accepting copied manifest inventory', async () => {
  const graph = await policyFixture().start()
  const replacement = vi.spyOn(graph.ctx.sessionController, 'create').mockImplementation(async () => { throw new Error('Replaced native method') })
  try {
    await expect(graph.api.auditPrepared(graph.ctx)).rejects.toMatchObject({ code: 'cloud/account-unavailable' })
    expect(replacement).not.toHaveBeenCalled()
  } finally { replacement.mockRestore() }
})

it('rechecks original native listener ownership after pending prepared metadata', async () => {
  const graph = await policyFixture().start()
  const entered = Promise.withResolvers<undefined>(), release = Promise.withResolvers<undefined>()
  const original = graph.adapter.resolveModel.bind(graph.adapter)
  vi.spyOn(graph.adapter, 'resolveModel').mockImplementationOnce(async (...args) => {
    entered.resolve(undefined); await release.promise; return original(...args)
  })
  const reading = graph.api.auditPrepared(graph.ctx)
  const rejected = expect(reading).rejects.toMatchObject({ code: 'cloud/account-unavailable' })
  try { await entered.promise; graph.withdrawLlmGuard() }
  finally { release.resolve(undefined) }
  await rejected
  expect(graph.adapter.calls).toBe(0)
})
