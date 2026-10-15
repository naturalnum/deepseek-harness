/** Direct Platform secret intake; native Host RPC carries only names and immutable references. */
import { stdioEnvironmentReceipt, stdioEnvironmentTicket, stdioEnvironmentTicketRequest,
  stdioEnvironmentUpload, type StdioEnvironmentTicketRequest } from '@power-evolve/contracts/stdio-environment'
import type { StdioEnvironmentRef } from '@power-evolve/contracts/mcp-metadata'
import { approvalUrl } from './approval-api.ts'
import { StdioV2HttpError } from './stdio-v2-api.ts'

/** Editable process variable; an undefined value retains the exact saved source value. */
export interface StdioEnvironmentField { readonly name: string; readonly value?: string }
/** Browser-local intake; replacement values never enter metadata requests or persisted form receipts. */
export class StdioEnvironmentHttpClient {
  constructor(private readonly request: typeof fetch = (...args) => globalThis.fetch(...args)) {}
  private async json(response: Response): Promise<unknown> {
    if (!response.ok) throw new StdioV2HttpError(response.status)
    return response.json() as Promise<unknown>
  }
  private async post(method: string, value: object): Promise<unknown> {
    return this.json(await this.request(`/api/powerEvolve/${method}`, { method: 'POST', credentials: 'same-origin',
      redirect: 'error', headers: { 'content-type': 'application/json' }, body: JSON.stringify({ request: value }) }))
  }
  /** Upload explicit replacements, retaining names only in the saved process configuration.
   * @param requestId Original upload submission identity, stable across uncertain outcomes.
   * @param fields Complete desired variable list; omitted values require an exact saved source.
   * @param source Original connection revision containing the retained values.
   * @returns Immutable masked reference, or undefined for an empty environment.
   */
  async prepare(requestId: string, fields: readonly StdioEnvironmentField[], source?: StdioEnvironmentTicketRequest['source']): Promise<StdioEnvironmentRef | undefined> {
    if (fields.length === 0) return undefined
    const upload = stdioEnvironmentUpload.parse({ formatVersion: 1,
      values: fields.flatMap(item => item.value === undefined ? [] : [{ name: item.name, value: item.value }]) })
    const bytes = new TextEncoder().encode(JSON.stringify(upload))
    try {
      const metadata = stdioEnvironmentTicketRequest.parse({ requestId, sizeBytes: bytes.byteLength,
        ...(source ? { source } : {}), keys: fields.map(item => ({ name: item.name, action: item.value === undefined ? 'retain' : 'replace' })) })
      const prior = stdioEnvironmentReceipt.parse(await this.post('stdioV2EnvironmentReceipt', { requestId }))
      if (prior.environment) return prior.environment
      const ticket = stdioEnvironmentTicket.parse(await this.post('stdioV2EnvironmentTicket', metadata))
      const trusted = new URL(await approvalUrl(this.request)), destination = new URL(ticket.uploadUrl)
      if (ticket.requestId !== requestId || destination.origin !== trusted.origin || destination.pathname !== '/stdio-environment/upload'
        || destination.username || destination.password || destination.search || destination.hash
        || Date.parse(ticket.expiresAt) <= Date.now()) {
        throw new StdioV2HttpError(502)
      }
      try {
        const value = await this.json(await this.request(destination.href, { method: 'POST', credentials: 'omit', redirect: 'error',
          referrerPolicy: 'no-referrer', headers: { authorization: `Bearer ${ticket.ticket}`, 'content-type': 'application/octet-stream' }, body: bytes }))
        const receipt = stdioEnvironmentReceipt.parse(value)
        if (!receipt.environment) throw new StdioV2HttpError(502)
        return receipt.environment
      } catch (cause) {
        const receipt = stdioEnvironmentReceipt.parse(await this.post('stdioV2EnvironmentReceipt', { requestId }))
        if (receipt.environment) return receipt.environment
        throw cause
      }
    } finally { bytes.fill(0) }
  }
}
