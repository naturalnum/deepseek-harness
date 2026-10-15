/** Independent service leases use the common native provider without borrowing a Session writer. */
import { createHmac, randomUUID } from 'node:crypto'
import { isDeepStrictEqual } from 'node:util'
import type { Pool, PoolClient } from 'pg'
import { z } from 'zod'
import { brandString, type Branded } from '@deepseek-ai/dsh-brand'
import { userId, sessionId, workspaceId, PlatformError } from '../contracts.ts'
import { nativeExecutionServiceWorld, type NativeExecutionServiceWorld } from '../native-execution/types.ts'
import { requireActiveAccount } from './account-authority.ts'
import { transaction } from './database.ts'
import { digest } from './identity.ts'
import type { ManagedCloudStorage } from './managed-storage.ts'
import { storageBinding, type StorageBinding } from './cloud-storage-types.ts'
import type { NativeProcessAuthority } from './native-process-authority.ts'
import type { NativeExecutionProcessIdentity } from './native-execution-authority-store.ts'
import { kubernetesPodStopStatus } from './pod-stop-status.ts'
import { mutateNativeExecutionPath } from './native-execution-mutations.ts'

/** Original action or independently leased MCP server identity. */
export type NativeServiceSourceId = Branded<'PowerEvolveNativeServiceSourceId'>
/** Trusted worker instance; an identifier alone does not authorize a service. */
export type NativeServiceWorkerId = Branded<'PowerEvolveNativeServiceWorkerId'>
/** Exact original producer lease; every use is rechecked against its durable source. */
export const nativeExecutionServiceOwner = z.object({
  userId, kind: nativeExecutionServiceWorld.shape.authorityKind,
  id: z.uuid().transform(value => brandString<NativeServiceSourceId>(value)),
  epoch: z.number().int().positive(),
  workerId: z.uuid().transform(value => brandString<NativeServiceWorkerId>(value)),
}).strict()
/** Producer-selected owner whose lease comes from PG, never from an Agent or payload. */
export type NativeExecutionServiceOwner = z.infer<typeof nativeExecutionServiceOwner>
/** Canonical producer facts retained by the service owner; lease renewal cannot change the frozen source fields. */
export interface NativeExecutionServiceLease {
  sessionId: z.infer<typeof sessionId>
  workspaceId: z.infer<typeof workspaceId>
  mode: NativeExecutionServiceWorld['mode']
  permissionGeneration: number
  expiresAt: Date
  source: z.infer<ReturnType<typeof z.json>>
}
/** The producer verifies the original account, action/configuration, worker epoch and live lease under PG locks.
 * @param client Account-locked provider transaction; no additional connection may be borrowed.
 * @param owner Original producer and worker lease.
 * @param purpose Provisioning cannot start a program; lifecycle collection cannot dispatch or write input.
 * @returns Canonical owned storage and permission facts only while the original producer lease is valid.
 */
export type NativeExecutionServiceReader = (client: PoolClient, owner: NativeExecutionServiceOwner,
  purpose: 'provision' | 'execution' | 'storage-read' | 'process-lifecycle') => Promise<NativeExecutionServiceLease>

const retainedSource = (lease: NativeExecutionServiceLease) => ({ sessionId: lease.sessionId,
  workspaceId: lease.workspaceId, mode: lease.mode, permissionGeneration: lease.permissionGeneration, source: lease.source })
const row = z.object({ owner: nativeExecutionServiceOwner, world: nativeExecutionServiceWorld, binding: storageBinding,
  grant: z.string(), source: z.json(), revoked: z.boolean() }).strict()

/** Platform-only authority for an original independently leased execution; cleanup remains exact after revocation. */
export class NativeExecutionServiceAuthority implements NativeProcessAuthority<NativeExecutionServiceWorld> {
  private readonly key: Uint8Array
  constructor(readonly pool: Pool, private readonly storage: ManagedCloudStorage,
    private readonly read: NativeExecutionServiceReader, grantKey: Uint8Array) {
    if (grantKey.byteLength < 32) throw new TypeError('Native service grant key requires at least 32 bytes')
    this.key = Uint8Array.from(grantKey)
  }

  private token(id: string): string {
    return createHmac('sha256', this.key).update('power-evolve/native-execution-service/v1\0').update(id).digest('hex')
  }

