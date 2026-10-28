// @vitest-environment jsdom
/** Real generated Remote and registered project form; only the Connection carrier is replaced. */
import { Context, FiberState } from '@deepseek-ai/cordis'
import * as NativeClientGateway from '@deepseek-ai/dsh-api-gateway/client'
import type { ConnectionHandle } from '@deepseek-ai/dsh-client-connection/client'
import { LocaleRuntime } from '@deepseek-ai/dsh-client-locale/client'
import { SlotRegistry } from '@deepseek-ai/dsh-client-ui-renderer/client'
import type { PropsRenderSlots } from '@deepseek-ai/dsh-client-ui-slots'
import type { DirectoryFlowOwnerProps } from '@deepseek-ai/dsh-client-ui-workspace/client'
import TypertRegistry from '@deepseek-ai/dsh-typert-registry'
import { cleanup, fireEvent, render, screen, waitFor } from '@testing-library/react'
import { afterEach, expect, it, onTestFinished, vi } from 'vitest'
import { CloudProjectFlow, type CloudProjectFlowInjected } from '../src/client/project-flow.tsx'
import { installCloudProjects } from '../src/client/projects.ts'

const holes = ['conversation.hero.workspace.directoryFlow', 'sidebar.workspaces.directoryFlow'] as const
function ProjectHost({ renderSlot }: PropsRenderSlots<typeof holes[number]>) {
  const owner: DirectoryFlowOwnerProps = { open: false, busy: false, onPicked: () => {}, onCancel: () => {}, onError: () => {} }
  return <>{renderSlot(holes[0], owner)}{renderSlot(holes[1], owner)}</>
}
afterEach(cleanup)

it.each(holes)('creates through the generated Remote from %s and withdraws its old action', async (hole) => {
  const ctx = new Context()
  onTestFinished(() => ctx.fiber.dispose())
  const activationFailures: unknown[] = []
  ctx.on('internal/status', (fiber) => {
    if (fiber.state === FiberState.FAILED) {
      void fiber.await().catch((error: unknown) => { activationFailures.push(error) })
    }
  })
  await ctx.plugin(TypertRegistry)
  await ctx.plugin(SlotRegistry)
  ctx.provide('locale', new LocaleRuntime(ctx, undefined, { preference: 'en', languages: ['en-US'] }))
  const call = vi.fn<ConnectionHandle['rpc']['call']>().mockResolvedValue({ ok: true, value: {
    workspace: { workspaceId: 'allocated-project', path: '/native/allocated-project', title: 'Project title', sessionIds: [],
      createdAt: '2026-10-19T00:00:00.000Z', updatedAt: '2026-10-19T00:00:00.000Z' },
  } })
  const connection: ConnectionHandle = {
    interactions: 'none', isLoopback: true,
    generation: { getSnapshot: () => undefined, subscribe: () => () => {} },
    state: { getSnapshot: () => undefined, subscribe: () => () => {} },
    reconnect: () => {}, start: () => ({ stop: () => {} }),
    openWebSocket: () => { throw new Error('Project creation must not open a socket') },
    registerGenerationSource: () => () => {},
    rpc: { call, open: async function* () { throw new Error('Project creation must not open a stream') } },
  }
  ctx.provide('connection', connection)
  await ctx.plugin(NativeClientGateway)
  ctx.slots.register({ name: 'root', children: {
    'conversation.hero.workspace.directoryFlow': { kind: 'single', scope: 'root' },
    'sidebar.workspaces.directoryFlow': { kind: 'single', scope: 'root' },
  } }, ProjectHost)
  const fiber = ctx.plugin({ apply(owner: Context) { installCloudProjects(owner) } })
  await fiber.await()
  await vi.waitFor(() => {
    for (const error of activationFailures) throw error
    expect(holes.map(name => ctx.slots.entries(name).length)).toEqual([1, 1])
  })
  const entry = ctx.slots.entries(hole)[0]
  const face = entry?.inject?.()
  const createProject = face?.['createProject'], t = face?.['t']
  if (entry === undefined || typeof createProject !== 'function' || typeof t !== 'function') {
    throw new Error('The registered project form requires its actual injected action and locale')
  }
  const injected: CloudProjectFlowInjected = {
    createProject: createProject as CloudProjectFlowInjected['createProject'], t: t as CloudProjectFlowInjected['t'],
  }
  const Component = entry.component as typeof CloudProjectFlow
  const props: DirectoryFlowOwnerProps = { open: true, busy: false, onPicked: vi.fn(), onCancel: vi.fn(), onError: vi.fn() }
  const view = render(<Component {...props} {...injected} />)
  fireEvent.change(screen.getByRole('textbox', { name: 'Project name' }), { target: { value: '  Project title  ' } })
  fireEvent.click(screen.getByRole('button', { name: 'Create' }))
  await waitFor(() => { expect(props.onPicked).toHaveBeenCalledExactlyOnceWith('/native/allocated-project') })
  expect(call).toHaveBeenCalledExactlyOnceWith('/api', 'cloudProjects/create',
    { args: { request: { title: 'Project title' } } }, expect.any(AbortSignal))
  expect(props.onError).not.toHaveBeenCalled()
  view.unmount()
  await fiber.dispose()
  expect(holes.map(name => ctx.slots.entries(name).length)).toEqual([0, 0])
  expect(ctx.get('remote.cloudProjects')).toBeUndefined()
  await expect(injected.createProject('After disposal', new AbortController().signal)).rejects.toThrow()
  expect(call).toHaveBeenCalledOnce()
})
