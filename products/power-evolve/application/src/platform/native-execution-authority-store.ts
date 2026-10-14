/** PG authority for native Agent worlds; storage and permission generations fence every dispatch. */
import { randomUUID } from 'node:crypto'
import type { Pool, PoolClient } from 'pg'
import { z } from 'zod'
import { nativeExecutionWorld, type NativeExecutionWorld } from '../native-execution/types.ts'
import { PlatformError } from '../contracts.ts'
import { storageBinding, type StorageBinding } from './cloud-storage-types.ts'
import { digest } from './identity.ts'
import { transaction } from './database.ts'
import type { TaskStore } from './tasks.ts'
import type { ManagedCloudStorage } from './managed-storage.ts'

/** Current native policy resolved from tenant defaults and committed Session events under the Session lock.
 * @param client Existing account/Session-locked transaction.
 * @param session Original authorized Session and operation.
 * @returns Current native mode and monotonic permission generation.
 */
export type NativeExecutionPolicyReader = (client: PoolClient,
  session: Awaited<ReturnType<TaskStore['authorized']>>) => Promise<Pick<NativeExecutionWorld, 'mode' | 'permissionGeneration'>>

/** Original operation authority plus the explicit durable interactive-holder branch.
 * @param client Existing account/Session-locked transaction.
 * @param token Original issued operation or interactive bearer.
 * @param purpose Read initialization or payload execution; implementations must not infer a fallback.
 * @returns The original authorized Session with its exact operation epoch.
 */
export interface NativeExecutionTaskAuthority {
  nativeWorldAuthorized(client: PoolClient, token: string, purpose: 'storage-read' | 'execution'): ReturnType<TaskStore['authorized']>
}

const rowSchema = z.object({ world: nativeExecutionWorld, binding: storageBinding, grant: z.string(), revoked: z.boolean() }).strict()

/** Platform owns original grant checks; trusted Runtime receives only its issued world and bounded methods. */
export class NativeExecutionAuthorityStore {
  private mutations = 0
  constructor(readonly pool: Pool, private readonly tasks: NativeExecutionTaskAuthority, private readonly storage: ManagedCloudStorage,
    private readonly policy: NativeExecutionPolicyReader) {}

  /** Issue an Agent-scoped storage world from the original operation; payload execution requires a separate current-cohort check.
   * @param token Current original operation bearer, never passed into a payload.
   * @param agentId Native Agent identity owned by the requesting Runtime.
   * @returns Frozen public world and private server-selected storage binding.
   */
  async open(token: string, agentId: string): Promise<{ world: NativeExecutionWorld; binding: StorageBinding }> {
    return transaction(this.pool, async (client) => {
      const session = await this.tasks.nativeWorldAuthorized(client, token, 'storage-read')
      if (agentId !== session.id) throw new PlatformError(403, 'native_world_agent_mismatch')
      const binding = await this.storage.resolve(session.user_id, session.workspace_id, client)
      const policy = await this.policy(client, session)
      const previous = await client.query<{ id: string }>(`SELECT id FROM pe_native_execution_worlds
        WHERE user_id=$1 AND session_id=$2 AND agent_id=$3 AND operation_id=$4 AND operation_epoch=$5
        AND grant_digest=$6 AND workspace_id=$7 AND storage_generation=$8 AND permission_generation=$9
        AND mode=$10 AND binding_snapshot=$11::jsonb AND revoked_at IS NULL ORDER BY created_at DESC LIMIT 1`,
      [session.user_id, session.id, agentId, session.operation_id, session.lease_epoch, digest(token), session.workspace_id,
        binding.generation, policy.permissionGeneration, policy.mode, JSON.stringify(binding)])
      const existingId = previous.rows[0]?.id
      const world = nativeExecutionWorld.parse({ worldId: existingId ?? randomUUID(), userId: session.user_id, sessionId: session.id,
        agentId, workspaceId: session.workspace_id, operationId: session.operation_id, operationEpoch: session.lease_epoch,
        storageGeneration: binding.generation, ...policy, workspaceRoot: '/workspace', homeRoot: '/home/agent' })
      if (existingId === undefined) await client.query(`INSERT INTO pe_native_execution_worlds(id,user_id,session_id,agent_id,operation_id,operation_epoch,
        grant_digest,workspace_id,storage_generation,permission_generation,mode,binding_snapshot)
        VALUES($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11,$12)`, [world.worldId, world.userId, world.sessionId, world.agentId,
        world.operationId, world.operationEpoch, digest(token), world.workspaceId, world.storageGeneration,
        world.permissionGeneration, world.mode, binding])
      return { world, binding }
    })
  }

