/** Strict detached export packets; SQL, missing cells and ambiguous JSON are never accepted. */
import { createHash } from 'node:crypto'
import { z } from 'zod'
import { LEGACY_SOURCE_LAYOUT, type LegacyColumn } from './legacy-import-layout.ts'

/** Explicit maintenance budgets; exceeding a budget rejects the complete packet. */
export interface LegacyImportLimits {
  readonly maxBundleBytes: number
  readonly maxRows: number
  readonly maxCellBytes: number
  readonly maxJsonDepth: number
  readonly maxJsonNodes: number
  readonly maxFiles: number
  readonly maxFileBytes: number
  readonly maxStorageBytes: number
}
/** Import diagnostics contain locations and codes, never durable values or secrets. */
export class LegacyImportError extends Error {
  constructor(readonly code: string, readonly location = '') {
    super(location ? `${code}: ${location}` : code)
    this.name = 'LegacyImportError'
  }
}
/** Compute a stable byte digest without decoding or reserializing JSON.
 * @param text Original export bytes or cell text.
 * @returns Lowercase SHA-256.
 */
export function legacyDigest(text: string | Uint8Array): string {
  return createHash('sha256').update(text).digest('hex')
}
/** Validate all configured budgets before reading a packet.
 * @param input Trusted maintenance configuration.
 * @returns An independently owned, frozen configuration.
 */
export function legacyLimits(input: LegacyImportLimits): LegacyImportLimits {
  const positive = z.number().int().positive()
  const result = z.object({ maxBundleBytes: positive, maxRows: positive, maxCellBytes: positive,
    maxJsonDepth: positive, maxJsonNodes: positive, maxFiles: positive, maxFileBytes: positive,
    maxStorageBytes: positive }).strict().safeParse(input)
  if (!result.success) throw new LegacyImportError('invalid_limits')
  return Object.freeze(result.data)
}
/** Recursively immutable JSON admitted by a detached export packet. */
export type LegacyJson = null | boolean | number | string | readonly LegacyJson[] | { readonly [key: string]: LegacyJson }

function freeze(value: LegacyJson): LegacyJson {
  if (value !== null && typeof value === 'object') {
    for (const item of Object.values(value)) freeze(item)
    Object.freeze(value)
  }
  return value
}
function numberValue(token: string): void {
  const number = Number(token)
  if (!Number.isFinite(number) || Number.isInteger(number) && !Number.isSafeInteger(number) || token.length > 1024) {
    throw new LegacyImportError('json_number_loss')
  }
  const decimal = (text: string) => {
    const [mantissa = '', power = '0'] = text.toLowerCase().split('e')
    const exponent = Number(power)
    if (!Number.isSafeInteger(exponent) || Math.abs(exponent) > 1024) throw new LegacyImportError('json_number_loss')
    const [whole = '', fraction = ''] = mantissa.split('.')
    let digits = (whole + fraction).replace('-', '').replace(/^0+/u, '')
    let scale = exponent - fraction.length
    while (digits.endsWith('0')) { digits = digits.slice(0, -1); scale++ }
    return digits ? `${mantissa.startsWith('-') ? '-' : ''}${digits}:${scale}` : '0'
  }
  if (decimal(token) !== decimal(String(number))) throw new LegacyImportError('json_number_loss')
}
/** Parse JSON with duplicate-key, exact-number and complete budget checks.
 * @param text Original cell or packet JSON.
 * @param limits Validated maintenance limits.
 * @param maximum Maximum bytes for this complete value.
 * @returns A frozen independently decoded value; the original text remains authoritative.
 */
