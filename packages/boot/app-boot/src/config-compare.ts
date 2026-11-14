/** Deterministic schema inspection for profile-owned prepared updates. */
import type { Plugin } from '@deepseek-ai/cordis'
import type Schema from '@deepseek-ai/schemastery'

function isSchemastery(schema: Plugin.Runtime['Config']): schema is Schema {
  return schema?.['~standard'].vendor === 'schemastery'
}

/**
 * Recognize the built-in schema subset whose validation has no user callback.
 * Recursive, transform, lazy and custom schemas remain unproven.
 * @param schema - the running plugin schema.
 * @returns Whether this schema belongs to the deterministic guarded-update subset.
 * @internal
 */
export function deterministicConfigSchema(schema: Plugin.Runtime['Config']): boolean {
  if (!isSchemastery(schema)) return false
  const seen = new Set<Schema>()
  const visit = (node: Schema): boolean => {
    if (seen.has(node)) return false
    seen.add(node)
    try {
      if (['string', 'number', 'boolean', 'const'].includes(node.type)) return true
      if (node.type === 'object') return Object.values(node.dict ?? {}).every(visit)
      if (node.type === 'array' || node.type === 'dict') return node.inner !== undefined && visit(node.inner)
      if (['tuple', 'union', 'intersect'].includes(node.type)) return (node.list ?? []).every(visit)
      return false
    } finally { seen.delete(node) }
  }
  return visit(schema)
}

/**
 * Snapshot native schema metadata without assuming every Standard Schema is Schemastery.
 * @param schema - the running config schema.
 * @returns Detached metadata, or undefined for an unrecognized schema.
 * @internal
 */
export function configSchemaSnapshot(schema: Plugin.Runtime['Config']): unknown {
  return isSchemastery(schema) ? structuredClone(schema.toJSON()) : undefined
}