  /** Issue or retrieve this exact producer's service world; changing identity requires original-resource reconciliation.
   * @param owner Producer lease selected by trusted control code and independently rechecked in PG.
   * @returns Bounded bearer, immutable world and server-selected binding; no program is dispatched.
   */
  async issue(owner: NativeExecutionServiceOwner): Promise<{ token: string; world: NativeExecutionServiceWorld; binding: StorageBinding }> {
    return transaction(this.pool, client => this.issueInTransaction(client, owner))
  }

  /** Issue the same independent service inside its producer's original admission transaction.
   * @param client Original account and accepted-source transaction; no nested connection is acquired.
   * @param owner Server-selected independent source identity.
   * @returns Immutable service world and bounded bearer after the caller commits.
   */
  async issueInTransaction(client: PoolClient, owner: NativeExecutionServiceOwner,
  ): Promise<{ token: string; world: NativeExecutionServiceWorld; binding: StorageBinding }> {
    await requireActiveAccount(client, owner.userId, 'update')
    const lease = await this.read(client, owner, 'provision')
    await this.assertLeaseTime(client, lease)
    const origin = await client.query('SELECT id FROM pe_sessions WHERE id=$1 AND user_id=$2 AND workspace_id=$3',
      [lease.sessionId, owner.userId, lease.workspaceId])
    if (origin.rowCount !== 1) throw new PlatformError(403, 'native_service_session_mismatch')
    const binding = await this.storage.resolve(owner.userId, lease.workspaceId, client)
    const existing = await client.query<{ id: string; world_id: string }>(`SELECT s.id,w.id AS world_id
      FROM pe_native_execution_services s JOIN pe_native_execution_worlds w ON w.service_id=s.id
      WHERE s.authority_kind=$1 AND s.authority_id=$2 AND s.authority_epoch=$3 AND s.revoked_at IS NULL FOR UPDATE OF s,w`,
    [owner.kind, owner.id, owner.epoch])
    const original = existing.rows[0]
    if (original) {
      const world = await this.world(client, original.world_id)
      await this.checkInTransaction(client, this.token(original.id), world, 'provision')
      return { token: this.token(original.id), world, binding }
    }
    const unresolved = await client.query(`SELECT p.id FROM pe_native_execution_services s
      JOIN pe_native_execution_worlds w ON w.service_id=s.id JOIN pe_native_execution_processes p ON p.world_id=w.id
      WHERE s.authority_kind=$1 AND s.authority_id=$2 AND (p.state<>'stopped'
        OR p.stop_evidence->>'resourceReleased' IS DISTINCT FROM 'true') LIMIT 1`, [owner.kind, owner.id])
    if (unresolved.rowCount) throw new PlatformError(409, 'native_service_reconciliation_required')
    const world = nativeExecutionServiceWorld.parse({ worldId: randomUUID(), userId: owner.userId,
      sessionId: lease.sessionId, workspaceId: lease.workspaceId, mode: lease.mode,
      permissionGeneration: lease.permissionGeneration, storageGeneration: binding.generation,
      workspaceRoot: '/workspace', homeRoot: '/home/agent', serviceId: randomUUID(), serviceEpoch: owner.epoch,
      authorityKind: owner.kind })
    const token = this.token(world.serviceId)
    await this.assertLeaseTime(client, lease)
    await client.query(`INSERT INTO pe_native_execution_services(id,user_id,session_id,workspace_id,authority_kind,
      authority_id,authority_epoch,owner_id,grant_digest,source_snapshot,lease_until)
      VALUES($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11)`, [world.serviceId, owner.userId, lease.sessionId, lease.workspaceId,
      owner.kind, owner.id, owner.epoch, owner.workerId, digest(token), retainedSource(lease), lease.expiresAt])
    await client.query(`INSERT INTO pe_native_execution_worlds(id,user_id,session_id,workspace_id,grant_digest,
      storage_generation,permission_generation,mode,binding_snapshot,service_id,service_epoch,authority_kind)
      VALUES($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11,$12)`, [world.worldId, owner.userId, lease.sessionId,
      lease.workspaceId, digest(token), world.storageGeneration, world.permissionGeneration, world.mode,
      binding, world.serviceId, world.serviceEpoch, world.authorityKind])
    return { token, world, binding }
  }

