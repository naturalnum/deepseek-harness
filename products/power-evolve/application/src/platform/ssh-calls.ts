/** Durable, owner-scoped SSH call state for the trusted Platform. */
import assert from 'node:assert/strict'
import { randomUUID } from 'node:crypto'
import type { Pool, PoolClient } from 'pg'
import { PlatformError, userId as executionUserId, type Identity } from '../contracts.ts'
import { transaction } from './database.ts'
import type { SshRunnerHandle, SshRunnerStatus, SshRunnerOrchestrator, SshRunnerRequest } from './ssh-runner.ts'
import { requireActiveAccount, requireBrowserAccount } from './account-authority.ts'

/** The caller computes a keyed HMAC over the entire canonical request, including any command. */
export interface SshCallAdmission {
  readonly requestId: string
  readonly connectionId: string
  readonly connectionRevision: number
  readonly kind: 'ssh.authenticate' | 'ssh.execute'
  readonly operationId?: string
  /** HMAC-SHA-256 hex; never a bare hash of a password or command. */
  readonly requestDigest: string
}

/** A row is internal to Platform and must not be serialized directly to Host. */
export interface SshCallRow {
  readonly id: string
  readonly user_id: string
  readonly request_id: string
  readonly connection_id: string
  readonly connection_revision: number
  readonly credential_revision: number
  readonly operation_id: string | null
  readonly kind: 'ssh.authenticate' | 'ssh.execute'
  readonly request_digest: string
  readonly state: 'accepted' | 'preparing' | 'ready' | 'dispatch-intent' | 'running'
    | 'succeeded' | 'failed' | 'uncertain' | 'cancelled'
  readonly cancel_requested: boolean
  readonly cleanup_complete: boolean
  readonly destination: SshRunnerHandle['destination'] | null
  readonly pod_uid: string | null
  readonly runner_instance_id: string | null
  readonly dispatch_digest: string | null
  readonly dispatch_owner: string | null
  readonly dispatch_epoch: number | null
  readonly result: unknown
  readonly error_code: string | null
  readonly lease_owner: string | null
  readonly lease_epoch: number
  readonly lease_until: Date | null
  readonly created_at: Date
  readonly updated_at: Date
}

const hexDigest = /^[a-f0-9]{64}$/u
const terminal = new Set(['succeeded', 'failed', 'cancelled'])

/** Current worker epoch for fenced transitions; first dispatch also requires a committed permit. */
export interface SshCallLease {
  readonly callId: string
  readonly owner: string
  readonly epoch: number
}

/** Commit a dispatch permit and invoke the dispatch-and-observe callback only for its dispatch-intent row.
 * @param calls Durable call store and lease fences.
 * @param runner Dispatch digest provider.
 * @param lease Current call, owner and epoch.
 * @param handle Prepared Runner identity.
 * @param request Complete authentication or execution request.
 * @param firstDispatch Dispatch-and-observe callback receiving the permit row.
 * @returns The permit row and branch selected before the callback can change its state.
 */
export async function dispatchFirstSshCall(calls: SshCallStore, runner: Pick<SshRunnerOrchestrator, 'digestFor'>,
  lease: SshCallLease, handle: SshRunnerHandle, request: SshRunnerRequest,
  firstDispatch: (row: SshCallRow) => Promise<void>): Promise<{ readonly row: SshCallRow; readonly dispatched: boolean }> {
  const digest = runner.digestFor(handle, request)
  const row = await calls.markDispatchIntent(lease, digest)
  if (row.state === 'dispatch-intent') {
    await firstDispatch(row)
    return { row, dispatched: true }
  }
  return { row, dispatched: false }
}

/** Platform database admissions, worker lease fences and dispatch permits for SSH Runner calls. */
export class SshCallStore {
  constructor(private readonly pool: Pool) {}

