/** Admission for the optional rolling carrier. Actual request and allocation ownership stays with DataClient. */
import { CARRIER_LIMITS as L, RESIDENCE_LIMITS as R } from './constants.ts'
import type { CarrierWireUsage } from './types.ts'

export const emptyUsage = (): CarrierWireUsage => ({ attempts: 0, sentBodyBytes: 0, replyBodyAllowance: 0 })

export function canSpend(usage: CarrierWireUsage, attempts: number, sent: number, reply: number): boolean {
  return usage.attempts + attempts <= L.attempts && usage.sentBodyBytes + sent <= L.sentBodyTotal
    && usage.replyBodyAllowance + reply <= L.replyAllowanceTotal
}

export function canSpendWithStopReserve(usage: CarrierWireUsage, sent: number, reply: number): boolean {
  return canSpend(usage, 1 + R.terminalAttempts, sent + R.terminalAttempts * R.fixedControlBytes,
    reply + R.terminalAttempts * L.reply)
}

interface Charge { readonly at: number; readonly sent: number; readonly reply: number }

/** DataClient checks admission and charges synchronously. At most one entry is retained per admitted attempt. */
export class RollingCarrierBudget {
  private readonly charges: Charge[] = []
  private sent = 0
  private reply = 0

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

  charge(now: number, sent: number, reply: number): void {
    this.charges.push({ at: now, sent, reply })
    this.sent += sent
    this.reply += reply
  }
}
