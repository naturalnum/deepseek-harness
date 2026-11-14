/** Profile-owned inspection of native Entry updates; the Loader retains mutation and lifecycle execution. */
import { FiberState, Inject, resolveConfig, symbols, type Fiber, type Plugin } from '@deepseek-ai/cordis'
import { deepEqual, isVolatile } from '@deepseek-ai/cosmokit'
import { EntryGroup, equalExceptVolatile, type Entry, type EntryOptions, type EntryConfigUpdatePlan, type EntryConfigInspection, type PreparedEntryConfigUpdate } from '@deepseek-ai/cordis-plugin-loader'
import { configSchemaSnapshot, deterministicConfigSchema } from './config-compare.ts'

type ConfigPlanState = {
  literalExpressions?: true
  version: number
  options: EntryOptions
  next: unknown
  before: unknown
  candidate: unknown
  effective: unknown
  parent: object | null
  schema: unknown
  runtime: Fiber['runtime'] | undefined
  moduleNamespace: unknown
} & ({
  kind: 'options'
  coldNamespace?: unknown
  nextOptions: EntryOptions
  maximum: number
  topology: ReturnType<EntryConfigInspector['_optionsTopology']>
} | {
  kind?: 'passive'
  coldNamespace?: never
  nextOptions?: never
})

function configSnapshot(value: unknown, literalExpressions = false, ancestors = new Set<object>()): unknown {
  if (isVolatile(value)) return configSnapshot(value.get(), literalExpressions, ancestors)
  if (typeof value === 'function' || typeof value === 'symbol') throw new Error('Unproven config dependency')
  if (value === null || typeof value !== 'object') return value
  if (ancestors.has(value)) throw new Error('Unproven recursive config')
  ancestors.add(value)
  try {
    if (literalExpressions && Reflect.ownKeys(value).some((key) => {
      const property = Object.getOwnPropertyDescriptor(value, key)
      return typeof key !== 'string' || property === undefined || !('value' in property)
        || (!property.enumerable && !(Array.isArray(value) && key === 'length'))
    })) throw new Error('Unproven declarative config property')
    if (Array.isArray(value)) return value.map(child => configSnapshot(child, literalExpressions, ancestors))
    if (Object.getPrototypeOf(value) !== Object.prototype && Object.getPrototypeOf(value) !== null) {
      throw new Error('Unproven config object')
    }
    if ('__jsExpr' in value) {
      const source = Object.getOwnPropertyDescriptor(value, '__jsExpr')
      if (!literalExpressions || Reflect.ownKeys(value).length !== 1 || source === undefined
        || !('value' in source) || typeof source.value !== 'string') throw new Error('Unproven config expression')
      return { __jsExpr: source.value }
    }
    return Object.fromEntries(Object.entries(value).map(([key, child]) => [key, configSnapshot(child, literalExpressions, ancestors)]))
  } finally { ancestors.delete(value) }
}

function optionChanges(previous: EntryOptions, next: EntryOptions): string[] {
  const keys = Object.keys({ ...next, ...previous }) as Array<keyof EntryOptions>
  return keys.filter(key => !deepEqual(next[key], previous[key], key === 'config'))
}

/** One original Entry's prepared inspections, owned by the profile's existing Loader. */
class EntryConfigInspector implements EntryConfigInspection {
  private readonly configPlans = new WeakMap<EntryConfigUpdatePlan, ConfigPlanState>()
  private readonly planFiberRevisions = new WeakMap<EntryConfigUpdatePlan, number | undefined>()
  constructor(private readonly entry: Entry) {}
  private get ctx() { return this.entry.ctx }
  private get fiber() { return this.entry.fiber }
  private get options() { return this.entry.options }
  private get moduleNamespace() { return this.entry.moduleNamespace }
  private get subgroup() { return this.entry.subgroup }
  private get subtree() { return this.entry.subtree }
  private get parent() { return this.entry.parent }
  private get disabled() { return this.entry.disabled }
  private get loader() { return this.entry.loader }
  private get configVersion() { return this.entry.configMutationRevision }
  private rememberConfigPlan(plan: EntryConfigUpdatePlan, state: ConfigPlanState): void {
    this.configPlans.set(plan, state)
    this.planFiberRevisions.set(plan, plan.fiber?.configMutationRevision)
  }

