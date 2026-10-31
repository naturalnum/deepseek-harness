/** Native profile plans bind the existing patch composition to Loader's actual update checks. */
import { AsyncLocalStorage } from 'node:async_hooks'
import { readFileSync } from 'node:fs'
import { isDeepStrictEqual } from 'node:util'
import { FiberState, type Context } from '@deepseek-ai/cordis'
import type { Entry, EntryConfigUpdatePlan, EntryOptions, LoaderUpdateGuard } from '@deepseek-ai/cordis-plugin-loader'
import Include, { applyEntryPatches, entryListSchema, type PatchOptions } from '@deepseek-ai/cordis-plugin-include'
import * as yaml from 'js-yaml'
import { readProfilePatches, type ProfileContext } from './profile-context.ts'
import { composeEntries } from './profile.ts'
import { prepareProfilePatches } from './compatibility-preflight.ts'

/** Root Includes owned by the public mount operation. @internal */
export const profileIncludes = new WeakMap<Context, Entry>()

/** Opaque native profile decisions; only the explicit bounded leaf path admits a known remount closure. */
export interface ProfileConfigUpdatePlan {
  /** Native per-entry decisions and identity/version bindings. */
  readonly entries: readonly EntryConfigUpdatePlan[]
  /** Most restrictive native decision, or complete composition deferred to a new graph. */
  readonly impact: EntryConfigUpdatePlan['impact'] | 'graph'
  /** Complete native composition deferred to a new graph; no local stop claims are made. */
  readonly restart?: Readonly<{
    before: readonly EntryOptions[]
    after: readonly EntryOptions[]
    baseUrl: string
    entryPrefix: string
    active: readonly EntryOptions[]
  }>
}

interface PlanState {
  maximum?: number
  inspectAfter?: () => PatchOptions[]
  ctx: Context
  root: Entry
  include: Include
  rootOptions: EntryOptions
  rootFiber: Entry['fiber']
  rootText: string
  before: PatchOptions[]
  after: PatchOptions[]
  expectedRoot: EntryOptions
  rows: EntryOptions[]
  previousRows: EntryOptions[]
  profile: ProfileContext
}

/** Own one opaque preparation; copying public decisions does not copy its identity. */
class NativeProfilePlan implements ProfileConfigUpdatePlan {
  readonly entries: ProfileConfigUpdatePlan['entries']
  readonly impact: ProfileConfigUpdatePlan['impact']
  declare readonly restart?: NonNullable<ProfileConfigUpdatePlan['restart']>
  readonly #state: PlanState

  constructor(fields: ProfileConfigUpdatePlan, state: PlanState) {
    this.entries = fields.entries
    this.impact = fields.impact
    if (fields.restart !== undefined) this.restart = fields.restart
    this.#state = state
    Object.freeze(this)
  }

  static stateOf(plan: ProfileConfigUpdatePlan): PlanState | undefined {
    return #state in plan ? plan.#state : undefined
  }
}

/** Read the effective rows with the original registered Include base and its normal patch preparation.
 * @param ctx Original root or a consumer of that root.
 * @param patches Complete native ordered patches.
 * @returns Original Include composition; legacy patch-only contexts retain the original composer.
 */
export function composeProfileEntries(ctx: Context, patches: PatchOptions[]): EntryOptions[] {
  const root = profileIncludes.get(ctx.root), include = root?.subtree
  if (root === undefined || !(include instanceof Include)) return composeEntries([patches])
  const config = root.options.config as Include.Config
  const parentURL = new URL('.', new URL(config.path, root.parent.tree.ctx.baseUrl)).href
  const base: unknown = yaml.load(readFileSync(include.filename, 'utf8'), { schema: entryListSchema })
  if (!Array.isArray(base)) throw new Error('Profile config requires a native entry-list root file')
  const prepared = prepareProfilePatches(ctx.root, structuredClone(patches), parentURL, 'dsh', base as EntryOptions[])
  return applyEntryPatches(base as EntryOptions[], prepared, (message: string) => { throw new Error(message) })
}

/**
 * Prepare one config-only edit over an already-applied flat root Include.
 * Pending patches, nested trees, inactive entries and unknown structural changes reject.
 * @param ctx - root context mounted through mountRootInclude.
 * @param target - existing uniquely addressed entry being edited.
 * @param before - complete currently saved patch list.
 * @param after - complete proposed patch list.
 * @returns An opaque plan containing the actual Loader config decisions.
 * @throws If the profile or proposed scope cannot be proven to be a single-entry edit.
 */
