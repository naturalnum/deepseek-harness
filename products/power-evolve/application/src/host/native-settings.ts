/** Native Settings forms backed by tenant preferences, independent of the shared Profile. */
import { Config as DeveloperConfig } from '@deepseek-ai/dsh-client-ui-settings'
import { Config as WelcomeConfig } from '@deepseek-ai/dsh-client-ui-settings-general'
import { z } from 'zod'
import type { Context } from '@deepseek-ai/cordis'
import type {} from '@deepseek-ai/dsh-api-gateway'
import { PlatformError } from '../contracts.ts'
import { modelSettingsNamespace, modelSettingsWrite } from '@power-evolve/contracts/model-settings'

const namespace = z.enum(['ui-settings', 'ui-settings-general'])
const stored = z.object({ value: z.record(z.string(), z.json()), revision: z.number().int().positive() }).strict()
const operation = z.discriminatedUnion('op', [
  z.object({ op: z.literal('set'), path: z.array(z.string()).length(1), value: z.json() }).strict(),
  z.object({ op: z.literal('unset'), path: z.array(z.string()).length(1) }).strict(),
])
type Call = (path: string, token: string, input: unknown) => Promise<unknown>
type WireResult = Awaited<ReturnType<Context['typertGateway']['wireRpc']['invoke']>>
const searchNamespace = 'web-search-deepseek', searchEntry = 'power-evolve-web-search'

/** Join native model descriptors with other settings without exposing the shared Profile.
 * @param base Original non-model settings describe response.
 * @param models Original tenant model describe response.
 * @returns One native describe response retaining the authoritative model schemas and revisions.
 */
export function nativeModelSettingsDescribe(base: unknown, models: unknown): unknown {
  const describe = z.object({ writable: z.boolean(), hasDocument: z.boolean(),
    namespaces: z.array(z.object({ ns: z.string() }).loose()) }).loose()
  const original = describe.parse(base), tenant = describe.parse(models)
  return { ...original, writable: original.writable || tenant.writable,
    namespaces: [...original.namespaces.filter(row => !modelSettingsNamespace.safeParse(row.ns).success), ...tenant.namespaces] }
}

/** Translate an original native model Settings write without accepting credential literals.
 * @param call Tenant-authorized Platform caller.
 * @param method Native update, replace or mutate method.
 * @param raw Exact native wire arguments.
 * @param token Current browser credential.
 * @returns The authoritative namespace view after its revisioned write.
 */
export function nativeModelSettingsWrite(call: Call, method: string, raw: unknown, token: string): Promise<unknown> {
  const common = z.object({ ns: modelSettingsNamespace, expectedRevision: z.number().int().positive().optional() })
  const mode = method.slice('settings/'.length)
  let input: { ns: z.infer<typeof modelSettingsNamespace>; value: unknown; expectedRevision?: number | undefined }
  if (mode === 'update') {
    const { patch, ...rest } = common.extend({ patch: z.record(z.string(), z.json()) }).strict().parse(raw)
    input = { ...rest, value: patch }
  } else if (mode === 'replace') {
    const { section, ...rest } = common.extend({ section: z.record(z.string(), z.json()) }).strict().parse(raw)
    input = { ...rest, value: section }
  } else if (mode === 'mutate') {
    const { ops, ...rest } = common.extend({ ops: modelSettingsWrite.shape.value.options[1] }).strict().parse(raw)
    input = { ...rest, value: ops }
  } else throw new PlatformError(403, 'native_settings_rejected')
  return call('/native/models/settings/write', token, modelSettingsWrite.parse({ ...input, mode }))
}

/** Preserve the upstream Search page namespace while the owned Profile contains a distinct Platform provider entry.
 * @param args Original native Settings arguments, validated by their original Remote descriptor after routing.
 * @returns The exact arguments with only the known Search entry identity translated.
 */
export function nativeTenantSettingsArguments(args: Record<string, unknown>): Record<string, unknown> {
  return args.ns === searchNamespace ? { ...args, ns: searchEntry } : args
}

