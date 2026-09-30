/** Product MCP schemas use their original dialect and local references without modifying JSON values. */
import Ajv, { type Options } from 'ajv'
import { Ajv2019 } from 'ajv/dist/2019.js'
import { Ajv2020 } from 'ajv/dist/2020.js'
import { z } from 'zod'

const schemaObject = z.record(z.string(), z.json())
const jsonValue = z.json()
const options: Options = {
  strict: true, strictTypes: false, strictTuples: false, strictRequired: false,
  allowUnionTypes: true, allowMatchingProperties: true, validateSchema: true,
  validateFormats: true, allErrors: false, ownProperties: true, logger: false, inlineRefs: false,
  coerceTypes: false, useDefaults: false, removeAdditional: false, $data: false,
}
const schemaMaps = new Set(['$defs', 'definitions', 'properties', 'patternProperties', 'dependentSchemas'])
const schemas = new Set(['additionalProperties', 'unevaluatedProperties', 'propertyNames', 'items',
  'additionalItems', 'unevaluatedItems', 'contains', 'not', 'if', 'then', 'else', 'contentSchema'])
const schemaArrays = new Set(['allOf', 'anyOf', 'oneOf', 'prefixItems'])
const annotations = new Set(['$schema', '$id', '$defs', 'definitions', '$anchor', 'title', 'description',
  'default', 'examples', 'deprecated', 'readOnly', 'writeOnly', 'contentMediaType', 'contentEncoding', 'contentSchema'])
// Fixed acceptance ceilings bound synchronous work on both shared services.
const MAX_DEPTH = 32
const MAX_SCHEMA_UNITS = 65_536
const MAX_EXPANDED_NODES = 256
const MAX_VALIDATION_UNITS = 2_000_000
type Json = z.infer<typeof jsonValue>
type Schema = boolean | Record<string, Json>

/** Count JSON nodes and string units iteratively, stopping before deeply nested values reach a parser. */
function units(value: unknown, limit: number): number {
  const pending = [{ value, depth: 0 }]
  let count = 0
  while (pending.length) {
    const item = pending.pop()!
    if (item.depth > MAX_DEPTH) throw new McpJsonSchemaError()
    count += typeof item.value === 'string' ? 1 + item.value.length : 1
    if (item.value !== null && typeof item.value === 'object') {
      const record = item.value as Record<string, unknown>
      for (const key in record) {
        if (!Object.hasOwn(record, key)) continue
        count += key.length
        pending.push({ value: record[key], depth: item.depth + 1 })
        if (count + pending.length > limit) throw new McpJsonSchemaError()
      }
    }
    if (count > limit) throw new McpJsonSchemaError()
  }
  return count
}

/** Compiled original schema; invalid JSON and validation exceptions are refusals without diagnostics. */
export type McpJsonSchemaValidator = (value: unknown) => boolean

/** Unsupported dialects, schema keywords and references share one redacted refusal. */
export class McpJsonSchemaError extends Error {
  /** Stable refusal shared by schema admission and argument validation. */
  readonly code = 'mcp_schema_unsupported'
  constructor() { super('mcp_schema_unsupported'); this.name = 'McpJsonSchemaError' }
}

function engine(schema: z.infer<typeof schemaObject>): Ajv {
  switch (schema.$schema) {
    case undefined:
    case 'https://json-schema.org/draft/2020-12/schema':
    case 'https://json-schema.org/draft/2020-12/schema#': return new Ajv2020(options)
    case 'https://json-schema.org/draft/2019-09/schema':
    case 'https://json-schema.org/draft/2019-09/schema#': return new Ajv2019(options)
    case 'http://json-schema.org/draft-07/schema':
    case 'http://json-schema.org/draft-07/schema#': return new Ajv({ ...options, ignoreKeywordsWithRef: true })
    default: throw new McpJsonSchemaError()
  }
}