  /** Admit a verified user's exact request; replay returns the original call even after connection changes.
   * New calls require the owned, enabled connection revision; execution also requires an owned running operation.
   * @param user - verified owner of the connection and request.
   * @param input - stable request identity, pinned revision, call kind and keyed request digest.
   * @param credentialToken Original Agent bearer rechecked inside admission.
   * @returns the committed accepted row, or the original row for an identical replay.
   * @throws PlatformError for invalid admission, missing authority or a conflicting request identity.
   */
  async admit(user: Identity, input: SshCallAdmission, credentialToken: string): Promise<SshCallRow> {
    if (!hexDigest.test(input.requestDigest)) throw new PlatformError(400, 'ssh_request_digest_invalid')
    if ((input.kind === 'ssh.authenticate' && input.operationId !== undefined)
      || (input.kind === 'ssh.execute' && input.operationId === undefined)) {
      throw new PlatformError(400, 'ssh_operation_invalid')
    }
    return transaction(this.pool, async (client) => {
      const actor = await requireBrowserAccount(client, credentialToken, { lock: 'update' })
      if (actor.userId !== user.userId) throw new PlatformError(401, 'unauthorized')
      const prior = await client.query<SshCallRow>(
        'SELECT * FROM pe_ssh_calls WHERE user_id=$1 AND request_id=$2', [user.userId, input.requestId])
      if (prior.rows[0]) {
        const row = prior.rows[0]
        if (row.connection_id !== input.connectionId || row.connection_revision !== input.connectionRevision
          || row.kind !== input.kind || row.operation_id !== (input.operationId ?? null)
          || row.request_digest !== input.requestDigest) throw new PlatformError(409, 'request_id_conflict')
        return row
      }
      const connection = await client.query<{ credential_revision: number }>(
        `SELECT credential_revision FROM pe_ssh_connections
         WHERE id=$1 AND user_id=$2 AND revision=$3 AND enabled=true AND deleted_at IS NULL`,
        [input.connectionId, user.userId, input.connectionRevision])
      if (!connection.rows[0]) throw new PlatformError(404, 'ssh_connection_not_found')
      if (input.kind === 'ssh.execute') {
        const operation = await client.query(
          `SELECT o.id FROM pe_operations o JOIN pe_sessions s ON s.id=o.session_id
           WHERE o.id=$1 AND s.user_id=$2 AND o.state='running'`, [input.operationId, user.userId])
        if (!operation.rowCount) throw new PlatformError(403, 'ssh_operation_not_owned')
      }
      const inserted = await client.query<SshCallRow>(
        `INSERT INTO pe_ssh_calls(id,user_id,request_id,connection_id,connection_revision,
           credential_revision,operation_id,kind,request_digest,state)
         VALUES($1,$2,$3,$4,$5,$6,$7,$8,$9,'accepted') RETURNING *`,
        [randomUUID(), user.userId, input.requestId, input.connectionId, input.connectionRevision,
          connection.rows[0].credential_revision, input.operationId ?? null, input.kind, input.requestDigest])
      const row = inserted.rows[0]
      assert(row !== undefined)
      return row
    })
  }

  /** Read the internal call row visible to its verified owner.
   * @param user - verified owner of the call.
   * @param callId - durable call identity.
   * @returns internal state for a trusted Platform coordinator.
   * @throws PlatformError when the call is absent or belongs to another user.
   */
  async get(user: Identity, callId: string): Promise<SshCallRow> {
    const found = await this.pool.query<SshCallRow>(
      'SELECT * FROM pe_ssh_calls WHERE id=$1 AND user_id=$2', [callId, user.userId])
    if (!found.rows[0]) throw new PlatformError(404, 'ssh_call_not_found')
    return found.rows[0]
  }

  /** List only the verified user's recent calls.
   * @param user - verified owner whose calls are read.
   * @returns at most 100 internal rows, ordered by descending creation time and identity.
   */
  async list(user: Identity): Promise<readonly SshCallRow[]> {
    const found = await this.pool.query<SshCallRow>(
      'SELECT * FROM pe_ssh_calls WHERE user_id=$1 ORDER BY created_at DESC,id DESC LIMIT 100', [user.userId])
    return found.rows
  }

  /** Find terminal calls whose recorded Pod cleanup remains incomplete after a crash.
   * @returns at most 20 succeeded, failed or cancelled call/Pod identities, ordered by update time and identity.
   */
  async cleanupCandidates(): Promise<readonly { id: string; pod_uid: string }[]> {
    const found = await this.pool.query<{ id: string; pod_uid: string }>(
      `SELECT id,pod_uid FROM pe_ssh_calls WHERE state IN ('succeeded','failed','cancelled')
       AND pod_uid IS NOT NULL AND cleanup_complete=false ORDER BY updated_at,id LIMIT 20`)
    return found.rows
  }

