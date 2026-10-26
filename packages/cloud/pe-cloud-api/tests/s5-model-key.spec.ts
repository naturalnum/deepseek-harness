import { MODEL_KEY_FIXTURE as APPROVED_MODEL_KEY, modelKeyBinding } from './model-key-policy-data.ts'
/** Component-only native transport composition; production Root AccountUse/browser/adapter acceptance stays pending. */
import { mkdirSync, mkdtempSync, readFileSync, realpathSync, rmSync, writeFileSync } from 'node:fs'
import { join } from 'node:path'
import { tmpdir } from 'node:os'
import { expect, it, onTestFinished } from 'vitest'
import { type Context } from '@deepseek-ai/cordis'
import { boot, initProfile, type ProfileContext } from '@deepseek-ai/dsh-app-boot'
import { brandString } from '@deepseek-ai/dsh-brand'
import { credentialRef } from '@deepseek-ai/dsh-credentials'
import { createLaunchEnvironmentSnapshot, DSH_LAUNCH_ENVIRONMENT_KEY } from '@deepseek-ai/dsh-launch-environment'
import type { AccountBinding, AccountUse } from '@deepseek-ai/dsh-pe-cloud-runtime/types'
import Gateway from '@deepseek-ai/dsh-api-gateway'
import RemoteAccess from '@deepseek-ai/dsh-api-remote-access'
import TypertRegistry from '@deepseek-ai/dsh-typert-registry'
import { Remote, remoteMethods, TypertRemoteService, type InvocationDescriptor, type PeerScope } from '@deepseek-ai/dsh-typert-protocol'
import { CloudAccountApi } from '../src/account-service.ts'
import { ConfigSaveCoordinator } from '../src/config-saves.ts'
import { ExposurePolicy } from '../src/exposure.ts'
import { CloudApiError } from '../src/errors.ts'
import { AccountModelKeyEnvironment, type ModelKeyAccess } from '../src/model-key.ts'
import { modelKeyCodecs } from '../src/model-key-json.ts'

const REF = APPROVED_MODEL_KEY.ref
const LIMITS = { bindings: [modelKeyBinding('provider')], maxMetadataBytes: 65536, maxKeyBytes: 64, maxVersionBytes: 128, maxReplyBytes: 4096 }
const METHODS = ['describe', 'set', 'unset'] as const

declare module '@deepseek-ai/cordis' { interface Context { s5ModelKey: FixtureKeyRemote } }

/** Only this fixture registers a Remote handler; the production candidate registers none. */
class FixtureKeyRemote extends TypertRemoteService {
  constructor(ctx: Context, private readonly access: () => ModelKeyAccess) {
    super(ctx, 's5ModelKey', { namespace: 'cloudModelKey' })
  }
  @Remote('describe') describe(request: unknown) { return this.access().describe(request) }
  @Remote('set') set(request: unknown) { return this.access().set(request) }
  @Remote('unset') unset(request: unknown) { return this.access().unset(request) }
}

function fixtureInvocations(policy = LIMITS): InvocationDescriptor[] {
  const codecs = modelKeyCodecs(policy, policy.bindings.map(binding => binding.ref))
  return METHODS.map(method => ({ id: 's5-fixture/' + method, service: 's5ModelKey', namespace: 'cloudModelKey', method,
    invocation: { kind: 'direct' }, parameters: [{ name: 'request', wire: 'request', source: 'json', codec: codecs[method] }],
    result: method === 'describe' ? codecs.state : codecs.saved }))
}