export function prepareProfileConfigUpdate(
  ctx: Context, target: Entry, before: PatchOptions[], after: PatchOptions[],
): ProfileConfigUpdatePlan {
  return prepareProfileUpdate(ctx, target, before, after)
}

/** Prepare one fixed-module leaf's config or enablement through the original Include composer.
 * Caller must obtain a real account idle window before persistence; this plan grants no runtime admission.
 * @param ctx Original root mounted by mountRootInclude.
 * @param target Existing uniquely addressed entry; insertion/removal and module changes remain unsupported.
 * @param before Complete saved patches already applied by the original Include.
 * @param after Proposed complete patches.
 * @param maximum Explicit visit bound for the actual native registry and dependency snapshot.
 * @returns Native identity/version-bound decisions; unknown or wider stop closures cannot commit.
 */
export async function prepareProfilePluginUpdate(
  ctx: Context, target: Entry, before: PatchOptions[], after: PatchOptions[], maximum: number,
): Promise<ProfileConfigUpdatePlan> {
  const plan = prepareProfileUpdate(ctx, target, before, after, maximum)
  if (target.fiber !== undefined || target.moduleNamespace !== undefined) return plan
  const state = NativeProfilePlan.stateOf(plan), next = state?.rows.find(row => row.id === target.options.id)
  if (next === undefined) throw new Error('Profile plugin target is unavailable')
  const cold = await target.prepareModuleOptionsUpdate(next, maximum)
  return prepareProfileUpdate(ctx, target, before, after, maximum, cold)
}

/** Prepare a bundle selection with the original composer and bounded native inventory.
 * Reconcile mode admits one existing leaf. Restart mode captures the complete composition for a new graph and cannot apply locally.
 * @param ctx Original mounted profile root.
 * @param before Original complete saved layers.
 * @param after Previewed complete selected layers, including original overlays.
 * @param maximum Bound on actual native registry visits.
 * @param application Local leaf reconciliation or persistence deferred to a complete graph restart.
 * @param inspectAfter Original reader for proposed layers, rechecked before persistence.
 * @returns Identity-bound native plan; a restart plan grants no current-graph application or stop admission.
 */
export async function prepareProfileSelectionUpdate(
  ctx: Context, before: PatchOptions[], after: PatchOptions[], maximum: number, application: 'reconcile' | 'restart' = 'reconcile',
  inspectAfter?: () => PatchOptions[],
): Promise<ProfileConfigUpdatePlan> {
  if (application === 'restart') return prepareProfileRestartUpdate(ctx, before, after, maximum, inspectAfter)
  const previous = composeProfileEntries(ctx, before), next = composeProfileEntries(ctx, after)
  if (previous.length !== next.length || previous.some((row, index) => row.id !== next[index]?.id)) {
    throw new Error('Profile selection impact has an unproven entry set')
  }
  const changed = previous.filter((row, index) => !isDeepStrictEqual(row, next[index]))
  if (changed.length > 1) throw new Error('Profile selection impact has an unproven multi-entry closure')
  const id = (changed[0] ?? previous[0])?.id
  const target = profileIncludes.get(ctx)?.subtree?.store[id ?? '']
  if (target === undefined) throw new Error('Profile selection impact has no existing target')
  return prepareProfilePluginUpdate(ctx, target, before, after, maximum)
}

function prepareProfileRestartUpdate(ctx: Context, before: PatchOptions[], after: PatchOptions[], maximum: number,
  inspectAfter?: () => PatchOptions[]): ProfileConfigUpdatePlan {
  const root = profileIncludes.get(ctx.root), include = root?.subtree, profile = ctx.get('profileContext')
  if (root === undefined || !(include instanceof Include) || profile === undefined || root.fiber?.state !== FiberState.ACTIVE
    || !Number.isSafeInteger(maximum) || maximum < 1 || include.ctx.baseUrl === undefined) {
    throw new Error('Profile restart requires the original active Include and a finite composition bound')
  }
  const previous = composeProfileEntries(ctx, before), rows = composeProfileEntries(ctx, after)
  for (const entries of [previous, rows]) {
    if (entries.length > maximum || entries.some(row => !row.id || typeof row.name !== 'string')
      || new Set(entries.map(row => row.id)).size !== entries.length) throw new Error('Profile restart composition is unproven')
  }
  const includeConfig = root.options.config as Include.Config
  return new NativeProfilePlan({ entries: Object.freeze([]), impact: 'graph',
    restart: Object.freeze({ before: structuredClone(previous), after: structuredClone(rows), baseUrl: include.ctx.baseUrl, entryPrefix: root.id + ':', active: structuredClone(include.root.data) }) },
  { ctx: ctx.root, root, include, profile, maximum, ...inspectAfter === undefined ? {} : { inspectAfter }, rootText: readFileSync(include.filename, 'utf8'),
    rootOptions: structuredClone(root.options), rootFiber: root.fiber,
    before: structuredClone(before), after: structuredClone(after), rows, previousRows: structuredClone(include.root.data),
    expectedRoot: { ...root.options, config: includeConfig } })
}

