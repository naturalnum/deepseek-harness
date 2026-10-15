/** The native in-process Subagent providers create PG-owned children under bounded original parent authority. */
import { z } from 'zod'
import { randomBytes, randomUUID } from 'node:crypto'
import type { SessionHeader } from '@deepseek-ai/dsh-session'
import { PlatformError, type Grant, operationId } from '../contracts.ts'
import { headerSchema } from '../session-records.ts'
import { transaction } from './database.ts'
import { requireModelGrant, resolveModelEffort } from './account-settings.ts'
import { settings } from '../contracts.ts'
import { readNativeRuntimePolicy } from './native-runtime-policy.ts'
import { digest } from './identity.ts'
import type { TaskStore } from './tasks.ts'

/** Deployment bounds for native descendants sharing their parent's account and workspace. */
export interface NativeSubagentLimits { maxChildren: number; maxDepth: number; lifetimeMs: number; leaseMs: number }

/** Original Header ids make uncertain creates idempotent; no accepted prompt is replayed. */
export class NativeSubagents {
  constructor(private readonly tasks: TaskStore, private readonly limits: NativeSubagentLimits) {}

  /** Freeze the native factory's actual child model before its own first turn, retaining the parent's token ceiling.
   * @param token Exact new child operation bearer; parent, user and Writer clocks remain required.
   * @param selection Actual native Agent options after resolveChildAgentOptions, never a provider credential.
   * @returns Validated child settings whose model the existing proxy continues to require exactly.
   */
  async configure(token: string, selection: { provider: string; model: string; maxTokens: number; reasoningEffort?: string }): Promise<Grant['settings']> {
    const value = z.object({ provider: z.string().min(1).max(128), model: z.string().min(1).max(1024),
      maxTokens: z.number().int().positive(), reasoningEffort: z.string().min(1).max(128).optional() }).strict().parse(selection)
    return transaction(this.tasks.pool, async (client) => {
      const child = await this.tasks.authorized(client, token)
      const derived = await client.query<{ parent_settings: unknown }>(`SELECT p.settings AS parent_settings FROM pe_native_subagent_grants d
        JOIN pe_operations p ON p.id=d.parent_operation_id WHERE d.operation_id=$1 AND d.session_id=$2 FOR UPDATE OF d`, [child.operation_id, child.id])
      if (!derived.rows[0]) throw new PlatformError(403, 'native_subagent_required')
      const parent = settings.parse(derived.rows[0].parent_settings)
      if (value.maxTokens > parent.maxTokens) throw new PlatformError(403, 'native_subagent_token_ceiling')
      const started = await client.query(`SELECT 1 FROM pe_events WHERE session_id=$1 AND event->>'type'='turn/start'
        AND seq>COALESCE((SELECT max(seq) FROM pe_events WHERE session_id=$1 AND event->>'type'='session/end-seed'
          AND event->'data'->>'inherited'='true'),-1) LIMIT 1`, [child.id])
      if (started.rowCount) throw new PlatformError(409, 'native_subagent_model_frozen')
      const effort = await resolveModelEffort(client, child.user_id, value.provider, value.model, value.reasoningEffort)
      await requireModelGrant(client, child.user_id, value.model, value.maxTokens, value.provider, effort)
      const selected = settings.parse({ model: value.model, maxTokens: value.maxTokens, revision: parent.revision,
        ...value.provider === 'power-evolve' ? {} : { provider: value.provider, ...effort === undefined ? {} : { reasoningEffort: effort } } })
      await client.query('UPDATE pe_operations SET settings=$2 WHERE id=$1', [child.operation_id, selected])
      return selected
    })
  }

