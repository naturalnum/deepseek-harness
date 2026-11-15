// @vitest-environment jsdom
/** Actual Native Root/Session/parent-hook/Node renderer; no alternate Markdown or file engine. */
import { cleanup, fireEvent, act, within } from '@testing-library/react'
import { afterEach, expect, it, onTestFinished, vi } from 'vitest'
import { SlotTestRuntime, contextMenuHook } from '@deepseek-ai/dsh-client-test-runtime'
import { LocaleRuntime } from '@deepseek-ai/dsh-client-locale/client'
import { SessionId } from '@deepseek-ai/dsh-session/types'
import type { SessionReference } from '@deepseek-ai/dsh-api-session-controller/client'
import { createSnapshotStore, type SnapshotStore } from '@deepseek-ai/dsh-client-store'
import type { InjectFace, PropsRuntime, PropsRenderSlots } from '@deepseek-ai/dsh-client-ui-slots'
import { MarkdownDelegateProvider } from '@deepseek-ai/dsh-client-ui-primitives'
import type { AssistantMessageNode, ChatNode, ChatNodeHookContext } from '@deepseek-ai/dsh-client-ui-chat/client'
import { CHAT_NODE_INJECT } from '../../../client/ui-chat/src/client/apply.ts'
import { registerChatNodeRenderers } from '../../../client/ui-chat/src/client/chat/register-node-renderers.ts'
import { presentationPolicyFor } from '../../../client/ui-chat/src/client/presentation-policy.ts'
import type { PerformanceUsageMode } from '../../../client/ui-chat/src/chat-settings.ts'
import { en, zh, NS } from '../../../client/ui-chat/src/client/locale.ts'
import { chatSnapshotFixture } from '../../../client/ui-chat/tests/chat-snapshot-fixture.client.ts'
import { useSearchableHidden } from '../../../client/ui-chat/src/client/chat/searchable-hidden.ts'
import { unusedImageLoader } from '../../../client/ui-chat/tests/reasoning-component-fixture.tsx'
import { installCloudFilePresentation } from '../src/client/file-presentation.ts'

afterEach(cleanup)
const SID = SessionId('same-file-policy-session')
const content = '- model.json\n\n`train.py`\n\n[download](sandbox:/workspace/result.csv)'
type Mode = 'closed' | 'open' | 'running' | 'interrupted'
interface Case { readonly node: ChatNode<'assistant-step'>; readonly context: ChatNodeHookContext }
function nodeCase(mode: Mode): Case {
  const blocks: AssistantMessageNode['blocks'] = [{ kind: 'text', text: content }]
  const final: AssistantMessageNode = { kind: 'assistant', seq: 2, time: 2000, turn: 1, step: 1, blocks,
    ...(mode === 'interrupted' ? { interrupted: true } : {}) }
  const snapshot = chatSnapshotFixture({
    ...(mode === 'running' ? { partial: { turn: 1, step: 1, blocks } } : { nodes: [final] }),
    turnEnds: mode === 'closed' || mode === 'interrupted' ? new Map([[1, 2]]) : new Map(),
  })
  const node = snapshot.nodes.values().find((value): value is ChatNode<'assistant-step'> => value.kind === 'assistant-step')
  if (node === undefined) throw new Error('Original Native assistant fixture absent')
  return { node, context: { turnData: snapshot.timeline.turns.get(1)?.data,
    disclosureReset: createSnapshotStore(0), useGroupAction: useSearchableHidden } }
}
interface RootFace {
  readonly hooks: { currentCase: SnapshotStore<Case> }
  readonly session: SessionReference
  readonly onOpenFile: (path: string, options?: { line?: number }) => void
}
const ignore = () => {}
function FileRoot({ useCurrentCase, session, onOpenFile, renderSlot, SessionProvider }:
  InjectFace<RootFace> & PropsRuntime<'root'> & PropsRenderSlots<'conversation.chat.node'>) {
  const current = useCurrentCase(value => value)
  return <SessionProvider session={session}><MarkdownDelegateProvider openFile={onOpenFile}>
    {renderSlot('conversation.chat.node', { node: current.node, openFile: onOpenFile,
      inspectCall: undefined, forkAt: ignore, loadImage: unusedImageLoader },
    { entryKey: 'assistant-step', hookContext: current.context })}
  </MarkdownDelegateProvider></SessionProvider>
}
async function fixture(install = true) {
  const runtime = await SlotTestRuntime.create()
  onTestFinished(() => runtime.dispose())
  const locale = new LocaleRuntime(runtime.ctx)
  runtime.ctx.provide('locale', locale); locale.register(NS, { en, zh }); locale.setLocale('en')
  runtime.slots.installLocale(locale)
  runtime.slots.provideRoot({ props: { useContextMenu: contextMenuHook() } })
  await runtime.sessions.add({ id: SID })
  const session = runtime.sessions.retainFor(runtime.ctx, SID), currentCase = createSnapshotStore(nodeCase('closed'))
  const open = vi.fn<RootFace['onOpenFile']>()
  runtime.slots.register({ name: 'root', children: {
    'conversation.chat.node': { kind: 'keyed', scope: 'session', inject: CHAT_NODE_INJECT },
  }, inject: (): RootFace => ({ hooks: { currentCase }, session, onOpenFile: open }) }, FileRoot)
  await runtime.mount({ inject: ['slots'], apply: (ctx) => {
    registerChatNodeRenderers(ctx, createSnapshotStore<PerformanceUsageMode>('detailed'), createSnapshotStore(presentationPolicyFor('detailed')))
  } })
  const mount = () => runtime.mount((ctx) => { installCloudFilePresentation(ctx) })
  const owner = install ? await mount() : undefined
  const view = runtime.renderRoot()
  const mode = (value: Mode) => { act(() => { currentCase.set(nodeCase(value)) }) }
  return { runtime, open, owner, mount, view, ui: within(view.container), mode }
}