  /** Record cleanup after the caller confirms deletion of the recorded Pod.
   * @param callId - durable call identity in a terminal or quarantined uncertain state.
   * @param podUid - exact persisted Pod UID whose cleanup was confirmed.
   * @throws PlatformError if the call, Pod identity or eligible state changed.
   */
  async markCleanupComplete(callId: string, podUid: string): Promise<void> {
    const updated = await this.pool.query(
      `UPDATE pe_ssh_calls SET cleanup_complete=true,updated_at=now()
       WHERE id=$1 AND pod_uid=$2 AND state IN ('succeeded','failed','cancelled','uncertain')`, [callId, podUid])
    if (!updated.rowCount) throw new PlatformError(409, 'ssh_cleanup_state_changed')
  }

  /** Claim unleased or expired work of one kind; a new epoch fences the previous process.
   * Uncertain calls with completed cleanup are excluded. Claiming does not grant a first-dispatch permit.
   * @param owner - coordinator identity recorded as the lease owner.
   * @param leaseMs - positive safe-integer lease duration in milliseconds.
   * @param kind - authentication or execution work handled by this coordinator.
   * @returns the claimed row with its incremented epoch, or null when no eligible row is available.
   */
  async claim(owner: string, leaseMs: number, kind: SshCallAdmission['kind']): Promise<SshCallRow | null> {
    if (!Number.isSafeInteger(leaseMs) || leaseMs < 1) throw new Error('Invalid SSH call lease')
    return transaction(this.pool, async (client) => {
      const found = await client.query<SshCallRow>(
        `SELECT * FROM pe_ssh_calls WHERE kind=$1 AND state IN
           ('accepted','preparing','ready','dispatch-intent','running','uncertain')
         AND (lease_until IS NULL OR lease_until<=now())
         AND NOT (state='uncertain' AND cleanup_complete=true)
         ORDER BY created_at,id LIMIT 1 FOR UPDATE SKIP LOCKED`, [kind])
      if (!found.rows[0]) return null
      const updated = await client.query<SshCallRow>(
        `UPDATE pe_ssh_calls SET lease_owner=$2,lease_epoch=lease_epoch+1,
           lease_until=now()+$3::double precision*interval '1 millisecond',updated_at=now()
         WHERE id=$1 RETURNING *`, [found.rows[0].id, owner, leaseMs])
      const row = updated.rows[0]
      assert(row !== undefined)
      return row
    })
  }

  private async withCallLock<T>(callId: string, work: (client: PoolClient) => Promise<T>): Promise<T> {
    return transaction(this.pool, async (client) => {
      // Acquire the row before evaluating lease time; an UPDATE predicate can run before its lock wait.
      await client.query('SELECT id FROM pe_ssh_calls WHERE id=$1 FOR UPDATE', [callId])
      return work(client)
    })
  }

  /** Extend only the current lease still unexpired after acquiring the nonterminal call's lock.
   * @param lease - current call, owner and epoch.
   * @param leaseMs - positive safe-integer renewal duration in milliseconds.
   * @throws PlatformError when the lease expired, changed or belongs to a terminal call.
   */
  async renew(lease: SshCallLease, leaseMs: number): Promise<void> {
    if (!Number.isSafeInteger(leaseMs) || leaseMs < 1) throw new Error('Invalid SSH call lease')
    return this.withCallLock(lease.callId, async (client) => {
      const renewed = await client.query(
        `UPDATE pe_ssh_calls SET lease_until=clock_timestamp()+$4::double precision*interval '1 millisecond'
         WHERE id=$1 AND lease_owner=$2 AND lease_epoch=$3 AND lease_until>clock_timestamp()
           AND state NOT IN ('succeeded','failed','cancelled') RETURNING id`,
        [lease.callId, lease.owner, lease.epoch, leaseMs])
      if (!renewed.rowCount) throw new PlatformError(409, 'ssh_call_lease_lost')
    })
  }

