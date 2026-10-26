import { afterEach, describe, expect, it, vi } from 'vitest'
import { Context } from '@deepseek-ai/cordis'
import { bindScopeParent, createScope, scopeOf } from '@deepseek-ai/dsh-scope'
import SkillRegistry, { type SkillCandidate, type SkillProvider, type SkillProviderControl, type SkillViewOptions } from '@deepseek-ai/dsh-skill'

const disposers: Array<() => Promise<unknown>> = []
async function registry(cacheEntries = 2): Promise<Context> {
  const ctx = new Context()
  const fiber = ctx.plugin(SkillRegistry, { collectCacheMaxEntries: cacheEntries })
  await fiber
  disposers.push(() => fiber.dispose())
  return ctx
}
afterEach(async () => { for (const dispose of disposers.splice(0)) await dispose() })
function candidate(provider: string, description: string, rank: number, name = 'same'): SkillCandidate {
  return { name, description, rank, provider, source: provider, locator: { description },
    invocation: { modelInvocable: false, userInvocable: true }, path: '/private/' + provider + '/SKILL.md',
    resourceBase: { kind: 'opaque', description: provider }, metadata: { owner: provider } }
}
function provider(name: string, candidates: readonly SkillCandidate[]) {
  const list = vi.fn(async (_options: SkillViewOptions) => candidates)
  const get = vi.fn(async (value: SkillCandidate) => ({ ...value, content: value.description }))
  return { name, list, get } satisfies SkillProvider
}
function service(ctx: Context): SkillRegistry {
  const skills = ctx.get('skills')
  if (skills === undefined) throw new Error('Missing skills fixture')
  return skills
}

