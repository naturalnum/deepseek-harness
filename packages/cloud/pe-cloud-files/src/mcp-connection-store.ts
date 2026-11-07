/** Account-private HTTP MCP definitions and native credential records, saved by the original account barrier. */
import { randomUUID } from 'node:crypto'
import { symbols, type Context } from '@deepseek-ai/cordis'
import { brandString, type Branded } from '@deepseek-ai/dsh-brand'
import { credentialKey } from '@deepseek-ai/dsh-credentials'
import { defineDomain } from '@deepseek-ai/dsh-storage-domain'
import type { AccountBinding } from '@deepseek-ai/dsh-pe-cloud-runtime/types'
import { z } from 'zod'

/** Opaque identifier scoped to the installed account store. */
export type McpConnectionId = Branded<'McpConnectionId'>
/** Persisted nonsecret definition; HTTP headers live only in the native credential provider. */
export interface McpConnectionRecord {
  readonly id: McpConnectionId
  readonly serverName: string
  readonly url: string
  readonly enabled: boolean
  readonly toolCallTimeoutMs: number
}
/** Explicit account storage and request budgets. */
export interface McpStoreLimits {
  readonly maxConnections: number
  readonly maxUrlBytes: number
  readonly maxHeaderBytes: number
  readonly maxHeaderCount: number
  readonly maxToolCallTimeoutMs: number
}
/** Definition input; omitted headers preserve the current credential record. */
export interface McpConnectionInput {
  readonly serverName: string
  readonly url: string
  readonly enabled: boolean
  readonly toolCallTimeoutMs: number
  readonly headers?: Readonly<Record<string, string>>
}
/** Private storage operations; no raw credential read method is exposed remotely. */
export interface AccountMcpConnectionStore {
  list(): readonly McpConnectionRecord[]
  save(id: McpConnectionId | undefined, input: McpConnectionInput): Promise<McpConnectionRecord>
  remove(id: McpConnectionId): Promise<void>
  configured(id: McpConnectionId): Promise<boolean>
  withHeaders<T>(id: McpConnectionId, consume: (headers: Record<string, string>) => Promise<T>): Promise<T>
}

const recordSchema = z.strictObject({ id: z.uuid(), serverName: z.string().regex(/^[A-Za-z0-9_-]{1,32}$/),
  url: z.string(), enabled: z.boolean(), toolCallTimeoutMs: z.number().int().positive() })
const headersSchema = z.strictObject({ version: z.literal(1), headers: z.record(z.string(), z.string()) })
function original(value: object): object {
  const raw: unknown = Reflect.get(value, symbols.original)
  return raw !== null && typeof raw === 'object' ? raw : value
}
function unavailable(): never { throw new Error('cloud/mcp-connection-unavailable') }

/** Validate a complete HTTP connection at its wire/storage entry.
 * @param input Untrusted connection input.
 * @param limits Original deployment bounds.
 * @returns Detached HTTP-only input; neither URL credentials nor non-HTTP transports are accepted.
 */