  /** Recheck account, original operation lease, durable native claim, storage and permission generation.
   * @param token Original operation bearer.
   * @param world Frozen server-issued world supplied by the bounded provider.
   * @param purpose Storage initialization reads or current-cohort business execution.
   * @returns Private storage binding only when all current generations match.
   */
  async assert(token: string, world: NativeExecutionWorld, purpose: 'execution' | 'storage-read' = 'execution'): Promise<StorageBinding> {
    return transaction(this.pool, async (client) => {
      const session = await this.tasks.nativeWorldAuthorized(client, token, purpose)
      const found = await client.query<{ world: unknown; binding: unknown; grant: string; revoked: boolean }>(
        `SELECT jsonb_build_object('worldId',id,'userId',user_id,'sessionId',session_id,'agentId',agent_id,
        'workspaceId',workspace_id,'operationId',operation_id,'operationEpoch',operation_epoch,
        'storageGeneration',storage_generation,'permissionGeneration',permission_generation,'mode',mode,
        'workspaceRoot','/workspace','homeRoot','/home/agent') AS world,binding_snapshot AS binding,
        grant_digest AS grant,revoked_at IS NOT NULL AS revoked FROM pe_native_execution_worlds WHERE id=$1 FOR UPDATE`, [world.worldId])
      const result = rowSchema.safeParse(found.rows[0])
      if (!result.success || result.data.revoked || result.data.grant !== digest(token)
        || JSON.stringify(result.data.world) !== JSON.stringify(world)
        || session.id !== world.sessionId || session.user_id !== world.userId || session.operation_id !== world.operationId
        || session.lease_epoch !== world.operationEpoch) throw new PlatformError(409, 'native_world_authority_lost')
      const binding = await this.storage.resolve(session.user_id, session.workspace_id, client)
      const policy = await this.policy(client, session)
      if (JSON.stringify(binding) !== JSON.stringify(result.data.binding) || policy.mode !== world.mode
        || policy.permissionGeneration !== world.permissionGeneration) throw new PlatformError(409, 'native_world_generation_changed')
      if (purpose === 'execution') {
        const uncertain = await client.query(`SELECT p.id FROM pe_native_execution_processes p
          JOIN pe_native_execution_worlds w ON w.id=p.world_id WHERE w.user_id=$1 AND w.workspace_id=$2
          AND (p.state='uncertain' OR p.state<>'stopped' AND (w.storage_generation<>$3 OR
          w.session_id=$4 AND (w.permission_generation<>$5 OR w.operation_epoch<>$6))) LIMIT 1`,
        [world.userId, world.workspaceId, world.storageGeneration, world.sessionId, world.permissionGeneration, world.operationEpoch])
        if (uncertain.rowCount) throw new PlatformError(409, 'native_world_reconciliation_required')
      }
      return binding
    })
  }

  /** Serialize native guarded mutations across utility processes and alias bindings to the same physical root.
   * The lock precedes payload submission; waiting never retries a write or holds account/Session locks; two PG slots remain available for payload authority and stop evidence.
   * @param token Original world bearer.
   * @param world Captured Agent world.
   * @param path Canonical execution-world target path.
   * @param apply One non-replayed mutation dispatch.
   * @returns Native mutation outcome after joined worker cleanup.
   */
  async mutate<T>(token: string, world: NativeExecutionWorld, path: string, apply: () => Promise<T>): Promise<T> {
    const binding = await this.assert(token, world)
    const root = path.startsWith('/workspace/') ? ['workspace', binding.rootKey, binding.rootRelativePath]
      : path.startsWith('/tmp/') ? ['temporary', world.userId, world.sessionId] : ['home', world.userId]
    const maximum = this.pool.options.max
    if (maximum === undefined || maximum < 3 || this.mutations >= maximum - 2) throw new PlatformError(429, 'native_fs_capacity')
    this.mutations++
    try {
      const key = JSON.stringify([...root, path]), client = await this.pool.connect()
      let locked = false, releaseError: unknown
      try {
        await client.query('SELECT pg_advisory_lock(hashtextextended($1,0))', [key])
        locked = true
        return await apply()
      } finally {
        try { if (locked) await client.query('SELECT pg_advisory_unlock(hashtextextended($1,0))', [key]) }
        catch (error) { releaseError = error; throw error }
        finally { client.release(releaseError !== undefined) }
      }
    } finally { this.mutations-- }
  }

  /** Revoke one issued world without altering original operation authority.
   * @param token Original operation bearer matching the issued world.
   * @param worldId Exact world identity.
   */
  async revoke(token: string, worldId: NativeExecutionWorld['worldId']): Promise<void> {
    const result = await this.pool.query(`UPDATE pe_native_execution_worlds SET revoked_at=COALESCE(revoked_at,clock_timestamp())
      WHERE id=$1 AND grant_digest=$2 RETURNING id`, [worldId, digest(token)])
    if (result.rowCount !== 1) throw new PlatformError(409, 'native_world_authority_lost')
  }

  /** Authenticate only original-world ownership for stop/release after authority was revoked.
   * This check never authorizes payload dispatch, reads, writes, or new leases.
   * @param token Original operation bearer.
   * @param world Exact originally issued world.
   */
  async assertOwnership(token: string, world: NativeExecutionWorld): Promise<void> {
    const result = await this.pool.query(`SELECT id FROM pe_native_execution_worlds WHERE id=$1 AND user_id=$2
      AND session_id=$3 AND agent_id=$4 AND operation_id=$5 AND operation_epoch=$6 AND grant_digest=$7
      AND workspace_id=$8 AND storage_generation=$9 AND permission_generation=$10 AND mode=$11`,
    [world.worldId, world.userId, world.sessionId, world.agentId, world.operationId, world.operationEpoch, digest(token),
      world.workspaceId, world.storageGeneration, world.permissionGeneration, world.mode])
    if (result.rowCount !== 1) throw new PlatformError(409, 'native_world_authority_lost')
  }
}
