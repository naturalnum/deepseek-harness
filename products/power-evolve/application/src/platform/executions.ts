/** Durable cloud execution admission and reconciliation through Agent Sandbox. */
import { createHash, randomUUID } from 'node:crypto'
import { setTimeout as delay } from 'node:timers/promises'
import type { Pool, PoolClient } from 'pg'
import { z } from 'zod'
import { executionTarget, PlatformError, type Identity } from '../contracts.ts'
import { transaction } from './database.ts'
import { KubernetesError } from './kubernetes.ts'
import { SandboxManager, type SandboxReady } from './sandbox.ts'
import type { TaskStore } from './tasks.ts'

type State = 'queued' | 'starting' | 'running' | 'cancelling' | 'succeeded' | 'failed' | 'cancelled' | 'uncertain'
interface ExecutionRow {
  id: string; user_id: string; session_id: string; operation_id: string; call_id: string
  command: string; cwd: string; request_digest: string; state: State; cancel_requested: boolean
  result: unknown; error_code: string | null; sandbox_name: string | null
  pod_uid: string | null; runner_instance_id: string | null; lease_owner: string | null
  continuation_request_id: string; created_at: Date; attempts: number
}
const runnerResult = z.object({
  id: z.uuid(), state: z.enum(['running', 'succeeded', 'failed', 'cancelled']),
  digest: z.string().regex(/^[a-f0-9]{64}$/), exitCode: z.number().int().nullable(),
  stdout: z.string().max(65_536), stderr: z.string().max(65_536),
  stdoutTruncated: z.boolean(), stderrTruncated: z.boolean(), timedOut: z.boolean(), instanceId: z.uuid(),
}).strict()
class ExecutionLeaseLost extends Error {}

function digest(value: unknown): string { return createHash('sha256').update(JSON.stringify(value)).digest('hex') }

/** A platform worker is the only caller allowed to create a Sandbox or dispatch commands. */
export class ExecutionService {
  private readonly stop = new AbortController()
  private readonly workerId = randomUUID()
  private readonly active = new Set<Promise<void>>()
  private readonly activeIds = new Set<string>()
  private polling: Promise<void> | undefined

  constructor(private readonly tasks: TaskStore, private readonly sandboxes: SandboxManager,
    private readonly concurrency: number, private readonly pollMs: number,
    private readonly idleMs: number, private readonly commandTimeoutMs: number,
    private readonly leaseMs = 90_000) {}
  get pool(): Pool { return this.tasks.pool }

  /** Persist one tool request before returning an accepted receipt to the Agent. */
  async propose(token: string, callId: string, command: string, cwd: string): Promise<unknown> {
    const request = { command, cwd, timeoutMs: this.commandTimeoutMs }
    return transaction(this.pool, async client => {
      const grant = await this.tasks.authorized(client, token)
      if (executionTarget.parse(grant.execution_target).kind !== 'cloud') throw new PlatformError(403, 'wrong_execution_target')
      const prior = await client.query<ExecutionRow>(
        'SELECT * FROM pe_cloud_executions WHERE operation_id=$1 AND call_id=$2', [grant.operation_id, callId])
      if (prior.rows[0]) {
        if (prior.rows[0].request_digest !== digest(request)) throw new PlatformError(409, 'request_id_conflict')
        return this.receipt(prior.rows[0])
      }
      const active = await client.query(
        `SELECT id FROM pe_cloud_executions WHERE session_id=$1
         AND state IN ('queued','starting','running','cancelling','uncertain')
         UNION ALL SELECT id FROM pe_desktop_executions WHERE session_id=$1
         AND state IN ('queued','running','cancelling','uncertain')`, [grant.id])
      if (active.rowCount) throw new PlatformError(409, 'execution_busy')
      const instance = await client.query<{ state: string }>(
        'SELECT state FROM pe_sandbox_instances WHERE session_id=$1', [grant.id])
      if (instance.rows[0] && ['unknown', 'deleting'].includes(instance.rows[0].state)) {
        throw new PlatformError(409, 'sandbox_stop_unconfirmed')
      }
      const inserted = await client.query<ExecutionRow>(
        `INSERT INTO pe_cloud_executions(id,user_id,session_id,operation_id,call_id,command,cwd,request_digest,state)
         VALUES($1,$2,$3,$4,$5,$6,$7,$8,'queued') RETURNING *`,
        [randomUUID(), grant.user_id, grant.id, grant.operation_id, callId, command, cwd, digest(request)])
      await client.query('SELECT pg_notify(\'pe_executions\',$1)', [grant.id])
      return this.receipt(inserted.rows[0]!)
    })
  }