async function fixture(name = 'a', masked = true, exposed = true, refs = [REF], maskRefs = refs) {
  const policy = { ...LIMITS, bindings: refs.map((ref, index) => ({
    ...modelKeyBinding('fixture-' + String(index), ref), provider: 'fixture-' + String(index),
  })) }
  const dir = realpathSync(mkdtempSync(join(tmpdir(), 'key-scratch-')))
  const profileDir = join(dir, 'profiles', 'component')
  mkdirSync(profileDir, { recursive: true })
  initProfile(profileDir, [])
  writeFileSync(join(dir, 'package.json'), '{"name":"s5-model-key-component"}\n')
  const credentialPath = join(dir, 'synthetic-credentials.yaml')
  writeFileSync(credentialPath, 'version: 1\nrefs: {}\n', { mode: 0o600 })
  const configPath = join(profileDir, 'cordis.yml')
  writeFileSync(configPath, JSON.stringify([
    { id: 'typert', name: 'cordis:key-typert' }, { id: 'access', name: 'cordis:key-access' },
    { id: 'gateway', name: 'cordis:key-gateway' }, { id: 'editor', name: 'cordis:key-editor' },
    { id: 'credentials', name: 'cordis:key-credentials', config: { path: credentialPath, watch: false } },
    { id: 'test-remotes', name: 'cordis:key-fixture-remotes' },
  ]))
  const saves = new ConfigSaveCoordinator({ maxAccounts: 1, maxRunning: 1, maxQueued: 4, maxQueuedPerAccount: 4,
    maxTrackedOperations: 8, maxTrackedOperationsPerAccount: 8, maxNestedPerOperation: 3, maxWaitersPerAccount: 2 })
  const endpoints = METHODS.map(method => ({ endpoint: 'cloudModelKey/' + method,
    handlerId: 'native:s5ModelKey', guard: 'authenticated-account' as const }))
  const root = new ExposurePolicy({ recipeVersion: 's5-key-component', rpcEndpoints: exposed ? endpoints : [],
    streamEndpoints: [], exactFetchRoutes: [], allowedSettings: [] })
  const lifetime = new AbortController()
  const binding: AccountBinding = Object.freeze({ accountId: brandString<AccountBinding['accountId']>(name),
    epoch: brandString<AccountBinding['epoch']>('1'), recipeVersion: root.manifest.recipeVersion, lifetime: lifetime.signal })
  const profile: ProfileContext = { name: 'component', dir: profileDir, patchPath: join(profileDir, 'cordis.patch.yml'),
    installAnchor: join(dir, 'package.json'), cwd: dir, home: dir, startedBundles: [], overlays: [], telemetryDisabledEnv: undefined }
  const environment = createLaunchEnvironmentSnapshot([
    { source: 'process', values: Object.fromEntries(refs.map(ref => [ref, 'synthetic-host-key'])) },
    { source: 'project-env', values: Object.fromEntries(refs.map(ref => [ref, 'synthetic-project-key'])) },
    { source: 'user-env', values: Object.fromEntries(refs.map(ref => [ref, 'synthetic-user-key'])) },
  ])
  let current = true, business = true
  let api: CloudAccountApi | undefined, use: AccountUse | undefined
  let barrier: ReturnType<ConfigSaveCoordinator['createAccount']> | undefined
  const ctx = await boot('s5-key-component', configPath, [], (owner) => {
    owner.provide('profileContext', profile)
    owner.provide('peAccount', binding)
    owner.provide(DSH_LAUNCH_ENVIRONMENT_KEY, masked ? new AccountModelKeyEnvironment(environment, maskRefs) : environment)
    barrier = saves.createAccount(binding, { references: refs, maxReferences: refs.length, maxReferenceBytes: 64 })
    api = new CloudAccountApi(owner, { binding, rootExposure: root, selected: root.manifest, saves: barrier,
      assertMountCurrent: (actual) => { expect(actual).toBe(binding); lifetime.signal.throwIfAborted() },
      assertBusinessCurrent: () => { if (!business) throw new CloudApiError('cloud/account-unavailable', 'Synthetic business closed') } })
    // A component borrow exercises the real checks; it is not Root's accepted production AccountUse.
    use = { binding, context: owner, assertCurrent() {
      if (!current) throw new CloudApiError('cloud/stale-generation', 'Synthetic borrow closed')
      lifetime.signal.throwIfAborted()
    }, release() { current = false } }
    const actualApi = api, actualUse = use
    Object.assign(owner.loader.builtins, { 'key-editor': api.providers.configEditor, 'key-credentials': api.providers.credentials,
      'key-typert': TypertRegistry, 'key-access': RemoteAccess, 'key-gateway': Gateway,
      'key-fixture-remotes': { inject: ['typert'], apply(scope: Context) {
        new FixtureKeyRemote(scope, () => actualApi.modelKeyAccess(actualUse, policy))
        scope.typert.register({ package: 's5-fixture-model-key', face: 'host', schemas: [],
          model: { services: [], events: [], objects: [] }, invocations: fixtureInvocations(policy) })
      } } })
  })
  if (api === undefined || use === undefined || barrier === undefined) throw new Error('Component assembly did not run')
  const owner = api, borrow = use, saveBarrier = barrier
  const installed = ctx.s5ModelKey
  expect(remoteMethods(installed).map(row => row.method).sort()).toEqual([...METHODS].sort())
  for (const method of METHODS) expect(ctx.typert.local.get('cloudModelKey/' + method)?.service).toBe('s5ModelKey')
  if (exposed) owner.audit({ recipeVersion: binding.recipeVersion, rpcEndpoints: endpoints, streamEndpoints: [], exactFetchRoutes: [] })
  const abort = new AbortController()
  const peer: PeerScope = { id: brandString<PeerScope['id']>('s5-fixture-peer'), ctx,
    principal: { kind: 'owner' }, interactions: 'answer', signal: abort.signal, dispose: () => Promise.resolve() }
  const call = (method: typeof METHODS[number], request: unknown) => ctx.typertGateway.invoke({ namespace: 'cloudModelKey',
    method, args: { request }, peer })
  onTestFinished(async () => {
    try {
      const receipt = await saveBarrier.stopConfigSaves(Date.now() + 1000)
      if (receipt.status === 'confirmed') { await owner.withdraw(); saves.releaseAccount(saveBarrier); saves.close() }
      const registry = ctx.typert
      await ctx.fiber.dispose()
      expect(registry.local.get('cloudModelKey/set')).toBeUndefined()
    } finally { rmSync(dir, { recursive: true, force: true }) }
  })
  return { ctx, api: owner, use: borrow, barrier: saveBarrier, saves, credentialPath, call,
    access: () => owner.modelKeyAccess(borrow, policy), revoke: () => { current = false },
    closeBusiness: () => { business = false } }
}