  /** Derive one child storage/model grant from a currently claimed parent step and writer.
   * @param token Exact original parent operation bearer.
   * @param rawHeader Native factory header; ids, lineage and depth are checked before any insert.
   * @returns One new child grant; its original request and header remain the native factory's authority.
   */
  async create(token: string, rawHeader: unknown): Promise<Grant> {
    const header: SessionHeader = headerSchema.parse(rawHeader)
    if (header.origin !== 'subagent' || !header.parentSession || header.delegationDepth === undefined
      || header.delegationDepth < 1 || header.delegationDepth > this.limits.maxDepth) {
      throw new PlatformError(400, 'native_subagent_header_invalid')
    }
    return transaction(this.tasks.pool, async (client) => {
      const parent = await this.tasks.executionAuthorized(client, token)
      if (header.parentSession !== parent.id || header.id === parent.id) throw new PlatformError(403, 'native_subagent_parent_mismatch')
      const expectedDepth = (headerSchema.parse(parent.header).delegationDepth ?? 0) + 1
      if (header.delegationDepth !== expectedDepth || header.cwd !== undefined && header.cwd !== '/workspace') {
        throw new PlatformError(400, 'native_subagent_header_invalid')
      }
      const previous = await client.query('SELECT session_id FROM pe_native_subagent_grants WHERE session_id=$1', [header.id])
      if (previous.rows[0]) throw new PlatformError(409, 'native_subagent_create_uncertain')
      const count = await client.query<{ count: string }>('SELECT count(*) FROM pe_native_subagent_grants WHERE parent_session_id=$1 AND parent_epoch=$2',
        [parent.id, parent.lease_epoch])
      if (Number(count.rows[0]?.count) >= this.limits.maxChildren) throw new PlatformError(429, 'native_subagent_limit')
      const writer = await client.query<{ epoch: string; worker_id: string }>(`SELECT w.epoch,w.worker_id FROM pe_native_writers w
        JOIN pe_attempts a ON a.operation_id=$2 AND a.epoch=$3 AND a.worker_id=w.worker_id AND a.ended_at IS NULL
        WHERE w.session_id=$1 AND w.expires_at>clock_timestamp() FOR SHARE OF w`, [parent.id, parent.operation_id, parent.lease_epoch])
      const original = writer.rows[0]
      if (!original) throw new PlatformError(409, 'native_subagent_parent_lost')
      const parentPolicy = await readNativeRuntimePolicy(client, parent)
      const childToken = randomBytes(32).toString('base64url'), childOperation = operationId.parse(randomUUID())
      await client.query(`INSERT INTO pe_sessions(id,user_id,workspace_id,create_request_id,header,lease_epoch,grant_digest,lease_until)
        SELECT $1,user_id,workspace_id,$1,$3,1,$4,clock_timestamp()+$5::double precision*interval '1 millisecond'
        FROM pe_sessions WHERE id=$2 AND user_id=$6`,
      [header.id, parent.id, header, digest(childToken), this.limits.leaseMs, parent.user_id])
      await client.query(`INSERT INTO pe_operations(id,session_id,request_id,input,settings,state,attempts,
        skill_selection,mcp_selection,stdio_mcp_selection,ssh_selection,remote_mcp_selection,stdio_v2_selection,execution_target)
        SELECT $1,$2,$2,'',settings,'running',1,skill_selection,mcp_selection,stdio_mcp_selection,ssh_selection,
          remote_mcp_selection,stdio_v2_selection,execution_target FROM pe_operations WHERE id=$3`,
      [childOperation, header.id, parent.operation_id])
      await client.query('INSERT INTO pe_attempts(operation_id,epoch,worker_id) VALUES($1,1,$2)', [childOperation, original.worker_id])
      await client.query(`INSERT INTO pe_native_subagent_grants(session_id,user_id,operation_id,parent_session_id,
        parent_operation_id,parent_epoch,parent_digest,parent_writer_epoch,worker_id,expires_at,parent_mode,parent_permission_generation)
        VALUES($1,$2,$3,$4,$5,$6,$7,$8,$9,clock_timestamp()+$10::double precision*interval '1 millisecond',$11,$12)`,
      [header.id, parent.user_id, childOperation, parent.id, parent.operation_id, parent.lease_epoch,
        digest(token), original.epoch, original.worker_id, this.limits.lifetimeMs, parentPolicy.mode, parentPolicy.permissionGeneration])
      return this.tasks.restoreGrantInTransaction(client, childOperation, childToken, 1)
    })
  }
}
