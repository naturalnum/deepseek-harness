/** Leased Cloud STDIO orchestration; committed start grants are never reconstructed during recovery. */
import { randomUUID } from 'node:crypto'
import { setTimeout as delay } from 'node:timers/promises'
import { stdioReceiptRequestV2 } from '@power-evolve/contracts/stdio-mcp'
import { stdioWorkerIdV2, type StdioActionLeaseV2, type StdioWorkerIdV2 } from '@power-evolve/contracts/stdio-runtime'
import { PlatformError } from '../contracts.ts'
import type { StdioAuthorizationServiceV2 } from './stdio-v2-authorization.ts'
import type { StdioCloudRunTransportV2 } from './stdio-v2-cloud-runtime.ts'
import type { StdioCloudWorkerStoreV2 } from './stdio-v2-worker-store.ts'
import type { StdioResultServiceV2 } from './stdio-v2-results.ts'
import type { StdioNoStartReceiptV2 } from './stdio-v2-no-start.ts'
import type { SandboxManager } from './sandbox.ts'

/** Short authority transactions and original, lease-fenced worker records. */
export type StdioCloudWorkerStoreApiV2 = Pick<StdioCloudWorkerStoreV2,
  'claimNext' | 'renew' | 'snapshot' | 'beginPreparation' | 'attach' | 'defer' | 'release' | 'capture'
  | 'assertProvisioning' | 'closeUnstarted' | 'readNoStart'>

/** Explicit polling and renewal inputs; the supervisor supplies a fresh process generation. */
export interface StdioCloudWorkerOptionsV2 {
  readonly workerId: StdioWorkerIdV2
  readonly pollMs: number
  readonly renewMs: number
  readonly leaseMs: number
}

/** Fixed orchestration outcomes; no private database, command or Runner errors are returned. */
export type StdioCloudWorkerStepV2 = 'pending' | 'observed' | 'finalized' | 'deferred' | 'lease-lost' | 'stopped'

class WorkInterrupted extends Error {
  constructor(readonly kind: 'cancelled' | 'stopped' | 'lease-lost') { super(kind) }
}

async function wait(ms: number, signal: AbortSignal): Promise<boolean> {
  if (signal.aborted) return false
  try { await delay(ms, undefined, { signal }); return !signal.aborted }
  catch (error) { if (signal.aborted) return false; throw error }
}

function leaseLost(error: unknown): boolean {
  return error instanceof PlatformError && error.code === 'stdio_v2_lease_lost'
    || error instanceof WorkInterrupted && error.kind === 'lease-lost'
}

/** One leased action per worker; shutdown waits for every owned creation, capture and HTTP request. */
export class StdioCloudWorkerV2 {
  private readonly options: Readonly<StdioCloudWorkerOptionsV2>
  private active: Promise<void> | undefined
  private currentStep: Promise<StdioCloudWorkerStepV2> | undefined
  private controller: AbortController | undefined
  private stepping = false

  constructor(private readonly store: StdioCloudWorkerStoreApiV2,
    private readonly authorization: Pick<StdioAuthorizationServiceV2, 'prepareLeased' | 'authorizeLeased'>,
    private readonly sandboxes: Pick<SandboxManager, 'ensureReady' | 'cancelCreation'>,
    private readonly transport: Pick<StdioCloudRunTransportV2, 'startDetached' | 'observeDetached' | 'cancelDetached'>,
    private readonly results: Pick<StdioResultServiceV2, 'record'>, options: StdioCloudWorkerOptionsV2) {
    if ([options.pollMs, options.renewMs, options.leaseMs].some(value => !Number.isSafeInteger(value)
      || value < 1 || value > 2_147_483_647) || options.renewMs >= options.leaseMs) {
      throw new TypeError('stdio_v2_worker_budget_invalid')
    }
    this.options = Object.freeze({ ...options, workerId: stdioWorkerIdV2.parse(options.workerId) })
  }

  /** Poll for durable work; no process-local task queue is authoritative.
   * @param signal Supervisor cancellation, combined with stop().
   * @returns Completion after current work and lease renewal have settled.
   */
  async run(signal: AbortSignal): Promise<void> {
    if (this.active || this.stepping) throw new Error('stdio_v2_worker_running')
    const controller = new AbortController()
    this.controller = controller
    const combined = AbortSignal.any([signal, controller.signal])
    const active = Promise.resolve().then(() => this.loop(combined))
    this.active = active
    try { await active }
    finally { this.active = undefined; this.controller = undefined }
  }

  /** Stop claiming work and await the current operation without granting a replacement executor.
   * @returns Quiescence of this worker, including in-flight authorization and network work.
   */
  async stop(): Promise<void> {
    this.controller?.abort()
    await this.active
    await this.currentStep
  }