/** Inspect schema locations only: properties named $ref and annotation data retain their ordinary JSON meaning. */
function complexity(root: Record<string, Json>, compiler: Ajv): number {
  const children = new Map<Schema, Schema[]>(), anchors = new Map<string, Schema>()
  function visit(value: Json): Schema {
    if (typeof value !== 'boolean' && (typeof value !== 'object' || value === null || Array.isArray(value))) {
      throw new McpJsonSchemaError()
    }
    const schema = value as Schema
    if (children.has(schema)) return schema
    const nested: Schema[] = []
    children.set(schema, nested)
    if (children.size > MAX_EXPANDED_NODES) throw new McpJsonSchemaError()
    if (typeof schema === 'boolean') return schema
    for (const keyword of Object.keys(schema)) {
      if (!annotations.has(keyword) && !compiler.getKeyword(keyword)) throw new McpJsonSchemaError()
    }
    for (const keyword of ['pattern', 'patternProperties', 'format', '$async', '$vocabulary', '$data',
      '$dynamicRef', '$dynamicAnchor', '$recursiveRef', '$recursiveAnchor']) {
      if (keyword in schema) throw new McpJsonSchemaError()
    }
    if (schema !== root && ('$id' in schema || '$schema' in schema)
      || schema.uniqueItems !== undefined && schema.uniqueItems !== false) throw new McpJsonSchemaError()
    if (schema.$ref !== undefined && (typeof schema.$ref !== 'string' || !schema.$ref.startsWith('#'))) {
      throw new McpJsonSchemaError()
    }
    if (schema.$anchor !== undefined) {
      if (typeof schema.$anchor !== 'string' || anchors.has(schema.$anchor)) throw new McpJsonSchemaError()
      anchors.set(schema.$anchor, schema)
    }
    for (const [keyword, child] of Object.entries(schema)) {
      if (schemaMaps.has(keyword) || keyword === 'dependencies') {
        if (typeof child !== 'object' || child === null || Array.isArray(child)) throw new McpJsonSchemaError()
        for (const entry of Object.values(child)) {
          if (keyword !== 'dependencies' || !Array.isArray(entry)) nested.push(visit(entry))
        }
      } else if (schemaArrays.has(keyword) || keyword === 'items' && Array.isArray(child)) {
        if (!Array.isArray(child)) throw new McpJsonSchemaError()
        for (const entry of child) nested.push(visit(entry))
      } else if (schemas.has(keyword)) nested.push(visit(child))
    }
    return schema
  }
  visit(root)
  for (const [schema, nested] of children) {
    if (typeof schema === 'boolean' || schema.$ref === undefined) continue
    const ref = decodeURIComponent(String(schema.$ref))
    let target: Json | undefined = ref === '#' ? root : anchors.get(ref.slice(1))
    if (ref.startsWith('#/')) {
      target = root
      for (const token of ref.slice(2).split('/')) {
        const key = token.replaceAll('~1', '/').replaceAll('~0', '~')
        if (typeof target !== 'object' || target === null || !Object.hasOwn(target, key)) {
          throw new McpJsonSchemaError()
        }
        target = Array.isArray(target) ? target[Number(key)] : target[key]
      }
    }
    if (target === undefined || !children.has(target as Schema)) throw new McpJsonSchemaError()
    nested.push(target as Schema)
  }
  const costs = new Map<Schema, { nodes: number; weight: number }>(), visiting = new Set<Schema>()
  function cost(schema: Schema): { nodes: number; weight: number } {
    if (visiting.has(schema)) throw new McpJsonSchemaError()
    const known = costs.get(schema)
    if (known !== undefined) return known
    visiting.add(schema)
    let nodes = 1, weight = 1
    if (typeof schema !== 'boolean') {
      // Literal comparisons also traverse data, including composite enum/const values.
      for (const keyword of ['enum', 'const', 'required', 'dependentRequired', 'type']) {
        if (schema[keyword] !== undefined) weight += units(schema[keyword], MAX_SCHEMA_UNITS)
      }
      for (const keyword of ['properties', 'dependentSchemas', 'dependencies']) {
        const map = schema[keyword]
        if (typeof map !== 'object' || map === null || Array.isArray(map)) continue
        for (const [key, value] of Object.entries(map)) {
          weight += 1 + key.length
          if (keyword === 'dependencies' && Array.isArray(value)) weight += units(value, MAX_SCHEMA_UNITS)
        }
      }
    }
    for (const child of children.get(schema)!) {
      const nested = cost(child)
      nodes += nested.nodes; weight += nested.weight
    }
    if (nodes > MAX_EXPANDED_NODES || weight > MAX_SCHEMA_UNITS) throw new McpJsonSchemaError()
    const total = { nodes, weight }
    visiting.delete(schema); costs.set(schema, total)
    return total
  }
  for (const schema of children.keys()) cost(schema)
  return cost(root).weight
}

/**
 * Compile a detached MCP schema with synchronous Ajv and no remote schema resolver.
 * Missing dialect means 2020-12; declared 2019-09 and draft-07 retain their keyword semantics.
 * Constraints retain their meaning. Regex/format, uniqueItems:true, dynamic/recursive references,
 * nested dialect/ID changes, external references, async and custom vocabularies reject explicitly.
 * Static document references must be acyclic. Schemas/values have depth at most 32; schemas
 * have at most 65,536 JSON/string units and 256 expanded schema nodes. The work estimate
 * includes literal comparisons, required/dependency lists and property names. That weight
 * multiplied by value JSON/string units cannot exceed 2,000,000; this is not an instruction counter.
 * Each compiler owns its schema IDs, preventing another connection's $id from supplying constraints.
 * @param schema Original JSON object schema from the immutable MCP catalog.
 * @param objectRoot Require the MCP input's explicit object root.
 * @returns A validator that never coerces, defaults, removes properties, or exposes schema diagnostics.
 */
export function compileMcpJsonSchema(schema: unknown, objectRoot = false): McpJsonSchemaValidator {
  try {
    units(schema, MAX_SCHEMA_UNITS)
    const detached = schemaObject.parse(schema)
    if (objectRoot && detached.type !== 'object') throw new McpJsonSchemaError()
    const compiler = engine(detached)
    // Ajv resolves standard $anchor references but its strict keyword registry omits the annotation.
    compiler.addKeyword({ keyword: '$anchor', schemaType: 'string' })
    const work = complexity(detached, compiler)
    const validate = compiler.compile(detached)
    return value => {
      try {
        units(value, Math.floor(MAX_VALIDATION_UNITS / work))
        return jsonValue.safeParse(value).success && validate(value) === true
      }
      catch (_invalidValue) { return false }
    }
  } catch (_unsupportedSchema) { throw new McpJsonSchemaError() }
}

/**
 * Validate remote structured output against its complete original schema.
 * @param schema Immutable advertised output schema; unsupported schema is a refusal.
 * @param value Decoded structuredContent, including absent content when the server omitted it.
 * @returns Whether the unmodified JSON value satisfies every supported constraint.
 */
export function validateMcpJsonSchemaValue(schema: unknown, value: unknown): boolean {
  try { return compileMcpJsonSchema(schema)(value) }
  catch (_unsupportedSchema) { return false }
}
