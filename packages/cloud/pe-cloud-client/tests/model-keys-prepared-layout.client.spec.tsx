// @vitest-environment jsdom
import { createModelKeyTestRenderer } from './model-keys-ui-fixture.client.tsx'
import { modelKeyActionDictionaries } from '../src/client/locales/model-credentials.ts'
import { CREDENTIAL_COPY, credentialPresentation } from './model-keys-presentation.client.ts'
/** Real retained namespace and readonly projection through the original Models/ProviderEditor; no persistence is simulated. */
import Schema from '@deepseek-ai/schemastery'
import { Context } from '@deepseek-ai/cordis'
import { bindSnapshotSelector } from '@deepseek-ai/dsh-client-test-runtime'
import type { SettingsNamespaceView } from '@deepseek-ai/dsh-api-remotes/client'
import type { JsonValue } from '@deepseek-ai/dsh-util-values'
import { cleanup, fireEvent, render, screen, waitFor, act, within } from '@testing-library/react'
import { afterEach, expect, it, onTestFinished, vi } from 'vitest'
import { ModelsSettingsStore } from '../../../client/ui-settings-models/src/client/store.ts'
import { ProviderEditor } from '../../../client/ui-settings-models/src/client/ProviderEditor.tsx'
import type { ModelsCredentialEditing, ModelsOperations, PreparedCredentialEdit } from '../../../client/ui-settings-models/src/client/operations.ts'
import type { ModelsSettingsMetadata } from '../../../client/ui-settings-models/src/client/integration.ts'
import { settingsSchema } from '../../../client/ui-settings-models/tests/settings-schema.client.ts'
import { en } from '../../../client/ui-settings-models/src/client/locales.ts'

afterEach(cleanup)
const ref = 'DEEPSEEK_API_KEY'
const denied = async (): Promise<never> => { throw new Error('Unexpected native credential/settings operation') }
const t = (key: keyof typeof en): string => en[key]
function namespace(ns = 'model-provider'): SettingsNamespaceView {
  const config = Schema.object({ apiKeyEnv: Schema.string().role('credential-ref') })
  return { ns, schema: JSON.parse(JSON.stringify(config.toJSON())) as JsonValue,
    value: { apiKeyEnv: ref }, autoGenerate: true, applies: 'live', secrets: [], revision: 1 }
}
function operations() {
  const nativeStore = vi.fn<ModelsOperations['storeCredential']>(async () => undefined)
  const writeSettings = vi.fn<ModelsOperations['writeSettings']>(denied)
  return { nativeStore, writeSettings,
    value: { storeCredential: nativeStore, removeCredential: denied, writeSettings, discoverModels: denied } satisfies ModelsOperations }
}
async function modelPage(edit: PreparedCredentialEdit, configured: boolean, install = true) {
  const ctx = new Context(), view = namespace(), ops = operations()
  onTestFinished(() => ctx.fiber.dispose())
  const metadata: ModelsSettingsMetadata = {
    providers: [{ id: 'deepseek-official', name: 'DeepSeek' }],
    configurableProviders: [{ provider: 'deepseek-official', displayName: 'DeepSeek', settingsNs: view.ns, settingsPath: [] }],
    settings: { writable: false, hasDocument: false, namespaces: [view] },
  }
  const mirror = { getSnapshot: () => ({ status: 'idle' as const, view: undefined, error: null }),
    subscribe: () => () => {}, ensure: denied, acceptView: () => {} }
  const controller = new ModelsSettingsStore(ctx, settingsSchema, mirror, { reads: {
    isCurrent: () => true, metadata: async () => metadata, credentials: async () => ({ [ref]: { configured, writable: true } }),
  }, unavailable: () => CREDENTIAL_COPY.keyEditUnavailable })
  await controller.load()
  const editing: ModelsCredentialEditing = { ...credentialPresentation, scope: 'original-model-provider-page', isCurrent: () => true,
    prepare: vi.fn(async () => edit) }
  const props = { controller, operations: ops.value, schema: settingsSchema, t,
    useSnapshot: bindSnapshotSelector(controller.store), credentialEditing: editing, renderSlot: () => null }
  const keyUi = await createModelKeyTestRenderer(ctx, { operations: ops.value, schema: settingsSchema, props }, install)
  render(keyUi.slots.renderSlot('root', {}))
  return { controller, ops, editing, keyUi }
}

