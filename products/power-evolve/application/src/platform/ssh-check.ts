/** Trusted, durable SSH authentication checks. No credential or internal call row crosses to Host. */
import { createHmac } from 'node:crypto'
import { lookup } from 'node:dns/promises'
import { isIP } from 'node:net'
import { PlatformError, type Identity } from '../contracts.ts'
import { SshCallStore, dispatchFirstSshCall, type SshCallLease, type SshCallRow } from './ssh-calls.ts'
import { SshConnectionService } from './ssh.ts'
import { SshRunnerBlocked, SshRunnerOrchestrator, type SshRunnerHandle,
  type SshRunnerObservation, type SshRunnerStatus } from './ssh-runner.ts'

const TIMEOUT_MS = 10_000
const MAX_OUTPUT_BYTES = 1024
// The Runner Pod has a 180-second active deadline; retain uncertain status beyond cleanup.
const UNCERTAIN_CLEANUP_GRACE_MS = 5 * 60_000
const safeCode = /^[a-z][a-z0-9_]{0,99}$/u
const safeBanner = (value: unknown): value is string | null => value === null || typeof value === 'string'
  && Buffer.byteLength(value) <= 512 && !/[\x00-\x08\x0b\x0c\x0e-\x1f\x7f]/u.test(value)

/** Fields permitted in an authenticated Host response. */
export interface SshCheckView {
  readonly callId: string
  readonly state: SshCallRow['state']
  readonly result?: { readonly kind: 'ssh.authenticate'; readonly serverBanner: string | null }
  readonly errorCode?: string
}

/** Deployment-owned worker identity, keyed admission, lease and poll durations, and optional DNS policy. */
export interface SshCheckOptions {
  readonly ownerId: string
  readonly requestKey: string
  readonly leaseMs: number
  /** Delay before a confirmed running call can be reclaimed for GET-only observation. */
  readonly pollMs: number
  readonly resolveHost?: (host: string) => Promise<string>
}

/** Admit and complete one owner-scoped SSH authentication check per claimed call. */
export class SshAuthenticationCheck {
  private readonly resolveHost: (host: string) => Promise<string>

  constructor(private readonly calls: SshCallStore, private readonly connections: SshConnectionService,
    private readonly runner: SshRunnerOrchestrator, private readonly options: SshCheckOptions) {
    if (!options.ownerId || options.requestKey.length < 32
      || !Number.isSafeInteger(options.leaseMs) || options.leaseMs < 1000
      || !Number.isSafeInteger(options.pollMs) || options.pollMs < 100) {
      throw new Error('Invalid SSH check configuration')
    }
    this.resolveHost = options.resolveHost ?? (async host => isIP(host) ? host
      : (await lookup(host, { family: 0 })).address)
  }

  private present(row: SshCallRow): SshCheckView {
    const view: SshCheckView = { callId: row.id, state: row.state }
    if (row.state === 'succeeded' && row.result && typeof row.result === 'object'
      && 'kind' in row.result && row.result.kind === 'ssh.authenticate'
      && 'serverBanner' in row.result && safeBanner(row.result.serverBanner)) {
      return { ...view, result: { kind: 'ssh.authenticate', serverBanner: row.result.serverBanner } }
    }
    return row.error_code && safeCode.test(row.error_code)
      ? { ...view, errorCode: row.error_code } : view
  }

  /** Admit a check with a digest binding every submitted field to its verified owner.
   * @param user Authenticated check owner.
   * @param input Durable request and selected connection revision.
   * @param credentialToken Raw agent bearer rechecked by admission under the account lock.
   * @returns Original receipt for an identical retry.
   */
  async submit(user: Identity, input: { readonly requestId: string
    readonly connectionId: string
    readonly connectionRevision: number }, credentialToken: string): Promise<SshCheckView> {
    const requestDigest = createHmac('sha256', this.options.requestKey)
      .update(JSON.stringify({ kind: 'ssh.authenticate', userId: user.userId,
        requestId: input.requestId, connectionId: input.connectionId,
        connectionRevision: input.connectionRevision, timeoutMs: TIMEOUT_MS,
        maxOutputBytes: MAX_OUTPUT_BYTES })).digest('hex')
    return this.present(await this.calls.admit(user, { ...input, kind: 'ssh.authenticate', requestDigest }, credentialToken))
  }

  /** Return only safe owner-scoped status fields.
   * @param user - verified owner of the original call.
   * @param callId - durable call identity to read.
   * @returns the call state and permitted public result or error fields.
   */
  async status(user: Identity, callId: string): Promise<SshCheckView> {
    return this.present(await this.calls.get(user, callId))
  }

