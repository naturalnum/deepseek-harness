/** Session/handle-only navigation using the original transport's private C02 capture. */
import type { BindingFieldNames, RequestExpectation } from '@deepseek-ai/dsh-pe-cloud-access/types'
import type { CloudServicePreviewPolicy } from '../types.ts'
import type { CloudServicePreviewSelection } from './service-preview.ts'
import { ClientFailure } from './errors.ts'

const bytes = (value: string): number => new TextEncoder().encode(value).byteLength
const need = (ok: unknown): void => { if (!ok) throw new ClientFailure('target-denied') }
function text(value: unknown, maximum: number): string {
  if (typeof value !== 'string' || value.length === 0 || value.length > maximum || bytes(value) > maximum
    || /[\u0000-\u0020\u007f]/u.test(value)) throw new ClientFailure('target-denied')
  return value
}

/**
 * Build a bounded preview GET URL from a Session/handle pair and captured account/generation values.
 * @param selected Original framework Session and recorded handle.
 * @param policy Captured Root policy.
 * @param fields Captured C02 fields.
 * @param expected Captured C02 values.
 * @returns Exact GET navigation URL, never an authorization token.
 */
export function servicePreviewUrl(selected: CloudServicePreviewSelection, policy: Readonly<CloudServicePreviewPolicy>,
  fields: Readonly<BindingFieldNames>, expected: Readonly<RequestExpectation>): string {
  need(Object.keys(selected).length === 2
    && Object.hasOwn(selected, 'sessionId') && Object.hasOwn(selected, 'serviceHandle'))
  const sessionId = text(selected.sessionId, policy.maxFieldBytes), serviceHandle = text(selected.serviceHandle, policy.maxFieldBytes)
  need(/^[A-Za-z0-9_-]{1,64}$/.test(serviceHandle))
  const names = ['sessionId', 'serviceHandle', fields.accountQuery, fields.generationQuery]
  need(new Set(names).size === names.length && names.every(name => /^[A-Za-z][A-Za-z0-9_-]*$/.test(name)))
  const url = new URL(policy.routePath, policy.previewOrigin)
  url.searchParams.set('sessionId', sessionId); url.searchParams.set('serviceHandle', serviceHandle)
  url.searchParams.set(fields.accountQuery, text(expected.accountId, policy.maxFieldBytes))
  url.searchParams.set(fields.generationQuery, text(expected.connectionGeneration, policy.maxFieldBytes))
  need(bytes(url.href) <= policy.maxUrlBytes)
  return url.href
}
