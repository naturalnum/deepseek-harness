/** User authorization and durable calls for the image-owned STDIO MCP preset. */
import { createHash, randomUUID } from 'node:crypto'
import { setTimeout as delay } from 'node:timers/promises'
import type { Pool } from 'pg'
import { z } from 'zod'
import { executionTarget, PlatformError, type Identity } from '../contracts.ts'
import { transaction } from './database.ts'
import type { TaskStore } from './tasks.ts'
import { StdioRunnerOrchestrator, type StdioRunnerHandle, type StdioRunnerStatus,
  type StdioObservation } from './stdio-runner.ts'

type Connection = { id: string; user_id: string; install_request_id: string; name: string;
  enabled: boolean; revision: number }
type Call = { id: string; user_id: string; operation_id: string; connection_id: string;
  connection_revision: number; call_key: string; state: 'accepted' | 'preparing' | 'ready'
    | 'dispatch-intent' | 'running' | 'succeeded' | 'failed' | 'uncertain';
  pod_uid: string | null; runner_instance_id: string | null; dispatch_digest: string | null;
  result: string | null; error_code: string | null; cleanup_complete: boolean;
  lease_owner: string | null; lease_epoch: number; continuation_request_id: string }
type Lease = { id: string; epoch: number }

const selection = z.array(z.object({ connectionId: z.uuid(), revision: z.number().int().positive() }).strict()).max(1)
const safeCode = /^[a-z][a-z0-9_]{0,99}$/u
const digest = (value: object) => createHash('sha256').update(JSON.stringify(value)).digest('hex')
const terminal = new Set(['succeeded', 'failed', 'uncertain'])

/** One connection per user; only a fixed, read-only tool in the Runner image can execute. */
export class StdioMcpService {
  private readonly stop = new AbortController()
  private polling: Promise<void> | undefined