  private nativeConfigResolvers(): boolean {
    const hooks = this.ctx.events._hooks['internal/config'] ?? []
    const label = this.ctx[symbols.isolate].loader
    const loader = label === undefined ? undefined : this.ctx.reflect.store[label]?.ctx.fiber
    const root = this.ctx.root.fiber
    // Core validates the candidate; Loader only interpolates entry-owned expressions.
    return loader !== undefined && hooks.length === 2 && hooks.every(hook => hook.ctx.fiber === root || hook.ctx.fiber === loader)
      && hooks.some(hook => hook.ctx.fiber === root) && hooks.some(hook => hook.ctx.fiber === loader)
  }

  /**
   * Reject unproven schema/resolver dependencies before any candidate parser runs.
   * @throws If this entry cannot use the deterministic config-only planning subset.
   */
  assertConfigUpdateSupported(): void {
    const fiber = this.fiber
    if (!fiber || !deterministicConfigSchema(fiber.runtime?.Config)
      || !this.nativeConfigResolvers()) {
      throw new Error('Loader config dependencies are unproven')
    }
    configSnapshot(this.options.config)
  }

  /**
   * Prepare the native config-only decision without updating options or references.
   * Only a deterministic schema and the two native resolver callbacks can prove live.
   * An unchanged declaration keeps exact typed expression source literal; runtime expressions stay unproven.
   * @param next - proposed complete raw plugin config.
   * @returns Opaque identity/version-bound plan; unknown/remount plans cannot commit as live.
   */
  prepareConfigUpdate(next: unknown): EntryConfigUpdatePlan {
    const fiber = this.fiber
    let impact: EntryConfigUpdatePlan['impact'] = 'unknown'
    let state: ConfigPlanState | undefined
    try {
      const proposed = { ...this.options, config: next }
      const changes = optionChanges(this.options, proposed)
      // Native declaration plugins keep nested row expressions literal. Only an
      // unchanged declaration can snapshot their source; never resolve or edit it.
      const literalExpressions = changes.length === 0
        && Object.getOwnPropertyDescriptor(fiber?.runtime?.callback ?? {}, EntryGroup.key)?.value === true
      const detachedNext = configSnapshot(next, literalExpressions)
      const options = structuredClone(this.options)
      if (changes.length === 0 && this.options.disabled === true && !this.subgroup && !this.subtree) {
        const plan: EntryConfigUpdatePlan = Object.freeze({ entry: this.entry, fiber, version: this.configVersion,
          impact: 'none', stopped: Object.freeze([]) })
        this.rememberConfigPlan(plan, { kind: 'passive', version: this.configVersion, options, next: detachedNext,
          before: undefined, candidate: undefined, effective: undefined, parent: Object.getPrototypeOf(this.ctx),
          schema: undefined, runtime: fiber?.runtime, moduleNamespace: this.moduleNamespace })
        return plan
      }
      if (!fiber?.uid || fiber.state !== FiberState.ACTIVE || this.disabled
        || Object.getPrototypeOf(this.ctx) !== this.parent.ctx || this.subgroup || this.subtree) throw new Error('Unproven entry state')
      const before = configSnapshot(fiber.effectiveConfig, literalExpressions)
      let candidate: unknown = fiber.effectiveConfig
      if (changes.length === 0) impact = 'none'
      else {
        this.assertConfigUpdateSupported()
        if (!this._volatileOnly(changes, this.options, proposed)) impact = 'remount'
        else {
          candidate = this._resolveVolatile(fiber, next)
          impact = this._sameOrdinary(fiber, candidate) ? 'live' : 'remount'
        }
      }
      state = {
        ...literalExpressions ? { literalExpressions: true } : {},
        version: this.configVersion, options, next: detachedNext, before, candidate,
        effective: configSnapshot(candidate, literalExpressions), parent: Object.getPrototypeOf(this.ctx),
        schema: configSchemaSnapshot(fiber.runtime?.Config),
        runtime: fiber.runtime, moduleNamespace: this.moduleNamespace,
      }
    } catch (error) {
      // An unproven snapshot, resolver or schema never grants a live update.
      void error
      impact = 'unknown'
    }
    const plan: EntryConfigUpdatePlan = Object.freeze({
      entry: this.entry, fiber, version: this.configVersion, impact,
      stopped: impact === 'live' || impact === 'none' ? Object.freeze([]) : undefined,
    })
    if (state !== undefined) this.rememberConfigPlan(plan, state)
    return plan
  }

