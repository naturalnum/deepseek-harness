/** Original account Loader, checked key writes, native catalog and Gateway notifications. */
import { credentialRef } from '@deepseek-ai/dsh-credentials'
import { buildModelCatalog } from '../../../api/session-controller/src/catalog.ts'
import { expect, it } from 'vitest'
import { localeFixture } from './locale-field-fixture.ts'

it('publishes committed model-key changes only to the owning account and keeps actual native model availability current', async () => {
  const a = await localeFixture('model-events-a', true, undefined, 'normal', true)
  const b = await localeFixture('model-events-b', true, undefined, 'normal', true)
  await a.unsetKey(a.keyStateBefore.version)
  const catalog = () => buildModelCatalog(a.ctx, { provider: 'deepseek-official', model: 'synthetic' })
  expect((await catalog()).groups).toEqual([])
  const streamA = await a.openEvents(), streamB = await b.openEvents()
  await expect(streamA.next()).resolves.toMatchObject({ value: { type: 'ready' } })
  await expect(streamB.next()).resolves.toMatchObject({ value: { type: 'ready' } })
  const nextA = streamA.next()
  let aResolved = false
  void nextA.then(() => { aResolved = true })
  a.ctx.emit('credentials/reference-updated', credentialRef('UNAPPROVED_MODEL_KEY'))
  await b.writeKey(b.keyStateBefore.version, 'synthetic-b-key')
  await expect(streamB.next()).resolves.toMatchObject({ value: {
    type: 'emit', event: 'credentials/reference-updated', args: [b.ref],
  } })
  expect(aResolved).toBe(false)
  expect(a.events?.inspect().queuedEvents).toBe(0)
  expect((await catalog()).groups).toEqual([])
  await expect(a.writeKey(a.keyStateBefore.version, 'stale-must-not-save')).rejects.toMatchObject({ code: 'cloud/config-conflict' })
  expect(aResolved).toBe(false)
  expect(a.events?.inspect().queuedEvents).toBe(0)

  await a.writeKey((await a.keyState()).version, 'synthetic-a-key')
  const added = await nextA
  expect(added.value).toEqual({ type: 'emit', event: 'credentials/reference-updated', args: [a.ref] })
  expect(JSON.stringify(added.value)).not.toContain('synthetic-a-key')
  expect((await catalog()).groups).toMatchObject([{ id: 'deepseek-official', models: [{ id: 'synthetic' }] }])

  const nextRemoval = streamA.next()
  await a.unsetKey((await a.keyState()).version)
  await expect(nextRemoval).resolves.toEqual({ done: false,
    value: { type: 'emit', event: 'credentials/reference-updated', args: [a.ref] } })
  expect((await catalog()).groups).toEqual([])
  expect(a.barrier.snapshot().failures).toEqual([])
  expect(b.barrier.snapshot().failures).toEqual([])
})
