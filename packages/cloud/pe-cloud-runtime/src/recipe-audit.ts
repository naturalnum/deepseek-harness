/** Actual Root Loader/provider audit; storage admission stays closed until a real files capability exists. */
import { Context, FiberState, symbols, type Fiber } from '@deepseek-ai/cordis'
import type {} from '@deepseek-ai/dsh-app-boot'
import { ExposureService } from '@deepseek-ai/dsh-pe-cloud-api'
import { AccountRuntimeError } from './errors.ts'
import type { DrainParticipant, RootRecipeInput, RootRecipeIssue, RootRecipeObservation, RootRecipeRole } from './types.ts'

type Entry = NonNullable<Fiber['entry']>
type Plan = ReturnType<Entry['prepareConfigUpdate']>

const ROOT_ROLES = ['access/root', 'runtime/root', 'api/root', 'files/root', 'opensandbox/root'] as const
const ROLES: readonly RootRecipeRole[] = [...ROOT_ROLES,
  'runtime/account', 'api/account', 'files/account', 'opensandbox/account', 'instructions/session', 'client/client']
const PROVIDERS = ['peAuth', 'peAccountRuntime', 'peExposure', 'peFilesPool', 'peSandboxCoordinator', 'webServer', 'credentials', 'clientModules'] as const

/** Actual participant contribution retained with its owning fiber, not a receipt or availability flag. */
export interface RegisteredRootParticipant {
  readonly participant: DrainParticipant
  readonly fiber: Fiber
}

interface EntryFact { readonly entry: Entry; readonly fiber: Fiber; readonly plan: Plan; readonly module: unknown }
interface Candidate {
  readonly input: RootRecipeInput
  readonly facts: readonly EntryFact[]
  readonly providers: readonly { key: string; value: object; fiber: Fiber }[]
  readonly participants: readonly RegisteredRootParticipant[]
  readonly manifest: object | undefined
}

function object(value: unknown): value is object {
  return value !== null && (typeof value === 'object' || typeof value === 'function')
}

function original(value: object): object {
  const target: unknown = Reflect.get(value, symbols.original)
  return object(target) ? target : value
}

function descends(fiber: Fiber, parent: Fiber): boolean {
  let current = fiber
  while (true) {
    if (current === parent) return true
    if (current.parent.fiber === current) return false
    current = current.parent.fiber
  }
}

/** One runtime's lifetime-bound audit; no caller can manufacture a sealed result or storage certificate. */
export class RootRecipeAudit {
  private candidate: Candidate | undefined
  private state: RootRecipeObservation = Object.freeze({ status: 'unsealed', rootEntries: 0, providers: 0, participants: 0, issues: Object.freeze([]) })

  /**
   * @param owner Runtime's real Loader fiber; all event observers unload with it.
   * @param participants Runtime's actual registrations, including their owning fibers.
   * @param control Read actual private control state, never caller-supplied readiness evidence.
   */
  constructor(
    private readonly owner: Context,
    private readonly participants: () => readonly RegisteredRootParticipant[],
    private readonly control: () => Readonly<{ phase: string; recipeVersion: string | undefined }>,
  ) {
    const changed = (): void => { this.revoke() }
    owner.on('internal/plugin', changed)
    owner.on('internal/service', changed)
    owner.on('loader/entry-init', changed)
    owner.on('loader/partial-dispose', changed)
    owner.on('loader/volatile-update', changed, { global: true })
    owner.on('loader/patch-context', (_entry, next) => { changed(); next() })
  }