  /** Verify the original dispatch epoch is still leased, in dispatch-intent and not cancelled.
   * Reading an intent never grants another POST.
   * @param lease - original call, dispatch owner and epoch to verify.
   * @throws PlatformError when the dispatch identity, lease or cancellation state no longer matches.
   */
  async assertDispatchLease(lease: SshCallLease): Promise<void> {
    const found = await this.pool.query(
      `SELECT id FROM pe_ssh_calls WHERE id=$1 AND lease_owner=$2 AND lease_epoch=$3
       AND dispatch_owner=$2 AND dispatch_epoch=$3
       AND lease_until>now() AND state='dispatch-intent' AND cancel_requested=false`,
      [lease.callId, lease.owner, lease.epoch])
    if (!found.rowCount) throw new PlatformError(409, 'ssh_call_lease_lost')
  }

  private async change(lease: SshCallLease, expected: SshCallRow['state'], next: SshCallRow['state'],
    values: readonly unknown[] = [], assignments = ''): Promise<SshCallRow> {
    return this.withCallLock(lease.callId, async (client) => {
      const changed = await client.query<SshCallRow>(
        `UPDATE pe_ssh_calls SET state=$5,updated_at=clock_timestamp()${assignments}
         WHERE id=$1 AND lease_owner=$2 AND lease_epoch=$3 AND lease_until>clock_timestamp()
           AND state=$4 RETURNING *`, [lease.callId, lease.owner, lease.epoch, expected, next, ...values])
      if (!changed.rows[0]) throw new PlatformError(409, 'ssh_call_state_or_lease_changed')
      return changed.rows[0]
    })
  }

  /** Begin Pod preparation after the accepted row commits.
   * @param lease - current call, owner and epoch for the accepted row.
   * @returns the row transitioned from accepted to preparing.
   * @throws PlatformError if the expected state or unexpired lease changed.
   */
  async startPreparing(lease: SshCallLease): Promise<SshCallRow> {
    return this.change(lease, 'accepted', 'preparing')
  }

  /** Save the exact Pod and Runner identity before any credential reaches the Runner.
   * @param lease - current call, owner and epoch for the preparing row.
   * @param handle - prepared destination, Pod UID and Runner instance for the same call.
   * @returns the ready row with the persisted Runner identity.
   * @throws PlatformError for a different call identity or a changed state or lease.
   */
  async markReady(lease: SshCallLease, handle: SshRunnerHandle): Promise<SshCallRow> {
    if (handle.callId !== lease.callId) throw new PlatformError(400, 'ssh_call_identity_invalid')
    return this.change(lease, 'preparing', 'ready',
      [handle.destination, handle.podUid, handle.instanceId],
      ',destination=$6,pod_uid=$7,runner_instance_id=$8')
  }