  private async loop(signal: AbortSignal): Promise<void> {
    while (!signal.aborted) {
      let lease: StdioActionLeaseV2 | null
      try { lease = await this.store.claimNext(this.options.workerId) }
      catch (_claimUnavailable) { if (!await wait(this.options.pollMs, signal)) return; continue }
      if (!lease) { if (!await wait(this.options.pollMs, signal)) return; continue }
      await this.step(lease, signal)
      // Pending approval, unavailable runners and slow observations cannot create a hot claim loop.
      if (!await wait(this.options.pollMs, signal)) return
    }
  }

  /** Process one already-claimed action without replaying an earlier dispatch intent.
   * @param lease Current internal worker identity and epoch, checked by the store at every write.
   * @param signal Supervisor cancellation; an issued permit remains an original reconciliation record.
   * @returns One bounded attempt's category; predispatch cancellation retains resources until formal closure.
   */
  async step(lease: StdioActionLeaseV2, signal: AbortSignal): Promise<StdioCloudWorkerStepV2> {
    if (this.stepping) throw new Error('stdio_v2_worker_running')
    if (lease.workerId !== this.options.workerId) throw new Error('stdio_v2_worker_owner_changed')
    const active = this.process(lease, signal)
    this.currentStep = active
    try { return await active }
    finally { this.currentStep = undefined }
  }

  private async process(lease: StdioActionLeaseV2, signal: AbortSignal): Promise<StdioCloudWorkerStepV2> {
    this.stepping = true
    const renewalStop = new AbortController()
    let lost = false
    const renewal = (async () => {
      while (await wait(this.options.renewMs, renewalStop.signal)) {
        try { await this.store.renew(lease) }
        catch (_renewUnavailable) { lost = true; return }
      }
    })()
    const assertLive = async () => {
      if (lost) throw new WorkInterrupted('lease-lost')
      const current = await this.store.snapshot(lease)
      if (lost) throw new WorkInterrupted('lease-lost')
      return current
    }
    const capture = async (mode: 'dispatch' | 'observe', operation: Parameters<StdioCloudWorkerStoreV2['capture']>[2]) => {
      if (lost) throw new WorkInterrupted('lease-lost')
      if (mode === 'dispatch' && signal.aborted) throw new WorkInterrupted('stopped')
      const writer = await this.store.capture(lease, mode, operation)
      if (lost) throw new WorkInterrupted('lease-lost')
      if (mode === 'dispatch' && signal.aborted) throw new WorkInterrupted('stopped')
      return writer
    }
    const assertCreation = async () => {
      const current = await assertLive()
      if (signal.aborted) throw new WorkInterrupted('stopped')
      if (current.cancelRequested) throw new WorkInterrupted('cancelled')
      if (current.dispatch || current.writer) throw new WorkInterrupted('lease-lost')
    }
    let outcome: StdioCloudWorkerStepV2 = 'deferred'
    try {
      let original = await assertLive()
      if (signal.aborted) return 'stopped'
      if (!original.dispatch && original.cancelRequested) {
        return await this.cancelUnstarted(lease, assertLive, () => lost)
      }
      if (!original.dispatch) {
        if (!original.prepared) await this.store.beginPreparation(lease)
        if (!original.writer) {
          const { sessionId, userId } = original.task
          const writer = await this.sandboxes.ensureReady(sessionId, userId, assertCreation, async (client, mode) => {
            if (lost) throw new WorkInterrupted('lease-lost')
            await this.store.assertProvisioning(client, lease, sessionId, userId, mode)
            if (lost) throw new WorkInterrupted('lease-lost')
          })
          if (lost) throw new WorkInterrupted('lease-lost')
          // Retain a known physical identity even if the supervisor stopped while creation completed.
          await this.store.attach(lease, writer)
          original = await assertLive()
        }
        if (signal.aborted) return 'stopped'
        if (original.cancelRequested) {
          return await this.cancelUnstarted(lease, assertLive, () => lost)
        }
        if (!original.prepared) {
          await this.authorization.prepareLeased(lease)
          original = await assertLive()
        }
        if (signal.aborted) return 'stopped'
        if (original.cancelRequested) {
          return await this.cancelUnstarted(lease, assertLive, () => lost)
        }
        if (original.state !== 'approved') return 'pending'
        if (!original.prepared || original.prepared.prepared.capture.kind !== 'cloud') throw new Error('stdio_v2_preparation_missing')
        const grant = await this.authorization.authorizeLeased(lease,
          stdioReceiptRequestV2.parse({ requestId: randomUUID() }).requestId,
          { kind: 'cloud', runnerInstanceId: original.prepared.prepared.capture.runnerInstanceId })
        // Only this confirmed true response may start. A lost COMMIT reply leaves a query-only intent.
        original = await assertLive()
        if (!original.dispatch || !original.prepared) throw new Error('stdio_v2_dispatch_missing')
        if (signal.aborted) return 'stopped'
        const observation = original.cancelRequested
          ? await this.transport.cancelDetached(original.dispatch, original.prepared.prepared, capture)
          : await this.transport.startDetached(original.dispatch, grant, original.prepared.prepared, capture)
        if (lost) return 'lease-lost'
        if (!observation) { await this.store.defer(lease, 'stdio_v2_runner_absent'); return 'deferred' }
        const receipt = await this.results.record(lease, observation)
        return receipt.finalized ? 'finalized' : 'observed'
      }
      // Recovery uses the committed original dispatch, without prepare(), authorize() or ensureReady().
      if (!original.prepared) throw new Error('stdio_v2_preparation_missing')
      if (original.cancelRequested) await this.store.defer(lease, 'stdio_v2_cancel_requested')
      const observation = original.cancelRequested
        ? await this.transport.cancelDetached(original.dispatch, original.prepared.prepared, capture)
        : await this.transport.observeDetached(original.dispatch, original.prepared.prepared, capture)
      if (lost) return 'lease-lost'
      if (!observation) { await this.store.defer(lease, 'stdio_v2_runner_absent'); return 'deferred' }
      const receipt = await this.results.record(lease, observation)
      outcome = receipt.finalized ? 'finalized' : 'observed'
    } catch (error) {
      if (leaseLost(error) || lost) { lost = true; outcome = 'lease-lost' }
      else if (error instanceof WorkInterrupted && error.kind === 'stopped') outcome = 'stopped'
      else {
        try {
          if (error instanceof WorkInterrupted && error.kind === 'cancelled') outcome = await this.cancelUnstarted(lease, assertLive, () => lost)
          else await this.store.defer(lease, 'stdio_v2_worker_unavailable')
        } catch (deferError) {
          if (leaseLost(deferError)) { lost = true; outcome = 'lease-lost' }
          // An unknown DB acknowledgement leaves the existing reservation; no terminal facts are invented.
        }
      }
    } finally {
      renewalStop.abort()
      await renewal
      try { if (!lost) await this.store.release(lease) }
      catch (_releaseUnavailable) { /* The database-clock lease expires without granting a new program start. */ }
      this.stepping = false
    }
    return outcome
  }