/** Project the real original Settings result back to the maintained Search UI namespace without synthesizing a descriptor.
 * @param method Original native Settings method.
 * @param result Original Gateway result, including unchanged refusals and schema/revision/value fields.
 * @returns The same result with only the mounted Search descriptor's namespace translated.
 */
export function nativeTenantSettingsResult(method: string, result: WireResult): WireResult {
  if (!result.ok) return result
  const descriptor = (value: unknown): unknown => {
    const row = z.object({ ns: z.string() }).loose().parse(value)
    return row.ns === searchEntry ? { ...row, ns: searchNamespace } : value
  }
  if (method === 'settings/describe') {
    const value = z.object({ namespaces: z.array(z.unknown()) }).loose().parse(result.value)
    return { ...result, value: { ...value, namespaces: value.namespaces.map(descriptor) } }
  }
  if (['settings/update', 'settings/replace', 'settings/mutate'].includes(method)) {
    return { ...result, value: descriptor(result.value) }
  }
  return result
}

/** Preserve the original Search UI subscription identity for actual Settings changes.
 * @param frame Original native event frame.
 * @returns The same notification with only its known Search namespace translated.
 */
export function nativeTenantSettingsEvent(frame: unknown): unknown {
  const value = z.object({ type: z.literal('emit'), event: z.literal('settings/document-updated'),
    args: z.tuple([z.string()]).rest(z.unknown()) }).loose().safeParse(frame)
  return value.success && value.data.args[0] === searchEntry
    ? { ...value.data, args: [searchNamespace, ...value.data.args.slice(1)] } : frame
}
function view(ns: z.infer<typeof namespace>, value: z.infer<typeof stored>) {
  const config = ns === 'ui-settings' ? DeveloperConfig : WelcomeConfig
  return { ns, autoGenerate: false, schema: config.toJSON(),
    value: ns === 'ui-settings' ? { enabled: true, ...value.value } : value.value,
    user: value.value, applies: 'live', secrets: [], revision: value.revision }
}

/** Route only native presentation preferences; Profile and provider credential writes refuse.
 * @param call Tenant-authorized Platform caller.
 * @param method Native settings Remote method.
 * @param raw Exact wire arguments.
 * @param token Current browser credential.
 * @returns Native Settings descriptor or revisioned write response.
 */
export async function nativeSettings(call: Call, method: string, raw: unknown, token: string): Promise<unknown> {
  if (method === 'settings/describe') {
    z.object({}).strict().parse(raw)
    const namespaces = await Promise.all(namespace.options.map(async ns => view(ns, stored.parse(await call('/native/preferences/read', token, { ns })))))
    return { writable: true, hasDocument: false, namespaces }
  }
  const revision = z.number().int().positive().optional()
  let ns: z.infer<typeof namespace>, value: unknown, expectedRevision: number | undefined
  const mode = method.slice('settings/'.length)
  if (mode === 'update' || mode === 'replace') {
    if (mode === 'update') {
      const parsed = z.object({ ns: namespace, patch: z.record(z.string(), z.json()), expectedRevision: revision }).strict().parse(raw)
      ns = parsed.ns; value = parsed.patch; expectedRevision = parsed.expectedRevision
    } else {
      const parsed = z.object({ ns: namespace, section: z.record(z.string(), z.json()), expectedRevision: revision }).strict().parse(raw)
      ns = parsed.ns; value = parsed.section; expectedRevision = parsed.expectedRevision
    }
  } else if (mode === 'mutate') {
    const parsed = z.object({ ns: namespace, ops: z.array(operation).max(32), expectedRevision: revision }).strict().parse(raw)
    ns = parsed.ns; value = parsed.ops; expectedRevision = parsed.expectedRevision
  } else throw new PlatformError(403, 'native_settings_rejected')
  return view(ns, stored.parse(await call('/native/preferences/write', token, { ns, mode, value,
    ...(expectedRevision === undefined ? {} : { expectedRevision }) })))
}