it('uses actual Native closing/stream/interrupted guards and returns to Native defaults when the Root contribution withdraws', async () => {
  const f = await fixture(false)
  expect(f.ui.queryByRole('button', { name: 'model.json' })).toBeNull()
  const owner = await f.mount()
  fireEvent.click(f.ui.getByRole('button', { name: 'model.json' }))
  fireEvent.click(f.ui.getByRole('button', { name: 'train.py' }))
  fireEvent.click(f.ui.getByRole('button', { name: 'download' }))
  expect(f.open.mock.calls.map(([path]) => path)).toEqual(['model.json', 'train.py', '/workspace/result.csv'])
  for (const mode of ['open', 'running', 'interrupted'] as const) {
    f.mode(mode)
    expect(f.ui.queryByRole('button', { name: 'model.json' })).toBeNull()
    expect(f.ui.queryByRole('button', { name: 'train.py' })).toBeNull()
    expect(f.ui.queryByRole('button', { name: 'download' })).toBeNull()
    expect(f.open).toHaveBeenCalledTimes(3)
  }
  f.mode('closed')
  expect(f.ui.getByRole('button', { name: 'model.json' })).toBeDefined()
  await owner.dispose()
  expect(f.ui.queryByRole('button', { name: 'model.json' })).toBeNull()
  expect(f.ui.queryByRole('button', { name: 'train.py' })).toBeNull()
  expect(f.open).toHaveBeenCalledTimes(3)
})

it('keeps two actual Native Roots with the same Session id on their own file callback and contribution lifetime', async () => {
  const a = await fixture(), b = await fixture()
  fireEvent.click(a.ui.getByRole('button', { name: 'model.json' }))
  expect(a.open).toHaveBeenCalledExactlyOnceWith('model.json', undefined)
  expect(b.open).not.toHaveBeenCalled()
  if (a.owner === undefined) throw new Error('Cloud Root contribution absent')
  await a.owner.dispose()
  expect(a.ui.queryByRole('button', { name: 'model.json' })).toBeNull()
  fireEvent.click(b.ui.getByRole('button', { name: 'model.json' }))
  expect(b.open).toHaveBeenCalledExactlyOnceWith('model.json', undefined)
  expect(a.open).toHaveBeenCalledOnce()
})
