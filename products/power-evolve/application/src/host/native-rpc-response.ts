/** Original Gateway byte attachments cross the bounded Platform JSON hop and return as native browser multipart. */
import type { Context } from '@deepseek-ai/cordis'
import type { ServerResponse } from 'node:http'
import { z } from 'zod'
import { PlatformError } from '../contracts.ts'
import { sendJson } from '../http.ts'

type WireResult = Awaited<ReturnType<Context['typertGateway']['wireRpc']['invoke']>>
const failure = z.object({ code: z.string(), message: z.string(), details: z.record(z.string(), z.json()) }).strict()
const result = z.discriminatedUnion('ok', [z.object({ ok: z.literal(true), value: z.json().optional() }).strict(),
  z.object({ ok: z.literal(false), error: failure }).strict()])
const ordinary = z.object({ type: z.literal('server-response'), rpcId: z.string(), result }).strict()
const binary = z.object({ type: z.literal('power-evolve-runtime-binary-response'), version: z.literal(1), rpcId: z.string(),
  result: z.object({ ok: z.literal(true), value: z.json().optional() }).strict(),
  attachments: z.array(z.object({ path: z.array(z.union([z.string(), z.number().int().nonnegative()])),
    data: z.string() }).strict()) }).strict()

/** Distinguish a native encoded result from an arbitrary business object containing similar field names. */
export class NativeWireResult {
  constructor(readonly result: WireResult) {}
}

/** Encode native byte attachments only for the private bounded Runtime-to-Platform JSON transport.
 * @param rpcId Original native Client correlation identity.
 * @param encoded Native Gateway result already encoded by its maintained descriptor.
 * @returns The original envelope for JSON, or an explicit private byte carrier; no Uint8Array is serialized as an object.
 */
export function nativeRuntimeResponse(rpcId: string, encoded: WireResult): unknown {
  if (!encoded.ok) return { type: 'server-response', rpcId, result: encoded }
  const { attachments, ...value } = encoded
  if (!attachments?.length) return { type: 'server-response', rpcId, result: value }
  return { type: 'power-evolve-runtime-binary-response', version: 1, rpcId, result: value,
    attachments: attachments.map(item => ({ path: [...item.path], data: Buffer.from(item.bytes).toString('base64') })) }
}

/** Return original native JSON or multipart to the Client after checking the private hop's correlation and byte budget.
 * @param response Original browser response owned by this carrier.
 * @param rpcId Exact Client request identity; a cross-request response refuses.
 * @param raw Original native Runtime reply relayed by Platform.
 * @param maxBytes Existing bounded transport response capacity, including multipart framing.
 * @returns Completion after all byte parts are encoded; malformed attachment placeholders and noncanonical base64 refuse.
 */
export async function sendNativeRuntimeResponse(response: ServerResponse, rpcId: string, raw: unknown, maxBytes: number): Promise<void> {
  const source = binary.safeParse(raw)
  if (!source.success) {
    const value = ordinary.parse(raw)
    if (value.rpcId !== rpcId) throw new PlatformError(502, 'native_runtime_rpc_identity')
    sendJson(response, value); return
  }
  const value = source.data
  if (value.rpcId !== rpcId) throw new PlatformError(502, 'native_runtime_rpc_identity')
  const metadata = { type: 'server-response', rpcId, result: value.result,
    attachments: value.attachments.map((item, index) => ({ path: item.path, codec: 'bytes', part: `bytes-${index}` })) }
  let budget = Buffer.byteLength(JSON.stringify(metadata)) + 512 * (value.attachments.length + 1)
  const decoded = value.attachments.map((item) => {
    const bytes = Buffer.from(item.data, 'base64')
    if (bytes.toString('base64') !== item.data) throw new PlatformError(502, 'native_runtime_bytes_invalid')
    budget += bytes.byteLength
    if (budget > maxBytes) throw new PlatformError(502, 'native_runtime_bytes_limit')
    let slot: unknown = value.result.value
    for (const key of item.path) {
      if (slot === null || typeof slot !== 'object' || !Object.hasOwn(slot, key)) throw new PlatformError(502, 'native_runtime_bytes_path')
      slot = Reflect.get(slot, key)
    }
    if (slot !== null) throw new PlatformError(502, 'native_runtime_bytes_path')
    return bytes
  })
  const parts = new FormData()
  for (const [index, bytes] of decoded.entries()) parts.set(`bytes-${index}`, new Blob([new Uint8Array(bytes)]))
  parts.set('metadata', JSON.stringify(metadata))
  const body = new Response(parts), data = Buffer.from(await body.arrayBuffer())
  if (data.byteLength > maxBytes) throw new PlatformError(502, 'native_runtime_bytes_limit')
  if (response.destroyed) return
  response.writeHead(200, { 'content-type': body.headers.get('content-type') ?? 'multipart/form-data',
    'content-length': String(data.length), 'cache-control': 'no-store' })
  response.end(data)
}