it('uses public native codec registration and redacted read/set/unset while synthetic ambient keys stay masked', async () => {
  const f = await fixture()
  const before = await f.access().describe({ ref: REF })
  expect(before).toMatchObject({ configured: false, writable: true })
  const saved = await f.call('set', { ref: REF, value: 'synthetic-account-key', version: before.version })
  expect(saved).toEqual(expect.objectContaining({ persisted: true }))
  const after = await f.access().describe({ ref: REF })
  expect(after).toMatchObject({ configured: true, source: 'file' })
  expect(after.version.editToken).not.toBe(before.version.editToken)
  expect((await f.ctx.credentials.resolve(REF))?.value === 'synthetic-account-key').toBe(true)
  const removed = await f.call('unset', { ref: REF, version: after.version })
  expect(JSON.stringify([before, saved, after, removed])).not.toContain('synthetic-')
  expect((await f.access().describe({ ref: REF })).configured).toBe(false)
  expect(await f.ctx.credentials.resolve(REF)).toBeUndefined()
  expect(f.barrier.snapshot().failures).toHaveLength(0)
})

it('rejects unknown refs, identity/path/plaintext fields and malformed versions through real native Gateway codecs', async () => {
  const f = await fixture(), view = await f.access().describe({ ref: REF })
  const before = readFileSync(f.credentialPath, 'utf8')
  for (const request of [null, [], { ref: 'OTHER' }, { ref: REF, accountId: 'b' }, { ref: REF, path: '/private' },
    { ref: REF, value: 'synthetic-secret' }, { ref: REF, plaintext: true }]) {
    await expect(f.call('describe', request)).rejects.toMatchObject({ code: 'gateway/input-invalid' })
  }
  for (const request of [{ ref: REF, value: 'synthetic-secret' }, { ref: REF, value: '', version: view.version },
    { ref: REF, value: 'synthetic-secret', version: { ...view.version, accountId: 'a' } },
    { ref: REF, value: '界'.repeat(22), version: view.version }]) {
    await expect(f.call('set', request)).rejects.toMatchObject({ code: 'gateway/input-invalid' })
  }
  expect(readFileSync(f.credentialPath, 'utf8')).toBe(before)
  expect(f.saves.snapshot().tracked).toBe(0)
  expect(f.barrier.snapshot().failures).toHaveLength(0)
})

