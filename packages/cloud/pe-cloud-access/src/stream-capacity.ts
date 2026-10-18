/** Finite actual logical-stream ownership; unknown cleanup retains every charged scope. */
import type { AccountId } from '@deepseek-ai/dsh-pe-cloud-runtime/types'
import type { Branded } from '@deepseek-ai/dsh-brand'
import { AuthAccessError } from './auth-error.ts'
import type { AuthIngressConfig } from './root-config.ts'

type Limits = Pick<AuthIngressConfig, 'maxLogicalStreams' | 'maxLogicalStreamsPerAccount' | 'maxLogicalStreamsPerPeer'>

/** Package-private accounting; authentication and actual Peer checks remain the registry's responsibility. */
export class StreamCapacity {
  private total = 0
  private readonly accounts = new Map<AccountId, number>()
  private readonly peers = new WeakMap<object, number>()
  private readonly blocked = new WeakSet<object>()
  private closed = false

  /** @param limits Explicit root/global/account/Peer capacities. */
  constructor(private readonly limits: Limits) {}

  /**
   * Count logical streams retained through actual settlement.
   * @returns Actual retained slots, including unknown cleanup.
   */
  get pending(): number { return this.total }

  /**
   * Reserve synchronously before the native stream table or inbox exists.
   * @param accountId Already verified account.
   * @param peer Exact internal entry owning the native Peer, never a browser id.
   * @param requestId Server correlation id.
   * @param unknown Close admission without awaiting this stream or its own transport.
   * @returns Single-shot native settlement callback; unknown permanently retains its slot.
   */
  acquire(accountId: AccountId, peer: object, requestId: Branded<'pe-request-id'>, unknown: () => void): (status: 'confirmed' | 'unknown') => void {
    if (this.closed || this.blocked.has(peer)) throw new AuthAccessError('cloud/account-unavailable', requestId)
    const accountCount = this.accounts.get(accountId) ?? 0
    const peerCount = this.peers.get(peer) ?? 0
    if (this.total >= this.limits.maxLogicalStreams || accountCount >= this.limits.maxLogicalStreamsPerAccount
      || peerCount >= this.limits.maxLogicalStreamsPerPeer) throw new AuthAccessError('cloud/capacity', requestId)
    this.total++
    this.accounts.set(accountId, accountCount + 1)
    this.peers.set(peer, peerCount + 1)
    let settled = false
    return (status) => {
      if (settled) return
      settled = true
      if (status === 'unknown') { this.blocked.add(peer); unknown(); return }
      this.total--
      const remaining = (this.accounts.get(accountId) ?? 1) - 1
      if (remaining === 0) this.accounts.delete(accountId)
      else this.accounts.set(accountId, remaining)
      this.peers.set(peer, (this.peers.get(peer) ?? 1) - 1)
    }
  }

  /** Stop new reservations; actual confirmed callbacks still release their original slots. */
  close(): void { this.closed = true }
}
