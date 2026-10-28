// @vitest-environment jsdom
/** Native shared form/schema/model integration; the current callback is an explicit immutable-page fixture. */
import { SlotRegistry } from '@deepseek-ai/dsh-client-ui-renderer/client'
import { LocaleRuntime } from '@deepseek-ai/dsh-client-locale/client'
import type { PropsRenderSlots } from '@deepseek-ai/dsh-client-ui-slots'
import { Context } from '@deepseek-ai/cordis'
import z from '@deepseek-ai/schemastery'
import { createElement } from 'react'
import { cleanup, fireEvent, render, screen } from '@testing-library/react'
import { allowAllAccess } from '@deepseek-ai/dsh-client-test-runtime/src/access.ts'
import { makeTranslate } from '@deepseek-ai/dsh-client-test-runtime/src/translate.ts'
import { ApprovedSettingsForm } from '../src/client/ApprovedSettings.tsx'
import { approvedSettingsDictionaries } from '../src/client/approved-settings-locales.ts'
import { afterEach, expect, it, onTestFinished, vi } from 'vitest'
import { TestRemote } from '@deepseek-ai/dsh-client-test-runtime'
import type { SettingsPathOpView } from '@deepseek-ai/dsh-api-remotes/client'
import type { JsonValue } from '@deepseek-ai/dsh-util-values'
import { ConfigForms } from '../../../client/ui-settings/src/client/config-form.ts'
import { SettingsDescribeMirror } from '../../../client/ui-settings/src/client/settings-mirror.ts'
import { SettingsSchemaService } from '../../../client/ui-settings/src/client/schema.ts'
import { createApprovedSettingsForm, installApprovedSettingsFields } from '../src/client/approved-settings.ts'

afterEach(cleanup)
const schema = z.object({ mode: z.union(['one', 'two']).default('one'), count: z.number().min(1).step(1).default(2),
  flag: z.boolean().default(false), complex: z.array(z.string()), hidden: z.string().role('secret'), unapproved: z.string() })
function wire(value: unknown): JsonValue { return JSON.parse(JSON.stringify(value)) as JsonValue }
async function fixture() {
  const ctx = new Context(); onTestFinished(() => ctx.fiber.dispose())
  let revision = 3, current = true
  let currentSchema = wire(schema.toJSON())
  const value = { mode: 'one', count: 2, flag: false, complex: [], unapproved: 'closed' }
  const namespace = () => ({ ns: 'data', schema: currentSchema, value: wire(value), user: wire(value),
    autoGenerate: true, revision, applies: 'live' as const, secrets: [{ path: ['hidden'], set: false }] })
  const describe = vi.fn(async () => ({ ok: true as const, value: { writable: true, hasDocument: false, namespaces: [namespace()] } }))
  const mutate = vi.fn(async (_namespace: string, _ops: readonly SettingsPathOpView[], _revision?: number) =>
    ({ ok: true as const, value: { ...namespace(), revision: ++revision } }))
  new TestRemote(ctx, { settings: { describe, mutate } })
  const mirror = new SettingsDescribeMirror(ctx), service = new SettingsSchemaService(ctx)
  const forms = new ConfigForms(ctx, { mirror, schema: service })
  await mirror.ensure()
  const fields = ['mode', 'count', 'flag', 'complex', 'hidden', 'missing']
    .map(path => ({ namespace: 'data', path, application: 'live' as const }))
  const record = createApprovedSettingsForm(forms, service, fields, 'data', () => {
    if (!current) throw new Error('Page revoked')
  })
  onTestFinished(() => { record.dispose() })
  return { ctx, mirror, forms, describe, mutate, record, namespace,
    close: () => { current = false }, advance: () => { revision++ },
    changeSchema: (value: JsonValue) => { currentSchema = value; mirror.acceptView(namespace()) } }
}