  /** Commit one dispatch permit under call, approval and connection locks, without network I/O.
   * A fresh dispatch-intent return authorizes one POST; later revocation cannot retract it.
   * A missing approval or changed connection fails without a permit. Recovery only queries the original Runner.
   * @param lease - current call, owner and epoch for the ready, uncancelled row.
   * @param digest - keyed digest of the exact request to send to the persisted Runner.
   * @returns dispatch-intent with a new permit, or failed when approval or the current connection denies dispatch.
   * @throws PlatformError for an invalid digest or a changed state, cancellation or lease.
   */
  async markDispatchIntent(lease: SshCallLease, digest: string): Promise<SshCallRow> {
    if (!hexDigest.test(digest)) throw new PlatformError(400, 'ssh_dispatch_digest_invalid')
    return transaction(this.pool, async (client) => {
      const owner = await client.query<{ user_id: string }>('SELECT user_id FROM pe_ssh_calls WHERE id=$1', [lease.callId])
      if (!owner.rows[0]) throw new PlatformError(409, 'ssh_call_state_or_lease_changed')
      await requireActiveAccount(client, executionUserId.parse(owner.rows[0].user_id), 'update')
      const found = await client.query<SshCallRow>(
        `SELECT * FROM pe_ssh_calls WHERE id=$1 AND lease_owner=$2 AND lease_epoch=$3
         AND lease_until>clock_timestamp() AND state='ready' AND cancel_requested=false
         AND pod_uid IS NOT NULL AND runner_instance_id IS NOT NULL FOR UPDATE`,
        [lease.callId, lease.owner, lease.epoch])
      const call = found.rows[0]
      if (!call) throw new PlatformError(409, 'ssh_call_state_or_lease_changed')
      const approved = call.kind === 'ssh.authenticate' || !!(await client.query(
        `SELECT id FROM pe_ssh_execute_actions WHERE id=$1 AND user_id=$2 AND state='approved'
         AND operation_id=$3 AND connection_id=$4 AND connection_revision=$5
         AND credential_revision=$6 AND request_digest=$7 FOR SHARE`,
        [call.id, call.user_id, call.operation_id, call.connection_id, call.connection_revision,
          call.credential_revision, call.request_digest])).rowCount
      const connection = await client.query<{ enabled: boolean; revision: number; credential_revision: number }>(
        `SELECT enabled,revision,credential_revision FROM pe_ssh_connections
         WHERE id=$1 AND user_id=$2 AND deleted_at IS NULL FOR SHARE`, [call.connection_id, call.user_id])
      const current = connection.rows[0]
      const authorized = approved && current?.enabled === true && current.revision === call.connection_revision
        && current.credential_revision === call.credential_revision
      // Waiting for a connection lock can outlive the lease; transaction-start now() is insufficient.
      const changed = await client.query<SshCallRow>(
        `UPDATE pe_ssh_calls SET state=$4,dispatch_digest=$5,
           dispatch_owner=$6,dispatch_epoch=$7,error_code=$8,updated_at=clock_timestamp()
         WHERE id=$1 AND lease_owner=$2 AND lease_epoch=$3 AND lease_until>clock_timestamp()
           AND state='ready' AND cancel_requested=false RETURNING *`,
        [lease.callId, lease.owner, lease.epoch, authorized ? 'dispatch-intent' : 'failed',
          authorized ? digest : null, authorized ? lease.owner : null, authorized ? lease.epoch : null,
          authorized ? null : approved ? 'ssh_connection_changed' : 'ssh_action_not_approved'])
      if (!changed.rows[0]) throw new PlatformError(409, 'ssh_call_state_or_lease_changed')
      return changed.rows[0]
    })
  }

  /** Persist a Runner observation only when its call, instance and digest match the leased row.
   * The coordinator interprets execution failure phases before recording a terminal execution outcome.
   * @param lease - current call, owner and epoch in dispatch-intent, running or uncertain state.
   * @param status - matching Runner state, result and optional error code.
   * @returns the row updated with the observed state and result.
   * @throws PlatformError if the call, Runner identity, digest, eligible state or lease changed.
   */
  async recordStatus(lease: SshCallLease, status: SshRunnerStatus): Promise<SshCallRow> {
    if (status.callId !== lease.callId) throw new PlatformError(409, 'ssh_runner_identity_changed')
    const next = status.state === 'running' ? 'running' : status.state
    return this.withCallLock(lease.callId, async (client) => {
      const changed = await client.query<SshCallRow>(
        `UPDATE pe_ssh_calls SET state=$4,result=$5,error_code=$6,updated_at=clock_timestamp()
         WHERE id=$1 AND lease_owner=$2 AND lease_epoch=$3 AND lease_until>clock_timestamp()
           AND state IN ('dispatch-intent','running','uncertain')
           AND runner_instance_id=$7 AND dispatch_digest=$8 RETURNING *`,
        [lease.callId, lease.owner, lease.epoch, next, status.result ?? null,
          status.errorCode ?? null, status.instanceId, status.digest])
      if (!changed.rows[0]) throw new PlatformError(409, 'ssh_call_state_or_identity_changed')
      return changed.rows[0]
    })
  }