  private async assertLeaseTime(client: PoolClient, lease: NativeExecutionServiceLease): Promise<void> {
    const result = await client.query<{ live: boolean }>('SELECT $1::timestamptz>clock_timestamp() AS live', [lease.expiresAt])
    if (result.rows[0]?.live !== true) throw new PlatformError(409, 'native_service_lease_lost')
  }

  private async world(client: PoolClient, id: string): Promise<NativeExecutionServiceWorld> {
    const result = await client.query<{ world: unknown }>(`SELECT jsonb_build_object('worldId',id,'userId',user_id,
      'sessionId',session_id,'workspaceId',workspace_id,'storageGeneration',storage_generation,
      'permissionGeneration',permission_generation,'mode',mode,'workspaceRoot','/workspace','homeRoot','/home/agent',
      'serviceId',service_id,'serviceEpoch',service_epoch,'authorityKind',authority_kind) AS world
      FROM pe_native_execution_worlds WHERE id=$1`, [id])
    return nativeExecutionServiceWorld.parse(result.rows[0]?.world)
  }

  /** Recheck only this service's producer lease and current immutable storage/policy generation.
   * @param token Original bounded service bearer.
   * @param world Original service world; an Agent world is not accepted.
   * @param purpose Initialization reads do not authorize execution.
   * @returns Exact owned storage binding while the original source remains current.
   */
  async assert(token: string, world: NativeExecutionServiceWorld,
    purpose: 'execution' | 'storage-read' = 'execution'): Promise<StorageBinding> {
    return transaction(this.pool, async (client) => {
      await requireActiveAccount(client, world.userId, 'update')
      return this.checkInTransaction(client, token, world, purpose)
    })
  }

  private async checkInTransaction(client: PoolClient, token: string, world: NativeExecutionServiceWorld,
    purpose: 'provision' | 'execution' | 'storage-read' | 'process-lifecycle'): Promise<StorageBinding> {
    const found = await client.query<{ owner: unknown; grant: string; source: unknown; revoked: boolean; binding: unknown }>(
      `SELECT jsonb_build_object('userId',s.user_id,'kind',s.authority_kind,'id',s.authority_id,
      'epoch',s.authority_epoch,'workerId',s.owner_id) AS owner,s.grant_digest AS grant,s.source_snapshot AS source,
      s.revoked_at IS NOT NULL OR w.revoked_at IS NOT NULL AS revoked,w.binding_snapshot AS binding
      FROM pe_native_execution_services s JOIN pe_native_execution_worlds w ON w.service_id=s.id
      WHERE s.id=$1 AND w.id=$2 FOR UPDATE OF s,w`, [world.serviceId, world.worldId])
    const raw = found.rows[0]
    const original = row.safeParse(raw && { ...raw, world: await this.world(client, world.worldId) })
    if (!original.success || original.data.revoked || original.data.grant !== digest(token)
      || !isDeepStrictEqual(original.data.world, world) || original.data.owner.userId !== world.userId
      || original.data.owner.epoch !== world.serviceEpoch || original.data.owner.kind !== world.authorityKind) {
      throw new PlatformError(409, 'native_service_authority_lost')
    }
    const lease = await this.read(client, original.data.owner, purpose)
    await this.assertLeaseTime(client, lease)
    const binding = await this.storage.resolve(world.userId, world.workspaceId, client)
    if (!isDeepStrictEqual(retainedSource(lease), original.data.source)
      || !isDeepStrictEqual(binding, original.data.binding)) throw new PlatformError(409, 'native_service_generation_changed')
    if (purpose !== 'storage-read' && purpose !== 'provision') {
      const unresolved = await client.query(`SELECT p.id FROM pe_native_execution_processes p
        JOIN pe_native_execution_worlds w ON w.id=p.world_id WHERE w.user_id=$1 AND w.workspace_id=$2
        AND (p.state='uncertain' OR p.state<>'stopped' AND w.storage_generation<>$3) LIMIT 1`,
      [world.userId, world.workspaceId, world.storageGeneration])
      if (unresolved.rowCount) throw new PlatformError(409, 'native_service_reconciliation_required')
    }
    await this.assertLeaseTime(client, lease)
    await client.query('UPDATE pe_native_execution_services SET lease_until=$2,updated_at=clock_timestamp() WHERE id=$1',
      [world.serviceId, lease.expiresAt])
    return binding
  }