  /** Restore recent owner-scoped checks after a browser refresh.
   * @param user - verified owner whose authentication checks are visible.
   * @returns recent authentication checks projected to safe public fields.
   */
  async list(user: Identity): Promise<{ items: SshCheckView[] }> {
    return { items: (await this.calls.list(user)).filter(row => row.kind === 'ssh.authenticate')
      .map(row => this.present(row)) }
  }

  /** A terminal status is durable before cleanup; retry any orphaned Runner resource. */
  async cleanupPending(): Promise<void> {
    for (const row of await this.calls.cleanupCandidates()) {
      try {
        await this.runner.cleanup(row.id)
        await this.calls.markCleanupComplete(row.id, row.pod_uid)
      } catch (_unavailable) { /* Keep the candidate for the next sweep. */ }
    }
  }

  /** Request cancellation; prepared Pods are removed by the leased worker.
   * @param user - verified owner of the original call.
   * @param callId - durable call identity to cancel.
   * @returns the durable cancellation state projected to safe public fields.
   */
  async cancel(user: Identity, callId: string): Promise<SshCheckView> {
    return this.present(await this.calls.cancel(user, callId))
  }

  private handle(row: SshCallRow): SshRunnerHandle | null {
    return row.destination && row.pod_uid && row.runner_instance_id
      ? { callId: row.id, destination: row.destination, podUid: row.pod_uid,
        instanceId: row.runner_instance_id } : null
  }

  private async observe(lease: SshCallLease, row: SshCallRow,
    observation: SshRunnerObservation): Promise<void> {
    if (observation.state === 'known') {
      const status = this.safeStatus(observation.status)
      if (!status) {
        await this.calls.markUncertain(lease, row.state, 'runner_status_invalid')
        return
      }
      await this.calls.recordStatus(lease, status)
      if (status.state === 'running') {
        await this.calls.deferRunning(lease, this.options.pollMs)
      } else {
        await this.runner.cleanup(row.id)
        if (row.pod_uid) await this.calls.markCleanupComplete(row.id, row.pod_uid)
      }
    } else {
      const reason = observation.state === 'uncertain' ? observation.reason : 'runner_call_absent'
      await this.calls.markUncertain(lease, row.state, safeCode.test(reason) ? reason : 'runner_status_unavailable')
    }
  }

  private safeStatus(status: SshRunnerStatus): SshRunnerStatus | null {
    if (status.state === 'running' && status.result === undefined && status.errorCode === undefined) {
      return { callId: status.callId, instanceId: status.instanceId, digest: status.digest, state: 'running' }
    }
    if (status.state === 'failed' && status.result === undefined
      && typeof status.errorCode === 'string' && safeCode.test(status.errorCode)) {
      return { callId: status.callId, instanceId: status.instanceId, digest: status.digest,
        state: 'failed', errorCode: status.errorCode }
    }
    const result = status.result
    if (status.state === 'succeeded' && status.errorCode === undefined && result
      && typeof result === 'object' && !Array.isArray(result)
      && 'kind' in result && result.kind === 'ssh.authenticate'
      && 'serverBanner' in result && safeBanner(result.serverBanner)) {
      return { callId: status.callId, instanceId: status.instanceId, digest: status.digest,
        state: 'succeeded', result: { kind: 'ssh.authenticate', serverBanner: result.serverBanner } }
    }
    return null
  }

  private async settleBeforeDispatch(lease: SshCallLease, row: SshCallRow,
    next: 'failed' | 'cancelled', reason: string | null): Promise<void> {
    if (row.state !== 'accepted' && row.state !== 'preparing' && row.state !== 'ready'
      && row.state !== 'uncertain') throw new PlatformError(409, 'ssh_call_state_changed')
    if (row.state !== 'accepted') await this.runner.cleanup(row.id)
    await this.calls.settleWithoutDispatch(lease, row.state,
      next, reason)
  }

