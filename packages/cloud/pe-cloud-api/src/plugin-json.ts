/** Closed, bounded catalog requests; this module grants no native update authority. */
import { snapshotJsonValue, type JsonValue } from '@deepseek-ai/dsh-util-values'
import { brandString } from '@deepseek-ai/dsh-brand'
import type { OwnerEpoch } from '@deepseek-ai/dsh-pe-cloud-runtime/types'
import type { PluginEditToken } from './save-hooks.ts'
import type { PluginChangeRequest, PluginControlLimits, PluginCurrentRequest, PluginOperation } from './plugin-types.ts'
import { firstScreenJsonBytes } from './first-screen-json.ts'
import { CloudApiError } from './errors.ts'

/** Example deployment data for the preinstalled reminder; this value grants no approval or writer authority. */
export const APPROVED_PLUGIN_CONTROL = Object.freeze({ id: 'repeat-tool-reminder',
  entryId: 'include:repeat-tool-reminder', moduleName: '@deepseek-ai/dsh-repeat-tool-reminder',
  packageName: '@deepseek-ai/dsh-repeat-tool-reminder', packageVersion: '0.2.1-rc.2',
  control: Object.freeze({ selectionTarget: Object.freeze({ kind: 'entry' as const, id: 'include:repeat-tool-reminder' }),
    operations: Object.freeze(['enabled', 'configure'] as const), maxImpact: 'local' as const,
    fields: Object.freeze([Object.freeze(['thresholds'])]) }) })
/** Exact authenticated unary RPC group; native manager/package writers remain closed. */
export const PLUGIN_RPC_ENDPOINTS: readonly string[] = Object.freeze(['cloudPlugins/current', 'cloudPlugins/change'])
function invalid(): never { throw new CloudApiError('cloud/forbidden', 'The approved plugin request has invalid or excessive fields.') }
function record(value: unknown, keys: readonly string[]): Record<string, unknown> {
  if (value === null || typeof value !== 'object' || Array.isArray(value)
    || Object.keys(value).length !== keys.length || Object.keys(value).some(key => !keys.includes(key))) invalid()
  return value as Record<string, unknown>
}
/** Detach explicit finite limits at the deployment parser.
 * @param input Deployment-owned byte limits.
 * @returns Frozen validated bounds.
 */
export function pluginControlLimits(input: PluginControlLimits): Readonly<PluginControlLimits> {
  for (const value of Object.values(input)) if (!Number.isSafeInteger(value) || value < 1) {
    throw new CloudApiError('cloud/invalid-config', 'Approved plugin controls require finite positive byte limits.')
  }
  return Object.freeze({ ...input })
}
/** Detach literal JSON; Loader expressions and prototype-control keys are never admitted as ordinary field values.
 * @param value Caller or original approved raw field.
 * @returns Detached JSON accepted by the ordinary field carrier.
 */
export function pluginLiteralValue(value: unknown): JsonValue {
  const detached: unknown = snapshotJsonValue(value)
  if (detached === undefined) invalid()
  const pending: unknown[] = [detached]
  while (pending.length > 0) {
    const item = pending.pop()
    if (item === null || typeof item !== 'object') continue
    if (Object.keys(item).some(key => ['__jsExpr', '__proto__', 'prototype', 'constructor'].includes(key))) invalid()
    for (const child of Object.values(item) as unknown[]) pending.push(child)
  }
  return detached as JsonValue
}
/** Strict parsing of the original carrier value before any save or Peer handoff.
 * @param input Required deployment limits.
 * @returns Closed request parsers.
 */
export function pluginRequests(input: PluginControlLimits): {
  current(value: unknown): PluginCurrentRequest
  change(value: unknown): PluginChangeRequest
} {
  const limits = pluginControlLimits(input)
  const text = (value: unknown, maximum = limits.maxRequestBytes): string => {
    if (typeof value !== 'string' || value.length === 0 || Buffer.byteLength(value) > maximum) invalid()
    return value
  }
  const reference = (row: Record<string, unknown>): PluginCurrentRequest => {
    return { id: text(row.id) }
  }
  return {
    current(value) { firstScreenJsonBytes(value, limits.maxRequestBytes); return reference(record(value, ['id'])) },
    change(value) {
      firstScreenJsonBytes(value, limits.maxRequestBytes)
      const row = record(value, ['id', 'version', 'mode', 'operation']), version = record(row.version, ['epoch', 'editToken'])
      if (row.mode !== 'if-idle' && row.mode !== 'stop-and-apply') invalid()
      const raw = row.operation
      if (raw === null || typeof raw !== 'object' || !('kind' in raw)) invalid()
      let operation: PluginOperation
      if (raw.kind === 'enabled') {
        const fields = record(raw, ['kind', 'enabled'])
        if (typeof fields.enabled !== 'boolean') invalid()
        operation = Object.freeze({ kind: 'enabled', enabled: fields.enabled })
      } else if (raw.kind === 'selected') {
        const fields = record(raw, ['kind', 'selected'])
        if (typeof fields.selected !== 'boolean') invalid()
        operation = Object.freeze({ kind: 'selected', selected: fields.selected })
      } else {
        const fields = record(raw, ['kind', 'path', 'value'])
        if (fields.kind !== 'configure' || !Array.isArray(fields.path) || fields.path.length === 0) invalid()
        const path = fields.path.map(segment => text(segment))
        if (path.some(segment => ['__proto__', 'prototype', 'constructor'].includes(segment))) invalid()
        operation = Object.freeze({ kind: 'configure', path: Object.freeze(path), value: pluginLiteralValue(fields.value) })
      }
      return Object.freeze({ ...reference(row), mode: row.mode, operation, version: Object.freeze({
        epoch: brandString<OwnerEpoch>(text(version.epoch, limits.maxVersionBytes)),
        editToken: brandString<PluginEditToken>(text(version.editToken, limits.maxVersionBytes)),
      }) })
    },
  }
}
