// @vitest-environment jsdom
/** Public page-model calls with account-local Ports and deferred external replies. */
import type {} from '../src/client/index.ts'
import { act, cleanup, renderHook, waitFor } from '@testing-library/react'
import { afterEach, expect, it, vi } from 'vitest'
import { deferredResult } from './deferred-result.ts'
import { en } from '../src/client/locales.ts'
import { usePersonalMcp } from '../src/client/use-personal-mcp.ts'
import {
  PersonalMcpConnectionRequestError,
  type PersonalMcpConnection,
  type PersonalMcpConnectionCheck,
  type PersonalMcpConnectionCreateRequest,
  type PersonalMcpConnectionPort,
} from '../src/client/personal-mcp-client.ts'

afterEach(cleanup)
const t = (key: keyof typeof en): string => en[key]
const connection: PersonalMcpConnection = {
  connection_id: '00000000-0000-4000-8000-000000000001', revision: 1,
  configuration_revision: 1, credential_revision: null, display_name: 'Knowledge',
  server_name: 'knowledge', server_url: 'https://mcp.example.test/mcp',
  authentication: { kind: 'none', secret_configured: false }, enabled: true,
  latest_check: null, created_at: '2026-10-09T00:00:00Z', updated_at: '2026-10-09T00:00:00Z',
}
const other: PersonalMcpConnection = { ...connection,
  connection_id: '00000000-0000-4000-8000-000000000002', display_name: 'Other account' }
const input: PersonalMcpConnectionCreateRequest = { display_name: connection.display_name,
  server_url: connection.server_url, authentication: { kind: 'none' }, enabled: true }
const checkInput = { configuration: input, session_id: 'existing-session', expected_revision: 1 }
const saved: PersonalMcpConnectionCheck = { check_id: 'saved-check', connection_id: connection.connection_id,
  configuration_revision: 1, credential_revision: null, state: 'succeeded', error_code: null,
  discovered_tools: 2, started_at: null, finished_at: null }
const unexpected = async (): Promise<never> => { throw new Error('Unexpected external operation') }
type FixturePort = {
  [Key in keyof PersonalMcpConnectionPort]:
  (...args: Parameters<PersonalMcpConnectionPort[Key]>) => ReturnType<PersonalMcpConnectionPort[Key]>
}
function port(overrides: Partial<PersonalMcpConnectionPort> = {}): FixturePort {
  return { list: vi.fn(async () => ({ items: [connection] })),
    create: vi.fn(unexpected), update: vi.fn(unexpected), toggle: vi.fn(unexpected), remove: vi.fn(unexpected),
    createCheck: vi.fn(unexpected), getCheck: vi.fn(unexpected), cancelCheck: vi.fn(unexpected),
    createDraftCheck: vi.fn(unexpected), getDraftCheck: vi.fn(unexpected), cancelDraftCheck: vi.fn(unexpected), ...overrides }
}
function model(client: PersonalMcpConnectionPort) {
  return renderHook(({ client }) => usePersonalMcp(client, t), { initialProps: { client } })
}
function begin<Result>(operation: () => Promise<Result>): Promise<Result> {
  const started: Promise<Result>[] = []
  act(() => { started.push(operation()) })
  const pending = started[0]
  if (pending === undefined) throw new Error('The public operation did not start')
  return pending
}

