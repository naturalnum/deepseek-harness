/** Private service-content launch handshake; only the clean public URL may enter Native Browser state. */
import type { RpcFetch } from '@deepseek-ai/dsh-client-connection/client'
import type { BindingFieldNames, RequestExpectation } from '@deepseek-ai/dsh-pe-cloud-access/types'
import type { CloudServiceApplicationPolicy } from '../types.ts'
import type { CloudServicePreviewSelection } from './service-preview.ts'
import { ClientFailure } from './errors.ts'
import { readResponse } from './read-response.ts'

/**
 * Transfer a bounded proof by POST and confirm the host-only Cookie before returning a public content URL.
 * @param fetch Original page's private fetch carrier; its bound transport owns the complete operation.
 * @param policy Captured deployment policy, never bootstrap or task data.
 * @param fields Original C02 header names.
 * @param expectation Captured page account/generation consistency inputs.
 * @param selection Original current Session and task service handle.
 * @param signal Original transport, operation deadline and page cancellation.
 * @param current Original page transport current check after each response.
 * @param unauthenticated Original transport's synchronous login revocation callback.
 * @returns Clean credential-free URL after all response bodies settle.
 */
export async function launchServiceApplication(fetch: RpcFetch, policy: CloudServiceApplicationPolicy,
  fields: BindingFieldNames, expectation: RequestExpectation, selection: CloudServicePreviewSelection,
  signal: AbortSignal, current: () => void, unauthenticated: () => void): Promise<string> {
  const fail = (): never => { throw new ClientFailure('target-denied') }
  const encoder = new TextEncoder()
  for (const field of [selection.sessionId, selection.serviceHandle, expectation.accountId, expectation.connectionGeneration]) {
    if (field.length === 0 || /[\u0000-\u0020\u007f]/u.test(field) || encoder.encode(field).byteLength > policy.maxFieldBytes) fail()
  }
  if (!/^[A-Za-z0-9_-]{1,64}$/.test(selection.serviceHandle)) fail()
  const requestBody = (input: object): string => {
    const body = JSON.stringify(input)
    if (encoder.encode(body).byteLength > policy.maxRequestBytes) throw new ClientFailure('capacity')
    return body
  }
  const read = async (target: string, init: RequestInit, expectedStatus: number): Promise<Uint8Array> => {
    current(); signal.throwIfAborted()
    const response = await fetch(target, { ...init, signal, redirect: 'error', referrerPolicy: 'no-referrer', cache: 'no-store' })
    if (response.status === 401 && init.credentials === 'same-origin') unauthenticated()
    // Reading on an already aborted signal would skip response ownership, so cancel this exact body first.
    if (signal.aborted) {
      try { await response.body?.cancel(signal.reason) } catch (error) { throw new ClientFailure('close-unconfirmed', error) }
      signal.throwIfAborted()
    }
    const bytes = await readResponse(response, policy.maxResponseBytes, signal)
    current(); signal.throwIfAborted()
    if (response.status !== expectedStatus) return fail()
    return bytes
  }
  const bytes = await read(policy.managementOrigin + '/cloud/service-application', { method: 'POST', credentials: 'same-origin',
    headers: { 'content-type': 'application/json', [fields.accountHeader]: expectation.accountId,
      [fields.generationHeader]: expectation.connectionGeneration },
    body: requestBody({ sessionId: selection.sessionId, serviceHandle: selection.serviceHandle }) }, 200)
  let input: unknown
  try { input = JSON.parse(new TextDecoder('utf-8', { fatal: true }).decode(bytes)) } catch (_invalid) { return fail() }
  if (input === null || typeof input !== 'object' || Array.isArray(input) || Object.keys(input).length !== 2) return fail()
  const row = input as Record<string, unknown>
  if (typeof row.origin !== 'string' || typeof row.proof !== 'string' || !/^[a-f0-9]{64}$/.test(row.proof)) return fail()
  let origin: URL
  try { origin = new URL(row.origin) } catch (_invalid) { return fail() }
  const configured = new URL(policy.contentOrigin), prefix = origin.hostname.slice(0, 32)
  if (origin.origin !== row.origin || !/^[a-f0-9]{32}$/.test(prefix)
    || origin.hostname !== prefix + '.' + configured.hostname || origin.port !== configured.port
    || origin.protocol !== configured.protocol) return fail()
  const authorized = await read(origin.origin + '/.well-known/dsh-service-preview/authorize', { method: 'POST', credentials: 'include',
    headers: { 'content-type': 'application/json' }, body: requestBody({ proof: row.proof }) }, 204)
  if (authorized.byteLength !== 0) fail()
  const ready = await read(origin.origin + '/.well-known/dsh-service-preview/ready', { method: 'GET', credentials: 'include' }, 204)
  if (ready.byteLength !== 0) fail()
  return origin.origin + '/'
}