  /** Check an original, unconsumed plan's native mutation versions and retained entry identities.
   * This is not a config, schema, lifecycle, or readiness audit.
   * @param plan Original plan issued by this entry.
   * @returns False for a foreign, consumed, or version/fiber-stale plan.
   */
  isConfigPlanVersionCurrent(plan: EntryConfigUpdatePlan): boolean {
    const state = this.configPlans.get(plan)
    return state !== undefined && plan.entry === this.entry && state.version === this.configVersion
      && plan.version === this.configVersion && plan.fiber === this.fiber
      && this.planFiberRevisions.has(plan) && this.planFiberRevisions.get(plan) === plan.fiber?.configMutationRevision
      && state.parent === Object.getPrototypeOf(this.ctx) && (state.kind === 'passive' || state.parent === this.parent.ctx)
      && state.runtime === this.fiber?.runtime && state.moduleNamespace === this.moduleNamespace
  }

  /**
   * Recheck a prepared live/no-op decision against current identity, options and effective values.
   * @param plan - unconsumed plan prepared by this entry.
   * @throws If the plan is unsupported, stale, consumed or its effective decision drifted.
   */
  assertConfigUpdatePlan(plan: EntryConfigUpdatePlan): ConfigPlanState {
    const state = this.configPlans.get(plan)
    if (state === undefined || (plan.impact !== 'live' && plan.impact !== 'none'
      && !(state.kind === 'options' && plan.impact === 'remount'))) throw new Error('Loader config impact is unproven')
    if (!this.isConfigPlanVersionCurrent(plan) || state.version !== this.configVersion
      || plan.fiber !== this.fiber || state.parent !== Object.getPrototypeOf(this.ctx)
      || state.runtime !== this.fiber?.runtime || state.moduleNamespace !== this.moduleNamespace
      || !deepEqual(state.options, this.options, true)
      || (state.kind !== 'passive' && !deepEqual(state.before, configSnapshot(this.fiber?.effectiveConfig, state.literalExpressions === true), true))) {
      throw new Error('Loader config plan is stale')
    }
    const fresh = state.kind === 'options' ? state.coldNamespace === undefined
      ? this.prepareOptionsUpdate(state.nextOptions, state.maximum)
      : this.prepareColdOptionsUpdate(state.nextOptions, state.maximum, state.coldNamespace)
      : this.prepareConfigUpdate(state.next)
    const checked = this.configPlans.get(fresh)
    if (fresh.impact !== plan.impact || checked === undefined || !deepEqual(state.effective, checked.effective, true)
      || !deepEqual(state.schema, checked.schema, true) || !deepEqual(plan.stopped, fresh.stopped, true)) {
      throw new Error('Loader config plan effective values drifted')
    }
    if (state.kind === 'options') {
      const topology = state.topology, current = this._optionsTopology(state.maximum)
      if (current.length !== topology.length || current.some((row, index) => {
        const prior = topology[index]
        return prior === undefined || row.fiber !== prior.fiber || row.parent !== prior.parent || row.runtime !== prior.runtime
          || row.state !== prior.state || row.uid !== prior.uid || row.dependencies.length !== prior.dependencies.length
          || row.dependencies.some((impl, i) => impl !== prior.dependencies[i])
      })) throw new Error('Loader plugin dependency graph is stale')
    }
    return state
  }

  /** Read a detached effective candidate from this entry's current proven plan.
   * This is a Host-side inspection primitive; callers must not publish private configuration.
   * @param plan Original plan prepared by this entry.
   * @returns A detached snapshot of the candidate checked by Loader.
   */
  snapshotConfigUpdatePlan(plan: EntryConfigUpdatePlan): unknown {
    this.assertConfigUpdatePlan(plan)
    const state = this.configPlans.get(plan)
    if (state === undefined || state.kind === 'passive' || state.effective === undefined) {
      throw new Error('Loader config plan has no inspectable effective configuration')
    }
    return structuredClone(state.effective)
  }

