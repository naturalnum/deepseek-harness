/** Compare raw plugin configs using schema metadata without executing config hooks or validators. */
import type { Plugin } from '@deepseek-ai/cordis'
import { deepEqual } from '@deepseek-ai/cosmokit'
import type Schema from '@deepseek-ai/schemastery'
import { isJsExpr } from './utils.ts'

function isSchemastery(schema: Plugin.Runtime['Config']): schema is Schema {
  return schema?.['~standard'].vendor === 'schemastery'
}

function isRecord(value: unknown): value is Record<string, unknown> {
  if (!value || typeof value !== 'object' || isJsExpr(value)) return false
  const prototype = Object.getPrototypeOf(value)
  return prototype === Object.prototype || prototype === null
}

function equal(a: unknown, b: unknown, schema: Schema | undefined, ancestors: Set<Schema>): boolean {
  if (schema?.meta?.volatile) return true
  if (schema?.type !== 'object' || !schema.dict || ancestors.has(schema)) return deepEqual(a, b, true)
  const left = a ?? schema.meta?.default
  const right = b ?? schema.meta?.default
  if (!isRecord(left) || !isRecord(right)) return deepEqual(left, right, true)
  const { dict } = schema
  ancestors.add(schema)
  try {
    return Object.keys({ ...left, ...right }).every(key =>
      equal(left[key], right[key], Object.hasOwn(dict, key) ? dict[key] : undefined, ancestors),
    )
  } finally {
    ancestors.delete(schema)
  }
}

/**
 * Compare two raw configs, treating schema-declared volatile fields at fixed object paths as equal and absent objects as their schema default.
 * Schema backedges, expressions, unknown fields and opaque values keep strict raw equality; an absent or non-Schemastery schema compares everything raw.
 * @param previous - previous raw config.
 * @param next - next raw config.
 * @param schema - the plugin's config schema.
 * @returns Whether the configs differ at most in volatile fields, without evaluating expressions, validating config or modifying inputs.
 * @internal
 */
export function equalExceptVolatile(previous: unknown, next: unknown, schema: Plugin.Runtime['Config']): boolean {
  return isSchemastery(schema) ? equal(previous, next, schema, new Set()) : deepEqual(previous, next, true)
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