  private noStartMatches(lease: StdioActionLeaseV2, original: Awaited<ReturnType<StdioCloudWorkerStoreV2['snapshot']>>,
    receipt: StdioNoStartReceiptV2): void {
    if (receipt.actionId !== lease.actionId
      || receipt.actionId !== original.task.actionId || receipt.executionRef.kind !== original.executionRef.kind
      || receipt.executionRef.executionId !== original.executionRef.executionId || receipt.taskDigest !== original.taskDigest
      || receipt.userId !== original.task.userId || receipt.sessionId !== original.task.sessionId
      || receipt.phase !== original.task.phase || receipt.preparedDigest !== (original.prepared?.preparedDigest ?? null)
      || original.writer && (receipt.resource.kind !== 'ready_retained'
        || receipt.resource.name !== original.writer.name || receipt.resource.podUid !== original.writer.podUid
        || receipt.resource.runnerInstanceId !== original.writer.runnerInstanceId)) {
      throw new PlatformError(409, 'stdio_v2_no_start_receipt_changed')
    }
  }

  private async closeUnstarted(lease: StdioActionLeaseV2,
    original: Awaited<ReturnType<StdioCloudWorkerStoreV2['snapshot']>>, isLost: () => boolean): Promise<void> {
    if (isLost()) throw new WorkInterrupted('lease-lost')
    let receipt: StdioNoStartReceiptV2
    try { receipt = await this.store.closeUnstarted(lease) }
    catch (error) {
      if (leaseLost(error) || isLost()) throw new WorkInterrupted('lease-lost')
      if (error instanceof PlatformError) throw error
      // A missing COMMIT acknowledgement permits only a read of this original closure.
      const recorded = await this.store.readNoStart(lease.actionId)
      if (isLost()) throw new WorkInterrupted('lease-lost')
      if (!recorded) throw error
      receipt = recorded
    }
    if (isLost()) throw new WorkInterrupted('lease-lost')
    this.noStartMatches(lease, original, receipt)
  }

  private async cancelUnstarted(lease: StdioActionLeaseV2,
    assertLive: () => ReturnType<StdioCloudWorkerStoreV2['snapshot']>, isLost: () => boolean): Promise<'finalized' | 'deferred'> {
    await this.store.defer(lease, 'stdio_v2_cancel_requested')
    const original = await assertLive()
    try {
      await this.closeUnstarted(lease, original, isLost)
      return 'finalized'
    } catch (error) {
      if (!(error instanceof PlatformError && error.status === 409
        && error.code === 'stdio_v2_no_start_resources_unavailable')) throw error
    }
    const current = await assertLive()
    // Ready writers retain their mounts; only an uncaptured original creation can be cleaned up here.
    if (current.dispatch || current.writer) return 'deferred'
    await this.sandboxes.cancelCreation(current.executionRef.executionId, current.task.sessionId, current.task.userId,
      lease.workerId, async () => { await assertLive() })
    const stopped = await assertLive()
    await this.closeUnstarted(lease, stopped, isLost)
    return 'finalized'
  }
}
