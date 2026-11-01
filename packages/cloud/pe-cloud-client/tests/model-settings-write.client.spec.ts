// @vitest-environment jsdom
/** The captured page sends versioned native Settings writes and contains unknown replies. */
import type { TypertClientRemote } from '@deepseek-ai/dsh-typert-protocol'
import { RemoteError } from '@deepseek-ai/dsh-typert-protocol'
import { expect, it, vi } from 'vitest'
import { createCloudModelSettingsCallbacks } from '../src/client/model-settings.ts'
import { modelSettingsDictionaries } from '../src/client/model-settings-locales.ts'

type Key = TypertClientRemote['cloudModelKey']
type Settings = Pick<TypertClientRemote['settings'], 'mutate'>
const unused = async (): Promise<never> => { throw new Error('Unexpected key operation') }
const key = { metadata: unused, describe: unused, set: unused, unset: unused } satisfies Key

it('passes the exact native revision and maps conflicts without exposing server details', async () => {
  const mutate = vi.fn<Settings['mutate']>(async () => ({ ok: false, error: new RemoteError('settings/conflict', 'PRIVATE', { ns: 'provider', expected: 9, actual: 10 }) }))
  const calls = createCloudModelSettingsCallbacks(key, { signal: new AbortController().signal, timeoutMs: 100,
    assertCurrent() {}, t: value => modelSettingsDictionaries.en[value] }, { mutate })
  const result = await calls.writeSettings!('provider', [{ op: 'set', path: ['models'], value: [{ id: 'a' }] }], 9)
  expect(result).toEqual({ kind: 'conflict', message: modelSettingsDictionaries.en.conflict })
  expect(mutate).toHaveBeenCalledExactlyOnceWith('provider', [{ op: 'set', path: ['models'], value: [{ id: 'a' }] }], 9)
  expect(JSON.stringify(result)).not.toContain('PRIVATE')
})

it('reports timeout as unknown and never resubmits a pending original write', async () => {
  const pending = Promise.withResolvers<Awaited<ReturnType<Settings['mutate']>>>()
  const mutate = vi.fn<Settings['mutate']>(() => pending.promise)
  const calls = createCloudModelSettingsCallbacks(key, { signal: new AbortController().signal, timeoutMs: 10,
    assertCurrent() {}, t: value => modelSettingsDictionaries.en[value] }, { mutate })
  const result = await calls.writeSettings!('provider', [{ op: 'set', path: ['models'], value: [] }], 3)
  expect(result).toEqual({ kind: 'unknown', message: modelSettingsDictionaries.en.unavailable })
  expect(mutate).toHaveBeenCalledOnce()
  pending.resolve({ ok: false, error: new RemoteError('settings/conflict', 'late', { ns: 'provider', expected: 3, actual: 4 }) })
  await pending.promise
  expect(mutate).toHaveBeenCalledOnce()
})