  /**
   * Audit actual entries, providers, immutable manifest and participant identity.
   * Storage has no usable public issuer yet, so even complete non-storage facts reject sealing.
   * @param input Fixed recipe expectations and original provider/manifest objects, not success assertions.
   * @throws AccountRuntimeError; inspect() retains bounded safe facts and the concrete missing checks.
   */
  seal(input: RootRecipeInput): void {
    if (this.state.status === 'closed') this.fail()
    this.candidate = undefined
    const issues: RootRecipeIssue[] = []
    const issue = (code: RootRecipeIssue): void => { if (!issues.includes(code)) issues.push(code) }
    // Fixed finite protocol lists bound work before traversing or copying expectations.
    if (input.entrypoints.length > ROLES.length || input.roots.length > ROOT_ROLES.length || input.providers.length > PROVIDERS.length) {
      if (input.entrypoints.length > ROLES.length) issue('entrypoint-catalog-mismatch')
      if (input.roots.length > ROOT_ROLES.length) issue('root-entry-missing')
      if (input.providers.length > PROVIDERS.length) issue('provider-missing')
      this.record(input.recipeVersion, [], [], [], undefined, issues)
      this.fail()
    }
    const control = this.control()
    if (control.phase !== 'active') issue('runtime-control-unavailable')
    if (control.recipeVersion !== undefined && control.recipeVersion !== input.recipeVersion) issue('version-mismatch')
    if (input.entrypoints.length !== ROLES.length || new Set(input.entrypoints).size !== ROLES.length
      || ROLES.some(role => !input.entrypoints.includes(role))) issue('entrypoint-catalog-mismatch')
    if (input.roots.length !== ROOT_ROLES.length || new Set(input.roots.map(row => row.role)).size !== ROOT_ROLES.length
      || new Set(input.roots.map(row => row.entryId)).size !== ROOT_ROLES.length
      || new Set(input.roots.map(row => row.module)).size !== ROOT_ROLES.length
      || ROOT_ROLES.some(role => !input.roots.some(row => row.role === role))) issue('root-entry-missing')
    if (input.providers.length !== PROVIDERS.length || new Set(input.providers.map(row => row.key)).size !== PROVIDERS.length
      || PROVIDERS.some(key => !input.providers.some(row => row.key === key))) issue('provider-missing')
    const root = this.owner.root
    const loader = root.get('loader')
    const rows = loader === undefined ? [] : [...loader.entries()]
    const facts = new Map<Entry, EntryFact>()
    const rootEntries = new Map<string, Entry>()
    for (const expected of input.roots) {
      const matches = rows.filter(row => row.options.id === expected.entryId)
      const modules = rows.filter(row => row.moduleNamespace === expected.module)
      const entry = matches[0]
      if (matches.length !== 1) { issue('root-entry-duplicate-or-missing'); continue }
      if (entry === undefined || entry.disabled) { issue('root-entry-inactive'); continue }
      if (entry.moduleNamespace !== expected.module) { issue('root-module-replaced'); continue }
      if (modules.length !== 1) { issue('root-entry-duplicate-or-missing'); continue }
      const fiber = entry.fiber
      if (fiber === undefined || fiber.state !== FiberState.ACTIVE || fiber.ctx.root !== root) {
        issue('root-entry-inactive'); continue
      }
      const plan = entry.prepareConfigUpdate(entry.options.config)
      if (plan.impact !== 'none') { issue('root-config-unproven'); continue }
      facts.set(entry, { entry, fiber, plan, module: entry.moduleNamespace })
      rootEntries.set(expected.role, entry)
    }
    for (const row of rows) {
      const name = row.options.name
      if (['/account', '/session', '/client'].some(suffix => name.startsWith('@deepseek-ai/dsh-pe-') && name.endsWith(suffix))) {
        issue('account-entry-in-root')
      }
    }
    const providers: Candidate['providers'][number][] = []
    for (const expected of input.providers) {
      const value: unknown = root.get(expected.key)
      if (!object(value) || original(value) !== original(expected.value)) { issue('provider-replaced-or-missing'); continue }
      const implementations: { fiber: Fiber; value: unknown }[] = []
      for (const runtime of root.registry.values()) for (const fiber of runtime.fibers) {
        if (fiber.ctx.root !== root || fiber.state !== FiberState.ACTIVE) continue
        const implementation = fiber.store?.[expected.key]
        if (implementation !== undefined && implementation.fiber === fiber) implementations.push({ fiber, value: implementation.value })
      }
      const entry = rows.find(row => row.options.id === expected.entryId)
      const implementation = implementations[0]
      if (implementations.length !== 1) { issue('provider-duplicate-or-missing'); continue }
      if (entry?.fiber === undefined || implementation === undefined || !descends(implementation.fiber, entry.fiber)
        || !object(implementation.value) || original(implementation.value) !== original(value)) {
        issue('provider-owner-mismatch'); continue
      }
      const roles: Partial<Record<RootRecipeInput['providers'][number]['key'], string>> = {
        peAuth: 'access/root', peAccountRuntime: 'runtime/root', peExposure: 'api/root',
        peFilesPool: 'files/root', peSandboxCoordinator: 'opensandbox/root',
      }
      const role = roles[expected.key]
      if (role !== undefined && rootEntries.get(role) !== entry) { issue('provider-owner-mismatch'); continue }
      if (!this.healthy(expected.key, original(value), entry)) { issue('provider-not-current'); continue }
      const plan = entry.prepareConfigUpdate(entry.options.config)
      if (plan.impact !== 'none') { issue('root-config-unproven'); continue }
      facts.set(entry, { entry, fiber: entry.fiber, plan, module: entry.moduleNamespace })
      providers.push({ key: expected.key, value: original(value), fiber: implementation.fiber })
    }
    const registered = this.participants()
    for (const [id, key, role] of [['files', 'peFilesPool', 'files/root'], ['execution', 'peSandboxCoordinator', 'opensandbox/root']] as const) {
      const values = registered.filter(row => row.participant.id === id)
      const provider = providers.find(row => row.key === key)
      const entry = rootEntries.get(role)
      const contribution = values[0]
      if (values.length !== 1 || contribution === undefined || provider === undefined || entry?.fiber === undefined) {
        issue('participant-missing'); continue
      }
      if (original(contribution.participant) !== provider.value || contribution.fiber.state !== FiberState.ACTIVE
        || !descends(contribution.fiber, entry.fiber)) issue('participant-provider-mismatch')
    }
    const exposure = root.get('peExposure')
    let manifest: object | undefined
    if (!(exposure instanceof ExposureService) || input.manifest !== exposure.policy.manifest) issue('manifest-replaced-or-missing')
    else {
      manifest = exposure.policy.manifest
      const m = exposure.policy.manifest
      if (m.recipeVersion !== input.recipeVersion) issue('version-mismatch')
      if (!Object.isFrozen(m) || [m.rpcEndpoints, m.streamEndpoints, m.exactFetchRoutes, m.allowedSettings].some(list =>
        !Object.isFrozen(list) || list.some(row => !Object.isFrozen(row)))
        || m.allowedSettings.some(row => !Object.isFrozen(row.fields))) issue('manifest-not-immutable')
    }
    // No storage descriptor or boolean can fill the absent files-owned verifier/capability.
    issue('storage-root-capability-missing')
    const detached: RootRecipeInput = Object.freeze({
      recipeVersion: input.recipeVersion, entrypoints: Object.freeze([...input.entrypoints]),
      roots: Object.freeze(input.roots.map(row => Object.freeze({ ...row }))),
      providers: Object.freeze(input.providers.map(row => Object.freeze({ ...row }))), manifest: input.manifest,
    })
    this.candidate = { input: detached, facts: [...facts.values()], providers, participants: [...registered], manifest }
    this.record(input.recipeVersion, [...rootEntries.values()], providers, registered, manifest, issues)
    this.fail()
  }

