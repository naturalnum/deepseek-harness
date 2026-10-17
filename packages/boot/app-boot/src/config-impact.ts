/** Live-only profile plans bind the existing patch composition to Loader's actual update checks. */
import { readFileSync } from 'node:fs'
import { isDeepStrictEqual } from 'node:util'
import { FiberState, type Context } from '@deepseek-ai/cordis'
import type { Entry, EntryConfigUpdatePlan, EntryOptions, LoaderUpdateGuard } from '@deepseek-ai/cordis-plugin-loader'
import Include, { entryListSchema, type PatchOptions } from '@deepseek-ai/cordis-plugin-include'
import * as yaml from 'js-yaml'
import { composeEntries } from './profile.ts'
import { readProfilePatches, type ProfileContext } from './profile-context.ts'
import { prepareProfilePatches } from './compatibility-preflight.ts'

/** Root Includes owned by the public mount operation. @internal */
export const profileIncludes = new WeakMap<Context, Entry>()

/** An opaque profile plan; remount and unknown stop closures are not granted by this slice. */
export interface ProfileConfigUpdatePlan {
  /** Native per-entry decisions and identity/version bindings. */
  readonly entries: readonly EntryConfigUpdatePlan[]
  /** Most restrictive native decision for the proposed single-entry edit. */
  readonly impact: EntryConfigUpdatePlan['impact']
}

interface PlanState {
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

const states = new WeakMap<ProfileConfigUpdatePlan, PlanState>()

/**
 * Prepare one config-only edit over an already-applied flat, empty-file root Include.
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
  const root = profileIncludes.get(ctx)
  const include = root?.subtree
  const profile = ctx.get('profileContext')
  if (root === undefined || !(include instanceof Include) || profile === undefined || root.fiber?.state !== FiberState.ACTIVE) {
    throw new Error('Profile config impact requires an active native root Include')
  }
  const rootText = readFileSync(include.filename, 'utf8')
  const base: unknown = yaml.load(rootText, { schema: entryListSchema })
  if (!Array.isArray(base) || base.length !== 0) throw new Error('Profile config impact supports an empty root file only')
  const includeConfig = root.options.config as Include.Config
  const parentURL = new URL('.', new URL(includeConfig.path, root.parent.tree.ctx.baseUrl)).href
  const preparedBefore = prepareProfilePatches(ctx, structuredClone(before), parentURL, 'dsh')
  const preparedAfter = prepareProfilePatches(ctx, structuredClone(after), parentURL, 'dsh')
  const current = composeEntries([preparedBefore])
  const rows = composeEntries([preparedAfter])
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
      || !isDeepStrictEqual({ ...next, config: undefined }, { ...previous, config: undefined })
      || (entry !== target && !isDeepStrictEqual(next, previous))) {
      throw new Error('Profile config impact has pending patches or an unproven structural change')
    }
    if (entry.fiber?.runtime?.Config !== undefined) entry.assertConfigUpdateSupported()
    return entry.prepareConfigUpdate(next.config)
  })
  const impact = plans.some(plan => plan.impact === 'unknown') ? 'unknown'
    : plans.some(plan => plan.impact === 'remount') ? 'remount'
      : plans.some(plan => plan.impact === 'live') ? 'live' : 'none'
  const plan: ProfileConfigUpdatePlan = Object.freeze({ entries: Object.freeze(plans), impact })
  states.set(plan, {
    ctx, root, include, profile, rootText, rootOptions: structuredClone(root.options), rootFiber: root.fiber,
    before: structuredClone(before), after: structuredClone(after), rows, previousRows: structuredClone(include.root.data),
    expectedRoot: { ...root.options, config: { ...includeConfig, patches: preparedAfter } },
  })
  return plan
}

/**
 * Recheck the plan at the persistence or application boundary without applying old patches.
 * @param plan - native plan prepared for this root.
 * @param written - whether the proposed patch is already on disk; defaults to false.
 * @throws If the plan, effective config, saved profile or root identity drifted.
 */
export function assertProfileConfigUpdate(plan: ProfileConfigUpdatePlan, written = false): void {
  const state = states.get(plan)
  if (state === undefined || (plan.impact !== 'live' && plan.impact !== 'none')) throw new Error('Profile config impact is unproven')
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
  const state = states.get(plan)
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
  return state.ctx.loader.withUpdateGuard(guard, async () => {
    const result = await operation()
    if (failure !== undefined) throw failure
    return result
  })
}