  /** Release a confirmed running SSH call for later observation without granting another dispatch permit.
   * @param lease - current call, owner and epoch for running authentication or execution work.
   * @param pollMs - positive safe-integer delay in milliseconds before another coordinator may claim it.
   * @throws Error for an invalid delay; PlatformError if the kind, state or unexpired lease changed.
   */
  async deferRunning(lease: SshCallLease, pollMs: number): Promise<void> {
    if (!Number.isSafeInteger(pollMs) || pollMs < 1) throw new Error('Invalid SSH call poll delay')
    return this.withCallLock(lease.callId, async (client) => {
      const changed = await client.query(
        `UPDATE pe_ssh_calls SET lease_owner=NULL,
           lease_until=clock_timestamp()+$4::double precision*interval '1 millisecond',updated_at=clock_timestamp()
         WHERE id=$1 AND lease_owner=$2 AND lease_epoch=$3 AND lease_until>clock_timestamp()
           AND kind IN ('ssh.authenticate','ssh.execute') AND state='running' RETURNING id`,
        [lease.callId, lease.owner, lease.epoch, pollMs])
      if (!changed.rowCount) throw new PlatformError(409, 'ssh_call_lease_lost')
    })
  }

  /** Quarantine an unverified outcome while retaining Pod identity for lookup or deletion.
   * @param lease - current call, owner and epoch.
   * @param expected - preparing, ready, dispatch-intent, running or uncertain state to replace.
   * @param reason - coordinator-selected error code for the uncertain outcome.
   * @returns the uncertain row, preserving its recorded Runner and dispatch identities.
   * @throws PlatformError for an ineligible expected state or a changed state or lease.
   */
  async markUncertain(lease: SshCallLease, expected: SshCallRow['state'], reason: string): Promise<SshCallRow> {
    if (!['preparing', 'ready', 'dispatch-intent', 'running', 'uncertain'].includes(expected)) {
      throw new PlatformError(400, 'ssh_call_state_invalid')
    }
    return this.change(lease, expected, 'uncertain', [reason], ',error_code=$6')
  }

  /** Settle without dispatch after the caller has deleted any prepared Pod.
   * @param lease - current call, owner and epoch.
   * @param expected - accepted, preparing, ready or uncertain state to replace.
   * @param next - failed or cancelled terminal outcome.
   * @param reason - coordinator-selected error code, or null for cancellation without an error.
   * @returns the terminal row only when no dispatch digest has been committed.
   * @throws PlatformError if the state or lease changed, or dispatch was already committed.
   */
  async settleWithoutDispatch(lease: SshCallLease, expected: 'accepted' | 'preparing' | 'ready' | 'uncertain',
    next: 'failed' | 'cancelled', reason: string | null): Promise<SshCallRow> {
    return this.withCallLock(lease.callId, async (client) => {
      const changed = await client.query<SshCallRow>(
        `UPDATE pe_ssh_calls SET state=$5,error_code=$6,updated_at=clock_timestamp()
         WHERE id=$1 AND lease_owner=$2 AND lease_epoch=$3 AND lease_until>clock_timestamp()
           AND state=$4 AND dispatch_digest IS NULL RETURNING *`,
        [lease.callId, lease.owner, lease.epoch, expected, next, reason])
      if (!changed.rows[0]) throw new PlatformError(409, 'ssh_call_state_or_lease_changed')
      return changed.rows[0]
    })
  }

  /** Request cancellation for an owned call; an accepted call becomes cancelled immediately.
   * Terminal rows are unchanged. Prepared work retains its state until cleanup; a committed dispatch
   * becomes uncertain and its permit remains valid, so the coordinator must confirm the remote outcome.
   * @param user - verified owner requesting cancellation.
   * @param callId - durable call identity.
   * @returns the terminal row unchanged, or the row with cancellation requested and its resulting state.
   * @throws PlatformError when the call is absent or belongs to another user.
   */
  async cancel(user: Identity, callId: string): Promise<SshCallRow> {
    return transaction(this.pool, async (client) => {
      const found = await client.query<SshCallRow>(
        'SELECT * FROM pe_ssh_calls WHERE id=$1 AND user_id=$2 FOR UPDATE', [callId, user.userId])
      const row = found.rows[0]
      if (!row) throw new PlatformError(404, 'ssh_call_not_found')
      if (terminal.has(row.state)) return row
      const state = row.state === 'accepted' ? 'cancelled'
        : row.dispatch_digest ? 'uncertain' : row.state
      const updated = await client.query<SshCallRow>(
        `UPDATE pe_ssh_calls SET cancel_requested=true,state=$2,updated_at=now()
         WHERE id=$1 RETURNING *`, [callId, state])
      const current = updated.rows[0]
      assert(current !== undefined)
      return current
    })
  }
}