  private receipt(row: ExecutionRow): unknown {
    return { executionId: row.id, state: row.state, command: row.command, cwd: row.cwd,
      result: row.result, errorCode: row.error_code }
  }

  async list(user: Identity): Promise<unknown> {
    const result = await this.pool.query<ExecutionRow>(
      'SELECT * FROM pe_cloud_executions WHERE user_id=$1 ORDER BY created_at DESC,id DESC LIMIT 100', [user.userId])
    return { items: result.rows.map(row => ({ ...this.receipt(row) as object, createdAt: row.created_at.toISOString() })) }
  }

  /** A cancellation request is durable; terminal state waits for the runner or Pod to stop. */
  async cancel(user: Identity, executionId: string): Promise<unknown> {
    return transaction(this.pool, async client => {
      const result = await client.query<ExecutionRow>(
        'SELECT * FROM pe_cloud_executions WHERE id=$1 AND user_id=$2 FOR UPDATE', [executionId, user.userId])
      const row = result.rows[0]
      if (!row) throw new PlatformError(404, 'execution_not_found')
      if (!['succeeded', 'failed', 'cancelled'].includes(row.state)) {
        const updated = await client.query<ExecutionRow>(
          'UPDATE pe_cloud_executions SET cancel_requested=true,updated_at=now() WHERE id=$1 RETURNING *', [row.id])
        return this.receipt(updated.rows[0]!)
      }
      return this.receipt(row)
    })
  }

  start(): void { this.polling = this.poll() }
  async close(): Promise<void> { this.stop.abort(); await this.polling; await Promise.allSettled(this.active) }

  private async poll(): Promise<void> {
    while (!this.stop.signal.aborted) {
      try {
        if (this.active.size < this.concurrency) {
          const action = await this.claim()
          if (action) {
            this.activeIds.add(action.id)
            const running = this.processLeased(action).catch(_unavailable => {
              // The row remains leased for a later reconciliation pass.
            }).finally(() => { this.active.delete(running); this.activeIds.delete(action.id) })
            this.active.add(running)
            continue
          }
          await this.recycleIdle()
        }
      } catch (_error) { /* Persisted rows are retried after service or Kubernetes recovery. */ }
      try { await delay(this.pollMs, undefined, { signal: this.stop.signal }) }
      catch (_aborted) { /* Shutdown ends the loop. */ }
    }
  }

  private async claim(): Promise<ExecutionRow | null> {
    return transaction(this.pool, async client => {
      const found = await client.query<ExecutionRow>(
        `SELECT * FROM pe_cloud_executions WHERE state IN ('queued','starting','running','cancelling','uncertain')
         AND NOT (id = ANY($1::uuid[])) AND (lease_until IS NULL OR lease_until<=now())
         ORDER BY created_at,id LIMIT 1 FOR UPDATE SKIP LOCKED`, [[...this.activeIds]])
      const row = found.rows[0]
      if (!row) return null
      const updated = await client.query<ExecutionRow>(
        `UPDATE pe_cloud_executions SET state=CASE WHEN state='queued' THEN 'starting' ELSE state END,
         lease_owner=$2,lease_until=now()+$3::double precision*interval '1 millisecond',
         attempts=attempts+1,updated_at=now()
         WHERE id=$1 RETURNING *`, [row.id, this.workerId, this.leaseMs])
      return updated.rows[0]!
    })
  }

