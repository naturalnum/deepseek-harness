/** Bounded access-owned opaque tokens for actual runtime generations; no account or readiness issuer. */
import { randomUUID } from 'node:crypto'
import type { Branded } from '@deepseek-ai/dsh-brand'
import type { AccountBinding, AccountId, AccountRuntimeService } from '@deepseek-ai/dsh-pe-cloud-runtime/types'
import { AuthAccessError } from './auth-error.ts'

type Generation = Branded<'pe-connection-generation'>
interface Record {
  readonly binding: AccountBinding
  readonly value: Generation
  readonly remove: () => void
}

/** Package-private token owner; business-current is required again for every lookup or comparison. */
export class ConnectionGenerations {
  private readonly records = new Map<AccountId, Record>()
  private closed = false

  /** @param runtime Actual root runtime. @param maximum Explicit retained-generation limit. */
  constructor(private readonly runtime: AccountRuntimeService, private readonly maximum: number) {}

  /**
   * Get one stable token for the exact currently published graph.
   * @param binding Runtime-owned binding from an actual AccountUse.
   * @param requestId Server correlation id.
   * @returns The same opaque token through same-generation reborrows.
   */
  current(binding: AccountBinding, requestId: Branded<'pe-request-id'>): Generation {
    if (this.closed || binding.lifetime.aborted) throw new AuthAccessError('cloud/account-unavailable', requestId)
    this.runtime.assertBusinessCurrent(binding)
    const existing = this.records.get(binding.accountId)
    if (existing !== undefined) {
      if (existing.binding.epoch !== binding.epoch || existing.binding.recipeVersion !== binding.recipeVersion
        || existing.binding.lifetime !== binding.lifetime) throw new AuthAccessError('cloud/account-unavailable', requestId)
      return existing.value
    }
    if (this.records.size >= this.maximum) throw new AuthAccessError('cloud/capacity', requestId)
    const record: Record = {
      binding, value: randomUUID() as Generation,
      remove: () => { if (this.records.get(binding.accountId) === record) this.records.delete(binding.accountId) },
    }
    this.records.set(binding.accountId, record)
    binding.lifetime.addEventListener('abort', record.remove, { once: true })
    return record.value
  }

  /** Revoke retained tokens and remove observers after ingress and Peer work has stopped. */
  close(): void {
    this.closed = true
    for (const record of this.records.values()) record.binding.lifetime.removeEventListener('abort', record.remove)
    this.records.clear()
  }
}
