/** Host-only retained writer tokens and bounded internal Platform requests. */
import { PlatformError, type Grant } from '../contracts.ts'
import { nativeWriterAcquire, nativeWriterIdentity, nativeWriterLease, nativeWriterReleased,
  type NativeWriterIdentity, type NativeWriterLease, type NativeWriterReleased } from '../native-writer-contracts.ts'
import type RuntimeScope from './scope.ts'

/** Exact retained Host authority and committed expiry; raw writer tokens remain in Host memory. */
export interface HostNativeWriterLease {
  readonly identity: NativeWriterIdentity
  readonly expiresAt: number
}

function sameReceipt(receipt: NativeWriterLease | NativeWriterReleased,
  identity: Pick<NativeWriterIdentity, 'sessionId' | 'workerId'>, epoch?: number): void {
  if (receipt.sessionId !== identity.sessionId || receipt.workerId !== identity.workerId
    || epoch !== undefined && receipt.epoch !== epoch) throw new PlatformError(502, 'native_writer_receipt')
}

/** Writer maintenance is independent of the operation that originally acquired it. */
export class HostNativeWriterClient {
  /**
   * @param runtime Host worker identity, exact grant guard and bounded Platform transport.
   */
  constructor(private readonly runtime: Pick<RuntimeScope, 'workerId' | 'assertGrant' | 'call'>) {}

  /** Acquire with a caller-retained random token; reuse that token after an uncertain response.
   * @param expected Exact current operation object installed in RuntimeScope.
   * @param retainedToken Host-generated canonical 32-byte base64url token, retained before sending.
   * @param signal Host admission lifetime; transport enforces its configured timeout.
   * @returns Independent writer identity and expiry without replacing the operation grant.
   */
  async acquire(expected: Grant, retainedToken: string, signal?: AbortSignal): Promise<HostNativeWriterLease> {
    this.runtime.assertGrant(expected)
    const request = nativeWriterAcquire.parse({ sessionId: expected.sessionId,
      workerId: this.runtime.workerId, token: retainedToken })
    const lease = nativeWriterLease.parse(await this.runtime.call('/runtime/native-writer/acquire', expected.token, request, signal))
    this.runtime.assertGrant(expected)
    sameReceipt(lease, request)
    return { identity: nativeWriterIdentity.parse({ ...request, epoch: lease.epoch }), expiresAt: lease.expiresAt }
  }

  /** Renew exact occupancy after its originating operation settles, without refreshing any operation grant.
   * @param identity Retained Session, worker, epoch and writer token.
   * @param signal Writer lifetime; transport enforces its configured timeout.
   * @returns Committed tokenless receipt for the same identity.
   */
  async renew(identity: NativeWriterIdentity, signal?: AbortSignal): Promise<NativeWriterLease> {
    const { token, ...input } = identity
    const lease = nativeWriterLease.parse(await this.runtime.call('/runtime/native-writer/renew', token, input, signal))
    sameReceipt(lease, identity, identity.epoch)
    return lease
  }

  /** Release exact occupancy; an uncertain response may be retried with the same retained identity.
   * @param identity Writer authority whose final epoch must remain in PostgreSQL.
   * @param signal Shutdown lifetime; transport enforces its configured timeout.
   * @returns Tokenless release receipt, including exact idempotent repeats until takeover.
   */
  async release(identity: NativeWriterIdentity, signal?: AbortSignal): Promise<NativeWriterReleased> {
    const { token, ...input } = identity
    const released = nativeWriterReleased.parse(await this.runtime.call('/runtime/native-writer/release', token, input, signal))
    sameReceipt(released, identity, identity.epoch)
    return released
  }
}
