/** Derive editable forms and plain values from plugin Config schemas. */
import { redactSecrets, type ConfigSchemaNode } from './redact.ts'
import z from '@deepseek-ai/schemastery'
import { isVolatile } from '@deepseek-ai/cosmokit'

/** Remove runtime references from a configuration snapshot.
 * @param value Parsed Config output.
 * @returns Detached ordinary values suitable for redaction and forms.
 */
export function plainConfig(value: unknown): unknown {
  if (isVolatile(value)) return plainConfig(value.get())
  if (Array.isArray(value)) return value.map(plainConfig)
  if (value !== null && typeof value === 'object') {
    return Object.fromEntries(Object.entries(value).map(([key, child]) => [key, plainConfig(child)]))
  }
  return value
}

function plainSchema(schema: z): z {
  const result = new z(schema.toJSON())
  const walk = (node: z): void => {
    delete node.meta.volatile
    if (node.meta.role === 'secret') { delete node.meta.default; delete node.meta.required }
    else if (node.meta.default !== undefined) node.meta.default = redactSecrets(node, node.meta.default).value
    for (const child of Object.values(node.dict ?? {})) walk(child)
    if (node.inner) walk(node.inner)
    if (node.sKey) walk(node.sKey)
    for (const child of node.list ?? []) walk(child)
  }
  walk(result)
  return result
}

/** Select fields whose nearest volatile ancestor makes them editable without remounting.
 * @param schema The plugin's Config schema.
 * @returns A plain form schema, or undefined when no field is live.
 */
export function volatileForm(schema: z): z | undefined {
  if (schema.meta.volatile) return plainSchema(schema)
  if (schema.type === 'object') {
    const dict = Object.fromEntries(Object.entries(schema.dict ?? {}).flatMap(([key, child]) => {
      const field = volatileForm(child)
      return field === undefined ? [] : [[key, field]]
    }))
    return Object.keys(dict).length === 0 ? undefined : z.object(dict)
  }
  return undefined
}

/** Whether a raw config node is an unevaluated `!!js` expression, kept whole rather than projected field by field. */
function isExpression(value: object): boolean {
  return Object.keys(value).length === 1 && typeof Reflect.get(value, '__jsExpr') === 'string'
}

/** Project only schema-declared fields, excluding ordinary configuration.
 * @param schema The filtered form schema.
 * @param value Plain raw or resolved config.
 * @returns The fields visible to this form.
 */
export function projectForm(schema: z, value: unknown): unknown {
  if (schema.type === 'object' && value !== null && typeof value === 'object' && !isExpression(value)) {
    return Object.fromEntries(Object.entries(schema.dict ?? {}).flatMap(([key, child]) => {
      const field: unknown = Reflect.get(value, key)
      return field === undefined ? [] : [[key, projectForm(child, field)]]
    }))
  }
  return value
}

/** Check that a field path lies beneath a declared volatile node.
 * @param schema Complete plugin Config schema.
 * @param path Field path addressed by a form edit.
 * @returns Whether the path can be edited live.
 */
export function isVolatilePath(schema: z, path: readonly string[]): boolean {
  if (schema.meta.volatile) return true
  const [key, ...rest] = path
  const child = key === undefined ? undefined : schema.dict?.[key]
  return child !== undefined && isVolatilePath(child, rest)
}

/** Whether a complete-leaf replacement is confined to ordinary, nonsecret configuration. */
export interface OrdinaryConfigPolicy {
  readonly writable: boolean
  readonly readOnlyReason?: 'secret' | 'live' | 'protected' | 'unproven'
  /** A selected secret ancestor makes the whole field opaque. */
  readonly secret: boolean
  /** Live descendants belong to Settings and are omitted from ordinary snapshots. */
  readonly volatile: boolean
}

/** Inspect metadata only; no schema builder, validator or value expression is run.
 * @param schema Complete native Config graph.
 * @param path Fixed object path selected by the caller.
 * @returns Replacement permission and the protection that an incomplete form must preserve.
 */
export function ordinaryConfigPolicy(schema: ConfigSchemaNode, path: readonly string[]): OrdinaryConfigPolicy {
  let leaf = schema, secret = false, volatile = false
  for (const segment of path) {
    secret ||= leaf.meta?.role === 'secret'
    volatile ||= !!leaf.meta?.volatile
    const child = leaf.type === 'object' ? leaf.dict?.[segment] : undefined
    if (child === undefined) return { writable: false, readOnlyReason: 'unproven', secret, volatile }
    leaf = child
  }
  secret ||= leaf.meta?.role === 'secret'
  volatile ||= !!leaf.meta?.volatile
  if (secret || volatile) return { writable: false, readOnlyReason: secret ? 'secret' : 'live', secret, volatile }
  const protection = { protectedChild: false, unproven: false }
  const active = new Set<ConfigSchemaNode>()
  const visit = (node: ConfigSchemaNode): void => {
    if (active.has(node)) { protection.unproven = true; return }
    active.add(node)
    if (node.meta?.role === 'secret') protection.protectedChild = true
    if (node.meta?.volatile) { protection.protectedChild = true; volatile = true }
    // An unresolved lazy or custom relation can conceal metadata. Leave its execution to the native planner.
    if (!['string', 'number', 'boolean', 'const', 'object', 'array', 'dict', 'tuple', 'union', 'intersect'].includes(node.type ?? '')) {
      protection.unproven = true
    } else {
      for (const child of Object.values(node.dict ?? {})) visit(child)
      if (node.inner) visit(node.inner)
      if (node.sKey) visit(node.sKey)
      for (const child of node.list ?? []) visit(child)
    }
    active.delete(node)
  }
  visit(leaf)
  const readOnlyReason = protection.unproven ? 'unproven' : protection.protectedChild ? 'protected' : undefined
  return { writable: readOnlyReason === undefined, ...readOnlyReason === undefined ? {} : { readOnlyReason }, secret, volatile }
}