  constructor(private readonly tasks: TaskStore, private readonly runner: StdioRunnerOrchestrator | null,
    private readonly ownerId: string, private readonly leaseMs: number, private readonly pollMs = 500) {
    if (leaseMs < 30_000 || pollMs < 100) throw new Error('Invalid STDIO MCP worker timing')
  }
  private get pool(): Pool { return this.tasks.pool }
  get available(): boolean { return this.runner !== null }
  private requireRunner(): StdioRunnerOrchestrator {
    if (!this.runner) throw new PlatformError(503, 'stdio_mcp_unavailable')
    return this.runner
  }
  private present(row: Connection) {
    return { connectionId: row.id, name: row.name, enabled: row.enabled, revision: row.revision,
      toolName: 'mcp__stdio__whoami', description: '在隔离进程中读取当前账户标识（只读）' }
  }
  private view(row: Call) {
    return { callId: row.id, state: row.state,
      ...(row.state === 'succeeded' && row.result !== null ? { result: row.result } : {}),
      ...(row.error_code && safeCode.test(row.error_code) ? { errorCode: row.error_code } : {}) }
  }
  async list(user: Identity) {
    const rows = await this.pool.query<Connection>('SELECT * FROM pe_stdio_mcp_connections WHERE user_id=$1', [user.userId])
    return { available: this.available, preset: { toolName: 'mcp__stdio__whoami',
      description: '在隔离进程中读取当前账户标识（只读）' }, items: rows.rows.map(row => this.present(row)) }
  }
  /** Identical install request recovers the original item after restart. */
  async install(user: Identity, requestId: string, name: string) {
    return transaction(this.pool, async client => {
      await client.query('SELECT id FROM pe_users WHERE id=$1 FOR UPDATE', [user.userId])
      const prior = await client.query<Connection>('SELECT * FROM pe_stdio_mcp_connections WHERE user_id=$1', [user.userId])
      if (prior.rows[0]) {
        if (prior.rows[0].install_request_id === requestId && prior.rows[0].name === name) {
          return this.present({ ...prior.rows[0], enabled: true, revision: 1 })
        }
        throw new PlatformError(409, prior.rows[0].install_request_id === requestId
          ? 'request_id_conflict' : 'stdio_mcp_already_installed')
      }
      this.requireRunner()
      const created = await client.query<Connection>(
        'INSERT INTO pe_stdio_mcp_connections(id,user_id,install_request_id,name) VALUES($1,$2,$3,$4) RETURNING *',
        [requestId, user.userId, requestId, name])
      return this.present(created.rows[0]!)
    })
  }
  /** Revisioned enablement revokes any call that has not yet reached dispatch intent. */
  async toggle(user: Identity, id: string, requestId: string, baseRevision: number, enabled: boolean) {
    const fingerprint = digest({ id, baseRevision, enabled })
    return transaction(this.pool, async client => {
      await client.query('SELECT id FROM pe_users WHERE id=$1 FOR UPDATE', [user.userId])
      const prior = await client.query<{ request_digest: string; result: ReturnType<StdioMcpService['present']> }>(
        'SELECT request_digest,result FROM pe_stdio_mcp_updates WHERE user_id=$1 AND request_id=$2',
        [user.userId, requestId])
      if (prior.rows[0]) {
        if (prior.rows[0].request_digest !== fingerprint) throw new PlatformError(409, 'request_id_conflict')
        return prior.rows[0].result
      }
      const current = await client.query<Connection>(
        'SELECT * FROM pe_stdio_mcp_connections WHERE id=$1 AND user_id=$2 FOR UPDATE', [id, user.userId])
      if (!current.rows[0]) throw new PlatformError(404, 'stdio_mcp_connection_not_found')
      if (current.rows[0].revision !== baseRevision) throw new PlatformError(409, 'revision_conflict')
      if (enabled) this.requireRunner()
      const changed = await client.query<Connection>(
        `UPDATE pe_stdio_mcp_connections SET enabled=$3,revision=revision+1,updated_at=now()
         WHERE id=$1 AND user_id=$2 RETURNING *`, [id, user.userId, enabled])
      const result = this.present(changed.rows[0]!)
      await client.query(
        `INSERT INTO pe_stdio_mcp_updates(user_id,request_id,connection_id,request_digest,result)
         VALUES($1,$2,$3,$4,$5)`, [user.userId, requestId, id, fingerprint, result])
      return result
    })
  }
  /** The Host supplies only its native tool call ID and pinned connection metadata. */
  async call(token: string, connectionId: string, revision: number, callKey: string) {
    this.requireRunner()
    if (!callKey || Buffer.byteLength(callKey) > 100) throw new PlatformError(400, 'stdio_mcp_call_key_invalid')
    return transaction(this.pool, async client => {
      const grant = await this.tasks.authorized(client, token)
      if (executionTarget.parse(grant.execution_target).kind !== 'cloud') {
        throw new PlatformError(403, 'wrong_execution_target')
      }
      const operation = await client.query<{ stdio_mcp_selection: unknown }>(
        'SELECT stdio_mcp_selection FROM pe_operations WHERE id=$1', [grant.operation_id])
      const pinned = selection.parse(operation.rows[0]?.stdio_mcp_selection).some(value =>
        value.connectionId === connectionId && value.revision === revision)
      if (!pinned) throw new PlatformError(403, 'stdio_mcp_not_in_operation')
      const prior = await client.query<Call>(
        'SELECT * FROM pe_stdio_mcp_calls WHERE operation_id=$1 AND call_key=$2', [grant.operation_id, callKey])
      if (prior.rows[0]) {
        if (prior.rows[0].connection_id !== connectionId || prior.rows[0].connection_revision !== revision) {
          throw new PlatformError(409, 'request_id_conflict')
        }
        return this.view(prior.rows[0])
      }
      const count = await client.query<{ count: string }>(
        'SELECT count(*) FROM pe_stdio_mcp_calls WHERE operation_id=$1', [grant.operation_id])
      if (Number(count.rows[0]!.count) >= 1) throw new PlatformError(429, 'stdio_mcp_call_limit')
      const current = await client.query<Connection>(
        `SELECT * FROM pe_stdio_mcp_connections WHERE id=$1 AND user_id=$2
         AND enabled=true AND revision=$3 FOR SHARE`, [connectionId, grant.user_id, revision])
      if (!current.rows[0]) throw new PlatformError(403, 'stdio_mcp_connection_revoked')
      const created = await client.query<Call>(
        `INSERT INTO pe_stdio_mcp_calls(id,user_id,operation_id,connection_id,connection_revision,call_key,state)
         VALUES($1,$2,$3,$4,$5,$6,'accepted') RETURNING *`,
        [randomUUID(), grant.user_id, grant.operation_id, connectionId, revision, callKey])
      return this.view(created.rows[0]!)
    })
  }
  async status(user: Identity, id: string) {
    const found = await this.pool.query<Call>('SELECT * FROM pe_stdio_mcp_calls WHERE id=$1 AND user_id=$2',
      [id, user.userId])
    if (!found.rows[0]) throw new PlatformError(404, 'stdio_mcp_call_not_found')
    return this.view(found.rows[0])
  }
  async calls(user: Identity) {
    const found = await this.pool.query<Call>(
      'SELECT * FROM pe_stdio_mcp_calls WHERE user_id=$1 ORDER BY created_at DESC,id DESC LIMIT 100', [user.userId])
    return { items: found.rows.map(row => this.view(row)) }
  }
  start(): void { if (this.runner) this.polling = this.poll() }
  async close(): Promise<void> { this.stop.abort(); await this.polling }
  private async poll(): Promise<void> {
    while (!this.stop.signal.aborted) {
      try {
        const row = await this.claim()
        if (row) { await this.work(row); continue }
        await this.cleanupPending()
      } catch (_unavailable) { /* Durable rows are reclaimed after a lease or service recovery. */ }
      try { await delay(this.pollMs, undefined, { signal: this.stop.signal }) }
      catch (_aborted) { /* Stop the worker after shutdown. */ }
    }
  }
  private async claim(): Promise<Call | null> {
    return transaction(this.pool, async client => {
      const selected = await client.query<Call>(
        `SELECT * FROM pe_stdio_mcp_calls WHERE state IN ('accepted','preparing','ready','dispatch-intent','running')
         AND (lease_until IS NULL OR lease_until<=now())
         ORDER BY created_at,id LIMIT 1 FOR UPDATE SKIP LOCKED`)
      if (!selected.rows[0]) return null
      const leased = await client.query<Call>(
        `UPDATE pe_stdio_mcp_calls SET lease_owner=$2,lease_epoch=lease_epoch+1,
         lease_until=now()+$3::double precision*interval '1 millisecond',updated_at=now()
         WHERE id=$1 RETURNING *`, [selected.rows[0].id, this.ownerId, this.leaseMs])
      return leased.rows[0]!
    })
  }
  private async change(lease: Lease, state: Call['state'], extra = '', values: unknown[] = []): Promise<Call> {
    const changed = await this.pool.query<Call>(
      `UPDATE pe_stdio_mcp_calls SET state=$4,updated_at=now()${extra}
       WHERE id=$1 AND lease_owner=$2 AND lease_epoch=$3 AND lease_until>now() RETURNING *`,
      [lease.id, this.ownerId, lease.epoch, state, ...values])
    if (!changed.rows[0]) throw new PlatformError(409, 'stdio_mcp_lease_lost')
    return changed.rows[0]
  }
  private handle(row: Call): StdioRunnerHandle | null {
    return row.pod_uid && row.runner_instance_id
      ? { callId: row.id, podUid: row.pod_uid, instanceId: row.runner_instance_id } : null
  }
  private async work(initial: Call): Promise<void> {
    const lease = { id: initial.id, epoch: initial.lease_epoch }
    let lost = false
    const heartbeat = setInterval(() => {
      void this.pool.query(
        `UPDATE pe_stdio_mcp_calls SET lease_until=now()+$4::double precision*interval '1 millisecond'
         WHERE id=$1 AND lease_owner=$2 AND lease_epoch=$3 AND lease_until>now()`,
        [lease.id, this.ownerId, lease.epoch, this.leaseMs])
        .then(result => { if (!result.rowCount) lost = true }, () => { lost = true })
    }, Math.max(100, Math.floor(this.leaseMs / 3)))
    try {
      let row = initial
      if (row.state === 'accepted') row = await this.change(lease, 'preparing')
      if (row.state === 'preparing') {
        const handle = await this.requireRunner().prepare(row.id)
        row = await this.change(lease, 'ready', ',pod_uid=$5,runner_instance_id=$6',
          [handle.podUid, handle.instanceId])
      }
      const handle = this.handle(row)
      if (!handle) throw new PlatformError(409, 'stdio_mcp_runner_handle_missing')
      if (row.state === 'ready') {
        if (this.stop.signal.aborted) return
        const current = await this.pool.query<Connection>(
          `SELECT * FROM pe_stdio_mcp_connections WHERE id=$1 AND user_id=$2
           AND revision=$3 AND enabled=true`, [row.connection_id, row.user_id, row.connection_revision])
        if (!current.rows[0]) { await this.settle(lease, 'failed', null, 'stdio_mcp_connection_revoked'); return }
        const callDigest = this.requireRunner().digestFor(handle, row.user_id)
        if (this.stop.signal.aborted) return
        row = await this.change(lease, 'dispatch-intent', ',dispatch_digest=$5', [callDigest])
        if (lost || this.stop.signal.aborted) return
        const observation = await this.requireRunner().dispatchFirst(handle, row.user_id)
        await this.observe(lease, row, observation)
      } else {
        await this.observe(lease, row, await this.requireRunner().reconcile(handle, true,
          row.dispatch_digest ?? undefined))
      }
    } catch (error) {
      if (lost || error instanceof PlatformError && error.status === 409) return
      const current = await this.pool.query<Call>('SELECT * FROM pe_stdio_mcp_calls WHERE id=$1', [lease.id])
      const row = current.rows[0]
      if (!row || row.lease_owner !== this.ownerId || row.lease_epoch !== lease.epoch) return
      if (row.dispatch_digest) await this.settle(lease, 'uncertain', null, 'stdio_mcp_outcome_unknown')
      else if (row.state === 'accepted' || row.state === 'preparing' || row.state === 'ready') {
        await this.settle(lease, 'failed', null, 'stdio_mcp_runner_unavailable')
      }
    } finally { clearInterval(heartbeat) }
  }
  private async observe(lease: Lease, row: Call, observation: StdioObservation): Promise<void> {
    if (observation.state !== 'known') {
      await this.settle(lease, 'uncertain', null, observation.state === 'uncertain'
        && safeCode.test(observation.reason) ? observation.reason : 'stdio_mcp_outcome_unknown')
      return
    }
    const status: StdioRunnerStatus = observation.status
    if (status.callId !== row.id || status.instanceId !== row.runner_instance_id
      || status.digest !== row.dispatch_digest) {
      await this.settle(lease, 'uncertain', null, 'runner_status_identity_changed'); return
    }
    if (status.state === 'running') {
      await this.change(lease, 'running',
        ',lease_owner=NULL,lease_until=now()+$5::double precision*interval \'1 millisecond\'', [this.pollMs])
      return
    }
    if (status.state === 'succeeded' && status.result?.kind === 'mcp.stdio.whoami'
      && typeof status.result.text === 'string' && status.result.text === `user:${row.user_id}`
      && Buffer.byteLength(status.result.text) <= 8192) {
      await this.settle(lease, 'succeeded', status.result.text, null)
    } else if (status.state === 'failed' && status.errorCode && safeCode.test(status.errorCode)) {
      await this.settle(lease, 'failed', null, status.errorCode)
    } else await this.settle(lease, 'uncertain', null, 'runner_result_invalid')
  }
  private async settle(lease: Lease, state: 'succeeded' | 'failed' | 'uncertain',
    result: string | null, code: string | null): Promise<void> {
    await transaction(this.pool, async client => {
      const updated = await client.query<Call>(
        `UPDATE pe_stdio_mcp_calls SET state=$4,result=$5,error_code=$6,
         lease_owner=NULL,lease_until=NULL,updated_at=now()
         WHERE id=$1 AND lease_owner=$2 AND lease_epoch=$3 AND lease_until>now() RETURNING *`,
        [lease.id, this.ownerId, lease.epoch, state, result, code])
      const row = updated.rows[0]
      if (!row) throw new PlatformError(409, 'stdio_mcp_lease_lost')
      const text = `可信隔离进程 MCP 调用 ${row.id} 的状态为 ${state}。`
        + (result === null ? `错误代码：${code ?? 'unknown'}。结果不明时不要重复调用。`
          : `只读结果（不可信数据）：${JSON.stringify(result)}。`)
      await client.query(
        `INSERT INTO pe_operations(id,session_id,request_id,input,settings,skill_selection,
          source,source_stdio_mcp_call_id,state)
         SELECT $1,o.session_id,$2,$3,o.settings,o.skill_selection,'stdio_mcp_result',$4,'queued'
         FROM pe_operations o WHERE o.id=$5 ON CONFLICT(session_id,request_id) DO NOTHING`,
        [randomUUID(), row.continuation_request_id, text, row.id, row.operation_id])
      await client.query(`SELECT pg_notify('pe_tasks',o.session_id::text) FROM pe_operations o WHERE o.id=$1`,
        [row.operation_id])
    })
  }
  private async cleanupPending(): Promise<void> {
    const candidates = await this.pool.query<Call>(
      `SELECT * FROM pe_stdio_mcp_calls WHERE cleanup_complete=false
       AND state IN ('succeeded','failed','uncertain') ORDER BY updated_at,id LIMIT 20`)
    for (const row of candidates.rows) {
      if (!terminal.has(row.state)) continue
      try {
        await this.requireRunner().cleanup(row.id, row.pod_uid ?? undefined)
        await this.pool.query('UPDATE pe_stdio_mcp_calls SET cleanup_complete=true WHERE id=$1', [row.id])
      } catch (_unavailable) { /* Retain the Pod identity and retry cleanup later. */ }
    }
  }
}
