/** Original transport occurrences; parsing never falls back between carriers or selects identity. */
import type { IncomingMessage } from 'node:http'
import type { Branded } from '@deepseek-ai/dsh-brand'
import { parseRequestExpectation } from './binding.ts'
import type { BindingFieldNames, RequestExpectation } from './types.ts'

/**
 * Extract exactly the configured carrier, preserving repeated header/query values.
 * @param request - Original Node request with unmerged raw header pairs.
 * @param url - Parsed original URL; query values are decoded once by URLSearchParams.
 * @param fields - Fixed deployment field names.
 * @param carrier - Server-selected route carrier, never a browser option or fallback.
 * @param requestId - Server correlation id.
 * @returns The validated consistency inputs, without authentication authority.
 */
export function readRequestExpectation(
  request: IncomingMessage, url: URL, fields: BindingFieldNames, carrier: 'headers' | 'query',
  requestId: Branded<'pe-request-id'>,
): RequestExpectation {
  const values = (name: string): string[] => {
    const result: string[] = []
    for (let index = 0; index < request.rawHeaders.length; index += 2) {
      if (request.rawHeaders[index]?.toLowerCase() === name) result.push(request.rawHeaders[index + 1] ?? '')
    }
    return result
  }
  return parseRequestExpectation(carrier === 'headers'
    ? { accountIds: values(fields.accountHeader), connectionGenerations: values(fields.generationHeader) }
    : { accountIds: url.searchParams.getAll(fields.accountQuery), connectionGenerations: url.searchParams.getAll(fields.generationQuery) },
  requestId)
}
