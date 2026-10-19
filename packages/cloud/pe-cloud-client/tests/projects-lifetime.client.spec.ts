// @vitest-environment jsdom
import { Context } from '@deepseek-ai/cordis'
import { SlotRegistry } from '@deepseek-ai/dsh-client-ui-renderer/client'
import { LocaleRuntime } from '@deepseek-ai/dsh-client-locale/client'
import { expect, it, onTestFinished, vi } from 'vitest'
import { installCloudProjects } from '../src/client/projects.ts'

async function fixture(mount: () => Promise<() => Promise<void>>) {
  const ctx = new Context()
  onTestFinished(() => ctx.fiber.dispose())
  await ctx.plugin(SlotRegistry).await()
  ctx.provide('locale', new LocaleRuntime(ctx))
  // This collaborator records the Remote mount lifetime; actual generated metadata is imported by the entry.
  ctx.provide('remote', { $mount: mount } as never)
  const fiber = ctx.plugin({ apply(owner: Context) { installCloudProjects(owner) } })
  await fiber.await()
  return { ctx, fiber }
}

it('withdraws the generated Remote contribution with the Cloud entry', async () => {
  const unmount = vi.fn(async () => {})
  const mount = vi.fn(async () => unmount)
  const { fiber } = await fixture(mount)
  await vi.waitFor(() => { expect(mount).toHaveBeenCalledOnce() })
  await fiber.dispose()
  expect(unmount).toHaveBeenCalledOnce()
})

it('joins a late Remote mount and withdraws it after the entry has been stopped', async () => {
  const ready = Promise.withResolvers<() => Promise<void>>()
  const unmount = vi.fn(async () => {})
  const mount = vi.fn(() => ready.promise)
  const { fiber } = await fixture(mount)
  await vi.waitFor(() => { expect(mount).toHaveBeenCalledOnce() })
  const disposed = fiber.dispose()
  ready.resolve(unmount)
  await disposed
  await vi.waitFor(() => { expect(unmount).toHaveBeenCalledOnce() })
})