it('projects only approved supported leaves and exposes unknown/complex/secret fields as unsupported', async () => {
  const { record } = await fixture(), state = record.face.hooks.approvedSettings.getSnapshot()
  expect(state.fields.map(field => field.field)).toEqual(['mode', 'count', 'flag'])
  expect(state.unsupported).toEqual(['complex', 'hidden', 'missing'])
  expect(state.fields[0]?.choices).toEqual(['one', 'two'])
})
it('uses native schema constraints and stages until save with the original edit revision', async () => {
  const { record, mutate, mirror, namespace, advance } = await fixture()
  record.face.edit('count', '0'); record.face.save(); await Promise.resolve()
  expect(mutate).not.toHaveBeenCalled()
  record.face.edit('count', '4'); advance(); mirror.acceptView(namespace())
  record.face.save(); await vi.waitFor(() => { expect(mutate).toHaveBeenCalledOnce() })
  expect(mutate.mock.calls[0]?.[0]).toBe('data')
  expect(mutate.mock.calls[0]?.[2]).toBe(3)
})
it('rechecks the original page after waiting behind another write in the original queue', async () => {
  const f = await fixture(), gate = Promise.withResolvers<undefined>()
  f.mutate.mockImplementationOnce(async () => { await gate.promise; return { ok: true, value: f.namespace() } })
  const first = f.forms.get('data').mutate([{ op: 'set', path: ['count'], value: 3 }])
  await vi.waitFor(() => { expect(f.mutate).toHaveBeenCalledOnce() })
  f.record.face.edit('count', '5'); f.record.face.save(); f.close(); gate.resolve(undefined)
  await first; await vi.waitFor(() => { expect(f.record.face.hooks.approvedSettings.getSnapshot().saving).toBe(false) })
  expect(f.mutate).toHaveBeenCalledOnce()
})
it('refuses queued work after the Host projection loses an approved field', async () => {
  const f = await fixture(), gate = Promise.withResolvers<undefined>()
  f.mutate.mockImplementationOnce(async () => { await gate.promise; return { ok: true, value: f.namespace() } })
  const first = f.forms.get('data').mutate([{ op: 'set', path: ['count'], value: 3 }])
  await vi.waitFor(() => { expect(f.mutate).toHaveBeenCalledOnce() })
  f.record.face.edit('count', '5'); f.record.face.save()
  f.changeSchema(wire(z.object({ mode: z.string() }).toJSON()))
  gate.resolve(undefined); await first
  await vi.waitFor(() => { expect(f.record.face.hooks.approvedSettings.getSnapshot().saving).toBe(false) })
  expect(f.mutate).toHaveBeenCalledOnce()
})
it('retirement rejects captured callbacks without starting another write or replay', async () => {
  const f = await fixture(); f.record.face.edit('mode', 'two'); f.record.dispose(); f.record.face.save()
  await vi.waitFor(() => { expect(f.record.face.hooks.approvedSettings.getSnapshot().saving).toBe(false) })
  expect(f.mutate).not.toHaveBeenCalled()
})

function SettingsHost({ renderSlot }: PropsRenderSlots<'settings.section'>) {
  return renderSlot('settings.section', { close: () => {} })
}
it('registers one native Settings section and withdraws forms, waiters and copy on original page abort', async () => {
  const f = await fixture(), control = new AbortController()
  await f.ctx.plugin(SlotRegistry).await()
  const locale = new LocaleRuntime(f.ctx); locale.setLocale('en'); f.ctx.provide('locale', locale)
  const collapse = f.ctx.slots.register({ name: 'root', children: { 'settings.section': { kind: 'list', scope: 'root' } } }, SettingsHost)
  onTestFinished(collapse)
  const owner = f.ctx.plugin({ inject: ['slots', 'locale', 'configForms', 'settingsSchema'], apply(ctx: Context) {
    installApprovedSettingsFields(ctx, [{ namespace: 'data', path: 'mode', application: 'live' }], control.signal,
      (scope) => { scope.fiber.assertActive() })
  } })
  await owner.await(); await vi.waitFor(() => { expect(f.ctx.slots.entries('settings.section')).toHaveLength(1) })
  expect(f.ctx.slots.entries('settings.approved.namespace')).toHaveLength(1)
  expect(locale.bind('cloud-approved-settings')('title')).toBe('Approved configuration')
  control.abort()
  expect(f.ctx.slots.entries('settings.section')).toHaveLength(0)
  expect(f.ctx.slots.entries('settings.approved.namespace')).toHaveLength(0)
  expect(locale.bind('cloud-approved-settings')('title')).toBe('title')
  collapse()
  f.ctx.slots.register({ name: 'root', children: { 'settings.section': { kind: 'list', scope: 'root' } } }, SettingsHost)
  expect(f.ctx.slots.entries('settings.section')).toHaveLength(0)
})

it('keeps post-dispatch cancellation unconfirmed without replaying or replacing its original revision', async () => {
  const f = await fixture(), gate = Promise.withResolvers<undefined>()
  f.mutate.mockImplementationOnce(async () => { await gate.promise; return { ok: true, value: f.namespace() } })
  f.record.face.edit('count', '5'); f.record.face.save()
  await vi.waitFor(() => { expect(f.mutate).toHaveBeenCalledOnce() })
  f.close(); gate.resolve(undefined)
  await vi.waitFor(() => { expect(f.record.face.hooks.approvedSettings.getSnapshot()).toMatchObject({ saving: false, failed: true }) })
  expect(f.mutate).toHaveBeenCalledOnce()
  expect(f.mutate.mock.calls[0]?.[2]).toBe(3)
})