export function mcpConnectionInput(input: unknown, limits: McpStoreLimits): McpConnectionInput {
  const parsed = recordSchema.omit({ id: true }).extend({ headers: z.record(z.string(), z.string()).optional() }).parse(input)
  const url = new URL(parsed.url)
  if (!['http:', 'https:'].includes(url.protocol) || url.username || url.password || url.hash
    || /[\u0000-\u0020\u007f]/u.test(parsed.url) || Buffer.byteLength(parsed.url) > limits.maxUrlBytes
    || parsed.toolCallTimeoutMs > limits.maxToolCallTimeoutMs) unavailable()
  if (parsed.headers !== undefined) {
    if (Object.keys(parsed.headers).length > limits.maxHeaderCount
      || Buffer.byteLength(JSON.stringify(parsed.headers)) > limits.maxHeaderBytes) unavailable()
    for (const [key, value] of Object.entries(parsed.headers)) {
      if (!/^[!#$%&'*+.^_`|~0-9A-Za-z-]+$/.test(key) || /[\0\r\n]/.test(value)
        || ['host', 'content-length', 'connection', 'transfer-encoding'].includes(key.toLowerCase())) unavailable()
    }
  }
  return parsed
}

/** Open the account's existing private backend and credential provider.
 * @param ctx Original account entry.
 * @param binding Original runtime-issued account generation.
 * @param limits Explicit finite store budgets.
 * @param mounted Original files installation check, also valid during restore.
 * @param current Original business admission after restore.
 * @param submit Original serialized account save barrier.
 * @returns Account-local store; disposal joins the native domain close.
 */
export async function openMcpConnectionStore(ctx: Context, binding: AccountBinding, limits: McpStoreLimits,
  mounted: () => void, current: () => void, submit: <T>(work: () => Promise<T>) => Promise<T>): Promise<AccountMcpConnectionStore> {
  mounted()
  const facility = ctx.get('storageDomain'), provider = ctx.get('credentials')
  if (facility === undefined || provider === undefined || ctx.get('peAccount') !== binding) unavailable()
  for (const value of Object.values(limits)) if (!Number.isSafeInteger(value) || value < 1) unavailable()
  const spec = defineDomain({ name: 'cloud_mcp_connections', version: 1,
    global: { schema: z.strictObject({ accountId: z.string(), connections: z.array(recordSchema).max(limits.maxConnections) }),
      initial: { accountId: String(binding.accountId), connections: [] } }, tables: {} })
  const domain = await facility.open(spec)
  ctx.effect(() => () => domain.close(), 'pe-cloud-files: close account MCP definitions')
  mounted()
  const check = (): void => {
    mounted(); current(); binding.lifetime.throwIfAborted()
    const installed = ctx.get('credentials')
    if (installed === undefined || original(installed) !== original(provider)
      || ctx.get('peAccount') !== binding || domain.global.get().accountId !== binding.accountId) unavailable()
  }
  if (domain.global.get().accountId !== binding.accountId) unavailable()
  const key = (id: McpConnectionId) => credentialKey('mcp-connection', 'connection-' + id)
  const list = (): McpConnectionRecord[] => {
    check()
    return domain.global.get().connections.map(row => ({ ...row, id: brandString<McpConnectionId>(row.id) }))
  }
  const requireEntry = (id: McpConnectionId): McpConnectionRecord => {
    const row = list().find(entry => entry.id === id)
    if (row === undefined) unavailable()
    return row
  }
  const mutate = async <T>(work: (submitted: () => void) => Promise<T>): Promise<T> => {
    const result = await submit(async () => {
      const state = { started: false }
      try { return { ok: true as const, value: await work(() => { state.started = true }) } }
      catch (error) { if (state.started) throw error; return { ok: false as const, error } }
    })
    if (!result.ok) throw result.error
    return result.value
  }
  return {
    list,
    async save(id, input) {
      const value = mcpConnectionInput(input, limits)
      return mutate(async (submitted) => {
        check()
        const rows = list()
        if (id !== undefined) requireEntry(id)
        if (rows.some(row => row.id !== id && row.serverName === value.serverName)
          || id === undefined && rows.length >= limits.maxConnections) unavailable()
        const selected = id ?? brandString<McpConnectionId>(randomUUID())
        if (value.headers !== undefined) {
          submitted()
          await provider.modifyRecord(key(selected), () => { check(); return Promise.resolve({ kind: 'grant' as const,
            payload: { version: 1, headers: { ...value.headers } } }) })
          check()
        }
        const { headers: _headers, ...definition } = value
        const row: McpConnectionRecord = { id: selected, ...definition }
        const next = id === undefined ? [...rows, row] : rows.map(old => old.id === id ? row : old)
        submitted()
        await domain.global.set({ accountId: String(binding.accountId), connections: next }); check()
        return row
      })
    },
    async remove(id) {
      return mutate(async (submitted) => {
        requireEntry(id)
        submitted()
        await domain.global.set({ accountId: String(binding.accountId), connections: list().filter(row => row.id !== id) }); check()
        await provider.deleteRecord(key(id)); check()
      })
    },
    async configured(id) {
      requireEntry(id)
      const value = await provider.describeRecord(key(id)); check()
      return value.configured
    },
    async withHeaders(id, consume) {
      requireEntry(id)
      const stored = await provider.readRecord(key(id)); check()
      if (stored === undefined) return consume({})
      if (stored.kind !== 'grant') unavailable()
      const value = headersSchema.parse(stored.payload)
      const { id: _id, ...definition } = requireEntry(id)
      mcpConnectionInput({ ...definition, headers: value.headers }, limits)
      check()
      return consume({ ...value.headers })
    },
  }
}