it.each(['create', 'update', 'toggle', 'remove', 'check', 'cancel'] as const)(
  'plain HTTP browser crypto preserves the original %s request across an uncertain reply', async (operation) => {
    const originalCrypto = globalThis.crypto, requests: string[] = []
    vi.stubGlobal('crypto', { getRandomValues: originalCrypto.getRandomValues.bind(originalCrypto) })
    try {
      async function reply<Value>(requestId: string, value: Value): Promise<Value> {
        requests.push(requestId)
        if (requests.length === 1) throw new TypeError('lost reply')
        return value
      }
      const client = port({
        create: vi.fn<PersonalMcpConnectionPort['create']>((_input, requestId) => reply(requestId, connection)),
        update: vi.fn<PersonalMcpConnectionPort['update']>((_id, _input, requestId) => reply(requestId, connection)),
        toggle: vi.fn<PersonalMcpConnectionPort['toggle']>((_id, _revision, _enabled, requestId) => reply(requestId, connection)),
        remove: vi.fn<PersonalMcpConnectionPort['remove']>((_id, _revision, requestId) => reply(requestId, undefined)),
        createCheck: vi.fn<PersonalMcpConnectionPort['createCheck']>((_id, _input, requestId) => reply(requestId, saved)),
        cancelCheck: vi.fn<PersonalMcpConnectionPort['cancelCheck']>((_id, _checkId, requestId) => reply(requestId, { ...saved, state: 'canceled' })),
      })
      const view = model(client)
      await waitFor(() => { expect(view.result.current.loading).toBe(false) })
      const execute = () => {
        switch (operation) {
          case 'create': return view.result.current.create(input)
          case 'update': return view.result.current.update(connection.connection_id, { ...input, expected_revision: 1 })
          case 'toggle': return view.result.current.toggle(connection.connection_id, 1, false)
          case 'remove': return view.result.current.remove(connection.connection_id, 1)
          case 'check': return view.result.current.startCheck(connection.connection_id, checkInput)
          case 'cancel': return view.result.current.cancelCheck(connection.connection_id, saved.check_id)
        }
      }
      await act(async () => { await execute() })
      expect(requests).toHaveLength(1)
      expect(requests[0]).toMatch(/^[0-9a-f]{8}-[0-9a-f]{4}-4[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/u)
      await act(async () => {
        if (operation === 'check') expect(await view.result.current.retryCheck()).toEqual(saved)
        else if (operation === 'cancel') expect(await execute()).toEqual({ ...saved, state: 'canceled' })
        else expect(await view.result.current.retryMutation()).toEqual(operation === 'remove' ? true : connection)
      })
      expect(requests).toEqual([requests[0], requests[0]])
      expect(view.result.current.failedMutation).toBe(false)
      expect(view.result.current.failedCheckAttempt).toBeUndefined()
      expect(view.result.current.error).toBeUndefined()
    } finally { vi.unstubAllGlobals() }
  },
)

it('editing one saved connection preserves the other account-local rows', async () => {
  const updated = { ...connection, display_name: 'Edited knowledge', revision: 2 }
  const list = vi.fn<PersonalMcpConnectionPort['list']>()
    .mockResolvedValueOnce({ items: [connection, other] }).mockResolvedValueOnce({ items: [updated, other] })
  const update = vi.fn<PersonalMcpConnectionPort['update']>().mockResolvedValue(updated)
  const view = model(port({ list, update }))
  await waitFor(() => { expect(view.result.current.loading).toBe(false) })
  await act(async () => {
    expect(await view.result.current.update(connection.connection_id, { ...input, expected_revision: 1 })).toEqual(updated)
  })
  expect(view.result.current.connections).toEqual([updated, other])
  expect(update).toHaveBeenCalledOnce()
})

it('a definite saved-check authorization refusal permits a later user gesture without an automatic retry', async () => {
  const createCheck = vi.fn<PersonalMcpConnectionPort['createCheck']>()
    .mockRejectedValueOnce(new PersonalMcpConnectionRequestError(401)).mockResolvedValueOnce(saved)
  const view = model(port({ createCheck }))
  await waitFor(() => { expect(view.result.current.loading).toBe(false) })
  await act(async () => { expect(await view.result.current.startCheck(connection.connection_id, checkInput)).toBeUndefined() })
  expect(view.result.current.failedCheckAttempt).toBeUndefined()
  expect(view.result.current.error).toBe(en.sessionExpired)
  expect(createCheck).toHaveBeenCalledOnce()
  await act(async () => { expect(await view.result.current.startCheck(connection.connection_id, checkInput)).toEqual(saved) })
  expect(createCheck).toHaveBeenCalledTimes(2)
  expect(createCheck.mock.calls[1]?.[2]).not.toBe(createCheck.mock.calls[0]?.[2])
})

it('reports an initial list refusal and clears it only after an explicit successful refresh', async () => {
  const list = vi.fn<PersonalMcpConnectionPort['list']>()
    .mockRejectedValueOnce(new PersonalMcpConnectionRequestError(401))
    .mockResolvedValueOnce({ items: [connection], available: true })
  const view = model(port({ list }))
  await waitFor(() => { expect(view.result.current.loading).toBe(false) })
  expect(view.result.current.error).toBe(en.sessionExpired)
  expect(view.result.current.connections).toEqual([])
  await act(async () => { await view.result.current.reload() })
  expect(view.result.current.error).toBeUndefined()
  expect(view.result.current.connections).toEqual([connection])
  expect(list).toHaveBeenCalledTimes(2)
})

it.each(['success', 'failure'] as const)('ignores a late initial list %s after the account Port changes', async (outcome) => {
  const pending = deferredResult<Awaited<ReturnType<PersonalMcpConnectionPort['list']>>>()
  const list = vi.fn<PersonalMcpConnectionPort['list']>(() => pending.promise)
  const view = model(port({ list }))
  const next = port({ list: async () => ({ items: [other], available: true }) })
  view.rerender({ client: next })
  await waitFor(() => { expect(view.result.current.connections).toEqual([other]) })
  expect(list.mock.calls[0]?.[1]?.aborted).toBe(true)
  await act(async () => {
    if (outcome === 'success') pending.resolve({ items: [connection] })
    else pending.reject(new PersonalMcpConnectionRequestError(401))
  })
  expect(view.result.current.connections).toEqual([other])
  expect(view.result.current.error).toBeUndefined()
  expect(view.result.current.loading).toBe(false)
})

it('blocks new writes during an uncertain mutation and retries only its original input and identity', async () => {
  const updated = { ...connection, revision: 2, enabled: false }
  const toggle = vi.fn<PersonalMcpConnectionPort['toggle']>()
    .mockRejectedValueOnce(new TypeError('lost reply')).mockResolvedValueOnce(updated)
  const list = vi.fn<PersonalMcpConnectionPort['list']>()
    .mockResolvedValueOnce({ items: [connection, other] }).mockResolvedValueOnce({ items: [updated, other] })
  const client = port({ toggle, list })
  const view = model(client)
  await waitFor(() => { expect(view.result.current.loading).toBe(false) })
  await act(async () => { await view.result.current.toggle(connection.connection_id, 1, false) })
  expect(view.result.current.failedMutation).toBe(true)
  expect(view.result.current.error).toBe(en.personalMcpMutationUncertain)
  await act(async () => {
    expect(await view.result.current.create(input)).toBeUndefined()
    expect(await view.result.current.update(connection.connection_id, { ...input, expected_revision: 1 })).toBeUndefined()
    expect(await view.result.current.toggle(other.connection_id, 1, false)).toBeUndefined()
    expect(await view.result.current.remove(other.connection_id, 1)).toBe(false)
  })
  expect(client.create).not.toHaveBeenCalled()
  expect(client.update).not.toHaveBeenCalled()
  expect(client.remove).not.toHaveBeenCalled()
  expect(toggle).toHaveBeenCalledOnce()
  await act(async () => { expect(await view.result.current.retryMutation()).toEqual(updated) })
  expect(toggle.mock.calls[0]).toEqual(toggle.mock.calls[1])
  expect(view.result.current.connections).toEqual([updated, other])
  expect(view.result.current.failedMutation).toBe(false)
  expect(view.result.current.error).toBeUndefined()
})

it('admits one saved check and refuses concurrent check, cancellation and metadata writes', async () => {
  const pending = deferredResult<PersonalMcpConnectionCheck>()
  const createCheck = vi.fn<PersonalMcpConnectionPort['createCheck']>(() => pending.promise)
  const client = port({ createCheck })
  const view = model(client)
  await waitFor(() => { expect(view.result.current.loading).toBe(false) })
  const checking = begin(() => view.result.current.startCheck(connection.connection_id, checkInput))
  await act(async () => {
    expect(await view.result.current.startCheck(connection.connection_id, checkInput)).toBeUndefined()
    expect(await view.result.current.cancelCheck(connection.connection_id, saved.check_id)).toBeUndefined()
    expect(await view.result.current.create(input)).toBeUndefined()
    expect(await view.result.current.update(connection.connection_id, { ...input, expected_revision: 1 })).toBeUndefined()
    expect(await view.result.current.toggle(connection.connection_id, 1, false)).toBeUndefined()
    expect(await view.result.current.remove(connection.connection_id, 1)).toBe(false)
  })
  expect(createCheck).toHaveBeenCalledOnce()
  for (const name of ['create', 'update', 'toggle', 'remove', 'cancelCheck'] as const) expect(client[name]).not.toHaveBeenCalled()
  await act(async () => { pending.resolve(saved); expect(await checking).toEqual(saved) })
  expect(view.result.current.connections[0]?.latest_check).toEqual(saved)
  expect(view.result.current.busyId).toBeUndefined()
})

it.each(['success', 'failure'] as const)('a late mutation %s cannot change or unlock the replacement account', async (outcome) => {
  const oldReply = deferredResult<PersonalMcpConnection>(), newReply = deferredResult<PersonalMcpConnection>()
  const oldToggle = vi.fn<PersonalMcpConnectionPort['toggle']>(() => oldReply.promise)
  const view = model(port({ toggle: oldToggle }))
  await waitFor(() => { expect(view.result.current.loading).toBe(false) })
  const oldOperation = begin(() => view.result.current.toggle(connection.connection_id, 1, false))
  const nextToggle = vi.fn<PersonalMcpConnectionPort['toggle']>(() => newReply.promise)
  view.rerender({ client: port({ list: async () => ({ items: [other] }), toggle: nextToggle }) })
  await waitFor(() => { expect(view.result.current.connections).toEqual([other]) })
  const newOperation = begin(() => view.result.current.toggle(other.connection_id, 1, false))
  await act(async () => {
    if (outcome === 'success') oldReply.resolve({ ...connection, revision: 2, enabled: false })
    else oldReply.reject(new PersonalMcpConnectionRequestError(401))
    expect(await oldOperation).toBeUndefined()
  })
  expect(view.result.current.connections).toEqual([other])
  expect(view.result.current.error).toBeUndefined()
  expect(view.result.current.busyId).toBe(other.connection_id)
  expect(view.result.current.failedMutation).toBe(false)
  await act(async () => { newReply.resolve({ ...other, revision: 2, enabled: false }); await newOperation })
  expect(nextToggle).toHaveBeenCalledOnce()
})

it('a successful mutation awaiting its refresh cannot return a result for a replacement account', async () => {
  const refresh = deferredResult<Awaited<ReturnType<PersonalMcpConnectionPort['list']>>>()
  const list = vi.fn<PersonalMcpConnectionPort['list']>()
    .mockResolvedValueOnce({ items: [connection] }).mockImplementationOnce(() => refresh.promise)
  const view = model(port({ list, toggle: async () => ({ ...connection, revision: 2, enabled: false }) }))
  await waitFor(() => { expect(view.result.current.loading).toBe(false) })
  const operation = begin(() => view.result.current.toggle(connection.connection_id, 1, false))
  await waitFor(() => { expect(list).toHaveBeenCalledTimes(2) })
  view.rerender({ client: port({ list: async () => ({ items: [other] }) }) })
  await waitFor(() => { expect(view.result.current.connections).toEqual([other]) })
  await act(async () => { refresh.resolve({ items: [connection] }); expect(await operation).toBeUndefined() })
  expect(view.result.current.connections).toEqual([other])
  expect(view.result.current.busyId).toBeUndefined()
})

it.each([
  { operation: 'start', outcome: 'success' }, { operation: 'start', outcome: 'failure' },
  { operation: 'cancel', outcome: 'success' }, { operation: 'cancel', outcome: 'failure' },
] as const)('a late saved-check $operation $outcome cannot publish into or unlock a new account', async ({ operation, outcome }) => {
  const oldReply = deferredResult<PersonalMcpConnectionCheck>(), newReply = deferredResult<PersonalMcpConnectionCheck>()
  const old = port({ createCheck: () => oldReply.promise, cancelCheck: () => oldReply.promise })
  const view = model(old)
  await waitFor(() => { expect(view.result.current.loading).toBe(false) })
  const oldOperation = begin(() => operation === 'start'
    ? view.result.current.startCheck(connection.connection_id, checkInput)
    : view.result.current.cancelCheck(connection.connection_id, saved.check_id))
  const nextCheck = vi.fn<PersonalMcpConnectionPort['createCheck']>(() => newReply.promise)
  view.rerender({ client: port({ list: async () => ({ items: [other] }), createCheck: nextCheck }) })
  await waitFor(() => { expect(view.result.current.connections).toEqual([other]) })
  const newOperation = begin(() => view.result.current.startCheck(other.connection_id, checkInput))
  await act(async () => {
    if (outcome === 'success') oldReply.resolve(saved)
    else oldReply.reject(new PersonalMcpConnectionRequestError(401))
    expect(await oldOperation).toBeUndefined()
  })
  expect(view.result.current.connections).toEqual([other])
  expect(view.result.current.error).toBeUndefined()
  expect(view.result.current.failedCheckAttempt).toBeUndefined()
  expect(view.result.current.busyId).toBe(`check:${other.connection_id}`)
  await act(async () => { newReply.resolve({ ...saved, connection_id: other.connection_id }); await newOperation })
  expect(nextCheck).toHaveBeenCalledOnce()
})

it('empty retry actions neither invent a request nor call the Port', async () => {
  const client = port()
  const view = model(client)
  await waitFor(() => { expect(view.result.current.loading).toBe(false) })
  await act(async () => {
    expect(await view.result.current.retryCheck()).toBeUndefined()
    expect(await view.result.current.retryMutation()).toBeUndefined()
    await view.result.current.loadMore()
  })
  expect(client.createCheck).not.toHaveBeenCalled()
  expect(client.create).not.toHaveBeenCalled()
  expect(client.list).toHaveBeenCalledOnce()
})

it('an ambiguous saved-check retry retains its original request until a definite refusal permits a new gesture', async () => {
  const createCheck = vi.fn<PersonalMcpConnectionPort['createCheck']>()
    .mockRejectedValueOnce(new PersonalMcpConnectionRequestError(503))
    .mockRejectedValueOnce(new TypeError('retry reply lost'))
    .mockRejectedValueOnce(new PersonalMcpConnectionRequestError(401))
    .mockResolvedValueOnce(saved)
  const view = model(port({ createCheck }))
  await waitFor(() => { expect(view.result.current.loading).toBe(false) })
  await act(async () => { await view.result.current.startCheck(connection.connection_id, checkInput) })
  const original = view.result.current.failedCheckAttempt
  expect(original).toMatchObject({ connectionId: connection.connection_id, sessionId: checkInput.session_id })
  await act(async () => { await view.result.current.retryCheck() })
  expect(view.result.current.failedCheckAttempt).toEqual(original)
  await act(async () => { await view.result.current.retryCheck() })
  expect(view.result.current.failedCheckAttempt).toBeUndefined()
  expect(view.result.current.error).toBe(en.sessionExpired)
  expect(createCheck.mock.calls[0]).toEqual(createCheck.mock.calls[1])
  expect(createCheck.mock.calls[0]).toEqual(createCheck.mock.calls[2])
  await act(async () => { await view.result.current.startCheck(connection.connection_id, checkInput) })
  expect(createCheck.mock.calls[3]?.[2]).not.toBe(createCheck.mock.calls[0]?.[2])
  expect(view.result.current.connections[0]?.latest_check).toEqual(saved)
})

it('a second public page request while the cursor read is pending does not fetch another page', async () => {
  const pending = deferredResult<Awaited<ReturnType<PersonalMcpConnectionPort['list']>>>()
  const list = vi.fn<PersonalMcpConnectionPort['list']>()
    .mockResolvedValueOnce({ items: [connection], nextCursor: 'next' }).mockImplementationOnce(() => pending.promise)
  const view = model(port({ list }))
  await waitFor(() => { expect(view.result.current.loading).toBe(false) })
  const operation = begin(() => view.result.current.loadMore())
  expect(view.result.current.loadingMore).toBe(true)
  await act(async () => { await view.result.current.loadMore() })
  expect(list).toHaveBeenCalledTimes(2)
  await act(async () => { pending.resolve({ items: [other] }); await operation })
  expect(view.result.current.connections).toEqual([connection, other])
})