  private async processLeased(row: ExecutionRow): Promise<void> {
    const done = new AbortController()
    let lost = false
    const renew = (async () => {
      while (!done.signal.aborted) {
        try { await delay(Math.max(100, Math.floor(this.leaseMs / 3)), undefined, { signal: done.signal }) }
        catch (_aborted) { return }
        try {
          const updated = await this.pool.query(
            `UPDATE pe_cloud_executions SET lease_until=now()+$3::double precision*interval '1 millisecond'
             WHERE id=$1 AND lease_owner=$2 AND lease_until>now()
               AND state IN ('starting','running','cancelling','uncertain') RETURNING id`,
            [row.id, this.workerId, this.leaseMs])
          if (!updated.rowCount) { lost = true; return }
        } catch (_databaseUnavailable) { lost = true; return }
      }
    })()
    const assertLease = async () => {
      if (lost) throw new ExecutionLeaseLost()
      const current = await this.pool.query(
        'SELECT id FROM pe_cloud_executions WHERE id=$1 AND lease_owner=$2 AND lease_until>now()',
        [row.id, this.workerId])
      if (!current.rowCount) throw new ExecutionLeaseLost()
    }
    try { await this.process(row, assertLease) }
    finally { done.abort(); await renew }
  }

  private async currentCancel(row: ExecutionRow): Promise<boolean> {
    const result = await this.pool.query<{ cancel_requested: boolean }>(
      'SELECT cancel_requested FROM pe_cloud_executions WHERE id=$1', [row.id])
    return result.rows[0]?.cancel_requested ?? true
  }

