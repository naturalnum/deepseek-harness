/** Shared bounded approval projection for original native scalar Settings forms. */
import z from '@deepseek-ai/schemastery'
import { isJsonValue, type JsonValue } from '@deepseek-ai/dsh-util-values'
import type { SettingsDescribeValue, SettingsNamespaceView } from '@deepseek-ai/dsh-settings/types'
import { CloudApiError } from './errors.ts'
import type { ApprovedConfigurationField, SettingsExposure } from './types.ts'

function unavailable(): never {
  throw new CloudApiError('cloud/account-unavailable', 'The approved native settings form is unavailable.')
}

/** Compare every approved field with the exact existing C04 namespace declarations.
 * @param fields Frozen approved fields.
 * @param settings Actual manifest declarations.
 * @returns Whether both finite sets agree, independently of their order.
 */
export function approvedSettingsMatch(fields: readonly ApprovedConfigurationField[], settings: readonly SettingsExposure[]): boolean {
  const expected = new Map<string, Set<string>>()
  for (const field of fields) {
    const names = expected.get(field.namespace) ?? new Set<string>()
    if (names.has(field.field)) return false
    names.add(field.field); expected.set(field.namespace, names)
  }
  if (settings.length !== expected.size) return false
  const seen = new Set<string>()
  return settings.every((row) => {
    const names = expected.get(row.namespace)
    if (seen.has(row.namespace) || names === undefined || names.size !== row.fields.length) return false
    seen.add(row.namespace)
    return row.fields.every(field => names.delete(field))
  })
}

function scalar(schema: z<unknown>, maximum: number): void {
  const pending = [schema]
  let visited = 0
  while (pending.length > 0) {
    const next = pending.pop()
    if (next === undefined || ++visited > maximum || next.meta.role === 'secret') unavailable()
    if (next.type === 'union' || next.type === 'intersect') {
      if (next.list === undefined || next.list.length > maximum) unavailable()
      pending.push(...next.list)
    } else if (!['string', 'number', 'boolean', 'const'].includes(next.type)) unavailable()
    else if (next.type === 'const' && next.value !== null && typeof next.value === 'object') unavailable()
  }
}

function pick(value: JsonValue | undefined, fields: readonly ApprovedConfigurationField[]): JsonValue | undefined {
  if (value === undefined) return undefined
  if (value === null || typeof value !== 'object' || Array.isArray(value)) unavailable()
  return Object.fromEntries(fields.flatMap((field) => {
    if (!Object.hasOwn(value, field.field)) return []
    const selected = value[field.field]
    if (selected === undefined || selected !== null && typeof selected === 'object') unavailable()
    return [[field.field, selected]]
  }))
}

/** Project one original redacted form without disclosing unrelated schema references or values.
 * Only top-level scalar leaves are supported; unknown, structured and secret schemas stay closed.
 * @param view Original SettingsController view under native redaction.
 * @param fields The exact approved leaves in this namespace.
 * @param maximum Existing first-screen collection bound.
 * @returns Original revision and approved schema/value/base/user facts only.
 * @throws CloudApiError if an approved leaf is missing, secret, structured or outside the native schema.
 */
export function projectApprovedSettingsNamespace(
  view: SettingsNamespaceView, fields: readonly ApprovedConfigurationField[], maximum: number,
): SettingsNamespaceView {
  if (fields.length === 0 || fields.length > maximum || fields.some(field => field.namespace !== view.ns)) unavailable()
  // Native Settings owns this Schemastery.toJSON() envelope; it is not caller-supplied schema.
  if (view.schema === null || typeof view.schema !== 'object' || Array.isArray(view.schema)) unavailable()
  const form = new z<unknown>(view.schema)
  if (form.type !== 'object' || form.dict === undefined) unavailable()
  const selected: Record<string, z<unknown>> = {}
  for (const field of fields) {
    const native = Object.hasOwn(form.dict, field.field) ? form.dict[field.field] : undefined
    if (native === undefined) unavailable()
    scalar(native, maximum)
    if (field.values === undefined) selected[field.field] = native
    else {
      for (const value of field.values) {
        try { if (!Object.is(native(value), value)) unavailable() }
        catch (_invalidNativeValue) { unavailable() }
      }
      const restricted = z.union(field.values.map(value => z.const<unknown>(value)))
      restricted.meta = { ...native.meta }
      if (!field.values.some(value => Object.is(value, native.meta.default))) delete restricted.meta.default
      selected[field.field] = restricted
    }
  }
  const schema: unknown = z.object(selected).toJSON()
  if (!isJsonValue(schema)) unavailable()
  return { ns: view.ns, autoGenerate: view.autoGenerate, revision: view.revision, applies: view.applies,
    schema: schema as JsonValue, value: pick(view.value, fields) ?? {},
    ...view.base === undefined ? {} : { base: pick(view.base, fields) ?? {} },
    ...view.user === undefined ? {} : { user: pick(view.user, fields) ?? {} }, secrets: [],
  }
}

/** Project exact approved namespaces from the original native Settings description.
 * @param value Original redacted SettingsController description.
 * @param fields Frozen approval rows.
 * @param maximum Existing collection bound.
 * @returns A bounded approved form view; document access stays closed.
 * @throws CloudApiError if namespaces are missing, ambiguous, unsupported or exceed the finite bound.
 */
export function projectApprovedSettings(
  value: SettingsDescribeValue, fields: readonly ApprovedConfigurationField[], maximum: number,
): SettingsDescribeValue {
  if (value.namespaces.length > maximum || fields.length > maximum) unavailable()
  const namespaces = [...new Set(fields.map(field => field.namespace))]
  return { writable: value.writable, hasDocument: false, namespaces: namespaces.map((ns) => {
    const matches = value.namespaces.filter(view => view.ns === ns), view = matches[0]
    if (matches.length !== 1 || view === undefined) unavailable()
    return projectApprovedSettingsNamespace(view, fields.filter(field => field.namespace === ns), maximum)
  }) }
}