  private async work(lease: SshCallLease, initial: SshCallRow): Promise<void> {
    let row = initial
    if (row.kind !== 'ssh.authenticate') return
    if (row.cancel_requested && !row.dispatch_digest) {
      await this.settleBeforeDispatch(lease, row, 'cancelled', null)
      return
    }
    if (row.state === 'uncertain' && !row.dispatch_digest) {
      await this.settleBeforeDispatch(lease, row, 'failed', row.error_code ?? 'ssh_check_unavailable')
      return
    }
    if (row.state === 'accepted') row = await this.calls.startPreparing(lease)
    if (row.state === 'preparing') {
      const connection = await this.connections.metadataForCall({ userId: row.user_id as Identity['userId'] },
        row.connection_id, row.connection_revision)
      if (connection.credentialRevision !== row.credential_revision) {
        await this.settleBeforeDispatch(lease, row, 'failed', 'ssh_credential_changed')
        return
      }
      const ip = await this.resolveHost(connection.host)
      if (!isIP(ip)) throw new SshRunnerBlocked('connector_runner_destination_invalid')
      const handle = await this.runner.prepare(row.id, { ip, port: connection.port,
        username: connection.username, hostKeySha256: connection.hostKeySha256 })
      row = await this.calls.markReady(lease, handle)
    }
    const handle = this.handle(row)
    if (!handle) {
      await this.calls.markUncertain(lease, row.state, 'runner_handle_missing')
      return
    }
    if (row.state === 'uncertain' && row.dispatch_digest
      && Date.now() - row.created_at.getTime() >= UNCERTAIN_CLEANUP_GRACE_MS) {
      const finalObservation = await this.runner.reconcile(handle, true, row.dispatch_digest)
      if (finalObservation.state === 'known' && finalObservation.status.state !== 'running') {
        await this.observe(lease, row, finalObservation)
      } else {
        await this.runner.cleanup(row.id)
        await this.calls.markCleanupComplete(row.id, handle.podUid)
      }
      return
    }
    if (row.cancel_requested) {
      if (!row.dispatch_digest) await this.settleBeforeDispatch(lease, row, 'cancelled', null)
      else {
        await this.observe(lease, row, await this.runner.cancel(handle, row.dispatch_digest))
        await this.runner.cleanup(row.id)
      }
      return
    }
    if (row.state !== 'ready') {
      await this.observe(lease, row, await this.runner.reconcile(handle, true, row.dispatch_digest ?? undefined))
      return
    }
    const connection = await this.connections.credentialForCall({ userId: row.user_id as Identity['userId'] },
      row.connection_id, row.connection_revision)
    if (connection.credentialRevision !== row.credential_revision) {
      await this.settleBeforeDispatch(lease, row, 'failed', 'ssh_credential_changed')
      return
    }
    const request = { kind: 'ssh.authenticate' as const, credential: connection.credential,
      timeoutMs: TIMEOUT_MS, maxOutputBytes: MAX_OUTPUT_BYTES }
    await dispatchFirstSshCall(this.calls, this.runner, lease, handle, request, async (row) => {
      await this.observe(lease, row, await this.runner.dispatchFirst(handle, request))
    })
  }

  /** Claim one durable call; a reclaimed dispatch intent is recovered by GET only.
   * @returns whether a call was claimed, including calls deferred or fenced after lease loss.
   */
  async pump(): Promise<boolean> {
    const row = await this.calls.claim(this.options.ownerId, this.options.leaseMs, 'ssh.authenticate')
    if (!row) return false
    const lease: SshCallLease = { callId: row.id, owner: this.options.ownerId, epoch: row.lease_epoch }
    let lost = false
    const leaseLost = (): boolean => lost
    let renewing = false
    const timer = setInterval(() => {
      if (renewing) return
      renewing = true
      void this.calls.renew(lease, this.options.leaseMs)
        .catch((_error: unknown) => { lost = true })
        .finally(() => { renewing = false })
    }, Math.max(100, Math.floor(this.options.leaseMs / 3)))
    try {
      await this.work(lease, row)
    } catch (error) {
      if (leaseLost() || error instanceof PlatformError && error.status === 409) return true
      const current = await this.calls.get({ userId: row.user_id as Identity['userId'], username: '' }, row.id)
      if (current.dispatch_digest) {
        if (['dispatch-intent', 'running'].includes(current.state)) await this.calls.markUncertain(lease, current.state,
          'ssh_check_unavailable')
      } else if (current.state === 'accepted' || current.state === 'preparing'
        || current.state === 'ready' || current.state === 'uncertain') {
        const reason = error instanceof SshRunnerBlocked && safeCode.test(error.code)
          ? error.code : 'ssh_check_unavailable'
        try { await this.settleBeforeDispatch(lease, current,
          current.cancel_requested ? 'cancelled' : 'failed', current.cancel_requested ? null : reason) }
        catch (_cleanupError) {
          if (current.state !== 'uncertain') await this.calls.markUncertain(lease, current.state,
            'runner_cleanup_unconfirmed')
        }
      }
    } finally { clearInterval(timer) }
    return true
  }
}