it('renders approved scalar controls once, reports unsupported fields and writes only on explicit save', async () => {
  const f = await fixture(), unused = (): never => { throw new Error('No unrelated native UI data is read') }
  const props: Parameters<typeof ApprovedSettingsForm>[0] = {
    ...allowAllAccess, useSessions: unused, useSessionStatus: unused, useSessionRetainInfo: unused,
    usePanelInfo: unused, useWorkspaces: unused, useResource: unused,
    t: makeTranslate(approvedSettingsDictionaries.en), edit: f.record.face.edit, resetField: f.record.face.resetField,
    save: f.record.face.save, discard: f.record.face.discard,
    useApprovedSettings: selector => selector(f.record.face.hooks.approvedSettings.getSnapshot()),
  }
  const view = render(createElement(ApprovedSettingsForm, props))
  expect(screen.queryByLabelText('hidden')).toBeNull()
  expect(screen.queryByLabelText('unapproved')).toBeNull()
  expect(screen.getByText('This field cannot be edited with this form: complex')).toBeTruthy()
  expect(screen.getByRole('button', { name: 'Save' }).hasAttribute('disabled')).toBe(true)
  fireEvent.change(screen.getByLabelText('count'), { target: { value: '7' } })
  expect(f.mutate).not.toHaveBeenCalled()
  view.rerender(createElement(ApprovedSettingsForm, props))
  fireEvent.click(screen.getByRole('button', { name: 'Save' }))
  await vi.waitFor(() => { expect(f.mutate).toHaveBeenCalledOnce() })
  expect(f.mutate.mock.calls[0]).toEqual(['data', [{ op: 'set', path: ['count'], value: 7 }], 3])
  view.unmount()
})

it('isolates two original page providers with the same namespace and never retargets a revoked edit', async () => {
  const a = await fixture(), b = await fixture()
  a.record.face.edit('count', '6'); a.close(); a.record.face.save()
  b.record.face.edit('count', '8'); b.record.face.save()
  await vi.waitFor(() => { expect(b.mutate).toHaveBeenCalledOnce() })
  expect(a.mutate).not.toHaveBeenCalled()
  expect(b.mutate.mock.calls[0]).toEqual(['data', [{ op: 'set', path: ['count'], value: 8 }], 3])
})
it('keeps non-live approval out of the form and never submits it', async () => {
  const f = await fixture()
  const record = createApprovedSettingsForm(f.forms, f.ctx.settingsSchema,
    [{ namespace: 'data', path: 'count', application: 'graph-rebuild' }], 'data', () => {})
  expect(record.face.hooks.approvedSettings.getSnapshot().fields).toEqual([])
  record.face.save(); await Promise.resolve()
  expect(f.mutate).not.toHaveBeenCalled(); record.dispose()
})

it('renders held values read-only after a describe failure and keeps the original draft revision after recovery', async () => {
  const f = await fixture()
  f.record.face.edit('count', '6')
  f.describe.mockRejectedValueOnce(new Error('Synthetic describe failure'))
  await f.mirror.load()
  expect(f.record.face.hooks.approvedSettings.getSnapshot()).toMatchObject({ writable: false, dirty: true })
  f.record.face.save(); await Promise.resolve(); expect(f.mutate).not.toHaveBeenCalled()
  f.advance(); await f.mirror.load()
  expect(f.record.face.hooks.approvedSettings.getSnapshot()).toMatchObject({ writable: true, dirty: true })
  f.record.face.save(); await vi.waitFor(() => { expect(f.mutate).toHaveBeenCalledOnce() })
  expect(f.mutate.mock.calls[0]?.[2]).toBe(3)
})

function GeneralSettingsHost({ renderSlot }: PropsRenderSlots<'settings.general.item'>) {
  return renderSlot('settings.general.item', {})
}
it('keeps remaining approved fields inside General and withdraws them on original page retirement', async () => {
  const f = await fixture(), control = new AbortController()
  await f.ctx.plugin(SlotRegistry).await()
  const locale = new LocaleRuntime(f.ctx); locale.setLocale('en'); f.ctx.provide('locale', locale)
  f.ctx.slots.register({ name: 'root', children: { 'settings.general.item': { kind: 'list', scope: 'root' } } }, GeneralSettingsHost)
  const owner = f.ctx.plugin({ inject: ['slots', 'locale', 'configForms', 'settingsSchema'], apply(ctx: Context) {
    installApprovedSettingsFields(ctx, [{ namespace: 'data', path: 'count', application: 'live' },
      { namespace: 'locale', path: 'preference', application: 'live' }], control.signal,
    (scope) => { scope.fiber.assertActive() }, true)
  } })
  await owner.await()
  await vi.waitFor(() => { expect(f.ctx.slots.entries('settings.general.item')).toHaveLength(1) })
  expect(f.ctx.slots.entries('settings.section')).toHaveLength(0)
  expect(f.ctx.slots.entries('settings.approved.namespace')).toHaveLength(1)
  const entry = f.ctx.slots.entries('settings.general.item')[0]!
  expect(entry.options.id).toBe('cloud-approved-configuration')
  control.abort()
  expect(f.ctx.slots.entries('settings.general.item')).toHaveLength(0)
  expect(f.ctx.slots.entries('settings.approved.namespace')).toHaveLength(0)
})
