/** Public HTTP fixture values, normalized without object stringification or untyped JSON. */

/** @param input - Fetch URL input. @returns The URL passed to the transport. */
export function requestUrl(input: RequestInfo | URL): string {
  return typeof input === 'string' ? input : input instanceof URL ? input.href : input.url
}

/** @param body - JSON wire body. @returns Its string after checking the transport shape. */
export function bodyText(body: RequestInit['body']): string {
  if (typeof body !== 'string') throw new TypeError('Expected a JSON string request body')
  return body
}

/** @param text - Literal JSON. @returns A value requiring structural validation before access. */
export function jsonValue(text: string): unknown { return JSON.parse(text) }

/** @param value - Parsed JSON. @returns A checked object for assertions about public fields. */
export function jsonRecord(value: unknown): Record<string, unknown> {
  if (typeof value !== 'object' || value === null || Array.isArray(value)) throw new TypeError('Expected a JSON object')
  return value as Record<string, unknown>
}

/** @param value - Parsed JSON. @returns A checked array whose entries still need validation. */
export function jsonArray(value: unknown): unknown[] {
  if (!Array.isArray(value)) throw new TypeError('Expected a JSON array')
  return value
}

/** @param response - Captured HTTP request. @returns Its checked JSON object. */
export async function responseRecord(response: Request | undefined): Promise<Record<string, unknown>> {
  if (!response) throw new TypeError('Expected a captured HTTP request')
  return jsonRecord(await response.json())
}
