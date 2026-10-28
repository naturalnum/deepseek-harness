/** Private observation only; receipts attest delivery, never permission, remote cleanup or released ownership.
 * A sole protected preload subscribes before application import and receipts each successful bounded stderr write.
 * Missing/duplicate receipts, projection failures and publisher failures permanently taint this owner; the original
 * business Promise and unknown cleanup responsibility are retained. Late attachment cannot reconstruct prior work.
 */
import { channel } from 'node:diagnostics_channel'
import { createHash, randomUUID } from 'node:crypto'
import { writeSync } from 'node:fs'
import type { AllocationCreateIntent } from './allocation-types.ts'

type Operation = 'transport-fetch' | 'transport-close' | 'lifecycle-request' | 'lifecycle-connection-close'
  | 'sdk-create' | 'sdk-prepare' | 'sdk-stop' | 'sdk-root-close' | 'sdk-root-fence'
  | 'bootstrap-request' | 'bootstrap-connection-close' | 'bootstrap' | 'bootstrap-stream' | 'bootstrap-fence' | 'bootstrap-join'
  | 'native-command' | 'native-direct' | 'native-local-settled'

/** Closed safe input set; identities are emitted as fixed SHA256 values, never body/header/error text. */
export interface SemanticFacts {
  readonly intent?: AllocationCreateIntent | undefined
  readonly sandboxId?: string | undefined
  readonly runtimeIdentity?: string | undefined
  readonly operationId?: string | undefined
  readonly method?: string | undefined
  readonly statusCode?: number | undefined
  readonly responseBytes?: number | undefined
  readonly events?: number | undefined
  readonly step?: 'prep' | 'loader' | undefined
  readonly fenced?: boolean | undefined
  readonly initialized?: boolean | undefined
  readonly streamTerminal?: boolean | undefined
  readonly failed?: boolean | undefined
  readonly directObserved?: boolean | undefined
  readonly stdoutEof?: boolean | undefined
  readonly stderrEof?: boolean | undefined
  readonly rangeConfirmed?: boolean | undefined
  readonly localSettled?: boolean | undefined
  readonly remoteAttempted?: boolean | undefined
  readonly physicalStopAcknowledged?: boolean | undefined
}

/** Original local span identity; not a server operation id or authority. */
export interface SemanticSpan { readonly id: number; readonly operation: Operation }

/** Private diagnostics payload; the sole protected receiver receipts only its successful bounded write. */
export interface SemanticAuditEvent {
  readonly version: 1
  readonly owner: string
  readonly sequence: number
  readonly span: number
  readonly operation: Operation
  readonly phase: 'start' | 'end' | 'point'
  readonly outcome: 'fulfilled' | 'rejected' | undefined
  readonly tainted: boolean
  readonly fields: Readonly<Record<string, string | number | boolean>>
  /** Acknowledge this one synchronous delivery after writing; no business authority is conferred. */
  receipt(): void
}

const digest = (value: string): string => createHash('sha256').update(value).digest('hex')
function project(facts: SemanticFacts): Readonly<Record<string, string | number | boolean>> {
  const fields: Record<string, string | number | boolean> = {}
  const intent = facts.intent
  if (intent !== undefined) fields.intentSha256 = digest(JSON.stringify([intent.allocationId, intent.accountId, intent.epoch,
    intent.sessionId, intent.workspaceId, intent.environmentVersion, intent.provider, intent.projectMountVersion,
    intent.requestedAt, intent.createDeadlineAt]))
  for (const key of ['sandboxId', 'runtimeIdentity', 'operationId'] as const) {
    const value = facts[key]
    if (value !== undefined) fields[`${key}Sha256`] = digest(value)
  }
  if (facts.method !== undefined) fields.method = ['GET', 'POST', 'DELETE'].includes(facts.method) ? facts.method : 'other'
  if (facts.step !== undefined) fields.step = facts.step
  for (const key of ['statusCode', 'responseBytes', 'events'] as const) {
    const value = facts[key]
    if (value !== undefined) {
      if (!Number.isSafeInteger(value) || value < 0) throw new Error('Invalid semantic audit counter.')
      fields[key] = value
    }
  }
  for (const key of ['fenced', 'initialized', 'streamTerminal', 'failed', 'directObserved', 'stdoutEof', 'stderrEof',
    'rangeConfirmed', 'localSettled', 'remoteAttempted', 'physicalStopAcknowledged'] as const) {
    const value = facts[key]
    if (value !== undefined) fields[key] = value
  }
  return Object.freeze(fields)
}

