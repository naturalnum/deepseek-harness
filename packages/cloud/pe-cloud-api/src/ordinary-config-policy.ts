/** Cloud ordinary-field replacement policy over the original native schema metadata. */
import type { ConfigSchemaNode } from '@deepseek-ai/dsh-settings'

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