  /**
   * Refuse external admission without a current full seal; missing storage never passes.
   * @param recipeVersion Expected deployment version, not a permission or generation value.
   * @throws AccountRuntimeError before any account or transport business work.
   */
  assertSealed(recipeVersion: string): void {
    this.recheck()
    if (this.state.recipeVersion !== undefined && recipeVersion !== this.state.recipeVersion) this.revoke()
    this.fail()
  }

  /** Revoke previous audit facts after replacement, reload or explicit administrative closure. */
  revoke(): void {
    if (this.state.status === 'closed' || this.state.status === 'unsealed' || this.state.status === 'revoked') return
    this.candidate = undefined
    this.state = Object.freeze({ ...this.state, status: 'revoked', issues: Object.freeze(['recipe-revoked'] as const) })
  }

  /** Permanently close this runtime audit; a later call cannot restore its authority. */
  close(): void {
    this.candidate = undefined
    this.state = Object.freeze({ ...this.state, status: 'closed', issues: Object.freeze(['runtime-closed'] as const) })
  }

  /**
   * Inspect actual identities without upgrading a blocked audit to a seal.
   * @returns Safe detached facts, revoked if any retained identity or health check changed.
   */
  inspect(): RootRecipeObservation { this.recheck(); return this.state }

  private recheck(): void {
    const candidate = this.candidate
    if (candidate === undefined) return
    try {
      for (const { entry, fiber, plan, module } of candidate.facts) {
        if (entry.fiber !== fiber || fiber.state !== FiberState.ACTIVE || entry.moduleNamespace !== module) throw new Error('changed')
        entry.assertConfigUpdatePlan(plan)
      }
      for (const { key, value, fiber } of candidate.providers) {
        const now: unknown = this.owner.root.get(key)
        if (!object(now) || original(now) !== value || fiber.state !== FiberState.ACTIVE) throw new Error('changed')
        const fact = candidate.facts.find(row => descends(fiber, row.fiber))
        if (fact === undefined || !this.healthy(key, value, fact.entry)) throw new Error('changed')
      }
      const now = this.participants()
      if (now.length !== candidate.participants.length || candidate.participants.some(row => !now.includes(row))) throw new Error('changed')
      if (candidate.manifest !== undefined && this.owner.root.get('peExposure')?.policy.manifest !== candidate.manifest) throw new Error('changed')
    } catch (_cause) { this.revoke() }
  }