it.each([false, true])('original Models submits the named prepared Key with model-provider and minimal readonly schema (configured=%s)', async (configured) => {
  const store = vi.fn<PreparedCredentialEdit['store']>(async () => undefined)
  const f = await modelPage({ ref, store, remove: denied }, configured)
  expect(f.controller.store.getSnapshot()).toMatchObject({ writable: false, rows: [{ apiKeyEnv: ref }] })
  expect(f.controller.store.getSnapshot().rows[0]?.entry.settingsNs).toBe('model-provider')
  expect(f.controller.store.getSnapshot().namespaces.has('llm-deepseek')).toBe(false)
  fireEvent.click(screen.getByRole('button', { name: CREDENTIAL_COPY.editKey }))
  const field = await screen.findByLabelText(en.keyInput)
  expect(screen.getByRole('button', { name: en.apply })).toHaveProperty('disabled', true)
  expect(screen.queryByText(en.customized)).toBeNull()
  fireEvent.change(field, { target: { value: 'synthetic-model-provider-input' } })
  expect(screen.getByRole('button', { name: en.apply })).toHaveProperty('disabled', false)
  fireEvent.click(screen.getByRole('button', { name: en.apply }))
  await waitFor(() => { expect(store).toHaveBeenCalledExactlyOnceWith('synthetic-model-provider-input') })
  expect(f.editing.prepare).toHaveBeenCalledExactlyOnceWith(ref, expect.any(AbortSignal))
  expect(f.ops.nativeStore).not.toHaveBeenCalled()
  expect(f.ops.writeSettings).not.toHaveBeenCalled()
})

it('original Models refuses a prepared callback for a different reference before opening the Key field', async () => {
  const store = vi.fn<PreparedCredentialEdit['store']>(async () => undefined)
  const f = await modelPage({ ref: 'OTHER_REFERENCE', store, remove: denied }, false)
  fireEvent.click(screen.getByRole('button', { name: CREDENTIAL_COPY.editKey }))
  await screen.findByText(CREDENTIAL_COPY.keyEditUnavailable)
  expect(screen.queryByLabelText(en.keyInput)).toBeNull()
  expect(store).not.toHaveBeenCalled()
  expect(f.ops.nativeStore).not.toHaveBeenCalled()
  expect(f.ops.writeSettings).not.toHaveBeenCalled()
})

it('the prepared credential-only ProviderEditor still checks its captured ref at the write operation', async () => {
  const ops = operations(), store = vi.fn<PreparedCredentialEdit['store']>(async () => undefined)
  render(<ProviderEditor provider="deepseek-official" displayName="DeepSeek" namespace={namespace()}
    schema={settingsSchema} settingsPath={[]} operations={ops.value} t={t} readOnly={false}
    credentialOnly credentialRequired credentialEdit={{ ref: 'OTHER_REFERENCE', store, remove: denied }} onClose={() => {}}/>)
  fireEvent.change(screen.getByLabelText(en.keyInput), { target: { value: 'synthetic-wrong-ref-input' } })
  fireEvent.click(screen.getByRole('button', { name: en.apply }))
  await screen.findByText(en.conflict)
  expect(store).not.toHaveBeenCalled()
  expect(ops.nativeStore).not.toHaveBeenCalled()
  expect(ops.writeSettings).not.toHaveBeenCalled()
})

it.each([false, true])('unknown native layout remains closed without a prepared credential-only intent (credentialOnly=%s)', (credentialOnly) => {
  const ops = operations()
  render(<ProviderEditor provider="deepseek-official" displayName="DeepSeek" namespace={namespace()}
    schema={settingsSchema} settingsPath={[]} operations={ops.value} t={t} readOnly={false}
    credentialOnly={credentialOnly} onClose={() => {}}/>)
  expect(screen.queryByLabelText(en.keyInput)).toBeNull()
  expect(screen.getByRole('button', { name: en.apply })).toHaveProperty('disabled', true)
  expect(ops.nativeStore).not.toHaveBeenCalled()
  expect(ops.writeSettings).not.toHaveBeenCalled()
})

it('known native layout keeps its original credential operation without a prepared intent', async () => {
  const ops = operations()
  render(<ProviderEditor provider="deepseek-official" displayName="DeepSeek" namespace={namespace('llm-deepseek')}
    schema={settingsSchema} settingsPath={[]} operations={ops.value} t={t} readOnly={false} onClose={() => {}}/>)
  fireEvent.change(screen.getByLabelText(en.keyInput), { target: { value: 'synthetic-native-input' } })
  fireEvent.click(screen.getByRole('button', { name: en.apply }))
  await waitFor(() => { expect(ops.nativeStore).toHaveBeenCalledExactlyOnceWith(ref, 'synthetic-native-input') })
  expect(ops.writeSettings).not.toHaveBeenCalled()
})