it('accepts an exact UTF-8 input limit and rejects one excess byte before native submission', async () => {
  const f = await fixture(), view = await f.access().describe({ ref: REF })
  const exact = '界'.repeat(21) + 'a'
  await expect(f.call('set', { ref: REF, value: exact, version: view.version })).resolves.toMatchObject({ persisted: true })
  const after = await f.access().describe({ ref: REF })
  await expect(f.call('set', { ref: REF, value: exact + 'b', version: after.version }))
    .rejects.toMatchObject({ code: 'gateway/input-invalid' })
  expect((await f.ctx.credentials.resolve(REF))?.value === exact).toBe(true)
})

it('keeps unaudited exposure and missing approved environment closed before reading or writing', async () => {
  const closed = await fixture('closed', true, false), missing = await fixture('missing', false)
  for (const f of [closed, missing]) {
    const before = readFileSync(f.credentialPath, 'utf8')
    await expect(f.access().describe({ ref: REF })).rejects.toBeInstanceOf(CloudApiError)
    await expect(f.access().set({ ref: REF, value: 'synthetic-key', version: { epoch: '1', editToken: 'unissued' } }))
      .rejects.toBeInstanceOf(CloudApiError)
    expect(readFileSync(f.credentialPath, 'utf8')).toBe(before)
    expect(f.saves.snapshot().tracked).toBe(0)
    expect(f.barrier.snapshot().failures).toHaveLength(0)
  }
})

it('rejects cross-account and stale-tab versions with one native write and no failed save receipt', async () => {
  const a = await fixture('a'), b = await fixture('b')
  const view = await a.access().describe({ ref: REF })
  await expect(b.access().set({ ref: REF, value: 'synthetic-cross', version: view.version }))
    .rejects.toMatchObject({ code: 'cloud/config-conflict' })
  await expect(a.api.modelKeyAccess(b.use, LIMITS).describe({ ref: REF })).rejects.toMatchObject({ code: 'cloud/stale-generation' })
  const results = await Promise.allSettled([
    a.access().set({ ref: REF, value: 'synthetic-first', version: view.version }),
    a.access().set({ ref: REF, value: 'synthetic-stale', version: view.version }),
  ])
  expect(results.map(result => result.status)).toEqual(['fulfilled', 'rejected'])
  expect((await a.ctx.credentials.resolve(REF))?.value === 'synthetic-first').toBe(true)
  expect(await b.ctx.credentials.resolve(REF)).toBeUndefined()
  expect(a.barrier.snapshot().failures).toHaveLength(0)
  expect(b.barrier.snapshot().failures).toHaveLength(0)
})

for (const close of ['borrow', 'business', 'exposure'] as const) {
  it('rechecks ' + close + ' inside the original queued save turn and retains no failure for zero-write refusal', async () => {
    const f = await fixture(), view = await f.access().describe({ ref: REF })
    const wait = Promise.withResolvers<undefined>(), entered = Promise.withResolvers<undefined>()
    onTestFinished(() => { wait.resolve(undefined) })
    const held = f.barrier.admit('settings', async () => { entered.resolve(undefined); await wait.promise })
    await entered.promise
    const before = readFileSync(f.credentialPath, 'utf8')
    const request = f.access().set({ ref: REF, value: 'synthetic-no-late-write', version: view.version })
    const observed = Promise.allSettled([request])
    expect(f.saves.snapshot().queued).toBe(1)
    if (close === 'borrow') f.revoke()
    else if (close === 'business') f.closeBusiness()
    else f.api.invalidate()
    wait.resolve(undefined)
    await held
    const [result] = await observed
    expect(result?.status).toBe('rejected')
    expect(readFileSync(f.credentialPath, 'utf8')).toBe(before)
    expect(f.barrier.snapshot().failures).toHaveLength(0)
    expect(f.saves.snapshot().tracked).toBe(0)
  })
}

