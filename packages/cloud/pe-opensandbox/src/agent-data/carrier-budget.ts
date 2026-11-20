/** Admission for the optional rolling carrier. Actual request and allocation ownership stays with DataClient. */
import { CARRIER_LIMITS as L, RESIDENCE_LIMITS as R } from './constants.ts'
import type { CarrierWireUsage } from './types.ts'

/**
 * Create a fresh carrier charge ledger with zero usage on all three axes.
 * @returns Initial carrier charges before any request is admitted.
 */
export const emptyUsage = (): CarrierWireUsage => ({ attempts: 0, sentBodyBytes: 0, replyBodyAllowance: 0 })

/**
 * Check that the prospective charges fit the carrier ceilings.
 * @param usage - Charges already counted for this admission.
 * @param attempts - Number of additional requests.
 * @param sent - Encoded bytes in the additional request bodies.
 * @param reply - Reply bytes allowed for the additional requests.
 * @returns Whether all three ceilings allow the additional charges.
 */
export function canSpend(usage: CarrierWireUsage, attempts: number, sent: number, reply: number): boolean {
  return usage.attempts + attempts <= L.attempts && usage.sentBodyBytes + sent <= L.sentBodyTotal
    && usage.replyBodyAllowance + reply <= L.replyAllowanceTotal
}

/**
 * Check one ordinary request while retaining space for terminal control and protected progress.
 * @param usage - Charges already counted for this admission.
 * @param sent - Encoded bytes in the request body.
 * @param reply - Reply bytes allowed for the request.
 * @param reserved - Additional unspent capacity held for protected progress.
 * @returns Whether the request fits while both reservations remain available.
 */
export function canSpendWithStopReserve(usage: CarrierWireUsage, sent: number, reply: number, reserved = emptyUsage()): boolean {
  return canSpend(usage, 1 + R.terminalAttempts + reserved.attempts,
    sent + R.terminalAttempts * R.fixedControlBytes + reserved.sentBodyBytes,
    reply + R.terminalAttempts * L.reply + reserved.replyBodyAllowance)
}

/** Keep one rolling window of the original service's poll cadence, startup checks and signed grants. */
export class ServiceProgressBudget {
  private readonly spent = new RollingCarrierBudget()
  private readonly limit: CarrierWireUsage

  constructor(pollBytes: number) {
    const polls = Math.ceil(L.localLifetimeMs / R.minPollMs) + 4
    const attempts = polls + R.grants
    this.limit = { attempts, sentBodyBytes: polls * pollBytes + R.grants * R.fixedControlBytes,
      replyBodyAllowance: attempts * L.reply }
  }

  /**
   * Read unspent protected progress capacity after expired charges age out.
   * @param now - Current monotonic milliseconds.
   * @returns Available attempts and byte allowances for the original service.
   */
  remaining(now: number): CarrierWireUsage {
    const spent = this.spent.usage(now)
    return { attempts: this.limit.attempts - spent.attempts, sentBodyBytes: this.limit.sentBodyBytes - spent.sentBodyBytes,
      replyBodyAllowance: this.limit.replyBodyAllowance - spent.replyBodyAllowance }
  }

  /**
   * Check whether one progress request fits the remaining allowance.
   * @param now - Current monotonic milliseconds.
   * @param sent - Encoded bytes in the request body.
   * @param reply - Reply bytes allowed for the request.
   * @returns Whether one attempt and both byte charges fit.
   */
  canSpend(now: number, sent: number, reply: number): boolean {
    const left = this.remaining(now)
    return left.attempts >= 1 && left.sentBodyBytes >= sent && left.replyBodyAllowance >= reply
  }

  /**
   * Charge an admitted request against the original service's progress allowance.
   * @param now - Admission time in monotonic milliseconds.
   * @param sent - Encoded bytes in the request body.
   * @param reply - Reply bytes allowed for the request.
   */
  charge(now: number, sent: number, reply: number): void { this.spent.charge(now, sent, reply) }
}

interface Charge { readonly at: number; readonly sent: number; readonly reply: number }

/** DataClient checks admission and charges synchronously. At most one entry is retained per admitted attempt. */
export class RollingCarrierBudget {
  private readonly charges: Charge[] = []
  private sent = 0
  private reply = 0

  /**
   * Read the three charges still within the rolling window.
   * @param now - Current monotonic milliseconds.
   * @returns The charges that still count against carrier admission.
   */
  usage(now: number): CarrierWireUsage {
    for (;;) {
      const first = this.charges[0]
      if (first === undefined || now - first.at < L.localLifetimeMs) break
      this.charges.shift()
      this.sent -= first.sent
      this.reply -= first.reply
    }
    return { attempts: this.charges.length, sentBodyBytes: this.sent, replyBodyAllowance: this.reply }
  }

  /**
   * Record one admitted request and its full byte allowances.
   * @param now - Admission time in monotonic milliseconds.
   * @param sent - Encoded bytes in the request body.
   * @param reply - Reply bytes allowed for the request.
   */
  charge(now: number, sent: number, reply: number): void {
    this.charges.push({ at: now, sent, reply })
    this.sent += sent
    this.reply += reply
  }
}