function prepareProfileUpdate(
  ctx: Context, target: Entry, before: PatchOptions[], after: PatchOptions[], maximum?: number, preparedTarget?: EntryConfigUpdatePlan,
): ProfileConfigUpdatePlan {
  const root = profileIncludes.get(ctx)
  const include = root?.subtree
  const profile = ctx.get('profileContext')
  if (root === undefined || !(include instanceof Include) || profile === undefined || root.fiber?.state !== FiberState.ACTIVE) {
    throw new Error('Profile config impact requires an active native root Include')
  }
  const rootText = readFileSync(include.filename, 'utf8')
  const base: unknown = yaml.load(rootText, { schema: entryListSchema })
  if (!Array.isArray(base)) throw new Error('Profile config impact requires a native entry-list root file')
  const includeConfig = root.options.config as Include.Config
  const parentURL = new URL('.', new URL(includeConfig.path, root.parent.tree.ctx.baseUrl)).href
  const preparedBefore = prepareProfilePatches(ctx, structuredClone(before), parentURL, 'dsh', base as EntryOptions[])
  const preparedAfter = prepareProfilePatches(ctx, structuredClone(after), parentURL, 'dsh', base as EntryOptions[])
  const warn = (): never => { throw new Error('Profile config impact contains an unresolved native patch') }
  const current = applyEntryPatches(base as EntryOptions[], structuredClone(preparedBefore), warn)
  const rows = applyEntryPatches(base as EntryOptions[], structuredClone(preparedAfter), warn)
  const entries = current.map(row => include.store[row.id])
  if (!isDeepStrictEqual(current, include.root.data)) throw new Error('Profile config impact has pending patches')
  if (rows.length !== current.length
    || new Set(rows.map(row => row.id)).size !== rows.length || !entries.includes(target)) {
    throw new Error('Profile config impact has an unproven entry set')
  }
  const plans = entries.map((entry, index) => {
    const previous = current[index]
    const next = rows[index]
    if (entry === undefined || previous === undefined || next === undefined
      || entry.parent !== include.root || entry.subtree || entry.subgroup
      || !isDeepStrictEqual(previous, entry.options) || next.id !== previous.id
      || !isDeepStrictEqual({ ...next, config: undefined, ...maximum === undefined ? {} : { disabled: undefined } },
        { ...previous, config: undefined, ...maximum === undefined ? {} : { disabled: undefined } })
      || (entry !== target && !isDeepStrictEqual(next, previous))) {
      throw new Error('Profile config impact has pending patches or an unproven structural change')
    }
    if (entry === target && maximum !== undefined) return preparedTarget ?? entry.prepareOptionsUpdate(next, maximum)
    if (entry === target && entry.fiber?.runtime?.Config !== undefined) entry.assertConfigUpdateSupported()
    return entry.prepareConfigUpdate(next.config)
  })
  const impact = plans.some(plan => plan.impact === 'unknown') ? 'unknown'
    : plans.some(plan => plan.impact === 'remount') ? 'remount'
      : plans.some(plan => plan.impact === 'live') ? 'live' : 'none'
  return new NativeProfilePlan({ entries: Object.freeze(plans), impact }, {
    ctx, root, include, profile, rootText, rootOptions: structuredClone(root.options), rootFiber: root.fiber,
    ...maximum === undefined ? {} : { maximum },
    before: structuredClone(before), after: structuredClone(after), rows, previousRows: structuredClone(include.root.data),
    expectedRoot: { ...root.options, config: { ...includeConfig, patches: preparedAfter } },
  })
}

/**
 * Recheck the plan at the persistence or application boundary without applying old patches.
 * @param plan - native plan prepared for this root.
 * @param written - whether the proposed patch is already on disk; defaults to false.
 * @throws If the plan, effective config, saved profile or root identity drifted.
 */