it('blocks direct native writes for the approved ref and rejects result extras and invalid mutation inputs without secret diagnostics', async () => {
  const f = await fixture()
  await expect(f.ctx.credentials.set(REF, 'synthetic-bypass')).rejects.toMatchObject({ code: 'cloud/config-conflict' })
  await expect(f.ctx.credentials.unset(REF)).rejects.toMatchObject({ code: 'cloud/config-conflict' })
  const codecs = modelKeyCodecs(LIMITS, [REF]), view = await f.access().describe({ ref: REF })
  for (const field of ['value', 'path', 'cause', 'accountId']) {
    expect(() => codecs.state.create().parse({ ...view, [field]: 'synthetic-leak' })).toThrow(CloudApiError)
  }
  await expect(f.access().set({ ref: REF, value: 'synthetic-hidden', version: {} })).rejects.toSatisfy((error: unknown) =>
    error instanceof CloudApiError && !JSON.stringify(error).includes('synthetic-hidden') && error.cause === undefined)
  expect(() => f.api.modelKeyAccess(f.use, { ...LIMITS, maxReplyBytes: 1 })).toThrow(CloudApiError)
  expect(await f.ctx.credentials.resolve(REF)).toBeUndefined()
  expect(f.barrier.snapshot().failures).toHaveLength(0)
})

it('masks the approved name without consulting any ambient layer and delegates unrelated names', () => {
  const names: string[] = []
  const environment = new AccountModelKeyEnvironment({ get(name) { names.push(name); return undefined },
    getFrom(name, _sources) { names.push(name); return undefined } }, [REF])
  expect(environment.get(REF)).toBeUndefined()
  expect(environment.getFrom('deepseek_api_key', ['process', 'project-env', 'user-env'])).toBeUndefined()
  expect(names).toEqual([])
  environment.get('S5_PUBLIC_SETTING')
  expect(names).toEqual(['S5_PUBLIC_SETTING'])
  expect(APPROVED_MODEL_KEY.ref).toBe(credentialRef('DEEPSEEK_API_KEY'))
})

it('maps a real native file failure to a fixed response while the original owner retains unknown responsibility', async () => {
  const f = await fixture(), view = await f.access().describe({ ref: REF })
  rmSync(f.credentialPath)
  mkdirSync(f.credentialPath)
  const error: unknown = await f.call('set', { ref: REF, value: 'synthetic-private-value', version: view.version })
    .catch((failure: unknown) => failure)
  expect(error).toBeInstanceOf(CloudApiError)
  if (!(error instanceof CloudApiError)) throw new Error('Expected a controlled component failure')
  expect(error.code).toBe('cloud/account-unavailable')
  expect(error.message).not.toContain('synthetic-private-value')
  expect(error.message).not.toContain(f.credentialPath)
  expect(error.cause).toBeUndefined()
  expect(error.details).toEqual({})
  expect(f.barrier.snapshot().failures[0]?.outcome).toBe('unknown')
  expect(JSON.stringify(f.barrier.snapshot())).not.toContain('synthetic-private-value')
  expect((await f.barrier.stopConfigSaves(Date.now() + 1000)).status).toBe('unknown')
})

it('uses the same native codec, controlled writer and account environment for two explicitly declared custom refs', async () => {
  const refs = [credentialRef('TRIAL_DEEPSEEK_KEY'), credentialRef('SECOND_DECLARED_KEY')]
  const f = await fixture('custom-refs', true, true, refs)
  for (const ref of refs) {
    const view = await f.access().describe({ ref })
    expect(view.configured).toBe(false)
    await f.call('set', { ref, value: 'synthetic-' + ref, version: view.version })
    expect((await f.ctx.credentials.resolve(ref))?.value).toBe('synthetic-' + ref)
    const current = await f.access().describe({ ref })
    await f.call('unset', { ref, version: current.version })
    expect(await f.ctx.credentials.resolve(ref)).toBeUndefined()
  }
  await expect(f.call('describe', { ref: REF })).rejects.toMatchObject({ code: 'gateway/input-invalid' })
  expect(f.barrier.snapshot().failures).toEqual([])
})

it('refuses a mismatched approved environment mask before reading or writing the original credentials', async () => {
  const refs = [credentialRef('TRIAL_DEEPSEEK_KEY'), credentialRef('SECOND_DECLARED_KEY')]
  const f = await fixture('incomplete-mask', true, true, refs, refs.slice(0, 1))
  const before = readFileSync(f.credentialPath, 'utf8')
  await expect(f.access().describe({ ref: refs[1] })).rejects.toMatchObject({ code: 'cloud/account-unavailable' })
  expect(readFileSync(f.credentialPath, 'utf8')).toBe(before)
  expect(f.saves.snapshot().tracked).toBe(0)
})