  /** Snapshot the actual registry and reject a leaf whose stop could affect another fiber.
   * @param maximum Explicit registry visit bound.
   * @returns Original fiber/dependency identities; no caller-supplied stop list is trusted.
   */
  _optionsTopology(maximum: number) {
    if (!Number.isSafeInteger(maximum) || maximum < 1) throw new Error('Loader plugin plan requires a finite registry bound')
    const rows: {
      fiber: Fiber
      parent: Fiber
      runtime: Fiber['runtime']
      state: FiberState
      uid: Fiber['uid']
      dependencies: readonly unknown[]
    }[] = []
    let visited = 0
    for (const runtime of this.ctx.registry.values()) {
      if (++visited > maximum) throw new Error('Loader plugin registry exceeds its plan bound')
      for (const fiber of runtime.fibers) {
        if (++visited > maximum) throw new Error('Loader plugin registry exceeds its plan bound')
        const dependencies = fiber.dependencies
        if (fiber !== this.fiber?.ctx.fiber) {
          if (dependencies.some(impl => impl.ctx.fiber === this.fiber?.ctx.fiber)) throw new Error('Loader plugin has a dependent service consumer')
          let parent = fiber.parent.fiber
          for (let i = 0; parent !== parent.parent.fiber; i++) {
            if (i >= maximum || parent === this.fiber?.ctx.fiber) throw new Error('Loader plugin has an unproven child stop closure')
            parent = parent.parent.fiber
          }
        }
        rows.push({ fiber, parent: fiber.parent.fiber, runtime: fiber.runtime, state: fiber.state, uid: fiber.uid, dependencies })
      }
    }
    return rows
  }

  /** Prepare a config/enablement change for one already-loaded native leaf module.
   * Other options, descendants, service dependents, unresolved schemas and never-loaded disabled modules reject.
   * @param next Complete proposed row from the native Include composer.
   * @param maximum Explicit bound for the complete original registry snapshot.
   * @returns An opaque native plan with an exact stop list, or an unknown decision.
   */
  prepareOptionsUpdate(next: EntryOptions, maximum: number): EntryConfigUpdatePlan {
    const fiber = this.fiber
    let state: ConfigPlanState | undefined
    let impact: EntryConfigUpdatePlan['impact'] = 'unknown'
    let stopped: readonly Fiber[] | undefined
    try {
      if (!fiber || !this.moduleNamespace || this.subgroup || this.subtree
        || Object.getPrototypeOf(this.ctx) !== this.parent.ctx
        || ![FiberState.ACTIVE, FiberState.DISPOSED].includes(fiber.state)
        || (this.options.disabled !== undefined && typeof this.options.disabled !== 'boolean')
        || (next.disabled !== undefined && typeof next.disabled !== 'boolean')
        || !deepEqual({ ...this.options, config: undefined, disabled: undefined },
          { ...next, config: undefined, disabled: undefined }, true)) throw new Error('Unproven plugin options')
      this.assertConfigUpdateSupported()
      const topology = this._optionsTopology(maximum)
      const candidate = this._resolveVolatile(fiber, next.config)
      const unchanged = optionChanges(this.options, next).length === 0
      impact = unchanged ? 'none' : 'remount'
      stopped = Object.freeze(!unchanged && fiber.state === FiberState.ACTIVE ? [fiber] : [])
      state = { kind: 'options', version: this.configVersion, options: structuredClone(this.options),
        next: configSnapshot(next.config), nextOptions: structuredClone(next), before: configSnapshot(fiber.effectiveConfig),
        candidate, effective: configSnapshot(candidate), parent: Object.getPrototypeOf(this.ctx),
        schema: configSchemaSnapshot(fiber.runtime?.Config), runtime: fiber.runtime, moduleNamespace: this.moduleNamespace,
        maximum, topology }
    } catch (error) { void error }
    const plan: EntryConfigUpdatePlan = Object.freeze({ entry: this.entry, fiber, version: this.configVersion, impact, stopped })
    if (state !== undefined) this.rememberConfigPlan(plan, state)
    return plan
  }

  /** Load only the original entry's preinstalled code for a never-active disabled leaf, without creating a fiber.
   * @param next Native composed row; package names and all structural options remain unchanged.
   * @param maximum Explicit original registry visit bound.
   * @returns Native plan after the original importer settles; caller rechecks its request/window before persistence.
   */
  async prepareModuleOptionsUpdate(next: EntryOptions, maximum: number): Promise<EntryConfigUpdatePlan> {
    if (this.fiber !== undefined || this.moduleNamespace !== undefined) return this.prepareOptionsUpdate(next, maximum)
    const namespace: unknown = await this.parent.tree.import(this.options.name)
    return this.prepareColdOptionsUpdate(next, maximum, namespace)
  }