  /** Collect only the exact already-admitted service process while its original producer lease remains current.
   * @param token Original service bearer.
   * @param world Original immutable service world.
   * @param process Exact server-retained admission, name, UID and namespace.
   * @returns Current storage binding; no new process or input authority is granted.
   */
  async assertProcess(token: string, world: NativeExecutionServiceWorld,
    process: NativeExecutionProcessIdentity): Promise<StorageBinding> {
    return transaction(this.pool, async (client) => {
      await requireActiveAccount(client, world.userId, 'update')
      const binding = await this.checkInTransaction(client, token, world, 'process-lifecycle')
      const found = await client.query<{ state: string; request_digest: string; stop_evidence: unknown }>(
        `SELECT state,request_digest,stop_evidence FROM pe_native_execution_processes WHERE id=$1 AND world_id=$2
        AND pod_name=$3 AND pod_uid=$4 AND namespace=$5 FOR UPDATE`,
        [process.id, world.worldId, process.name, process.uid, process.namespace])
      const value = found.rows[0]
      if (!value || !['running', 'stopping', 'stopped'].includes(value.state)
        || !/^[a-f0-9]{64}$/u.test(value.request_digest)) throw new PlatformError(409, 'native_process_admission_lost')
      if (value.state === 'stopped') {
        const proof = z.object({ processId: z.literal(process.id), worldId: z.literal(world.worldId),
          podUid: z.literal(process.uid), storageGeneration: z.literal(world.storageGeneration),
          permissionGeneration: z.literal(world.permissionGeneration), status: z.string(), observation: z.unknown() })
          .loose().safeParse(value.stop_evidence)
        if (!proof.success || kubernetesPodStopStatus(proof.data.observation) !== proof.data.status) {
          throw new PlatformError(409, 'native_process_admission_lost')
        }
      }
      await this.checkInTransaction(client, token, world, 'process-lifecycle')
      return binding
    })
  }

  /** Preserve native edit coordination only for aliases of the exact same physical path.
   * @param token Original service bearer.
   * @param world Original immutable service world.
   * @param path Canonical guest path.
   * @param apply Original single non-replayed mutation.
   * @returns Native edit result after its exact worker has stopped.
   */
  async mutate<T>(token: string, world: NativeExecutionServiceWorld, path: string, apply: () => Promise<T>): Promise<T> {
    const binding = await this.assert(token, world)
    return mutateNativeExecutionPath(this.pool, world, binding, path, apply)
  }

  /** Verify only the original service and world bearer after revocation for exact cleanup.
   * @param token Original service bearer.
   * @param world Original complete service world.
   */
  async assertOwnership(token: string, world: NativeExecutionServiceWorld): Promise<void> {
    const found = await this.pool.query(`SELECT w.id FROM pe_native_execution_worlds w
      JOIN pe_native_execution_services s ON s.id=w.service_id WHERE w.id=$1 AND s.id=$2 AND s.user_id=$3
      AND s.session_id=$4 AND s.workspace_id=$5 AND s.authority_kind=$6 AND s.authority_epoch=$7
      AND w.storage_generation=$8 AND w.permission_generation=$9 AND w.mode=$10
      AND s.grant_digest=$11 AND w.grant_digest=$11`, [world.worldId, world.serviceId, world.userId, world.sessionId,
      world.workspaceId, world.authorityKind, world.serviceEpoch, world.storageGeneration,
      world.permissionGeneration, world.mode, digest(token)])
    if (found.rowCount !== 1) throw new PlatformError(409, 'native_service_authority_lost')
  }

  /** Revoke this exact service without granting replacement or declaring its processes stopped.
   * @param token Original service bearer retained by trusted cleanup code.
   * @param world Exact original service world.
   */
  async revoke(token: string, world: NativeExecutionServiceWorld): Promise<void> {
    await this.assertOwnership(token, world)
    await this.pool.query(`UPDATE pe_native_execution_services SET revoked_at=COALESCE(revoked_at,clock_timestamp()),
      updated_at=clock_timestamp() WHERE id=$1 AND grant_digest=$2`, [world.serviceId, digest(token)])
  }
}
