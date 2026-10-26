/** Real Loader/Registry/API/Files services; empty storage fixture grants no native content or business readiness. */
import { mkdtempSync, mkdirSync, writeFileSync, rmSync, symlinkSync, statSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { fileURLToPath } from 'node:url'
import { symbols, type Context, type Fiber } from '@deepseek-ai/cordis'
import { boot, initProfile } from '@deepseek-ai/dsh-app-boot'
import { brandString } from '@deepseek-ai/dsh-brand'
import TypertRegistry from '@deepseek-ai/dsh-typert-registry'
import * as TypertLoader from '@deepseek-ai/dsh-typert-loader'
import { remoteMethods } from '@deepseek-ai/dsh-typert-protocol'
import SkillRegistry from '@deepseek-ai/dsh-skill'
import { CloudAccountFiles, type AccountFilesPreparation, type SkillBundlePort, type SkillVersionPort } from '@deepseek-ai/dsh-pe-cloud-files'
import type { AccountBinding } from '@deepseek-ai/dsh-pe-cloud-runtime/types'
import WorkspaceRegistry from '@deepseek-ai/dsh-workspace'
import { expect, it, onTestFinished } from 'vitest'
import { CloudAccountApi } from '../src/account-service.ts'
import { CloudSkillService } from '../src/cloud-skills.ts'
import { ConfigSaveCoordinator } from '../src/config-saves.ts'
import { ExposurePolicy } from '../src/exposure.ts'
import type { ConfigSaveBarrier } from '../src/save-hooks.ts'

/** Metadata constructor shape only; this fixture never installs or activates a Workspace. */
class UnusedWorkspaceRegistry extends WorkspaceRegistry {
  createProject(): Promise<never> { return Promise.reject(new Error('No Workspace activation in this fixture')) }
  createAdmittedProject(): Promise<never> { return Promise.reject(new Error('No Workspace activation in this fixture')) }
  createS2Project(): Promise<never> { return Promise.reject(new Error('No Workspace activation in this fixture')) }
}

function original(value: object): object {
  const target: unknown = Reflect.get(value, symbols.original)
  return target !== null && typeof target === 'object' ? target : value
}

function providerSignal(service: CloudSkillService): AbortSignal {
  const publication: unknown = Reflect.get(service, 'publication')
  if (publication === null || typeof publication !== 'object') throw new Error('Publication absent')
  const control: unknown = Reflect.get(publication, 'control')
  if (control === null || typeof control !== 'object') throw new Error('Provider control absent')
  const signal: unknown = Reflect.get(control, 'signal')
  if (!(signal instanceof AbortSignal)) throw new Error('Provider signal absent')
  return signal
}

async function fixture(scopedFiles = false) {
  const home = mkdtempSync(join(tmpdir(), 'cloud-skills-identity-')), profileDir = join(home, 'profiles', 'test')
  mkdirSync(profileDir, { recursive: true }); initProfile(profileDir, [])
  writeFileSync(join(home, 'package.json'), JSON.stringify({
    name: 'cloud-skills-identity-fixture', dependencies: { '@deepseek-ai/dsh-pe-cloud-api': '0.2.1-rc.2' },
  }))
  mkdirSync(join(home, 'node_modules', '@deepseek-ai'), { recursive: true })
  // Only package artifact discovery uses this link; service code is the candidate Source through the original test aliases.
  symlinkSync(fileURLToPath(new URL('..', import.meta.url)), join(home, 'node_modules', '@deepseek-ai', 'dsh-pe-cloud-api'), 'dir')
  const config = join(profileDir, 'cordis.yml')
  writeFileSync(config, JSON.stringify([
    { id: 'typert', name: 'cordis:identity-typert' },
    { id: 'typert-loader', name: 'cordis:identity-typert-loader', config: { packages: ['@deepseek-ai/dsh-pe-cloud-api'] } },
    { id: 'skills', name: 'cordis:identity-registry' },
    { id: 'capability', name: 'cordis:identity-capability' },
  ]))
  const lifetime = new AbortController()
  const binding: AccountBinding = Object.freeze({
    accountId: brandString<AccountBinding['accountId']>('registry-component'),
    epoch: brandString<AccountBinding['epoch']>('1'), recipeVersion: 'registry-component', lifetime: lifetime.signal,
  })
  const policy = new ExposurePolicy({ recipeVersion: binding.recipeVersion, rpcEndpoints: [], streamEndpoints: [],
    exactFetchRoutes: [], allowedSettings: [] })
  const saves = new ConfigSaveCoordinator({ maxAccounts: 1, maxRunning: 1, maxQueued: 4, maxQueuedPerAccount: 4,
    maxTrackedOperations: 8, maxTrackedOperationsPerAccount: 8, maxNestedPerOperation: 2, maxWaitersPerAccount: 2 })
  let ctx: Context | undefined, api: CloudAccountApi | undefined, files: CloudAccountFiles | undefined
  let raw: CloudSkillService | undefined, barrier: ConfigSaveBarrier | undefined
  let registryFiber: Fiber | undefined, capabilityFiber: Fiber | undefined, typertFiber: Fiber | undefined
  let currentReads = 0
  const deny = (): never => { throw new Error('No native storage, publication or Peer operation in this fixture') }
  const bundles: SkillBundlePort = {
    prepareBundle: deny, commitCatalog: deny, withBundleSource: deny, exportBundle: deny, materializeBundleVersion: deny,
    observeCatalog(signal) {
      signal.throwIfAborted(); currentReads++; return Promise.resolve({ value:{ entries:[],revision:null },release(){} })
    },
  }
  const port: SkillVersionPort & { bundles: SkillBundlePort } = { bundles,
    prepare: deny, commit: deny, withSource: deny,
    current(signal) { signal.throwIfAborted(); currentReads++; return Promise.resolve({ value: undefined, release() {} }) },
  }
  onTestFinished(async () => {
    try {
      if (api !== undefined && barrier !== undefined) {
        await api.stopConfigSaves(Date.now() + 1000); await api.withdraw(); saves.releaseAccount(barrier)
      }
      await ctx?.fiber.dispose(); saves.close()
    } finally { rmSync(home, { recursive: true, force: true }) }
  })
  const root = await boot('cloud-skills-identity-fixture', config, [], (owner) => {
    ctx = owner
    owner.provide('profileContext', { name: 'test', dir: profileDir, patchPath: join(profileDir, 'cordis.patch.yml'),
      installAnchor: join(home, 'package.json'), cwd: home, home, startedBundles: [], overlays: [], telemetryDisabledEnv: undefined })
    owner.provide('peAccount', binding)
    const current = (actual: AccountBinding): void => {
      if (actual !== binding) throw new Error('Foreign fixture binding')
      lifetime.signal.throwIfAborted()
    }
    barrier = saves.createAccount(binding)
    api = new CloudAccountApi(owner, { binding, rootExposure: policy, selected: policy.manifest, saves: barrier,
      assertMountCurrent: current, assertBusinessCurrent: deny })
    const info = statSync(home, { bigint: true })
    // Unused metadata-only preparation grant; no Linux confinement or native installation is asserted here.
    const grant: AccountFilesPreparation['defaultGrant'] = { binding, backend: 'root-owned-isolated-linux-tmpfs', leaf: 'default-workspace',
      parent: { rootPath: home, rootDevice: String(info.dev), rootInode: String(info.ino) }, assertExclusive: () => { current(binding) } }
    files = new CloudAccountFiles(owner, { binding, defaultGrant: grant, skillVersions: () => port,
      assertMountCurrent: current, assertUnpublished: () => { current(binding) },
      port: { createWorkspaceRegistry: () => UnusedWorkspaceRegistry } })
    const preparedApi = api, preparedFiles = files
    Object.assign(owner.loader.builtins, {
      'identity-typert': TypertRegistry,
      'identity-typert-loader': { inject: TypertLoader.inject, Config: TypertLoader.Config,
        async apply(scope: Context, config: TypertLoader.Config) { typertFiber = scope.fiber; await TypertLoader.apply(scope, config) } },
      'identity-registry': { apply(scope: Context) { registryFiber = scope.fiber; new SkillRegistry(scope) } },
      'identity-capability': { inject: ['typert'], apply(scope: Context) {
        capabilityFiber = scope.fiber
        raw = preparedApi.prepareCloudSkills(scope, { files: scopedFiles ? scope.peCloudFiles : preparedFiles,
          limits: { maxFileBytes: 4096, maxRequestBytes: 16384, maxReplyBytes: 4096, maxRetainedVersions: 4 },
          managed: { limits: { maxRequestBytes: 65536, maxReplyBytes: 131072, maxMetadataBytes: 4096, maxRetainedProviders: 8 },
            bundleLimits: { maxInstallations: 4, maxFiles: 8, maxDirectories: 6, maxDepth: 5, maxPathBytes: 256,
              maxFileBytes: 4096, maxContentBytes: 16384, maxArchiveBytes: 32768, maxArchiveEntries: 16,
              maxExpandedArchiveBytes: 16384, maxInputBytes: 65536, maxManifestBytes: 8192,
              maxCatalogBytes: 8192, maxDownloadBytes: 32768, maxRequestBytes: 65536, maxReplyBytes: 131072,
              maxStagingBytes: 65536, reservationBytes: 65536 }, assertWorkspace: deny },
          withModelKeyPeerUse: deny })
      } },
    })
  })
  if (raw === undefined || files === undefined || registryFiber === undefined
    || capabilityFiber === undefined || typertFiber === undefined) throw new Error('Original fixture graph absent')
  return { ctx: root, raw, files, registryFiber, capabilityFiber, typertFiber, get currentReads() { return currentReads } }
}

it.each([false, true])('keeps raw and contextual calls live with scoped files=%s and real strict Typert registration', async (scopedFiles) => {
  const f = await fixture(scopedFiles), proxy = f.ctx.cloudSkills
  expect(proxy).not.toBe(f.raw)
  expect(original(proxy)).toBe(f.raw)
  for (const service of [f.raw, proxy]) {
    expect(() => { service.assertCurrent() }).not.toThrow()
    expect(service.inspect().rpcEndpoints.map(row => row.endpoint)).toEqual(['current','publish','installed','details','install','update','uninstall','download'].map(method => 'cloudSkills/'+method))
    await expect(service.restore()).resolves.toBeUndefined()
  }
  expect(f.currentReads).toBe(2)
  const captured: unknown = Reflect.get(f.raw, 'registry')
  expect(captured).toBe(original(f.ctx.skills))
  expect(remoteMethods(proxy).map(row => row.method)).toEqual(['current','publish','installed','details','install','update','uninstall','download'])
  expect(proxy.typertRemote.service).toBe(f.raw)
  for (const method of ['current','publish','installed','details','install','update','uninstall','download']) {
    const descriptor = f.ctx.typert.local.get(`cloudSkills/${method}`)
    if (descriptor === undefined) throw new Error('Original Typert registration absent')
    expect(descriptor).toMatchObject({ service: 'cloudSkills', namespace: 'cloudSkills', method,
      invocation: { kind: 'direct' }, cancellation: { parameter: 'signal' }, result: { mode: 'strict' } })
    expect(descriptor.parameters[0]).toMatchObject({ wire: 'request', source: 'json', codec: { mode: 'strict' } })
  }
  const heldFiles: unknown = Reflect.get(proxy, 'files')
  if (!(heldFiles instanceof CloudAccountFiles)) throw new Error('Original files service absent')
  expect(() => { heldFiles.assertInstalled(f.ctx) }).not.toThrow()
  expect(heldFiles.binding).toBe(f.files.binding)
  if (scopedFiles) expect(original(heldFiles)).not.toBe(f.files)
  else expect(original(heldFiles)).toBe(f.files)
  expect(original(original(heldFiles))).toBe(f.files)
})

it.each(['withdraw', 'replace'] as const)('rejects the captured real Registry after %s without any pointer read', async (action) => {
  const f = await fixture(), proxy = f.ctx.cloudSkills
  const signal = providerSignal(f.raw)
  expect(signal.aborted).toBe(false)
  await f.registryFiber.dispose()
  if (action === 'replace') {
    await f.ctx.plugin(SkillRegistry)
    expect(original(f.ctx.skills)).not.toBe(Reflect.get(f.raw, 'registry'))
  }
  for (const service of [f.raw, proxy]) {
    expect(() => { service.assertCurrent() }).toThrow()
    expect(() => { service.inspect() }).toThrow()
  }
  expect(f.currentReads).toBe(0)
})

it('keeps the provider lifecycle owned by the capability fiber while the real Registry stays active', async () => {
  const f = await fixture(), registry = original(f.ctx.skills), signal = providerSignal(f.raw)
  expect(signal.aborted).toBe(false)
  await f.capabilityFiber.dispose()
  expect(original(f.ctx.skills)).toBe(registry)
  expect(signal.aborted).toBe(true)
})

it('rejects withdrawn actual Typert descriptors while the original capability remains current', async () => {
  const f = await fixture()
  await f.typertFiber.dispose()
  for (const service of [f.raw, f.ctx.cloudSkills]) {
    expect(() => { service.assertCurrent() }).not.toThrow()
    expect(() => { service.inspect() }).toThrow(expect.objectContaining({ code: 'cloud/account-unavailable' }))
  }
})
