/** Private startup diagnostics preserve original failures and never serialize error payloads. */
import { mkdtempSync, mkdirSync, rmSync, writeFileSync } from 'node:fs'
import { join } from 'node:path'
import { tmpdir } from 'node:os'
import { expect, it, onTestFinished } from 'vitest'
import { initProfile } from '@deepseek-ai/dsh-app-boot'
import { brandString } from '@deepseek-ai/dsh-brand'
import { createLaunchEnvironmentSnapshot } from '@deepseek-ai/dsh-launch-environment'
import { startNativeAccountBoot, type NativeAccountBootInput } from '../src/native-boot.ts'
import { observeStartup, startupFailureObserver } from '../src/startup-observation.ts'
import type { AccountBinding } from '../src/types.ts'

it('records one bounded approved failure without reading getters or exposing error payloads', () => {
  const secret = 'STARTUP_SECRET_CANARY_/private/credential.yaml', records: string[] = []
  let getterReads = 0
  const fourth = { code: secret, name: secret }
  const third = { code: 'ENOENT', name: 'Error', cause: fourth, message: secret, stack: secret }
  const second = Object.defineProperties({}, {
    code: { value: 'cloud/account-unavailable' }, cause: { value: third },
    name: { get() { getterReads++; throw new Error(secret) } },
  })
  const failure = { code: secret, name: secret, message: secret, stack: secret, cause: second }
  const observer = startupFailureObserver(['include', 'model-key'], (record) => { records.push(record) })
  observeStartup(observer, { phase: 'audit-provider' })
  observeStartup(observer, { failure, requiredEntryId: 'include:model-key' })
  observeStartup(observer, { phase: 'ready' })
  observeStartup(observer, { failure: new Error(secret), requiredEntryId: secret })
  expect(records).toHaveLength(1)
  expect(Buffer.byteLength(records[0]!, 'utf8')).toBeLessThanOrEqual(512)
  expect(records[0]).not.toContain(secret)
  expect(JSON.parse(records[0]!)).toEqual({ kind: 'cloud/startup-failure', phase: 'audit-provider', requiredEntryId: 'model-key',
    causes: [{ code: 'unknown', name: 'unknown' }, { code: 'cloud/account-unavailable', name: 'unknown' },
      { code: 'ENOENT', name: 'Error' }] })
  expect(getterReads).toBe(0)
})

it('omits unapproved entry ids and contains a failing private sink without retry', () => {
  const records: string[] = []
  const observer = startupFailureObserver(['include'], (record) => { records.push(record) })
  observeStartup(observer, { phase: 'storage-before-read' })
  observeStartup(observer, { failure: new Error('secret-message'), requiredEntryId: '/private/not-approved' })
  expect(JSON.parse(records[0]!)).not.toHaveProperty('requiredEntryId')
  let calls = 0
  const broken = startupFailureObserver(['include'], () => { calls++; throw new Error('diagnostic failure') })
  expect(() => { observeStartup(broken, { failure: new Error('original') }) }).not.toThrow()
  observeStartup(broken, { failure: new Error('later') })
  expect(calls).toBe(1)
})

it('reports observer expiry as its current phase without claiming failure or emitting again', () => {
  const records: string[] = []
  const observer = startupFailureObserver(['include'], (record) => { records.push(record) })
  observeStartup(observer, { phase: 'storage-prepare' })
  observeStartup(observer, { expired: true })
  observeStartup(observer, { phase: 'nativeboot' })
  observeStartup(observer, { failure: new Error('later actual failure') })
  expect(records).toHaveLength(1)
  expect(JSON.parse(records[0]!)).toEqual({ kind: 'observation-expired', phase: 'storage-prepare', causes: [] })
  const completed = startupFailureObserver(['include'], (record) => { records.push(record) })
  observeStartup(completed, { settled: true })
  observeStartup(completed, { expired: true })
  expect(records).toHaveLength(1)
  const nativeRecords: string[] = []
  const native = startupFailureObserver(['include'], (record) => { nativeRecords.push(record) })
  observeStartup(native, { phase: 'nativeboot' })
  observeStartup(native, { nativeError: new Error('nonfatal-secret-message') })
  observeStartup(native, { failure: new Error('later fatal failure') })
  expect(nativeRecords).toHaveLength(1)
  expect(JSON.parse(nativeRecords[0]!)).toEqual({ kind: 'native-error-event', phase: 'nativeboot',
    causes: [{ code: 'unknown', name: 'unknown' }] })
})

function nativeInput(): NativeAccountBootInput {
  const directory = mkdtempSync(join(tmpdir(), 'pe-startup-observation-'))
  onTestFinished(() => { rmSync(directory, { recursive: true, force: true }) })
  const dir = join(directory, 'profile'); mkdirSync(dir, { recursive: true }); initProfile(dir, [])
  const configPath = join(directory, 'account.yml'); writeFileSync(configPath, '[]\n')
  const anchor = join(directory, 'package.json'); writeFileSync(anchor, '{"name":"startup-observation-fixture"}\n')
  return {
    binding: Object.freeze({ accountId: brandString<AccountBinding['accountId']>('startup-observation'),
      epoch: brandString<AccountBinding['epoch']>('1'), recipeVersion: 'startup-observation', lifetime: new AbortController().signal }),
    profile: { name: 'startup-observation', dir, patchPath: join(dir, 'cordis.patch.yml'), installAnchor: anchor,
      cwd: directory, home: directory, startedBundles: [], overlays: [], telemetryDisabledEnv: undefined },
    configPath, bareModuleBaseUrl: new URL('../../../../package.json', import.meta.url).href,
    environment: createLaunchEnvironmentSnapshot([]), requiredEntryIds: ['include'], maxObservedEvents: 4,
    prepare() {},
  }
}

it('preserves an original prepare failure when every diagnostic callback throws', async () => {
  const failure = new Error('ORIGINAL_SECRET_PREPARE_FAILURE')
  const handle = startNativeAccountBoot({ ...nativeInput(),
    observeStartup() { throw new Error('DIAGNOSTIC_SECRET_FAILURE') }, prepare() { throw failure } })
  onTestFinished(async () => { await handle.dispose() })
  const outcome = await handle.result
  expect(outcome.status).toBe('failed')
  if (outcome.status !== 'failed' || !(outcome.cause instanceof Error)) throw new Error('Original native failure was lost')
  expect(outcome.cause.cause).toBe(failure)
})

it('preserves a synchronous storage-read failure before constructing the native graph', () => {
  const failure = new Error('ORIGINAL_SECRET_STORAGE_FAILURE')
  const input = { ...nativeInput(), assertBeforeNativeRead() { throw failure },
    observeStartup() { throw new Error('DIAGNOSTIC_SECRET_FAILURE') } }
  let caught: unknown
  try { startNativeAccountBoot(input) } catch (cause) { caught = cause }
  expect(caught).toBe(failure)
})