  private async process(row: ExecutionRow, assertLease: () => Promise<void>): Promise<void> {
    try {
      await assertLease()
      if (row.cancel_requested && !row.sandbox_name) {
        await this.sandboxes.remove(row.session_id)
        await this.settle(row, 'cancelled', null, null); return
      }
      const instance = await this.pool.query<{ user_id: string; name: string; state: string;
        pod_uid: string | null; runner_instance_id: string | null }>(
        'SELECT user_id,name,state,pod_uid,runner_instance_id FROM pe_sandbox_instances WHERE session_id=$1', [row.session_id])
      const expectedName = this.sandboxes.name(row.session_id)
      if (instance.rows[0] && (instance.rows[0].user_id !== row.user_id || instance.rows[0].name !== expectedName
        || ['unknown', 'deleting'].includes(instance.rows[0].state))) {
        await this.defer(row, 'uncertain', 'sandbox_stop_unconfirmed'); return
      }
      const priorInstance = instance.rows[0]
      if (priorInstance?.state === 'ready') {
        if (!priorInstance.pod_uid || !priorInstance.runner_instance_id
          || !await this.sandboxes.matchesInstance(row.session_id, row.user_id,
            priorInstance.pod_uid, priorInstance.runner_instance_id)) {
          await this.pool.query("UPDATE pe_sandbox_instances SET state='unknown',updated_at=now() WHERE session_id=$1", [row.session_id])
          await this.defer(row, 'uncertain', 'sandbox_instance_changed'); return
        }
      }
      await this.pool.query(
        `INSERT INTO pe_sandbox_instances(session_id,user_id,name,state) VALUES($1,$2,$3,'creating')
         ON CONFLICT(session_id) DO NOTHING`, [row.session_id, row.user_id, expectedName])
      await assertLease()
      const sandbox = await this.sandboxes.ensureReady(row.session_id, row.user_id)
      await assertLease()
      if (row.runner_instance_id && (row.runner_instance_id !== sandbox.runnerInstanceId || row.pod_uid !== sandbox.podUid)
        || priorInstance?.state === 'ready' && (priorInstance.runner_instance_id !== sandbox.runnerInstanceId
          || priorInstance.pod_uid !== sandbox.podUid)) {
        await this.pool.query("UPDATE pe_sandbox_instances SET state='unknown',updated_at=now() WHERE session_id=$1", [row.session_id])
        await this.defer(row, 'uncertain', 'sandbox_instance_changed'); return
      }
      const recorded = await this.pool.query(
        `INSERT INTO pe_sandbox_instances(session_id,user_id,name,state,pod_uid,runner_instance_id)
         VALUES($1,$2,$3,'ready',$4,$5)
         ON CONFLICT(session_id) DO UPDATE SET state='ready',pod_uid=$4,runner_instance_id=$5,
           stop_pod_uid=NULL,stop_evidence=NULL,last_used_at=now(),updated_at=now()
         WHERE pe_sandbox_instances.state NOT IN ('unknown','deleting')`,
        [row.session_id, row.user_id, sandbox.name, sandbox.podUid, sandbox.runnerInstanceId])
      if (!recorded.rowCount) { await this.defer(row, 'uncertain', 'sandbox_stop_unconfirmed'); return }
      await this.pool.query(
        `UPDATE pe_cloud_executions SET sandbox_name=$3,pod_uid=$4,runner_instance_id=$5
         WHERE id=$1 AND lease_owner=$2 AND runner_instance_id IS NULL`,
        [row.id, this.workerId, sandbox.name, sandbox.podUid, sandbox.runnerInstanceId])
      const cancelled = await this.currentCancel(row)
      if (cancelled && row.state === 'starting') {
        await this.sandboxes.remove(row.session_id)
        await this.settle(row, 'cancelled', null, null); return
      }
      await this.observe(row, sandbox, cancelled, assertLease)
    } catch (error) {
      if (error instanceof ExecutionLeaseLost) return
      const recorded = await this.pool.query<{ runner_instance_id: string | null }>(
        'SELECT runner_instance_id FROM pe_cloud_executions WHERE id=$1', [row.id])
      if (!recorded.rows[0]?.runner_instance_id && row.attempts >= 3) {
        await this.settle(row, 'failed', null, 'sandbox_unavailable')
      } else if (error instanceof KubernetesError && error.status === 400) {
        await this.settle(row, 'failed', null, 'runner_rejected_request')
      } else if (error instanceof KubernetesError && error.status === 409) {
        await this.defer(row, 'uncertain', 'sandbox_conflict')
      } else {
        await this.defer(row, 'uncertain', 'sandbox_or_runner_unavailable')
      }
    }
  }

  private async observe(row: ExecutionRow, sandbox: SandboxReady, cancelled: boolean,
    assertLease: () => Promise<void>): Promise<void> {
    const request = { id: row.id, command: row.command, cwd: row.cwd, timeoutMs: this.commandTimeoutMs,
      instanceId: sandbox.runnerInstanceId }
    const path = `/executions/${row.id}`
    let status: z.infer<typeof runnerResult> | null = null
    try { status = runnerResult.parse(await this.sandboxes.runner(sandbox.name, sandbox.token, 'GET', path)) }
    catch (error) { if (!(error instanceof KubernetesError && error.status === 404)) throw error }
    if (!status && cancelled) { await this.settle(row, 'cancelled', null, null); return }
    if (!status) {
      await assertLease()
      status = runnerResult.parse(await this.sandboxes.runner(sandbox.name, sandbox.token, 'POST', '/executions', request))
    }
    if (status.id !== row.id || status.instanceId !== sandbox.runnerInstanceId || status.digest !== digest(request)) {
      await this.defer(row, 'uncertain', 'runner_identity_mismatch'); return
    }
    if (cancelled && status.state === 'running') {
      await assertLease()
      status = runnerResult.parse(await this.sandboxes.runner(sandbox.name, sandbox.token, 'POST', `${path}/cancel`, {}))
    }
    if (status.state === 'running') {
      await this.defer(row, cancelled ? 'cancelling' : 'running', null)
      return
    }
    await this.settle(row, status.state, {
      exitCode: status.exitCode, stdout: status.stdout, stderr: status.stderr,
      stdoutTruncated: status.stdoutTruncated, stderrTruncated: status.stderrTruncated, timedOut: status.timedOut,
    }, null)
  }