describe('SkillRegistry candidate inspection', () => {
  it('reports every rank/tie/runtime candidate using the cached native winner without loading a body', async () => {
    const ctx = await registry(), first = candidate('project', 'first local candidate', 100)
    const duplicate = candidate('project', 'second local candidate', 100)
    const later = candidate('later', 'later provider', 100), user = candidate('user', 'user', 300)
    const bundled = candidate('bundled', 'bundled', 600)
    const project = provider('project', [first, duplicate]), second = provider('later', [later]), third = provider('user', [user]), fourth = provider('bundled', [bundled])
    ctx.skills.registerProvider(() => project)
    ctx.skills.registerProvider(() => second)
    ctx.skills.registerProvider(() => third)
    ctx.skills.registerProvider(() => fourth)
    ctx.skills.register({ name: 'same', description: 'runtime', source: 'runtime', content: 'runtime body' })
    const snapshot = await ctx.skills.snapshot()
    const observed = await ctx.skills.inspect()
    expect(observed.complete).toBe(true)
    expect(observed.candidates).toHaveLength(6)
    expect(observed.candidates.filter(row => row.selected).map(row => row.candidate.description))
      .toEqual(snapshot.skills.map(row => row.description))
    for (const row of observed.candidates) {
      expect(row.selected).toBe(row.candidate === first)
      expect(row.overriddenBy).toBe(row.selected ? undefined : first)
    }
    expect(observed.candidates[0]?.candidate).toBe(first)
    expect(observed.candidates[0]?.candidate.locator).toBe(first.locator)
    expect(observed.candidates[0]?.candidate.metadata).toBe(first.metadata)
    expect(project.list).toHaveBeenCalledTimes(1)
    expect(project.get).not.toHaveBeenCalled(); expect(second.get).not.toHaveBeenCalled()
    expect((await ctx.skills.get('same'))?.content).toBe(first.description)
    expect(project.get).toHaveBeenCalledWith(first, expect.any(Object))
    expect(second.get).not.toHaveBeenCalled()
  })

  it('keeps same-reference duplicate entries distinct while selecting exactly the first local occurrence', async () => {
    const ctx = await registry(), value = candidate('repeated', 'same object twice', 10)
    ctx.skills.registerProvider(() => provider('repeated', [value, value]))
    const observed = await ctx.skills.inspect()
    expect(observed.candidates.map(row => row.selected)).toEqual([true, false])
    expect(observed.candidates[0]?.candidate).toBe(value)
    expect(observed.candidates[1]?.overriddenBy).toBe(value)
    expect((await ctx.skills.snapshot()).skills).toHaveLength(1)
  })

  it('keeps closest-scope precedence and reparenting while exposing every covered contribution', async () => {
    const ctx = await registry(), global = candidate('same-provider', 'global', 1)
    ctx.skills.registerProvider(() => provider('same-provider', [global]))
    const parentA = createScope(ctx, { preset: 'a' }), parentB = createScope(ctx, { preset: 'b' })
    const a = candidate('same-provider', 'parent-a', 900), b = candidate('same-provider', 'parent-b', 1000)
    service(parentA.ctx).registerProvider(() => provider('same-provider', [a]))
    service(parentB.ctx).registerProvider(() => provider('same-provider', [b]))
    const key = {}, parent = bindScopeParent(key, scopeOf(parentA.ctx)!)
    const fromA = await ctx.skills.inspect({ scope: key })
    expect(fromA.candidates.map(row => [row.candidate.description, row.selected])).toEqual([['global', false], ['parent-a', true]])
    expect(fromA.candidates[0]?.overriddenBy).toBe(a)
    expect((await ctx.skills.get('same', { scope: key }))?.description).toBe('parent-a')
    parent.rebind(scopeOf(parentB.ctx)!)
    const fromB = await ctx.skills.inspect({ scope: key })
    expect(fromB.candidates.map(row => row.candidate.description)).toEqual(['global', 'parent-b'])
    expect(fromB.candidates[0]?.overriddenBy).toBe(b)
    expect((await ctx.skills.inspect()).candidates.map(row => row.candidate)).toEqual([global])
    await parentA.dispose(); await parentB.dispose()
  })

  it('shares completed collections with snapshot/get and preserves the finite cwd cache eviction', async () => {
    const ctx = await registry(2), values = ['c', 'a', 'b'].map(name => candidate('catalog', name, 1, name))
    const source = provider('catalog', values)
    ctx.skills.registerProvider(() => source)
    const options = { cwd: '/workspace/a' }
    expect((await ctx.skills.inspect(options)).candidates.map(row => row.candidate.name)).toEqual(['a', 'b', 'c'])
    await ctx.skills.snapshot(options); await ctx.skills.get('a', options)
    expect(source.list).toHaveBeenCalledTimes(1)
    expect(source.list.mock.calls[0]?.[0]).toBe(options)
    await ctx.skills.inspect({ cwd: '/workspace/b' }); await ctx.skills.inspect({ cwd: '/workspace/c' })
    await ctx.skills.inspect(options)
    expect(source.list).toHaveBeenCalledTimes(4)
  })

  it('never caches incomplete discovery and bounds revision retries with the original two attempts', async () => {
    const ctx = await registry(), seen = candidate('partial', 'visible partial candidate', 1)
    const partialList = vi.fn(async () => ({ candidates: [seen], complete: false }))
    ctx.skills.registerProvider(() => ({ name: 'partial', list: partialList, get: async () => undefined }))
    expect(await ctx.skills.inspect()).toMatchObject({ complete: false, candidates: [{ candidate: seen, selected: true }] })
    expect((await ctx.skills.inspect()).complete).toBe(false)
    expect(partialList).toHaveBeenCalledTimes(2)
    const unstable = await registry(); let calls = 0
    unstable.skills.registerProvider(control => ({ name: 'unstable', list: async () => {
      calls += 1; control.invalidate(); return [candidate('unstable', `attempt ${calls}`, 1)]
    }, get: async () => undefined }))
    const observed = await unstable.skills.inspect()
    expect(observed.complete).toBe(false)
    expect(observed.candidates[0]?.candidate.description).toBe('attempt 2')
    expect(calls).toBe(2)
    await unstable.skills.inspect(); expect(calls).toBe(4)
  })

  it('drops revoked candidates through the original fiber disposal and ignores stale invalidation controls', async () => {
    const ctx = await registry(), fallback = candidate('fallback', 'fallback', 50)
    ctx.skills.registerProvider(() => provider('fallback', [fallback]))
    let control: SkillProviderControl | undefined
    const fiber = ctx.plugin({ name: 'borrowed-provider', inject: ['skills'], apply(parent: Context) {
      parent.skills.registerProvider((given) => { control = given; return provider('preferred', [candidate('preferred', 'preferred', 1)]) })
    } })
    await fiber
    expect((await ctx.skills.inspect()).candidates.find(row => row.selected)?.candidate.provider).toBe('preferred')
    await fiber.dispose()
    expect(control?.signal.aborted).toBe(true)
    const after = await ctx.skills.inspect()
    expect(after.candidates.map(row => row.candidate)).toEqual([fallback])
    control?.invalidate()
    expect((await ctx.skills.inspect()).candidates.map(row => row.candidate)).toEqual([fallback])
  })

  it('retries provider removal during discovery and never retains the withdrawn candidate in a stable result', async () => {
    const ctx = await registry(), started = Promise.withResolvers<undefined>(), blocked = Promise.withResolvers<undefined>()
    const preferred = candidate('withdrawn', 'withdrawn', 1), fallback = candidate('fallback', 'fallback', 10)
    const remove = ctx.skills.registerProvider(() => ({ name: 'withdrawn', list: async () => { started.resolve(undefined); await blocked.promise; return [preferred] }, get: async () => undefined }))
    ctx.skills.registerProvider(() => provider('fallback', [fallback]))
    const pending = ctx.skills.inspect(); await started.promise
    remove(); blocked.resolve(undefined)
    const observed = await pending
    expect(observed.complete).toBe(true)
    expect(observed.candidates.map(row => row.candidate)).toEqual([fallback])
  })

  it('rejects aborted cache reads and stops waiting for an uncooperative discovery without caching it', async () => {
    const ctx = await registry(), value = candidate('slow', 'slow', 1), controller = new AbortController()
    const started = Promise.withResolvers<undefined>(), blocked = Promise.withResolvers<undefined>()
    ctx.skills.registerProvider(() => ({ name: 'slow', list: async () => { started.resolve(undefined); await blocked.promise; return [value] }, get: async () => undefined }))
    const pending = ctx.skills.inspect({ signal: controller.signal }); await started.promise
    controller.abort(new Error('cancel inspection'))
    await expect(pending).rejects.toThrow('cancel inspection')
    blocked.resolve(undefined)
    await ctx.skills.inspect()
    const cachedAbort = new AbortController(); cachedAbort.abort(new Error('cancel cached inspection'))
    await expect(ctx.skills.inspect({ signal: cachedAbort.signal })).rejects.toThrow('cancel cached inspection')
  })
})
