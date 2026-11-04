/** Root-selected Office declarations use only the original launch overlays and account binding. */
import { posix } from 'node:path'
import { isDeepStrictEqual } from 'node:util'
import type { Context } from '@deepseek-ai/cordis'
import { composeProfileEntries, readProfilePatches, type ProfileContext } from '@deepseek-ai/dsh-app-boot'
import { accountPresetConfigDigest } from './account-policy.ts'
import { AccountRuntimeError } from './errors.ts'
import type { AccountId } from './types.ts'
import type { RuntimeRootConfig } from './root-config.ts'

type Row = ReturnType<typeof composeProfileEntries>[number]
type Json = Record<string, unknown>
const targets = [
  { id: 'skill-office', name: '@deepseek-ai/dsh-skill-office', selection: 'office', invocation: 'invocation',
    mutable: ['invocation', 'cli', 'executionRoot', 'systemTools'] },
  { id: 'bundled-report-skills', name: '@deepseek-ai/dsh-skill-filesystem', selection: 'reports', invocation: 'bundledInvocation',
    mutable: ['bundledInvocation', 'bundledExecutionRoot', 'bundledInstructions'] },
] as const
function refuse(): never { throw new AccountRuntimeError('cloud/invalid-config', 'Office canary requires its exact original two-provider declaration.') }
function record(value: unknown): value is Json {
  return value !== null && typeof value === 'object' && !Array.isArray(value)
    && Object.getPrototypeOf(value) === Object.prototype
}
function freeze(value: unknown): void {
  if (value !== null && typeof value === 'object') {
    if (Object.hasOwn(value, '__jsExpr')) refuse()
    for (const child of Object.values(value)) freeze(child)
    Object.freeze(value)
  }
}
function path(value: unknown, maximum: number): void {
  if (typeof value !== 'string' || !posix.isAbsolute(value) || posix.normalize(value) !== value
    || value.includes('\0') || value.includes('\\') || Buffer.byteLength(value) > maximum) refuse()
}
function invocation(config: Json, field: string, enabled: boolean): void {
  const value = config[field]
  if (!record(value) || Object.keys(value).length !== 2
    || value.modelInvocable !== enabled || value.userInvocable !== enabled) refuse()
}

/** Private per-request declaration, retained by the original Factory recipe and policy facts. */
export interface OfficeProfileSelection {
  readonly overlays: ProfileContext['overlays']
  /** Validate actual base plus saved patches before pinning the installed two-entry facts. */
  assertEntries(ctx: Context): readonly { readonly id: string; readonly name: string; readonly config: Json }[]
}

/** Resolve one immutable Root-only selection; this does not certify an image or publish an account. */
export function selectOfficeProfile(config: RuntimeRootConfig, accountId: AccountId): OfficeProfileSelection | undefined {
  const selected = config.officeCanary
  if (selected === undefined) return undefined
  const maximum = config.accountPolicy.maxPresetConfigBytes, maxEntries = config.native.maxEntries
  const enabled = selected.accountId === accountId
  if (selected.accountId.length === 0 || Buffer.byteLength(selected.accountId) > config.accountPolicy.maxPolicyStringBytes) refuse()
  const values = targets.map((target) => {
    const row = selected[target.selection]
    if (Buffer.byteLength(row.configJson) > maximum) refuse()
    let value: unknown
    try { value = JSON.parse(row.configJson) as unknown } catch { refuse() }
    if (!record(value)) refuse()
    accountPresetConfigDigest(value, maximum)
    invocation(value, target.invocation, true)
    if (target.selection === 'office') {
      if (Object.hasOwn(value, 'cli') || !record(value.systemTools)
        || Object.keys(value.systemTools).some(key => !['soffice', 'pdftoppm', 'wordRefresh'].includes(key))) refuse()
      path(value.executionRoot, config.paths.maxPathBytes)
      for (const key of ['soffice', 'pdftoppm', 'wordRefresh']) path(value.systemTools[key], config.paths.maxPathBytes)
    } else {
      path(value.bundledExecutionRoot, config.paths.maxPathBytes)
      if (typeof value.bundledInstructions !== 'string' || value.bundledInstructions.trim().length === 0) refuse()
    }
    freeze(value)
    return { ...target, baseline: row.baselineConfigSha256, config: value }
  })
  const overlays = enabled ? values.map(row => ({ id: row.id, config: row.config })) : []
  freeze(overlays)
  return Object.freeze({ overlays, assertEntries(ctx: Context) {
    const profile = ctx.get('profileContext')
    if (profile === undefined || !isDeepStrictEqual(profile.overlays, overlays)
      || ctx.get('peAccount')?.accountId !== accountId) refuse()
    // composeProfileEntries must read the mounted original Include base, not a patch-only context.
    if (![...ctx.loader.entries()].some(row => row.options.id === 'include' && row.subtree !== undefined)) refuse()
    const baseline = composeProfileEntries(ctx, readProfilePatches('dsh', { ...profile, overlays: [] }))
    const actual = composeProfileEntries(ctx, readProfilePatches('dsh', profile))
    const find = (rows: Row[], id: string, name: string): Json => {
      if (rows.length > maxEntries) refuse()
      const matches = rows.filter(row => row.id === id), entry = matches[0]
      if (matches.length !== 1 || entry === undefined || entry.name !== name || entry.group === true
        || entry.disabled !== undefined && entry.disabled !== false || !record(entry.config)) refuse()
      return entry.config
    }
    return values.map((row) => {
      const original = find(baseline, row.id, row.name)
      if (accountPresetConfigDigest(original, maximum) !== row.baseline) refuse()
      invocation(original, row.invocation, false)
      if (original.packagedBundles !== true || typeof (row.selection === 'office' ? original.assetRoot : original.bundledSkillDir) !== 'string'
        || row.selection === 'reports' && (original.providerName !== 'dsh-reports' || original.includeDefaultRoots !== false || original.watch !== false)) refuse()
      const retained = (value: Json): Json => Object.fromEntries(Object.entries(value).filter(([key]) =>
        !(row.mutable as readonly string[]).includes(key)))
      if (!isDeepStrictEqual(retained(original), retained(row.config))) refuse()
      const expected = enabled ? row.config : original, effective = find(actual, row.id, row.name)
      if (!isDeepStrictEqual(effective, expected)) refuse()
      return { id: row.id, name: row.name, config: expected }
    })
  } })
}
