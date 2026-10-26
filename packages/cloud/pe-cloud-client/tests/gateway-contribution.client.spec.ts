/** Current generated Cloud contribution on the native Client Remote; the inert Connection admits no business requests. */
import { Context } from '@deepseek-ai/cordis'
import { apply, inject } from '@deepseek-ai/dsh-api-gateway/client'
import type { ConnectionHandle } from '@deepseek-ai/dsh-client-connection/client'
import contribution from '@deepseek-ai/dsh-pe-cloud-api/remote'
import TypertRegistry from '@deepseek-ai/dsh-typert-registry'
import { expect, it, onTestFinished, vi } from 'vitest'

async function fixture() {
  const ctx = new Context()
  onTestFinished(async () => { await ctx.fiber.dispose() })
  await ctx.plugin(TypertRegistry)
  const call = vi.fn<ConnectionHandle['rpc']['call']>(async () => { throw new Error('Unexpected business RPC') })
  const open = vi.fn<NonNullable<ConnectionHandle['rpc']['open']>>(() => { throw new Error('Unexpected business stream') })
  ctx.provide('connection', {
    interactions: 'answer', isLoopback: true,
    openWebSocket: () => { throw new Error('Unexpected physical socket') },
    generation: { getSnapshot: () => undefined, subscribe: () => () => {} },
    state: { getSnapshot: () => undefined, subscribe: () => () => {} },
    reconnect: () => {}, rpc: { call, open }, registerGenerationSource: () => () => {}, start: () => ({ stop: () => {} }),
  } satisfies ConnectionHandle)
  await ctx.plugin({ inject, apply })
  return { ctx, call, open }
}

it('mounts every actual Cloud descriptor atomically before its native skill dependency activates', async () => {
  const { ctx, call, open } = await fixture()
  const skillMethods = contribution.descriptors.filter(row => row.namespace === 'cloudSkills').map(row => row.method)
  expect(skillMethods).toHaveLength(8)
  expect(skillMethods).toContain('install')
  const observed: string[][] = []
  const dependency = ctx.inject(['remote', 'remote.cloudSkills'], (owner) => {
    const namespace = owner.remote.cloudSkills
    observed.push(skillMethods.filter(method => typeof Reflect.get(namespace, method) === 'function'))
  })
  expect(dependency.state).toBe(0)
  const unmount = await ctx.remote.$mount(contribution)
  expect(observed).toEqual([skillMethods])
  for (const descriptor of contribution.descriptors) {
    const namespace: unknown = ctx.get(`remote.${descriptor.namespace}`)
    expect(namespace).toBeDefined()
    if (namespace === null || typeof namespace !== 'object') throw new Error('Actual generated namespace is missing')
    expect(Reflect.get(namespace, descriptor.method)).toBeTypeOf('function')
  }
  expect(ctx.typert.remotes.list()).toHaveLength(contribution.descriptors.length)
  await unmount()
  expect(ctx.typert.remotes.list()).toEqual([])
  expect(ctx.get('remote.cloudSkills')).toBeUndefined()
  expect(dependency.state).toBe(0)
  expect(call).not.toHaveBeenCalled()
  expect(open).not.toHaveBeenCalled()
})

it('withdraws actual generated callbacks across complete unmount and remount without dispatching business work', async () => {
  const { ctx, call, open } = await fixture(), unmount = await ctx.remote.$mount(contribution)
  const retained = ctx.remote.cloudSkills.installed, retainedInstall = ctx.remote.cloudSkills.install
  await unmount()
  for (const name of ['cloudModelKey', 'cloudProjects', 'cloudSkills']) expect(ctx.get(`remote.${name}`)).toBeUndefined()
  await expect(retained({})).resolves.toMatchObject({ ok: false, error: {
    code: 'gateway/internal', message: 'client api: Remote method cloudSkills/installed is no longer mounted',
  } })
  await expect(Reflect.apply(retainedInstall, undefined, [])).resolves.toMatchObject({ ok: false, error: {
    code: 'gateway/internal', message: 'client api: Remote method cloudSkills/install is no longer mounted',
  } })
  const second = await ctx.remote.$mount(contribution)
  expect(ctx.remote.cloudSkills.install).toBeTypeOf('function')
  await expect(retained({})).resolves.toMatchObject({ ok: false })
  await second()
  expect(ctx.typert.remotes.list()).toEqual([])
  expect(call).not.toHaveBeenCalled()
  expect(open).not.toHaveBeenCalled()
})

it.each(['ctx', 'empty', 'name', 'has', 'remove', 'installDirect', 'installScoped', 'assertMethodAvailable'])(
  'still refuses native namespace member %s before registration', async (method) => {
    const { ctx, call } = await fixture(), original = contribution.descriptors.find(row => row.namespace === 'cloudSkills')
    if (original === undefined) throw new Error('Actual Cloud descriptor is missing')
    await expect(ctx.remote.$mount({ package: contribution.package, descriptors: [{ ...original, method }] }))
      .rejects.toThrow('conflicts with its namespace service')
    expect(ctx.typert.remotes.list()).toEqual([])
    expect(ctx.get('remote.cloudSkills')).toBeUndefined()
    expect(call).not.toHaveBeenCalled()
  },
)

it('preserves strict input and duplicate refusals around the actual mounted contribution', async () => {
  const { ctx, call } = await fixture(), original = contribution.descriptors.find(row => row.namespace === 'cloudSkills')
  if (original === undefined) throw new Error('Actual Cloud descriptor is missing')
  await expect(ctx.remote.$mount({ package: contribution.package, descriptors: [{ ...original,
    parameters: original.parameters.map(row => ({ ...row, codec: { mode: 'src-json' as const } })),
  }] })).rejects.toThrow('has no strict codec')
  await expect(ctx.remote.$mount({ package: contribution.package, descriptors: [original, original] }))
    .rejects.toThrow('contribution repeats direct method')
  expect(ctx.typert.remotes.list()).toEqual([])
  const unmount = await ctx.remote.$mount(contribution)
  await expect(ctx.remote.$mount(contribution)).rejects.toThrow('is already mounted')
  expect(ctx.remote.cloudSkills.install).toBeTypeOf('function')
  expect(ctx.typert.remotes.list()).toHaveLength(contribution.descriptors.length)
  await unmount()
  expect(ctx.typert.remotes.list()).toEqual([])
  expect(call).not.toHaveBeenCalled()
})