export function legacyJson(text: string, limits: LegacyImportLimits, maximum = limits.maxCellBytes): LegacyJson {
  if (Buffer.from(text).toString('utf8') !== text) throw new LegacyImportError('json_text_encoding')
  if (Buffer.byteLength(text) > maximum) throw new LegacyImportError('json_bytes_limit')
  let offset = 0, nodes = 0
  const whitespace = () => { while (/\s/u.test(text[offset] ?? '') && offset < text.length) offset++ }
  const string = (): string => {
    if (text[offset] !== '"') throw new LegacyImportError('invalid_json')
    const start = offset++
    while (offset < text.length) {
      const character = text[offset++]
      if (character === '\\') { offset++; continue }
      if (character === '"') {
        const parsed: unknown = JSON.parse(text.slice(start, offset))
        if (typeof parsed !== 'string') throw new LegacyImportError('invalid_json')
        return parsed
      }
    }
    throw new LegacyImportError('invalid_json')
  }
  const value = (depth: number): void => {
    if (++nodes > limits.maxJsonNodes || depth > limits.maxJsonDepth) throw new LegacyImportError('json_structure_limit')
    whitespace()
    if (text[offset] === '"') { string(); return }
    if (text[offset] === '{') {
      offset++; whitespace()
      const keys = new Set<string>()
      if (text[offset] === '}') { offset++; return }
      for (;;) {
        whitespace()
        const key = string()
        if (keys.has(key)) throw new LegacyImportError('duplicate_json_key')
        keys.add(key); whitespace()
        if (text[offset++] !== ':') throw new LegacyImportError('invalid_json')
        value(depth + 1); whitespace()
        if (text[offset] === '}') { offset++; return }
        if (text[offset++] !== ',') throw new LegacyImportError('invalid_json')
      }
    }
    if (text[offset] === '[') {
      offset++; whitespace()
      if (text[offset] === ']') { offset++; return }
      for (;;) {
        value(depth + 1); whitespace()
        if (text[offset] === ']') { offset++; return }
        if (text[offset++] !== ',') throw new LegacyImportError('invalid_json')
      }
    }
    const scalar = /^(?:null|true|false|-?(?:0|[1-9]\d*)(?:\.\d+)?(?:[eE][+-]?\d+)?)/u.exec(text.slice(offset))?.[0]
    if (!scalar) throw new LegacyImportError('invalid_json')
    if (/^-?\d/u.test(scalar)) numberValue(scalar)
    offset += scalar.length
  }
  try {
    value(0); whitespace()
    if (offset !== text.length) throw new LegacyImportError('invalid_json')
    const result: unknown = JSON.parse(text)
    return freeze(z.json().parse(result))
  } catch (error) {
    if (error instanceof LegacyImportError) throw error
    throw new LegacyImportError('invalid_json')
  }
}

const digest = z.string().regex(/^[a-f0-9]{64}$/u)
const timestamp = z.string().regex(/^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}(?:\.\d{1,6})?Z$/u)
const cells = z.record(z.string(), z.string().nullable())
const row = z.object({ disposition: z.enum(['preserve', 'convert', 'excluded', 'rejected']),
  values: cells, sha256: digest }).strict()
const entry = z.object({ area: z.enum(['workspace', 'home', 'skill-text', 'skill-package', 'office']),
  owner: z.string(), resource: z.string(), path: z.string(), kind: z.enum(['directory', 'file']),
  sourcePath: z.string().nullable(), bytes: z.string().nullable(), sha256: digest.nullable(),
  mode: z.number().int().min(0).max(0o777), uid: z.number().int().nonnegative(), gid: z.number().int().nonnegative() }).strict()
const bundleSchema = z.object({ format: z.literal('power-evolve-legacy-offline'), version: z.literal(1),
  source: z.object({ schema: z.literal(37), ddlSha256: digest, snapshotId: z.uuid(), codeId: z.string().min(1),
    stoppedAt: timestamp, cut: timestamp }).strict(),
  counts: z.object({ preserve: z.number().int().nonnegative(), convert: z.number().int().nonnegative(),
    excluded: z.number().int().nonnegative(), rejected: z.number().int().nonnegative() }).strict(),
  tables: z.record(z.string(), z.array(row)), files: z.array(entry),
  cutProof: z.string(), stops: z.array(z.object({ table: z.string(), rowSha256: digest, evidence: z.string() }).strict()),
}).strict()
/** Complete source row; all columns are represented as original PostgreSQL export text. */
export type LegacySourceRow = z.infer<typeof row>
/** Detached byte inventory; runtime paths never appear in a packet. */
export type LegacyFileEntry = z.infer<typeof entry>
/** Validated packet representation; input tables include all 77 source tables, even when empty. */
export type LegacyBundle = z.infer<typeof bundleSchema>

/** Parse and freeze a complete detached export packet.
 * @param text Original packet JSON, bounded before decoding.
 * @param limits Explicit maintenance budgets.
 * @returns A validated packet with no omitted or unknown source tables.
 */
