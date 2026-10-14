/** Account-owned permission presentation over the exact PG knob fold. */
import { Context } from '@deepseek-ai/cordis'
import type { SessionProjectionBaseline } from '@deepseek-ai/dsh-api-session-controller/types'
import type {} from '@deepseek-ai/dsh-permission-presets'
import { z } from 'zod'
import { PlatformError } from '../contracts.ts'

/** Private committed knob overrides; defaults and names belong to the live native composition. */
export const nativePermissionKnobs = z.object({ preset: z.string().nullable(),
  sandbox: z.enum(['read-only', 'workspace-write', 'danger-full-access']).nullable(),
  approval: z.enum(['ask', 'never']).nullable() }).strict()

const baseline = z.object({ asOfSeq: z.number().int().min(-1), values: z.record(z.string(), z.json()),
  permissionKnobs: nativePermissionKnobs.optional() }).loose()

/** Resolve the private PG fold through the maintained native permission catalog.
 * @param ctx Account-owned native Context, or absence for the legacy shared Host.
 * @param raw PG projection baseline at its committed watermark.
 * @returns Only original public projection fields, with the native current permission value.
 */
export function nativePermissionProjection(ctx: Context | undefined, raw: unknown): SessionProjectionBaseline {
  const value = baseline.parse(raw)
  if (ctx === undefined) return { asOfSeq: value.asOfSeq, values: value.values }
  const service = ctx.get('permissionPresets')
  if (service === undefined || value.permissionKnobs === undefined) throw new PlatformError(503, 'native_permission_projection_unavailable')
  return { asOfSeq: value.asOfSeq, values: { ...value.values,
    permissions: { currentValue: service.viewKnobs(value.permissionKnobs).currentValue } } }
}
