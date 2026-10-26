/** Literal JSON drafts for approved ordinary fields; native Config remains the validator. */
import { snapshotJsonValue, type JsonValue } from '@deepseek-ai/dsh-util-values'
import type { AccountPluginField } from './types.ts'
import { ClientFailure } from '../../errors.ts'

/** Compare approved path segments without interpreting dotted labels.
 * @param left First native path.
 * @param right Second native path.
 * @returns Whether both paths name the same approved field.
 */
export function samePluginPath(left: readonly string[], right: readonly string[]): boolean {
  return left.length === right.length && left.every((part, index) => part === right[index])
}
/** Detach a literal field value without admitting Loader expressions or prototype keys.
 * @param input Parsed JSON draft.
 * @returns Detached literal JSON; no native schema validation is implied.
 */
export function pluginLiteralDraft(input: unknown): JsonValue {
  const value = snapshotJsonValue(input)
  if (value === undefined) throw new ClientFailure('closed')
  const pending: unknown[] = [value]
  while (pending.length > 0) {
    const item = pending.pop()
    if (item === undefined || item === null || typeof item !== 'object') continue
    for (const [key, child] of Object.entries(item)) {
      if (['__jsExpr', '__proto__', 'prototype', 'constructor'].includes(key)) throw new ClientFailure('closed')
      pending.push(child)
    }
  }
  return value as JsonValue
}
/** Read native schema annotations throughout an approved field, including referenced definitions.
 * @param field Ordinary field metadata; no Loader builder or code is evaluated.
 * @returns Native write permission restricted by secret/volatile safeguards, plus disclosure metadata.
 */
export function pluginFieldPolicy(field: AccountPluginField): {
  readonly secret: boolean
  readonly volatile: boolean
  readonly writable: boolean
} {
  let secret = field.secrets.length > 0 || field.readOnlyReason === 'secret'
  let volatile = field.readOnlyReason === 'live'
  const pending: JsonValue[] = [field.schema]
  while (pending.length > 0) {
    const value = pending.pop()
    if (value === undefined || value === null || typeof value !== 'object') continue
    if (!Array.isArray(value)) {
      const meta = value['x-cordis']
      if (meta !== null && typeof meta === 'object' && !Array.isArray(meta)) {
        secret ||= meta.role === 'secret' || meta.role === 'password'
        volatile ||= meta.volatile === true
      }
      secret ||= value.writeOnly === true
    }
    pending.push(...Object.values(value))
  }
  return { secret, volatile, writable: field.writable && !secret && !volatile }
}
/** Stage the raw original value only when its metadata permits disclosure.
 * @param field Selected original approved field.
 * @returns Literal JSON text, or an empty draft for absent or concealed values.
 */
export function pluginFieldDraft(field: AccountPluginField): string {
  return pluginFieldPolicy(field).secret || field.value === undefined ? '' : JSON.stringify(field.value, null, 2)
}
/** Check JSON carrier syntax only; the Host owns native validation.
 * @param text Current draft text.
 * @returns Whether an explicit literal JSON value is available for submission.
 */
export function validPluginDraft(text: string): boolean {
  try { pluginLiteralDraft(JSON.parse(text)); return true }
  catch (_invalid) { return false }
}