/** Instance-owned bounded observation state; absent subscribers add no Promise reactions or emitted work. */
export class PrivateSemanticAudit {
  private readonly channel = channel('dsh:pe-opensandbox:semantic:v1')
  private owner: string | undefined
  private sequence = 0
  private spans = 0
  private tainted = false

  /**
   * Start an observation only when a receiver is already subscribed.
   * @param operation Fixed observation kind.
   * @param facts Safe original identities.
   * @returns Original local span, or undefined without a subscriber.
   */
  begin(operation: Operation, facts: SemanticFacts = {}): SemanticSpan | undefined {
    if (!this.channel.hasSubscribers) {
      if (this.owner !== undefined) this.taint('receipt')
      return undefined
    }
    const span = Object.freeze({ id: ++this.spans, operation })
    this.emit(span, 'start', undefined, facts)
    return span
  }

  /**
   * Publish an observed synchronous fact without authorizing a transition.
   * @param operation Fixed synchronous observation kind.
   * @param facts Safe observed facts.
   */
  point(operation: Operation, facts: SemanticFacts): void {
    if (this.channel.hasSubscribers) this.emit({ id: 0, operation }, 'point', undefined, facts)
    else if (this.owner !== undefined) this.taint('receipt')
  }

  /** Observe the same original Promise; every original return/rejection and identity remains unchanged.
   * @param span Original observation, absent when not subscribed at admission.
   * @param actual Original Promise, never replaced by an observation chain.
   * @param facts Safe final fields read after original settlement; rejected work supplies no value.
   * @returns The exact same Promise object.
   */
  watch<T>(span: SemanticSpan | undefined, actual: Promise<T>, facts: (value?: T) => SemanticFacts = () => ({})): Promise<T> {
    if (span !== undefined) {
      const ended = (outcome: 'fulfilled' | 'rejected', value?: T): void => {
        let final: SemanticFacts
        try { final = facts(value) } catch (_cause) { this.taint('final-fields'); return }
        this.emit(span, 'end', outcome, final)
      }
      void actual.then((value) => { ended('fulfilled', value) }, () => { ended('rejected') })
    }
    return actual
  }

  private emit(span: SemanticSpan, phase: 'start' | 'end' | 'point', outcome: 'fulfilled' | 'rejected' | undefined,
    facts: SemanticFacts): void {
    let receipts = 0
    try {
      this.owner ??= randomUUID()
      const event: SemanticAuditEvent = Object.freeze({ version: 1, owner: this.owner, sequence: ++this.sequence, span: span.id,
        operation: span.operation, phase, outcome, tainted: this.tainted, fields: project(facts),
        receipt: () => { receipts++ } })
      this.channel.publish(event)
    } catch (_cause) { this.taint('publisher'); return }
    // A protected sole subscriber receipts only after its bounded original-stderr write succeeds.
    // Node defers subscriber throws to uncaughtException; no receipt also taints before that turn.
    if (receipts !== 1) this.taint('receipt')
  }

  private taint(reason: 'publisher' | 'receipt' | 'final-fields'): void {
    if (this.tainted) return
    this.tainted = true
    try { writeSync(2, `DSH_SEMANTIC_AUDIT_TAINT ${JSON.stringify({ owner: this.owner, sequence: this.sequence, reason })}\n`) }
    catch (_cause) { /* Evidence remains tainted; a missing receipt/end and future tainted events cannot qualify it. */ }
  }
}
