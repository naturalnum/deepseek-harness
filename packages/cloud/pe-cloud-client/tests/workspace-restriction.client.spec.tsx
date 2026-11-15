// @vitest-environment jsdom
/** Original Native Modal over root-owned display data; only account I/O is scripted. */
import type { ComponentProps } from 'react'
import { Context } from '@deepseek-ai/cordis'
import { SlotRegistry } from '@deepseek-ai/dsh-client-ui-renderer/client'
import { LocaleRuntime } from '@deepseek-ai/dsh-client-locale/client'
import { createSnapshotStore } from '@deepseek-ai/dsh-client-store'
import type { GlobalStandardProps, PropsLocale, StandardSourceBinding } from '@deepseek-ai/dsh-client-ui-slots'
import type { WorkspaceId, WorkspaceView } from '@deepseek-ai/dsh-api-workspace-controller/client'
import { act, cleanup, fireEvent, render, screen } from '@testing-library/react'
import { afterEach, expect, it, onTestFinished, vi } from 'vitest'
import { createSlotRenderer } from '../../../client/ui-renderer/src/client/scoped-slots.tsx'
import { WorkspaceDialogs } from '../../../client/ui-workspace/src/client/rows/WorkspaceDialogs.tsx'
import { en, zh, ja, es, fr, de, ru, pt } from '../../../client/ui-workspace/src/client/locales.ts'
import { en as commonEn } from '../../../client/locale/src/locales/en.ts'
import { zh as commonZh } from '../../../client/locale/src/locales/zh.ts'
import { createWorkspaceDeleteRestriction, workspaceDeletionCopy } from '../src/client/workspace-restriction.ts'

afterEach(cleanup)
const WORKSPACE = 'restriction-workspace' as WorkspaceId
const workspaces: readonly WorkspaceView[] = [{ workspaceId: WORKSPACE, path: '/account/project', title: 'Project', sessionIds: [],
  createdAt: '2026-11-15T00:00:00.000Z', updatedAt: '2026-11-15T00:00:00.000Z' }]
type DialogActions = Pick<ComponentProps<typeof WorkspaceDialogs>, 'renameWorkspace' | 'deleteWorkspace' | 'settleWorkspaceAction'>
function DialogHost({ t, workspaceDeleteDisabledReason, ...actions }:
  DialogActions & Pick<GlobalStandardProps, 'workspaceDeleteDisabledReason'> & PropsLocale<'workspace'>) {
  return <WorkspaceDialogs {...actions} workspaceDeleteDisabledReason={workspaceDeleteDisabledReason} t={t} workspaces={workspaces}
    request={{ action: 'delete', workspaceId: WORKSPACE, displayTitle: 'Project', storedTitle: 'Project' }} />
}
async function fixture(restricted: boolean) {
  const ctx = new Context(), slots = new SlotRegistry(ctx), reason = createWorkspaceDeleteRestriction(ctx)
  expect(reason.message()).toBe(workspaceDeletionCopy.en)
  const locale = new LocaleRuntime(ctx)
  ctx.provide('locale', locale); slots.installLocale(locale); slots.install(createSlotRenderer())
  for (const id of ['ja', 'es', 'fr', 'de', 'ru', 'pt']) ctx.effect(() => locale.addLanguage({ id, label: id, fallback: 'en' }))
  ctx.effect(() => locale.register('common', { en: commonEn, zh: commonZh }))
  ctx.effect(() => locale.register('workspace', { en, zh, ja, es, fr, de, ru, pt })); locale.setLocale('zh')
  const absent = createSnapshotStore<StandardSourceBinding>({ key: undefined, hooks: {}, keyedHooks: {}, props: {} })
  slots.installScope('session', { current: absent, bindingSource: () => absent, renderArea: (_binding, { children }) => <>{children}</> })
  if (restricted) slots.provideRoot({ props: { workspaceDeleteDisabledReason: reason } })
  const deleteWorkspace = vi.fn<DialogActions['deleteWorkspace']>(async () => {})
  const renameWorkspace = vi.fn<DialogActions['renameWorkspace']>(async () => {})
  const settleWorkspaceAction = vi.fn<DialogActions['settleWorkspaceAction']>()
  const remove = slots.register({ name: 'root', locale: 'workspace',
    inject: () => ({ deleteWorkspace, renameWorkspace, settleWorkspaceAction }) }, DialogHost)
  const view = render(slots.renderSlot('root', {}))
  onTestFinished(async () => { cleanup(); remove(); await ctx.fiber.dispose() })
  return { locale, reason, deleteWorkspace, view }
}

it('keeps the original Native confirmation blocked with all eight original deployment messages on locale changes', async () => {
  const f = await fixture(true), dictionaries = { en, zh, ja, es, fr, de, ru, pt }
  for (const [id, copy] of Object.entries(workspaceDeletionCopy)) {
    act(() => { f.locale.setLocale(id) })
    expect(screen.getByRole('status').textContent).toBe(copy)
    expect(f.reason.message()).toBe(copy)
    const label = dictionaries[id as keyof typeof dictionaries]['delete.workspace']
    const confirm = screen.getByRole('button', { name: label })
    expect(confirm).toHaveProperty('disabled', true)
    fireEvent.click(confirm)
  }
  expect(f.deleteWorkspace).not.toHaveBeenCalled()
})

it('retains original Native deletion when no restriction is provided', async () => {
  const f = await fixture(false), confirm = screen.getByRole('button', { name: zh['delete.workspace'] })
  expect(confirm).toHaveProperty('disabled', false)
  expect(screen.queryByRole('status')).toBeNull()
  await act(async () => { fireEvent.click(confirm) })
  expect(f.deleteWorkspace).toHaveBeenCalledExactlyOnceWith(WORKSPACE)
})
