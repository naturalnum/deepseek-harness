/** Launcher-owned profile locations and composition inputs. */
import { join } from 'node:path'
import { composeEntries, loadProfileDirectory, readProfileManifest, PROFILE_PATCH_FILENAME, type Profile } from './profile.ts'
import { loadOptionalPatches } from './index.ts'
import type { PatchOptions } from '@deepseek-ai/cordis-plugin-include'
import type { EntryOptions } from '@deepseek-ai/cordis-plugin-loader'

/** Application-owned package manager executable; environment applies only to package operations. */
export interface ProfilePnpmInvocation {
  readonly command: string
  readonly args: readonly string[]
  readonly env: Readonly<Record<string, string>>
}

/** Current profile facts; scheduling and mutation belong to their callers. */
export interface ProfileContext {
  readonly name: string
  /** Packaged applications supply their bundled runtime instead of a PATH executable. */
  readonly packageManager?: ProfilePnpmInvocation
  readonly dir: string
  readonly patchPath: string
  readonly installAnchor: string
  readonly cwd: string
  readonly home: string
  /** Bundle packages used to start this process, before any persisted edits. */
  readonly startedBundles: readonly string[]
  /** Parsed command-line overlays, applied above profile and home patches. */
  readonly overlays: readonly PatchOptions[]
  /** Launch-time DSH_TELEMETRY_DISABLED value; any non-empty value opts out. */
  readonly telemetryDisabledEnv: string | undefined
}

declare module '@deepseek-ai/cordis' {
  interface Context {
    /** Present only in a profile launched by dsh. */
    profileContext: ProfileContext
  }
}

const TELEMETRY_ROW_ID = 'session-telemetry-otel'

/**
 * Resolve the telemetry opt-out switch into its boot patch. ANY non-empty
 * value (including `'0'`/`'false'`) disables: a privacy switch prefers
 * off-by-mistake over on-by-mistake. A composition without the telemetry row
 * exports nothing, so the switch is then trivially satisfied and no patch is
 * generated — custom profiles need not mount telemetry to run with the
 * switch set.
 * @param disabledEnv - the raw `DSH_TELEMETRY_DISABLED` value (`undefined` when unset).
 * @param hasRow - whether the composition carries the telemetry row.
 * @returns the disable patch, or `undefined` when no hard-disable patch is required.
 */
export function resolveTelemetryPatch(disabledEnv: string | undefined, hasRow: boolean): PatchOptions | undefined {
  if ((disabledEnv ?? '') === '' || !hasRow) return undefined
  return { id: TELEMETRY_ROW_ID, disabled: true }
}

/** Read current bundle and user layers with the launch-time overlays.
 * Deployment-unavailable bundle layers and modules are omitted in memory; saved selections and patches remain unchanged.
 * @param binName Diagnostic prefix for malformed or missing configuration.
 * @param context Data supplied by the profile launcher.
 * @param initialProfile Already loaded startup profile; omitted reads the current files.
 * @returns Detached ordered patches; this function does not update the Loader.
 */
export function readProfilePatches(binName: string, context: ProfileContext, initialProfile?: Profile): PatchOptions[] {
  const profile = initialProfile ?? loadProfileDirectory(binName, context.dir, context.installAnchor, { userLayer: false })
  const user = [
    ...(initialProfile?.patches ?? loadOptionalPatches(binName, context.patchPath) ?? []),
    ...(loadOptionalPatches(binName, join(context.home, PROFILE_PATCH_FILENAME)) ?? []),
    ...context.overlays,
  ]
  const patches = structuredClone([...profile.layers.flatMap(layer => layer.patches), ...user])
  const telemetryPatch = resolveTelemetryPatch(context.telemetryDisabledEnv,
    composeEntries([patches]).some(row => row.id === TELEMETRY_ROW_ID))
  if (telemetryPatch !== undefined) patches.push(telemetryPatch)
  const manager = composeEntries([patches]).find(row => row.id === 'plugin-manager' || row.name === '@deepseek-ai/dsh-plugin-manager')
  const config: unknown = manager?.config
  if (typeof config !== 'object' || config === null || !('unavailablePackages' in config)
    || config.unavailablePackages === undefined) return patches
  const names: unknown = config.unavailablePackages
  if (!Array.isArray(names) || !names.every((name): name is string => typeof name === 'string')) {
    throw new Error('Plugin deployment unavailablePackages must be an array of package names')
  }
  if (names.length === 0) return patches
  const unavailable = new Set<string>(names)
  const blocked = (name: string | undefined): boolean => name !== undefined
    && unavailable.has(name.split('/').slice(0, name.startsWith('@') ? 2 : 1).join('/'))
  const containsBlocked = (rows: readonly PatchOptions[]): boolean => rows.some(row => blocked(row.name)
    || row.insert !== undefined && containsBlocked(row.insert)
    || row.group === true && Array.isArray(row.config) && containsBlocked(row.config))
  const omitted = profile.layers.filter(layer => blocked(layer.packageName)
    || blocked(readProfileManifest(binName, layer.packageDir).name) || containsBlocked(layer.patches))
  const omittedIds = new Set<string>()
  const remember = (rows: readonly PatchOptions[]): void => {
    for (const row of rows) {
      if (row.name !== undefined && row.id !== undefined) omittedIds.add(row.id)
      if (row.insert !== undefined) remember(row.insert)
      if (row.group === true && Array.isArray(row.config)) remember(row.config)
    }
  }
  for (const layer of omitted) remember(layer.patches)
  const retained = structuredClone([
    ...profile.layers.filter(layer => !omitted.includes(layer)).flatMap(layer => layer.patches), ...user,
    ...telemetryPatch === undefined ? [] : [telemetryPatch],
  ])
  const keep = (row: PatchOptions): boolean => !blocked(row.name)
    && !(row.name === undefined && row.id !== undefined && omittedIds.has(row.id))
  const pruneEntries = (rows: readonly EntryOptions[]): EntryOptions[] => rows.filter(keep).map(row => ({ ...row,
    ...row.group !== true || !Array.isArray(row.config) ? {} : { config: pruneEntries(row.config) } }))
  const prune = (rows: readonly PatchOptions[]): PatchOptions[] => rows.flatMap((row) => {
    if (!keep(row)) return []
    return [{ ...row, ...row.insert === undefined ? {} : { insert: pruneEntries(row.insert) },
      ...row.group !== true || !Array.isArray(row.config) ? {} : { config: prune(row.config) } }]
  })
  return prune(retained)
}