  private healthy(key: string, value: object, entry: Entry): boolean {
    try {
      if (key === 'peSandboxCoordinator') {
        const check: unknown = Reflect.get(value, 'assertReady')
        if (typeof check !== 'function') return false
        Reflect.apply(check, value, [])
      }
      if (key === 'peAuth' || key === 'peFilesPool') {
        const method: unknown = Reflect.get(value, key === 'peAuth' ? 'observe' : 'inspect')
        if (typeof method !== 'function') return false
        const observed: unknown = Reflect.apply(method, value, [])
        if (!object(observed)) return false
        if (key === 'peAuth') return Reflect.get(observed, 'phase') === 'initialized'
        const config: unknown = entry.fiber?.config
        if (!object(config)) return false
        const minimum: unknown = Reflect.get(config, 'minimumHealthyWorkers')
        const healthy: unknown = Reflect.get(observed, 'healthy')
        return Reflect.get(observed, 'state') === 'running' && typeof minimum === 'number' && Number.isSafeInteger(minimum) && minimum > 0
          && typeof healthy === 'number' && Number.isSafeInteger(healthy) && healthy >= minimum
      }
      return true
    } catch (_cause) { return false }
  }

  private record(
    recipeVersion: string, roots: readonly unknown[], providers: readonly unknown[], participants: readonly unknown[],
    _manifest: object | undefined, issues: readonly RootRecipeIssue[],
  ): void {
    this.state = Object.freeze({ status: 'blocked', recipeVersion, rootEntries: roots.length, providers: providers.length,
      participants: participants.length, issues: Object.freeze([...issues]) })
  }

  private fail(): never {
    throw new AccountRuntimeError('cloud/account-unavailable', 'Root recipe is not sealed; inspect its current audit before admitting traffic')
  }
}