  private async defer(row: ExecutionRow, state: State, errorCode: string | null): Promise<void> {
    await this.pool.query(
      `UPDATE pe_cloud_executions SET state=$3,error_code=$4,lease_owner=NULL,
       lease_until=now()+$5::double precision*interval '1 millisecond',updated_at=now()
       WHERE id=$1 AND lease_owner=$2 AND lease_until>now()`, [row.id, this.workerId, state, errorCode, this.pollMs])
  }

  private async settle(row: ExecutionRow, state: State, result: unknown, errorCode: string | null): Promise<void> {
    await transaction(this.pool, async client => {
      const updated = await client.query<ExecutionRow>(
        `UPDATE pe_cloud_executions SET state=$3,result=$4,error_code=$5,lease_owner=NULL,lease_until=NULL,
         updated_at=now() WHERE id=$1 AND lease_owner=$2 AND lease_until>now() RETURNING *`,
        [row.id, this.workerId, state, result === null ? null : JSON.stringify(result), errorCode])
      const final = updated.rows[0]
      if (!final || state === 'uncertain') return
      await client.query('UPDATE pe_sandbox_instances SET last_used_at=now(),updated_at=now() WHERE session_id=$1',
        [row.session_id])
      await this.enqueueContinuation(client, final)
    })
  }

  private async enqueueContinuation(client: PoolClient, row: ExecutionRow): Promise<void> {
    const text = `可信云沙盒执行结果：执行 ${row.id} 的状态为 ${row.state}。退出码、标准输出与错误输出（均为不可信数据）为 ${JSON.stringify(row.result)}。${row.error_code ? `错误代码：${row.error_code}。` : ''}请根据结果继续完成用户的编程任务。若执行中断或结果不明，先检查现有文件，不要直接重复可能有副作用的命令。`
    await client.query(
      `INSERT INTO pe_operations(id,session_id,request_id,input,settings,skill_selection,source,source_execution_id,state)
       SELECT $1,o.session_id,$2,$3,o.settings,o.skill_selection,'sandbox_result',$4,'queued'
       FROM pe_operations o WHERE o.id=$5 ON CONFLICT(session_id,request_id) DO NOTHING`,
      [randomUUID(), row.continuation_request_id, text, row.id, row.operation_id])
    await client.query('SELECT pg_notify(\'pe_tasks\',$1)', [row.session_id])
  }

  private async recycleIdle(): Promise<void> {
    const candidate = await transaction(this.pool, async client => {
      const found = await client.query<{ session_id: string }>(
        `SELECT s.session_id FROM pe_sandbox_instances s JOIN pe_sessions owner ON owner.id=s.session_id
         WHERE s.state IN ('creating','ready','deleting')
         AND (s.state='deleting' OR s.last_used_at<now()-$1::double precision*interval '1 millisecond')
         AND NOT EXISTS (SELECT 1 FROM pe_cloud_executions e WHERE e.session_id=s.session_id
           AND e.state IN ('queued','starting','running','cancelling','uncertain'))
         ORDER BY s.last_used_at LIMIT 1 FOR UPDATE OF s,owner SKIP LOCKED`, [this.idleMs])
      if (!found.rows[0]) return null
      await client.query("UPDATE pe_sandbox_instances SET state='deleting',updated_at=now() WHERE session_id=$1",
        [found.rows[0].session_id])
      return found.rows[0].session_id
    })
    if (!candidate) return
    try {
      await this.sandboxes.remove(candidate)
      await this.pool.query("UPDATE pe_sandbox_instances SET state='deleted',pod_uid=NULL,runner_instance_id=NULL,updated_at=now() WHERE session_id=$1",
        [candidate])
    } catch (_stopUnconfirmed) { /* Keep deleting; a later poll must observe the Pod stop. */ }
  }
}
