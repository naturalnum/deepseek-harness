/** Original account Loader, checked key writes, native catalog and Gateway notifications. */
import { format } from 'node:util'
import { credentialRef } from '@deepseek-ai/dsh-credentials'
import { buildModelCatalog } from '../../../api/session-controller/src/catalog.ts'
import { expect, it, vi } from 'vitest'
import { CloudApiError } from '../src/errors.ts'
import { localeFixture } from './locale-field-fixture.ts'

it.each(['describe', 'set', 'unset'] as const)('logs the original model-key %s failure without exposing external messages', async (method) => {
  const f = await localeFixture('model-key-log-' + method, true, undefined, 'normal', true)
  const log = vi.spyOn(f.ctx.logger, 'warn').mockImplementation(() => {})
  const stderr = vi.spyOn(console, 'warn').mockImplementation(() => {})
  const submit = method === 'describe' ? vi.spyOn(f.barrier, 'describeCredentialEdit')
    : vi.spyOn(f.barrier, 'commitCredentialEdit')
  const invoke = () => method === 'describe' ? f.keyState() : method === 'set'
    ? f.writeKey(f.keyStateBefore.version, 'sk-fake-request-secret') : f.unsetKey(f.keyStateBefore.version)
  try {
    const cause = Object.assign(new Error('sk-fake-cause-secret'), { code: 'ECONNRESET' })
    const error = new CloudApiError('cloud/invalid-config', 'The approved credential provider is unavailable.')
    Object.defineProperty(error, 'cause', { value: cause })
    submit.mockRejectedValueOnce(error)
    await expect(invoke()).rejects.toMatchObject({ code: 'cloud/account-unavailable' })
    expect(stderr).toHaveBeenCalledWith('Cloud model credential operation failed: %j', expect.objectContaining({
      method, accountId: f.binding.accountId, failure: { type: 'CloudApiError', code: error.code, message: error.message },
      cause: { type: 'Error', code: 'ECONNRESET' },
    }))
    submit.mockRejectedValueOnce(Object.assign(new Error('sk-fake-provider-secret'), { code: 'EIO' }))
    await expect(invoke()).rejects.toMatchObject({ code: 'cloud/account-unavailable' })
    expect(stderr).toHaveBeenLastCalledWith('Cloud model credential operation failed: %j', expect.objectContaining({
      method, accountId: f.binding.accountId, failure: { type: 'Error', code: 'EIO' },
    }))
    expect(stderr.mock.calls).toEqual(log.mock.calls)
    expect(stderr.mock.calls.map(call => format(...call)).join('\n')).not.toContain('sk-fake-')
  } finally { submit.mockRestore(); log.mockRestore(); stderr.mockRestore() }
})

it('omits invalid model-key diagnostic tokens and retains valid boundary tokens', async () => {
  const f = await localeFixture('model-key-log-tokens', true, undefined, 'normal', true)
  const log = vi.spyOn(f.ctx.logger, 'warn').mockImplementation(() => {})
  const stderr = vi.spyOn(console, 'warn').mockImplementation(() => {})
  const submit = vi.spyOn(f.barrier, 'describeCredentialEdit')
  try {
    for (const row of [
      { code: 'EIO\nsk-fake-code', type: 'ProviderFailure', expected: { type: 'ProviderFailure' } },
      { code: 'x'.repeat(65), type: 'ProviderFailure', expected: { type: 'ProviderFailure' } },
      { code: 'EIO', type: 'Bad Type', expected: { code: 'EIO' } },
      { code: 'EIO', type: 'x'.repeat(65), expected: { code: 'EIO' } },
      { code: 'C'.repeat(64), type: 'T'.repeat(64), expected: { code: 'C'.repeat(64), type: 'T'.repeat(64) } },
    ]) {
      class ProviderFailure extends Error {}
      Object.defineProperty(ProviderFailure, 'name', { value: row.type })
      submit.mockRejectedValueOnce(Object.assign(new ProviderFailure('sk-fake-provider-secret'), { code: row.code }))
      await expect(f.keyState()).rejects.toMatchObject({ code: 'cloud/account-unavailable' })
      expect(stderr).toHaveBeenLastCalledWith('Cloud model credential operation failed: %j', {
        method: 'describe', accountId: f.binding.accountId, failure: row.expected,
      })
    }
    expect(stderr.mock.calls).toEqual(log.mock.calls)
    expect(stderr.mock.calls.map(call => format(...call)).join('\n')).not.toContain('sk-fake-')
  } finally { submit.mockRestore(); log.mockRestore(); stderr.mockRestore() }
})

it('publishes committed model-key changes only to the owning account and keeps actual native model availability current', async () => {
  const a = await localeFixture('model-events-a', true, undefined, 'normal', true)
  const b = await localeFixture('model-events-b', true, undefined, 'normal', true)
  await a.unsetKey(a.keyStateBefore.version)
  const catalog = () => buildModelCatalog(a.ctx, { provider: 'deepseek-official', model: 'synthetic' })
  expect((await catalog()).groups).toEqual([])
  const streamA = await a.openEvents(), streamB = await b.openEvents()
  await expect(streamA.next()).resolves.toMatchObject({ value: { type: 'ready' } })
  await expect(streamB.next()).resolves.toMatchObject({ value: { type: 'ready' } })
  const nextA = streamA.next()
  let aResolved = false
  void nextA.then(() => { aResolved = true })
  a.ctx.emit('credentials/reference-updated', credentialRef('UNAPPROVED_MODEL_KEY'))
  await b.writeKey(b.keyStateBefore.version, 'synthetic-b-key')
  await expect(streamB.next()).resolves.toMatchObject({ value: {
    type: 'emit', event: 'credentials/reference-updated', args: [b.ref],
  } })
  expect(aResolved).toBe(false)
  expect(a.events?.inspect().queuedEvents).toBe(0)
  expect((await catalog()).groups).toEqual([])
  await expect(a.writeKey(a.keyStateBefore.version, 'stale-must-not-save')).rejects.toMatchObject({ code: 'cloud/config-conflict' })
  expect(aResolved).toBe(false)
  expect(a.events?.inspect().queuedEvents).toBe(0)

  await a.writeKey((await a.keyState()).version, 'synthetic-a-key')
  const added = await nextA
  expect(added.value).toEqual({ type: 'emit', event: 'credentials/reference-updated', args: [a.ref] })
  expect(JSON.stringify(added.value)).not.toContain('synthetic-a-key')
  expect((await catalog()).groups).toMatchObject([{ id: 'deepseek-official', models: [{ id: 'synthetic' }] }])

  const nextRemoval = streamA.next()
  await a.unsetKey((await a.keyState()).version)
  await expect(nextRemoval).resolves.toEqual({ done: false,
    value: { type: 'emit', event: 'credentials/reference-updated', args: [a.ref] } })
  expect((await catalog()).groups).toEqual([])
  expect(a.barrier.snapshot().failures).toEqual([])
  expect(b.barrier.snapshot().failures).toEqual([])
})
