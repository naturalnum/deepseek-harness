// @vitest-environment jsdom
/** Existing Models page reuses its original provider editor with a scoped settings writer. */
import Schema from '@deepseek-ai/schemastery'
import { Context } from '@deepseek-ai/cordis'
import { bindSnapshotSelector } from '@deepseek-ai/dsh-client-test-runtime'
import type { JsonValue } from '@deepseek-ai/dsh-util-values'
import { cleanup, fireEvent, render, screen, waitFor } from '@testing-library/react'
import { afterEach, expect, it, onTestFinished, vi } from 'vitest'
import { ModelsSection } from '../src/client/ModelsSection.tsx'
import { ModelsSettingsStore } from '../src/client/store.ts'
import type { ModelsOperations } from '../src/client/operations.ts'
import { settingsSchema } from './settings-schema.client.ts'
import { en } from '../src/client/locales.ts'

afterEach(cleanup)
const denied = async (): Promise<never> => { throw new Error('unrestricted operation reached') }
const t = (key: keyof typeof en) => en[key]
function jsonValue(value: unknown): JsonValue {
  if (value === null || typeof value === 'string' || typeof value === 'boolean') return value
  if (typeof value === 'number' && Number.isFinite(value)) return value
  if (Array.isArray(value)) return value.map(jsonValue)
  if (typeof value === 'object') return Object.fromEntries(Object.entries(value).map(([key, item]) => [key, jsonValue(item)]))
  throw new Error('Expected JSON value')
}
async function mount(write: ModelsOperations['writeSettings'], isCurrent: () => boolean = () => true) {
  const ctx = new Context()
  onTestFinished(() => ctx.fiber.dispose())
  const schema = Schema.object({ apiKeyEnv: Schema.string().role('credential-ref'),
    models: Schema.array(Schema.object({ id: Schema.string().required(), name: Schema.string() })) })
  const view = { ns: 'model-provider', schema: jsonValue(JSON.parse(JSON.stringify(schema.toJSON()))),
    value: { apiKeyEnv: 'DEEPSEEK_API_KEY', models: [{ id: 'first' }] },
    user: { models: [{ id: 'first' }] }, base: {}, revision: 7, autoGenerate: true, applies: 'live' as const, secrets: [] }
  const controller = new ModelsSettingsStore(ctx, settingsSchema,
    { getSnapshot: () => ({ status: 'idle' as const, view: undefined, error: null }), subscribe: () => () => {}, ensure: denied, acceptView: () => {} },
    { reads: { isCurrent: () => true, metadata: async () => ({ providers: [{ id: 'deepseek-official', name: 'DeepSeek' }],
      configurableProviders: [{ provider: 'deepseek-official', displayName: 'DeepSeek', settingsNs: view.ns, settingsPath: [] }],
      settings: { writable: true, hasDocument: false, namespaces: [view] } }),
    credentials: async () => ({ DEEPSEEK_API_KEY: { configured: true, writable: true } }) },
    unavailable: () => en.keyEditUnavailable })
  await controller.load()
  const operations: ModelsOperations = { storeCredential: denied, removeCredential: denied, discoverModels: denied, writeSettings: write }
  render(<ModelsSection controller={controller} operations={operations} schema={settingsSchema} t={t}
    useSnapshot={bindSnapshotSelector(controller.store)} credentialEditing={{ scope: 'account-page', isCurrent, prepare: async () => null }} renderSlot={() => null} />)
  fireEvent.click(screen.getByRole('button', { name: /Edit DeepSeek \(deepseek-official\)/ }))
  fireEvent.click(screen.getByText(en.customized))
  fireEvent.change(screen.getByLabelText(`${en.modelId} 1`), { target: { value: 'updated' } })
  return view
}

it('saves the native model draft with the captured revision and without calling credentials', async () => {
  const write = vi.fn<ModelsOperations['writeSettings']>(async (_ns, _ops, revision) => ({ kind: 'conflict', message: String(revision) }))
  await mount(write)
  expect(screen.queryByLabelText(en.keyInput)).toBeNull()
  expect(screen.queryByLabelText(en.baseUrl)).toBeNull()
  fireEvent.click(screen.getByRole('button', { name: en.apply }))
  await waitFor(() => { expect(write).toHaveBeenCalledOnce() })
  expect(write).toHaveBeenCalledWith('model-provider', [{ op: 'set', path: ['models'], value: [{ id: 'updated' }] }], 7)
  expect(await screen.findByText(en.conflict)).toBeDefined()
})

it('does not retry an unconfirmed settings write from the same draft', async () => {
  const write = vi.fn<ModelsOperations['writeSettings']>(async () => ({ kind: 'unknown', message: 'unconfirmed' }))
  await mount(write)
  fireEvent.click(screen.getByRole('button', { name: en.apply }))
  await screen.findByText('unconfirmed')
  expect(screen.getByRole('button', { name: en.apply })).toHaveProperty('disabled', true)
  expect(write).toHaveBeenCalledOnce()
})

it('blocks a repeated write if the page is revoked before the result is observed', async () => {
  const write = vi.fn<ModelsOperations['writeSettings']>(async () => { throw new Error('revoked') })
  await mount(write)
  fireEvent.click(screen.getByRole('button', { name: en.apply }))
  await screen.findByText(en.keyEditUnavailable)
  expect(screen.getByRole('button', { name: en.apply })).toHaveProperty('disabled', true)
  expect(write).toHaveBeenCalledOnce()
})

it('uses the native unset operation when the user resets the model catalog', async () => {
  const write = vi.fn<ModelsOperations['writeSettings']>(async () => ({ kind: 'conflict', message: 'fixture' }))
  await mount(write)
  fireEvent.click(screen.getByRole('button', { name: en.resetModels }))
  fireEvent.click(screen.getByRole('button', { name: en.apply }))
  await waitFor(() => { expect(write).toHaveBeenCalledOnce() })
  expect(write).toHaveBeenCalledWith('model-provider', [{ op: 'unset', path: ['models'] }], 7)
})

it('does not dispatch an old draft after its captured page binding is revoked', async () => {
  let current = true
  const write = vi.fn<ModelsOperations['writeSettings']>(async () => ({ kind: 'conflict', message: 'fixture' }))
  await mount(write, () => current)
  current = false
  fireEvent.click(screen.getByRole('button', { name: en.apply }))
  await screen.findByText(en.keyEditUnavailable)
  expect(write).not.toHaveBeenCalled()
})