it('a prepared callback does not enable an unknown general settings layout', () => {
  const ops = operations(), store = vi.fn<PreparedCredentialEdit['store']>(async () => undefined)
  render(<ProviderEditor provider="deepseek-official" displayName="DeepSeek" namespace={namespace()}
    schema={settingsSchema} settingsPath={[]} operations={ops.value} t={t} readOnly={false}
    credentialEdit={{ ref, store, remove: denied }} onClose={() => {}}/>)
  expect(screen.queryByLabelText(en.keyInput)).toBeNull()
  expect(screen.getByRole('button', { name: en.apply })).toHaveProperty('disabled', true)
  expect(store).not.toHaveBeenCalled()
  expect(ops.nativeStore).not.toHaveBeenCalled()
})


it('keeps the Native row empty without the optional Cloud contribution', async () => {
  const store = vi.fn<PreparedCredentialEdit['store']>(async () => undefined)
  const f = await modelPage({ ref, store, remove: denied }, true, false)
  expect(screen.queryByRole('button', { name: CREDENTIAL_COPY.editKey })).toBeNull()
  expect(screen.queryByRole('button', { name: CREDENTIAL_COPY.removeKey })).toBeNull()
  expect(f.editing.prepare).not.toHaveBeenCalled()
  expect(store).not.toHaveBeenCalled()
  expect(f.ops.nativeStore).not.toHaveBeenCalled()
})

it('localizes all eight action dictionaries and withdraws the contribution with the original page', async () => {
  const f = await modelPage({ ref, store: denied, remove: denied }, true)
  for (const [id, copy] of Object.entries(modelKeyActionDictionaries)) {
    act(() => { f.keyUi.locale.setLocale(id) })
    expect(screen.getByRole('button', { name: copy.editKey })).toBeDefined()
    expect(screen.getByRole('button', { name: copy.removeKey })).toBeDefined()
  }
  expect(f.editing.prepare).not.toHaveBeenCalled()
  act(() => { f.keyUi.lifetime.abort() })
  expect(f.keyUi.slots.entries('settings.models.provider.credentials')).toHaveLength(0)
  expect(screen.queryByRole('button', { name: modelKeyActionDictionaries.pt.editKey })).toBeNull()
})

it.each([undefined, 'unconfirmed key removal'])('removes only the captured key and consumes a refused or unknown attempt (%s)', async (failure) => {
  const remove = vi.fn<PreparedCredentialEdit['remove']>(async () => failure), store = vi.fn(denied)
  const f = await modelPage({ ref, store, remove }, true)
  fireEvent.click(screen.getByRole('button', { name: CREDENTIAL_COPY.removeKey }))
  const dialog = await screen.findByRole('dialog', { name: CREDENTIAL_COPY.removeKeyTitle })
  fireEvent.click(within(dialog).getByRole('button', { name: CREDENTIAL_COPY.removeKey }))
  await waitFor(() => { expect(remove).toHaveBeenCalledOnce() })
  expect(f.editing.prepare).toHaveBeenCalledExactlyOnceWith(ref, expect.any(AbortSignal))
  expect(store).not.toHaveBeenCalled()
  expect(f.ops.nativeStore).not.toHaveBeenCalled()
  expect(f.ops.writeSettings).not.toHaveBeenCalled()
  if (failure !== undefined) {
    await within(dialog).findByText(failure)
    const repeat = within(dialog).getByRole('button', { name: CREDENTIAL_COPY.removeKey })
    expect(repeat).toHaveProperty('disabled', true)
    fireEvent.click(repeat)
    expect(remove).toHaveBeenCalledOnce()
  } else {
    await waitFor(() => { expect(screen.queryByRole('dialog')).toBeNull() })
  }
})

it('aborts a closed preparation and ignores its late result without opening the Native editor', async () => {
  const store = vi.fn<PreparedCredentialEdit['store']>(async () => undefined)
  const f = await modelPage({ ref, store, remove: denied }, false)
  const held = Promise.withResolvers<PreparedCredentialEdit>()
  onTestFinished(() => { held.resolve({ ref, store, remove: denied }) })
  vi.mocked(f.editing.prepare).mockImplementationOnce(async () => held.promise)
  fireEvent.click(screen.getByRole('button', { name: CREDENTIAL_COPY.editKey }))
  await screen.findByRole('status')
  await waitFor(() => { expect(f.editing.prepare).toHaveBeenCalledOnce() })
  const signal = vi.mocked(f.editing.prepare).mock.calls[0]![1]
  fireEvent.click(screen.getByRole('button', { name: en.cancel }))
  expect(signal.aborted).toBe(true)
  await act(async () => { held.resolve({ ref, store, remove: denied }); await held.promise })
  expect(screen.queryByLabelText(en.keyInput)).toBeNull()
  expect(store).not.toHaveBeenCalled()
})
