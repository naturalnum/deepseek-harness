import { afterEach, expect, it, vi } from 'vitest'
import { cleanup, fireEvent, render, screen, waitFor } from '@testing-library/react'
import { AccountHttpClient, AccountHttpError, type AuthorizedModel, type CurrentAccount } from '../src/client/account-api.ts'
import { AccountSection, type AccountSectionProps } from '../src/client/AccountSection.tsx'
import { en } from '../src/client/locales.ts'

const userId = '54f0f232-a068-4223-96e8-d0cff78d0f1c'
const models: AuthorizedModel[] = [
  { id: 'model-one', label: 'Model One', maxTokens: 4096 },
  { id: 'model-two', label: 'Model Two', maxTokens: 2048 },
]
const account = (model = 'model-one', maxTokens = 512, revision = 1): CurrentAccount =>
  ({ userId, username: 'alice', settings: { model, maxTokens, revision } })
const t: AccountSectionProps['t'] = key => key in en ? en[key as keyof typeof en] : String(key)

function mount(client: AccountHttpClient) {
  return render(<AccountSection client={client} t={t} close={() => undefined} />)
}

afterEach(() => { cleanup(); vi.restoreAllMocks() })

it('shows only authorized models, saves personal settings, then re-reads the current revision', async () => {
  let current = account()
  const me = vi.fn(async () => current)
  const settingsUpdate = vi.fn(async (input: { model: string; maxTokens: number }) => {
    current = account(input.model, input.maxTokens, 2)
    return current.settings
  })
  mount(Object.assign(new AccountHttpClient(), { me, modelsList: vi.fn(async () => models), settingsUpdate }))
  expect(await screen.findByText('alice')).toBeTruthy()
  const choice = screen.getByLabelText(en.model) as HTMLSelectElement
  expect([...choice.options].map(option => option.value)).toEqual(['model-one', 'model-two'])
  fireEvent.change(choice, { target: { value: 'model-two' } })
  fireEvent.change(screen.getByLabelText(en.maxTokens), { target: { value: '768' } })
  fireEvent.click(screen.getByRole('button', { name: en.save }))
  await waitFor(() => expect(settingsUpdate).toHaveBeenCalledOnce())
  expect(settingsUpdate.mock.calls[0]?.[0]).toMatchObject({ expectedRevision: 1, model: 'model-two', maxTokens: 768 })
  expect(settingsUpdate.mock.calls[0]?.[0].requestId).toMatch(/^[0-9a-f-]{36}$/u)
  expect(await screen.findByText(en.saved)).toBeTruthy()
  expect(me).toHaveBeenCalledTimes(2)
  expect((screen.getByLabelText(en.model) as HTMLSelectElement).value).toBe('model-two')
})

it('retries an uncertain save with the identical request ID and immutable payload', async () => {
  let current = account()
  const settingsUpdate = vi.fn()
    .mockRejectedValueOnce(new Error('network unavailable'))
    .mockImplementationOnce(async (input: { model: string; maxTokens: number }) => {
      current = account(input.model, input.maxTokens, 2)
      return current.settings
    })
  mount(Object.assign(new AccountHttpClient(), { me: vi.fn(async () => current), modelsList: vi.fn(async () => models), settingsUpdate }))
  await screen.findByText('alice')
  fireEvent.change(screen.getByLabelText(en.maxTokens), { target: { value: '1024' } })
  fireEvent.click(screen.getByRole('button', { name: en.save }))
  expect(await screen.findByText(en.saveRetry)).toBeTruthy()
  expect((screen.getByLabelText(en.maxTokens) as HTMLInputElement).disabled).toBe(true)
  fireEvent.click(screen.getByRole('button', { name: en.retrySave }))
  expect(await screen.findByText(en.saved)).toBeTruthy()
  expect(settingsUpdate).toHaveBeenCalledTimes(2)
  expect(settingsUpdate.mock.calls[1]?.[0]).toEqual(settingsUpdate.mock.calls[0]?.[0])
})

it('reloads the authoritative values after a revision conflict before another edit', async () => {
  const me = vi.fn().mockResolvedValueOnce(account()).mockResolvedValueOnce(account('model-one', 700, 2))
  const settingsUpdate = vi.fn().mockRejectedValueOnce(new AccountHttpError(409))
  mount(Object.assign(new AccountHttpClient(), { me, modelsList: vi.fn(async () => models), settingsUpdate }))
  await screen.findByText('alice')
  fireEvent.change(screen.getByLabelText(en.model), { target: { value: 'model-two' } })
  fireEvent.click(screen.getByRole('button', { name: en.save }))
  expect(await screen.findByText(en.conflict)).toBeTruthy()
  expect(me).toHaveBeenCalledTimes(2)
  expect((screen.getByLabelText(en.model) as HTMLSelectElement).value).toBe('model-one')
  expect((screen.getByLabelText(en.maxTokens) as HTMLInputElement).value).toBe('700')
  expect((screen.getByRole('button', { name: en.save }) as HTMLButtonElement).disabled).toBe(true)
})

it('refreshes the authorized catalog after a model is revoked', async () => {
  const modelsList = vi.fn().mockResolvedValueOnce(models).mockResolvedValueOnce([models[0]])
  const settingsUpdate = vi.fn().mockRejectedValueOnce(new AccountHttpError(403))
  mount(Object.assign(new AccountHttpClient(), { me: vi.fn(async () => account()), modelsList, settingsUpdate }))
  await screen.findByText('alice')
  fireEvent.change(screen.getByLabelText(en.model), { target: { value: 'model-two' } })
  fireEvent.click(screen.getByRole('button', { name: en.save }))
  expect(await screen.findByText(en.modelDenied)).toBeTruthy()
  const choice = screen.getByLabelText(en.model) as HTMLSelectElement
  expect([...choice.options].map(option => option.value)).toEqual(['model-one'])
  expect(modelsList).toHaveBeenCalledTimes(2)
})

it('blocks values outside the selected model limit without issuing a request', async () => {
  const settingsUpdate = vi.fn()
  mount(Object.assign(new AccountHttpClient(), { me: vi.fn(async () => account()),
    modelsList: vi.fn(async () => [{ id: 'model-one', label: 'Model One', maxTokens: 600 }]),
    settingsUpdate }))
  await screen.findByText('alice')
  fireEvent.change(screen.getByLabelText(en.maxTokens), { target: { value: '601' } })
  expect((screen.getByRole('button', { name: en.save }) as HTMLButtonElement).disabled).toBe(true)
  expect(settingsUpdate).not.toHaveBeenCalled()
})
