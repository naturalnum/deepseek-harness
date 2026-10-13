/** Native Settings forms backed by tenant preferences, independent of the shared Profile. */
import { Config as DeveloperConfig } from '@deepseek-ai/dsh-client-ui-settings'
import { Config as WelcomeConfig } from '@deepseek-ai/dsh-client-ui-settings-general'
import { z } from 'zod'
import { PlatformError } from '../contracts.ts'

const namespace = z.enum(['ui-settings', 'ui-settings-general'])
const stored = z.object({ value: z.record(z.string(), z.json()), revision: z.number().int().positive() }).strict()
const operation = z.discriminatedUnion('op', [
  z.object({ op: z.literal('set'), path: z.array(z.string()).length(1), value: z.json() }).strict(),
  z.object({ op: z.literal('unset'), path: z.array(z.string()).length(1) }).strict(),
])
type Call = (path: string, token: string, input: unknown) => Promise<unknown>
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