export function assertProfileConfigUpdate(plan: ProfileConfigUpdatePlan, written = false): void {
  const state = NativeProfilePlan.stateOf(plan)
  if (state === undefined || (plan.restart === undefined && plan.impact !== 'live' && plan.impact !== 'none'
    && !(state.maximum !== undefined && plan.impact === 'remount'
      && plan.entries.every(entry => entry.stopped !== undefined)))) throw new Error('Profile config impact is unproven')
  if (plan.restart !== undefined && state.inspectAfter !== undefined && !isDeepStrictEqual(state.inspectAfter(), state.after)) {
    throw new Error('Profile restart proposed layers are stale')
  }
  if (plan.restart !== undefined && (!isDeepStrictEqual(plan.restart.before, composeProfileEntries(state.ctx, state.before))
    || !isDeepStrictEqual(plan.restart.after, state.rows) || !isDeepStrictEqual(plan.restart.active, state.previousRows)
    || plan.restart.baseUrl !== state.include.ctx.baseUrl || plan.restart.entryPrefix !== state.root.id + ':')) {
    throw new Error('Profile restart composition snapshot is stale')
  }
  if (profileIncludes.get(state.ctx) !== state.root || state.root.fiber !== state.rootFiber) throw new Error('Profile config plan root is stale')
  if (!isDeepStrictEqual(state.root.options, state.rootOptions)) throw new Error('Profile config plan root options are stale')
  if (!isDeepStrictEqual(state.include.root.data, state.previousRows)) throw new Error('Profile config plan child rows are stale')
  if (readFileSync(state.include.filename, 'utf8') !== state.rootText) throw new Error('Profile config plan root file is stale')
  if (!isDeepStrictEqual(readProfilePatches('dsh', state.profile), written ? state.after : state.before)) {
    throw new Error('Profile config plan saved patches are stale')
  }
  for (const entry of plan.entries) entry.entry.assertConfigUpdatePlan(entry)
}

/**
 * Reserve the Loader while persisting and applying exactly this live-only plan.
 * Actual carrier/group/entry mutations are checked before their options or children change.
 * @param plan - supported plan for the current root.
 * @param operation - original persistence and reconcile operation, including all awaited work.
 * @returns The operation's result; failures remain failures even when a native child catches them.
 */
export async function withProfileConfigUpdate<T>(plan: ProfileConfigUpdatePlan, operation: () => Promise<T>): Promise<T> {
  assertProfileConfigUpdate(plan)
  if (plan.restart !== undefined) throw new Error('A graph restart plan cannot apply to the current Loader')
  const state = NativeProfilePlan.stateOf(plan)
  if (state === undefined) throw new Error('Profile config plan is unavailable')
  let started = false
  let failure: Error | undefined
  const checked = <R>(check: () => R): R => {
    try { return check() } catch (error) {
      failure = error instanceof Error ? error : new Error('Profile config guard failed', { cause: error })
      throw failure
    }
  }
  const guard: LoaderUpdateGuard = {
    entry: (entry, options, create) => checked(() => {
      if (entry === state.root) {
        assertProfileConfigUpdate(plan, true)
        if (started || create || !isDeepStrictEqual({ ...entry.options, ...options }, state.expectedRoot)) {
          throw new Error('Profile config carrier differs from the prepared plan')
        }
        started = true
        return undefined
      }
      const prepared = plan.entries.find(row => row.entry === entry)
      const expected = state.rows.find(row => row.id === entry.options.id)
      if (!started || prepared === undefined || expected === undefined || !create || !isDeepStrictEqual(options, expected)) {
        throw new Error('Profile config update exceeded its prepared entry scope')
      }
      return prepared
    }),
    group: (group, rows) => { checked(() => {
      if (!started || group !== state.include.root || !isDeepStrictEqual(rows, state.rows)) {
        throw new Error('Profile config update exceeded its prepared group scope')
      }
    }) },
    create: (group, options) => { checked(() => {
      if (!started || group !== state.include.root || !state.rows.some(row => isDeepStrictEqual(row, options))) {
        throw new Error('Profile config update attempted an unplanned entry')
      }
    }) },
    remove: () => checked(() => { throw new Error('Live profile config update cannot stop entries') }),
  }
  const scope = new AsyncLocalStorage<LoaderUpdateGuard>()
  const detach = state.maximum === undefined ? undefined : state.ctx.logger.exporter({ levels: { default: 0 }, export(message) {
    if (message.type !== 'error') return
    let fiber = message.fiber?.deref()
    while (fiber !== undefined) {
      if (plan.entries.some(row => row.impact === 'remount' && row.entry === fiber?.entry)) {
        failure ??= new Error('Native plugin activation or disposal reported a failure')
        return
      }
      if (fiber.parent.fiber === fiber) return
      fiber = fiber.parent.fiber
    }
  } })
  try {
    return await state.ctx.loader.withUpdateGuard(guard, async () => {
      const result = await operation()
      if (failure !== undefined) throw failure
      return result
    }, scope)
  } finally {
    await detach?.()
    scope.disable()
  }
}
