// @vitest-environment jsdom
import { Context } from '@deepseek-ai/cordis'
import { SlotRegistry } from '@deepseek-ai/dsh-client-ui-renderer/client'
import { LocaleRuntime } from '@deepseek-ai/dsh-client-locale/client'
import { expect, it } from 'vitest'
import { registerCloudProjectSlots } from '../src/client/project-slots.ts'
import type { PropsRenderSlots } from '@deepseek-ai/dsh-client-ui-slots'
import type { DirectoryFlowOwnerProps } from '@deepseek-ai/dsh-client-ui-workspace/client'

const holes = ['conversation.hero.workspace.directoryFlow', 'sidebar.workspaces.directoryFlow'] as const
function ProjectHost({ renderSlot }: PropsRenderSlots<typeof holes[number]>) {
  const owner: DirectoryFlowOwnerProps = { open: false, busy: false, onPicked: () => {}, onCancel: () => {}, onError: () => {} }
  return <>{renderSlot(holes[0], owner)}{renderSlot(holes[1], owner)}</>
}
it('waits for both original slot declarations, registers once, follows redeclaration and withdraws with its fiber', async () => {
  const ctx = new Context()
  await ctx.plugin(SlotRegistry).await()
  ctx.provide('locale', new LocaleRuntime(ctx))
  const slots = ctx.slots
  const fiber = ctx.plugin({ inject: ['slots', 'locale'], apply(owner: Context) {
    registerCloudProjectSlots(owner, async () => '/native/project')
  } })
  try {
    await fiber.await()
    expect(holes.map(hole => slots.entries(hole).length)).toEqual([0, 0])
    const declare = () => slots.register({ name: 'root', children: {
      'conversation.hero.workspace.directoryFlow': { kind: 'single', scope: 'root' },
      'sidebar.workspaces.directoryFlow': { kind: 'single', scope: 'root' },
    } }, ProjectHost)
    const remove = declare()
    expect(holes.map(hole => slots.entries(hole).length)).toEqual([1, 1])
    remove()
    expect(holes.map(hole => slots.entries(hole).length)).toEqual([0, 0])
    declare()
    expect(holes.map(hole => slots.entries(hole).length)).toEqual([1, 1])
    await fiber.dispose()
    expect(holes.map(hole => slots.entries(hole).length)).toEqual([0, 0])
  } finally { await ctx.fiber.dispose() }
})