export function parseLegacyBundle(text: string, limits: LegacyImportLimits): LegacyBundle {
  const parsed = bundleSchema.safeParse(legacyJson(text, limits, limits.maxBundleBytes))
  if (!parsed.success) throw new LegacyImportError('invalid_bundle')
  const bundle = parsed.data
  if (Object.keys(bundle.tables).length !== Object.keys(LEGACY_SOURCE_LAYOUT).length
    || Object.keys(LEGACY_SOURCE_LAYOUT).some(table => bundle.tables[table] === undefined)) throw new LegacyImportError('source_table_inventory')
  const counts = { preserve: 0, convert: 0, excluded: 0, rejected: 0 }
  let rows = 0
  for (const [table, records] of Object.entries(bundle.tables)) {
    const columns = LEGACY_SOURCE_LAYOUT[table]
    if (!columns) throw new LegacyImportError('source_table_inventory')
    for (const record of records) {
      if (++rows > limits.maxRows) throw new LegacyImportError('row_limit')
      if (Object.keys(record.values).length !== Object.keys(columns).length
        || Object.keys(columns).some(column => !Object.hasOwn(record.values, column))) throw new LegacyImportError('source_column_inventory', table)
      for (const [column, specification] of Object.entries(columns)) {
        legacyCell(record.values[column] ?? null, specification, limits, `${table}.${column}`)
      }
      if (legacyRowDigest(table, record.values) !== record.sha256) throw new LegacyImportError('row_digest', table)
      counts[record.disposition]++
      Object.freeze(record.values); Object.freeze(record)
    }
    Object.freeze(records)
  }
  if (Object.entries(counts).some(([key, value]) => bundle.counts[key as keyof typeof counts] !== value)) {
    throw new LegacyImportError('disposition_inventory')
  }
  if (bundle.files.length > limits.maxFiles) throw new LegacyImportError('file_limit')
  for (const file of bundle.files) Object.freeze(file)
  for (const stop of bundle.stops) Object.freeze(stop)
  Object.freeze(bundle.tables); Object.freeze(bundle.files); Object.freeze(bundle.stops)
  Object.freeze(bundle.source); Object.freeze(bundle.counts)
  return Object.freeze(bundle)
}
/** Hash a row in its fixed source-column order, retaining each cell's original representation.
 * @param table Fixed source table.
 * @param values Complete original cells.
 * @returns Row digest; it is independent of object-key ordering in the packet.
 */
export function legacyRowDigest(table: string, values: Readonly<Record<string, string | null>>): string {
  const layout = LEGACY_SOURCE_LAYOUT[table]
  if (!layout) throw new LegacyImportError('source_table_inventory')
  return legacyDigest(JSON.stringify([table, ...Object.keys(layout).map(column => values[column])]))
}
/** Validate a PostgreSQL export cell without substituting defaults or losing bigint/time precision.
 * @param value Original text or SQL NULL.
 * @param column Reviewed PostgreSQL column.
 * @param limits Explicit maintenance budgets.
 * @param location Public diagnostic column name.
 * @returns Resolves synchronously after complete validation.
 */
export function legacyCell(value: string | null, column: LegacyColumn, limits: LegacyImportLimits, location: string): void {
  if (value === null) {
    if (!column.nullable) throw new LegacyImportError('null_cell', location)
    return
  }
  if (Buffer.from(value).toString('utf8') !== value) throw new LegacyImportError('cell_text_encoding', location)
  if (Buffer.byteLength(value) > limits.maxCellBytes) throw new LegacyImportError('cell_bytes_limit', location)
  switch (column.kind) {
    case 'text': if (value.includes('\0')) throw new LegacyImportError('invalid_text', location); break
    case 'uuid': if (!/^[a-f0-9]{8}(?:-[a-f0-9]{4}){3}-[a-f0-9]{12}$/u.test(value)) throw new LegacyImportError('invalid_uuid', location); break
    case 'boolean': if (value !== 'true' && value !== 'false') throw new LegacyImportError('invalid_boolean', location); break
    case 'integer':
    case 'bigint': {
      if (!/^(?:0|-?[1-9]\d*)$/u.test(value)) throw new LegacyImportError('invalid_integer', location)
      const number = BigInt(value), width = column.kind === 'integer' ? 31n : 63n
      if (number < -(2n ** width) || number >= 2n ** width) throw new LegacyImportError('integer_range', location)
      break
    }
    case 'timestamptz':
      if (!timestamp.safeParse(value).success || !Number.isFinite(Date.parse(value))) throw new LegacyImportError('invalid_timestamp', location)
      break
    case 'bytea': if (!/^\\x(?:[a-f0-9]{2})*$/u.test(value)) throw new LegacyImportError('invalid_bytea', location); break
    case 'json': legacyJson(value, limits); break
    case 'jsonb': {
      const parsed = legacyJson(value, limits)
      const check = (item: LegacyJson): void => {
        if (typeof item === 'string' && item.includes('\0')) throw new LegacyImportError('jsonb_nul', location)
        if (typeof item === 'string' && Buffer.from(item).toString('utf8') !== item) throw new LegacyImportError('jsonb_unicode', location)
        if (item !== null && typeof item === 'object') for (const [key, child] of Object.entries(item)) {
          if (key.includes('\0')) throw new LegacyImportError('jsonb_nul', location)
          if (Buffer.from(key).toString('utf8') !== key) throw new LegacyImportError('jsonb_unicode', location)
          check(child)
        }
      }
      check(parsed); break
    }
  }
}