  private prepareColdOptionsUpdate(next: EntryOptions, maximum: number, namespace: unknown): EntryConfigUpdatePlan {
    let impact: EntryConfigUpdatePlan['impact'] = 'unknown'
    let state: ConfigPlanState | undefined
    let stopped: readonly Fiber[] | undefined
    const numericRaw = (value: unknown): boolean => value === undefined || value === null || typeof value === 'boolean'
      || typeof value === 'number' && Number.isFinite(value) || Array.isArray(value) && value.every(numericRaw)
      || typeof value === 'object' && !Array.isArray(value) && value !== null
        && (Object.getPrototypeOf(value) === Object.prototype || Object.getPrototypeOf(value) === null)
        && Object.values(value).every(numericRaw)
    try {
      if (this.fiber !== undefined || this.moduleNamespace !== undefined || this.options.disabled !== true
        || this.options.inject != null || this.subgroup || this.subtree || Object.getPrototypeOf(this.ctx) !== this.parent.ctx
        || (next.disabled !== undefined && typeof next.disabled !== 'boolean')
        || !deepEqual({ ...this.options, config: undefined, disabled: undefined },
          { ...next, config: undefined, disabled: undefined }, true)
        || !numericRaw(next.config)) throw new Error('Unproven cold plugin options')
      const plugin: Plugin = this.loader.unwrapExports(namespace)
      if (this.ctx.registry.resolve(plugin) === undefined || plugin.provide != null
        || Object.keys(Inject.resolve(plugin.inject)).length !== 0 || !deterministicConfigSchema(plugin.Config)
        || !this.nativeConfigResolvers()) {
        throw new Error('Unproven cold plugin dependencies or config resolver')
      }
      const topology = this._optionsTopology(maximum), candidate = resolveConfig(plugin, next.config)
      impact = optionChanges(this.options, next).length === 0 ? 'none' : 'remount'
      stopped = Object.freeze([])
      state = { kind: 'options', coldNamespace: namespace, version: this.configVersion, options: structuredClone(this.options),
        next: configSnapshot(next.config), nextOptions: structuredClone(next), before: undefined, candidate,
        effective: configSnapshot(candidate), parent: Object.getPrototypeOf(this.ctx), schema: configSchemaSnapshot(plugin.Config),
        runtime: undefined, moduleNamespace: undefined, maximum, topology }
    } catch (error) { void error }
    const plan: EntryConfigUpdatePlan = Object.freeze({ entry: this.entry, fiber: undefined, version: this.configVersion, impact, stopped })
    if (state !== undefined) this.rememberConfigPlan(plan, state)
    return plan
  }

  private _volatileOnly(changes: string[], previous: EntryOptions, next: EntryOptions): boolean {
    return changes.length === 1 && changes[0] === 'config' && this.fiber?.state === FiberState.ACTIVE
      && Object.getPrototypeOf(this.ctx) === this.parent.ctx
      && equalExceptVolatile(previous.config, next.config, this.fiber.runtime?.Config)
  }

  private _resolveVolatile(fiber: Fiber, raw: unknown): unknown {
    return fiber.resolveConfig(raw)
  }

  private _sameOrdinary(fiber: Fiber, candidate: unknown): boolean {
    return deepEqual(fiber.effectiveConfig, candidate, true)
  }


  consume(plan: EntryConfigUpdatePlan, options: Partial<EntryOptions>, create: boolean): PreparedEntryConfigUpdate {
    const state = this.assertConfigUpdatePlan(plan)
    const proposed = create ? options : { ...this.options, ...options }
    if (!deepEqual(proposed, state.nextOptions ?? { ...state.options, config: state.next }, true)) {
      throw new Error('Loader config commit differs from its prepared options')
    }
    if (plan.impact === 'unknown') throw new Error('Loader config impact is unproven')
    this.configPlans.delete(plan)
    return {
      impact: plan.impact, candidate: state.candidate,
      verify: () => {
        if (plan.impact !== 'remount') return
        const active = this.entry.fiber
        if (this.entry.disabled) {
          if (active !== undefined && active.state !== FiberState.DISPOSED) throw new Error('Loader plugin stop is unconfirmed')
          return
        }
        if (active?.state !== FiberState.ACTIVE || this.moduleNamespace !== (state.coldNamespace ?? state.moduleNamespace)
          || !deepEqual(configSnapshot(active.effectiveConfig), state.effective, true)) {
          throw new Error('Loader plugin update did not activate its prepared module and config')
        }
      },
    }
  }
}

/** Install profile inspection once on the original Loader; no process-global plan cache is used.
 * @param loader Existing profile Loader, before any profile plan is prepared.
 */
export function installEntryConfigInspection(loader: Entry['loader']): void {
  if (loader.configInspection !== undefined) return
  const entries = new WeakMap<Entry, EntryConfigInspector>()
  loader.configInspection = (entry) => {
    let inspector = entries.get(entry)
    if (inspector === undefined) { inspector = new EntryConfigInspector(entry); entries.set(entry, inspector) }
    return inspector
  }
}
