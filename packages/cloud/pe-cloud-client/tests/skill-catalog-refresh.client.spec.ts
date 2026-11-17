/** Actual Native cache and Session owners; only the remote boundary is scripted. */
import { Context } from '@deepseek-ai/cordis'
import { LocaleRuntime } from '@deepseek-ai/dsh-client-locale/client'
import { SlotRegistry } from '@deepseek-ai/dsh-client-ui-renderer/client'
import { InputTriggerService, type ClientSessionContext } from '@deepseek-ai/dsh-client-ui-input-trigger/client'
import { TestRemote, TestSessions } from '@deepseek-ai/dsh-client-test-runtime'
import { apply, inject } from '@deepseek-ai/dsh-client-ui-skill/client'
import type { SessionId } from '@deepseek-ai/dsh-session/types'
import { expect, it, onTestFinished, vi } from 'vitest'
import { UiConversation } from '@deepseek-ai/dsh-client-ui-conversation/client'
import { installCloudSkillCatalogRefresh } from '../src/client/skill-catalog-refresh.ts'

type Row = { name: string; description: string; modelInvocable: true }
type Reply = { ok: true; value: { skills: Row[] } }
type List = (payload: object, signal?: AbortSignal) => Promise<Reply>
const rows = (name: string): Row[] => [{ name, description: name, modelInvocable: true }]
const session = (id: string): ClientSessionContext => ({ sessionId: id as SessionId })
const request = () => ({ query: '', position: 'leading' as const, drilled: false, signal: new AbortController().signal })
async function fixture(list: List) {
  const ctx = new Context(), sessions = new TestSessions(async (action) => { await action() }, ctx)
  ctx.provide('sessions', sessions)
  onTestFinished(async () => { await ctx.fiber.dispose(); await sessions.disposeScopes() })
  for (const id of ['same-session', 'other-session']) {
    await sessions.add({ id }); sessions.retainFor(ctx, id as SessionId)
  }
  const remote = new TestRemote(ctx, { skills: { list } })
  const slots = new SlotRegistry(ctx), locale = new LocaleRuntime(ctx)
  ctx.provide('locale', locale)
  ctx.provide('sidebarRight', { openResource: vi.fn() })
  new UiConversation(ctx, sessions)
  slots.register({ name: 'root', children: {
    'tool.call.toolview': { kind: 'keyed', scope: 'session' },
    'conversation.user.text.node': { kind: 'keyed', scope: 'session', inline: true },
  } } as never, () => null)
  const triggers = new InputTriggerService(ctx), registrations = vi.spyOn(triggers, 'registerSource')
  const mountNative = async () => {
    const fiber = ctx.plugin({ inject: [...inject], apply }); await fiber.await(); return fiber
  }
  const mountCloud = async () => {
    const fiber = ctx.plugin(installCloudSkillCatalogRefresh); await fiber.await(); return fiber
  }
  const source = () => {
    const value = registrations.mock.calls.at(-1)?.[0]
    if (value === undefined) throw new Error('Original Native skill source did not register')
    return value
  }
  const native = await mountNative()
  return { ctx, sessions, remote, native, mountNative, mountCloud, source }
}

it('refreshes both original Session caches once and leaves another account with the same Session ID untouched', async () => {
  let aRows = rows('account-a-before'), bRows = rows('account-b-before')
  const aList = vi.fn(async () => ({ ok: true as const, value: { skills: aRows } }))
  const bList = vi.fn(async () => ({ ok: true as const, value: { skills: bRows } }))
  const a = await fixture(aList), b = await fixture(bList)
  await a.mountCloud(); await b.mountCloud()
  const aSource = a.source(), bSource = b.source()
  for (const id of ['same-session', 'other-session']) {
    await aSource.candidates(session(id), request()); await bSource.candidates(session(id), request())
  }
  const first = vi.fn(), second = vi.fn(), otherAccount = vi.fn()
  aSource.subscribeLexicon!(session('same-session'), first)
  aSource.subscribeLexicon!(session('other-session'), second)
  bSource.subscribeLexicon!(session('same-session'), otherAccount)
  aRows = rows('account-a-after'); bRows = rows('account-b-after')
  a.remote.emit('skills/change', [])
  expect(first).toHaveBeenCalledTimes(1); expect(second).toHaveBeenCalledTimes(1)
  expect(otherAccount).not.toHaveBeenCalled()
  expect(aSource.lexicon!(session('same-session'))).toBeUndefined()
  expect(bSource.lexicon!(session('same-session'))).toEqual(['account-b-before'])
  const [one, two] = await Promise.all([
    aSource.candidates(session('same-session'), request()), aSource.candidates(session('same-session'), request()),
  ])
  expect(one.map(row => row.name)).toEqual(['account-a-after']); expect(two).toEqual(one)
  await aSource.candidates(session('other-session'), request())
  expect(aList).toHaveBeenCalledTimes(4); expect(bList).toHaveBeenCalledTimes(2)
})

it('withdraws the Cloud event subscription and rebinds it to a replacement original Native cache provider', async () => {
  let current = rows('before')
  const list = vi.fn(async () => ({ ok: true as const, value: { skills: current } }))
  const f = await fixture(list), source = f.source(), owner = await f.mountCloud()
  await source.candidates(session('same-session'), request())
  await owner.dispose(); current = rows('after-cloud-withdrawal'); f.remote.emit('skills/change', [])
  expect(source.lexicon!(session('same-session'))).toEqual(['before'])
  await f.mountCloud()
  const oldControl = vi.spyOn(f.ctx.uiSkillCatalog, 'invalidate')
  await f.native.dispose()
  expect(f.ctx.get('uiSkillCatalog')).toBeUndefined()
  f.remote.emit('skills/change', []); expect(oldControl).not.toHaveBeenCalled()
  await f.mountNative()
  const replacement = f.source(), refreshed = vi.fn()
  expect(replacement).not.toBe(source)
  await replacement.candidates(session('same-session'), request())
  replacement.subscribeLexicon!(session('same-session'), refreshed)
  current = rows('after-native-replacement'); f.remote.emit('skills/change', [])
  expect(refreshed).toHaveBeenCalledTimes(1); expect(oldControl).not.toHaveBeenCalled()
  expect(replacement.lexicon!(session('same-session'))).toBeUndefined()
  expect((await replacement.candidates(session('same-session'), request())).map(row => row.name)).toEqual(['after-native-replacement'])
})

it('aborts a stale Cloud catalog read while the original Session retains the real RPC until it settles', async () => {
  const gate = Promise.withResolvers<Reply>()
  let rpcSignal: AbortSignal | undefined
  const list = vi.fn((_payload: object, signal?: AbortSignal) => { rpcSignal = signal; return gate.promise })
  const f = await fixture(list); await f.mountCloud()
  const source = f.source(), stale = expect(source.candidates(session('same-session'), request())).rejects.toThrow()
  try {
    await vi.waitFor(() => { expect(list).toHaveBeenCalledTimes(1) })
    expect(f.sessions.retainInfo('same-session' as SessionId).getSnapshot().referenceCount).toBe(2)
    f.remote.emit('skills/change', [])
    expect(rpcSignal?.aborted).toBe(true)
    expect(f.sessions.retainInfo('same-session' as SessionId).getSnapshot().referenceCount).toBe(2)
    gate.resolve({ ok: true, value: { skills: rows('stale') } }); await stale
    expect(f.sessions.retainInfo('same-session' as SessionId).getSnapshot().referenceCount).toBe(1)
    expect(source.lexicon!(session('same-session'))).toBeUndefined()
  } finally { gate.resolve({ ok: true, value: { skills: [] } }); await stale }
})
