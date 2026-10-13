/** Bounded JSON transport and error responses shared by the two product services. */
import type { IncomingMessage, ServerResponse } from 'node:http'
import { once } from 'node:events'
import { ZodError } from 'zod'
import { PlatformError } from './contracts.ts'

/** Read one JSON request within its byte limit.
 * @param request - incoming request.
 * @param maximumBytes - maximum complete body size.
 * @returns parsed JSON for a boundary-specific validator.
 */
export async function readJson(request: IncomingMessage, maximumBytes: number): Promise<unknown> {
  const buffers: Buffer[] = []
  let length = 0
  for await (const value of request) {
    const chunk = Buffer.isBuffer(value) ? value : Buffer.from(String(value))
    length += chunk.length
    if (length > maximumBytes) throw new PlatformError(413, 'request_too_large')
    buffers.push(chunk)
  }
  try { return JSON.parse(Buffer.concat(buffers).toString('utf8')) }
  catch (error) { throw new PlatformError(400, error instanceof SyntaxError ? 'invalid_json' : 'invalid_body') }
}

/** Read an opaque bearer credential; callers determine its audience and scope. */
export function bearer(request: IncomingMessage): string {
  const match = /^Bearer ([A-Za-z0-9_-]{32,256})$/.exec(request.headers.authorization ?? '')
  if (!match?.[1]) throw new PlatformError(401, 'unauthorized')
  return match[1]
}

/** Send a JSON result without caching private data. */
export function sendJson(response: ServerResponse, value: unknown, status = 200): void {
  response.writeHead(status, { 'content-type': 'application/json; charset=utf-8', 'cache-control': 'no-store' })
  response.end(JSON.stringify(value))
}

/** Convert known refusals to public codes while keeping internal errors out of responses. */
export function sendFailure(response: ServerResponse, error: unknown): void {
  if (response.headersSent) { response.destroy(); return }
  if (error instanceof PlatformError) {
    sendJson(response, { error: error.code, ...(error.details === undefined ? {} : { details: error.details }) }, error.status); return
  }
  if (error instanceof ZodError) { sendJson(response, { error: 'invalid_request' }, 400); return }
  sendJson(response, { error: 'service_unavailable' }, 503)
}

/** Write a stream item while respecting socket backpressure and disconnection. */
export async function writeLine(response: ServerResponse, value: unknown, signal: AbortSignal): Promise<void> {
  signal.throwIfAborted()
  if (!response.write(`${JSON.stringify(value)}\n`)) await once(response, 'drain', { signal })
}
