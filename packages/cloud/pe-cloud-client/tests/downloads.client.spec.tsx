// @vitest-environment jsdom
import { Context } from '@deepseek-ai/cordis'
import { SlotRegistry } from '@deepseek-ai/dsh-client-ui-renderer/client'
import { LocaleRuntime } from '@deepseek-ai/dsh-client-locale/client'
import type { PropsRenderSlots } from '@deepseek-ai/dsh-client-ui-slots'
import { expect, it } from 'vitest'
import { installCloudFileDownloads, type FileDownloadPage } from '../src/client/downloads.ts'
it('withdraws native download actions with their owning Loader fiber', async () => {
  const ctx = new Context()
  await ctx.plugin(SlotRegistry).await()
  ctx.provide('locale', new LocaleRuntime(ctx, undefined, { preference: 'en', languages: ['en-US'] }))
  const page: FileDownloadPage = { maxDownloadBytes: 2 ** 40,
    bootstrap: { capabilities: { filePreview: { state: 'available' } } },
    lifetime: { transport: { signal: new AbortController().signal, hooks: { fetch: async () => new Response(null) },
      navigationUrl: path => path } } }
  const declaration = ctx.slots.register({ name: 'root', children: {
    'sidebar.right.tab.document.actions': { kind: 'list', scope: 'session' },
    'sidebar.right.tab.document.unpreviewable': { kind: 'list', scope: 'session' },
  } }, ({ renderSlot }: PropsRenderSlots<'sidebar.right.tab.document.actions' | 'sidebar.right.tab.document.unpreviewable'>) =>
    <>{renderSlot('sidebar.right.tab.document.actions', { absolutePath: '/x' })}</>)
  const fiber = ctx.plugin({ apply(owner: Context) { installCloudFileDownloads(owner, page) } })
  try {
    await fiber.await()
    expect(ctx.slots.entries('sidebar.right.tab.document.actions')).toHaveLength(1)
    await fiber.dispose()
    expect(ctx.slots.entries('sidebar.right.tab.document.actions')).toHaveLength(0)
  } finally { declaration(); await ctx.fiber.dispose() }
})
