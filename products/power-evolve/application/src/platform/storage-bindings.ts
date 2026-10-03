/** Platform-owned storage selection and durable binding recovery API. */
import { z } from 'zod'
import { randomUUID } from 'node:crypto'
import type { Pool, PoolClient } from 'pg'
import type { Identity } from '../contracts.ts'
import { PlatformError } from '../contracts.ts'
import { storageSpacesView, storageDirectoryView, workspaceBindingsMissingView,
  storageDirectoriesRequest, storageDirectoriesView, storageDirectoryCreateRequest,
  workspaceBindingRestoreRequest, workspaceBindingStatusRequest, workspaceBindingReceipt,
  workspaceStorageTarget, storageRelativePath,
  type WorkspaceStorageTarget,
  type
  WorkspaceBindingReceipt, WorkspaceBindingRestoreRequest, StorageDirectoriesRequest,
  StorageDirectoriesView, StorageDirectoryCreateRequest } from '@power-evolve/contracts/workspace-binding'
import { storageBinding, recoveryStopTarget, recoveryStopProof, workspaceRecoveryClaim,
  type StorageBinding, type RecoveryStopTarget, type StopWorkspaceWriter } from './workspace-binding-types.ts'
import { transaction } from './database.ts'
import { assertCloudResolutionCleanup } from './cloud-execution-resolution-ownership.ts'
import { requireActiveAccount, requireBrowserAccount, lockAccountAuthorities } from './account-authority.ts'
import { accountUserId } from '../account-contracts.ts'
import type { SafePosix, StoragePath } from './safe-posix.ts'

/** Deployment-owned identity and lease duration for one recovery poll. */
export interface StorageBindingWorker { ownerId: string; leaseMs: number }

/** Browser operations return only owner-scoped identities and canonical relative directories. */
export interface StorageBindingApi {
  /** List private roots, lazily initializing only the explicitly provisioning personal root. */
  spaces(user: Identity): Promise<z.infer<typeof storageSpacesView>>
  /** List a bounded immediate directory page through retained descriptors. */
  directories(user: Identity, request: StorageDirectoriesRequest): Promise<StorageDirectoriesView>
  /** Persist directory intent under current browser authority; accepted mkdir continues independently of that bearer.
   * @param user Initially authenticated browser identity.
   * @param request Stable intent and directory target.
   * @param credentialToken Agent bearer rechecked under the account lock before acceptance.
   * @returns The created or reconciled directory.
   */
  createDirectory(user: Identity, request: StorageDirectoryCreateRequest, credentialToken: string): Promise<z.infer<typeof storageDirectoryView>>
  /** List existing unavailable bindings without creating replacement directories. */
  missing(user: Identity): Promise<z.infer<typeof workspaceBindingsMissingView>>
  /** Capture and fence the writer under current browser authority; workers continue the durable request independently.
   * @param user Initially authenticated browser identity.
   * @param request Stable recovery target and expected generation.
   * @param credentialToken Agent bearer rechecked under the account lock before acceptance or retry.
   * @returns The durable recovery receipt.
   */
  restore(user: Identity, request: WorkspaceBindingRestoreRequest, credentialToken: string): Promise<WorkspaceBindingReceipt>
  /** Read the accepted owner's durable recovery receipt. */
  status(user: Identity, request: { requestId: string }): Promise<WorkspaceBindingReceipt>
  /** Claim at most one recovery; infrastructure cleanup uses only the captured stop target. */
  poll(stopWriter: StopWorkspaceWriter, signal: AbortSignal, worker: StorageBindingWorker): Promise<boolean>
}

interface SpaceRow { id: string; user_id: string; root_key: string; title: string; is_default: boolean; root_state: string }
interface BindingRow {
  id: string; user_id: string; title: string; binding_generation: string; binding_state: string;
  recovery_request_id: string | null; create_storage_target: unknown;
  space_id: string | null; root_relative_path: string | null; root_key: string | null; root_state: string | null
}
interface RequestRow {
  user_id: string; request_id: string; workspace_id: string; space_id: string; root_relative_path: string;
  expected_generation: string; state: 'accepted' | 'stopping' | 'completed' | 'blocked';
  stop_target: unknown; stop_proof: unknown; lease_owner: string | null; lease_epoch: string;
  error_code: string | null; result: unknown
}
interface DirectoryRow { space_id: string; parent_path: string; name: string; state: string; result: unknown }
const cursorRecord = z.object({ spaceId: z.uuid(), parentPath: storageRelativePath,
  after: z.string().min(1).max(100) }).strict()
const workerRecord = z.object({ ownerId: z.uuid(), leaseMs: z.number().int().positive().max(300_000) }).strict()
const split = (path: string): string[] => path === '' ? [] : path.split('/')
function unavailable(): PlatformError { return new PlatformError(503, 'workspace_unavailable') }
function overlap(left: string, right: string): boolean {
  return left === right || left === '' || right === '' || left.startsWith(`${right}/`) || right.startsWith(`${left}/`)
}
function parsed<T>(schema: z.ZodType<T>, value: unknown): T {
  const result = schema.safeParse(value)
  if (!result.success) throw new PlatformError(400, 'invalid_request')
  return result.data
}
function receipt(row: RequestRow): WorkspaceBindingReceipt {
  const value = workspaceBindingReceipt.safeParse(row.state === 'completed' ? row.result : {
    requestId: row.request_id, workspaceId: row.workspace_id, state: row.state,
    expectedGeneration: Number(row.expected_generation), bindingGeneration: null, errorCode: row.error_code,
  })
  if (!value.success || value.data.requestId !== row.request_id || value.data.workspaceId !== row.workspace_id
    || value.data.expectedGeneration !== Number(row.expected_generation)) throw unavailable()
  return value.data
}

/** Owns registered roots, initial directory intent and generation-fenced recovery. */
export class StorageBindingService implements StorageBindingApi {
  constructor(private readonly pool: Pool, private readonly safe: SafePosix) {}

  private async owned(client: PoolClient, userId: string, workspaceId: string): Promise<BindingRow> {
    const value = await client.query<BindingRow>(`SELECT w.*,b.space_id,b.root_relative_path,s.root_key,s.root_state
      FROM pe_workspaces w LEFT JOIN pe_workspace_bindings b ON b.workspace_id=w.id AND b.user_id=w.user_id
      LEFT JOIN pe_storage_spaces s ON s.id=b.space_id AND s.user_id=w.user_id
      WHERE w.id=$1 AND w.user_id=$2 FOR UPDATE OF w`, [workspaceId, userId])
    if (!value.rows[0]) throw new PlatformError(404, 'workspace_not_found')
    return value.rows[0]
  }

  private async space(client: PoolClient, userId: string, spaceId: string): Promise<SpaceRow> {
    const value = await client.query<SpaceRow>('SELECT * FROM pe_storage_spaces WHERE id=$1 AND user_id=$2 FOR UPDATE',
      [spaceId, userId])
    if (!value.rows[0]) throw new PlatformError(404, 'storage_space_not_found')
    return value.rows[0]
  }

  private location(space: SpaceRow, path = ''): StoragePath {
    return { rootKey: storageBinding.shape.rootKey.parse(space.root_key), rootRelativePath: storageRelativePath.parse(path) }
  }

  private async present(location: StoragePath): Promise<boolean> {
    try { return await this.safe.probeDirectory(location) }
    catch (error) { if (error instanceof PlatformError && [400, 404, 503].includes(error.status)) return false; throw error }
  }

  private binding(row: BindingRow): StorageBinding {
    const value = storageBinding.safeParse({ workspaceId: row.id, spaceId: row.space_id, rootKey: row.root_key,
      rootRelativePath: row.root_relative_path, generation: Number(row.binding_generation) })
    if (!value.success) throw unavailable()
    return value.data
  }

  private async personal(client: PoolClient, userId: string): Promise<SpaceRow> {
    const id = randomUUID()
    await client.query(`INSERT INTO pe_storage_spaces(id,user_id,root_key,title,is_default,root_state)
      VALUES($1,$2,$1,'Personal storage',true,'provisioning') ON CONFLICT(user_id) WHERE is_default DO NOTHING`, [id, userId])
    const value = await client.query<SpaceRow>('SELECT * FROM pe_storage_spaces WHERE user_id=$1 AND is_default FOR UPDATE', [userId])
    return value.rows[0]!
  }

  private async initializeSpace(client: PoolClient, space: SpaceRow): Promise<void> {
    if (space.root_state !== 'provisioning') return
    await this.safe.ensureWorkspace(space.root_key)
    await client.query("UPDATE pe_storage_spaces SET root_state='ready',updated_at=clock_timestamp() WHERE id=$1 AND root_state='provisioning'", [space.id])
    space.root_state = 'ready'
  }

  private async noOverlap(client: PoolClient, workspaceId: string, target: WorkspaceStorageTarget): Promise<void> {
    const others = await client.query<{ root_relative_path: string }>(`SELECT root_relative_path FROM pe_workspace_bindings
      WHERE space_id=$1 AND workspace_id<>$2 UNION ALL
      SELECT r.root_relative_path FROM pe_workspace_binding_requests r JOIN pe_workspaces w
      ON w.id=r.workspace_id AND w.recovery_request_id=r.request_id
      WHERE r.space_id=$1 AND r.workspace_id<>$2 AND r.state IN ('accepted','stopping','blocked')`, [target.spaceId, workspaceId])
    if (others.rows.some(row => overlap(row.root_relative_path, target.rootRelativePath))) {
      throw new PlatformError(409, 'workspace_storage_overlap')
    }
  }

  /**
   * Save the initial target before any provisioning filesystem operation.
   * @param client Transaction holding the account update lock.
   * @param user Authenticated owner.
   * @param workspaceId Accepted new Workspace identity.
   * @param target Optional existing owned directory; omission selects a private new directory.
   */
  async attachInitial(client: PoolClient, user: Identity, workspaceId: string, target?: WorkspaceStorageTarget): Promise<void> {
    const selected = target === undefined
      ? workspaceStorageTarget.parse({ spaceId: (await this.personal(client, user.userId)).id, rootRelativePath: workspaceId })
      : workspaceStorageTarget.parse(target)
    const space = await this.space(client, user.userId, selected.spaceId)
    if (target !== undefined && (space.root_state !== 'ready' || !await this.present(this.location(space, selected.rootRelativePath)))) {
      throw unavailable()
    }
    await this.noOverlap(client, workspaceId, selected)
    await client.query('INSERT INTO pe_workspace_bindings(workspace_id,user_id,space_id,root_relative_path) VALUES($1,$2,$3,$4)',
      [workspaceId, user.userId, selected.spaceId, selected.rootRelativePath])
  }

  /**
   * Resolve owned storage; only persisted provisioning may create an initial root.
   * @param userId Authenticated owner identity.
   * @param workspaceId Stable owned Workspace identity.
   * @param client Optional caller transaction holding the account update lock.
   * @returns Validated current storage identity; unavailable bindings reject.
   */
  async resolve(userId: string, workspaceId: string, client?: PoolClient): Promise<StorageBinding> {
    if (!client) return transaction(this.pool, async current => {
      await requireActiveAccount(current, accountUserId.parse(userId), 'update')
      return this.resolve(userId, workspaceId, current)
    })
    let row = await this.owned(client, userId, workspaceId)
    if (row.binding_state === 'provisioning') {
      if (row.space_id === null) {
        if (row.create_storage_target !== null) throw unavailable()
        await client.query(`INSERT INTO pe_storage_spaces(id,user_id,root_key,title,is_default,root_state)
          VALUES($1,$2,$1,$3,false,'provisioning') ON CONFLICT(id) DO NOTHING`, [workspaceId, userId, row.title])
        await this.space(client, userId, workspaceId)
        await client.query("INSERT INTO pe_workspace_bindings(workspace_id,user_id,space_id,root_relative_path) VALUES($1,$2,$1,'')", [workspaceId, userId])
        row = await this.owned(client, userId, workspaceId)
      }
      const space = await this.space(client, userId, row.space_id!)
      await this.initializeSpace(client, space)
      const target = workspaceStorageTarget.parse({ spaceId: row.space_id, rootRelativePath: row.root_relative_path })
      await this.noOverlap(client, workspaceId, target)
      const location = this.location(space, target.rootRelativePath)
      if (!await this.present(location)) {
        if (row.create_storage_target !== null || target.rootRelativePath !== workspaceId) throw unavailable()
        await this.safe.createDirectory(this.location(space), [], workspaceId)
      }
      await client.query("UPDATE pe_workspaces SET binding_state='ready',binding_updated_at=GREATEST(clock_timestamp(),binding_updated_at+interval '1 millisecond') WHERE id=$1 AND binding_state='provisioning'", [workspaceId])
      row = await this.owned(client, userId, workspaceId)
    }
    if (row.binding_state !== 'ready' || row.root_state !== 'ready') throw unavailable()
    const binding = this.binding(row)
    if (!await this.present(binding)) throw unavailable()
    return binding
  }

  /** List metadata; a missing ready root remains unavailable and is never recreated. */
  async spaces(user: Identity): Promise<z.infer<typeof storageSpacesView>> {
    await transaction(this.pool, async client => {
      await requireActiveAccount(client, user.userId, 'update')
      await this.personal(client, user.userId)
    })
    return transaction(this.pool, async client => {
      await requireActiveAccount(client, user.userId, 'update')
      const personal = await this.personal(client, user.userId)
      await this.initializeSpace(client, personal)
      const spaces = await client.query<SpaceRow>('SELECT * FROM pe_storage_spaces WHERE user_id=$1 ORDER BY is_default DESC,created_at,id LIMIT 201', [user.userId])
      if (spaces.rows.length > 200) throw new PlatformError(413, 'storage_space_limit')
      const items = []
      for (const space of spaces.rows) items.push({ spaceId: space.id, title: space.title, isDefault: space.is_default,
        available: space.root_state === 'ready' && await this.present(this.location(space)) })
      return storageSpacesView.parse({ items })
    })
  }

  /** List an authorized directory page; the cursor is only an owner-checked position. */
  async directories(user: Identity, request: StorageDirectoriesRequest): Promise<StorageDirectoriesView> {
    const input = parsed(storageDirectoriesRequest, request)
    let after: string | undefined
    if (input.cursor !== undefined) {
      let value
      try { value = cursorRecord.parse(JSON.parse(Buffer.from(input.cursor, 'base64url').toString('utf8'))) }
      catch (_invalidCursor) { throw new PlatformError(400, 'invalid_storage_cursor') }
      if (value.spaceId !== input.spaceId || value.parentPath !== input.parentPath) throw new PlatformError(400, 'invalid_storage_cursor')
      after = value.after
    }
    return transaction(this.pool, async client => {
      await requireActiveAccount(client, user.userId, 'update')
      const space = await this.space(client, user.userId, input.spaceId)
      if (space.root_state !== 'ready' || !await this.present(this.location(space))) throw unavailable()
      const page = await this.safe.directories(this.location(space), split(input.parentPath), input.limit, after)
      const entries = page.names.flatMap(name => {
        const value = storageDirectoryView.safeParse({ name, path: [input.parentPath, name].filter(Boolean).join('/') })
        return value.success ? [value.data] : []
      })
      const last = page.names.at(-1)
      return storageDirectoriesView.parse({ spaceId: input.spaceId, parentPath: input.parentPath, entries,
        ...(page.more && last !== undefined ? { nextCursor: Buffer.from(JSON.stringify({ spaceId: input.spaceId,
          parentPath: input.parentPath, after: last })).toString('base64url') } : {}) })
    })
  }

  private async noWriter(client: PoolClient, userId: string): Promise<string> {
    const slot = await client.query<{ state: string; generation: string }>('SELECT state,generation FROM pe_mount_slots WHERE user_id=$1 FOR UPDATE', [userId])
    const instance = await client.query("SELECT session_id FROM pe_sandbox_instances WHERE user_id=$1 AND state<>'deleted' FOR UPDATE", [userId])
    if (slot.rows[0] && slot.rows[0].state !== 'free' || instance.rowCount) throw new PlatformError(409, 'workspace_busy')
    return slot.rows[0]?.generation ?? '0'
  }

  /** A durable mkdir intent permits reconciliation of an already-created directory after a lost response. */
  async createDirectory(user: Identity, request: StorageDirectoryCreateRequest, credentialToken: string): Promise<z.infer<typeof storageDirectoryView>> {
    const input = parsed(storageDirectoryCreateRequest, request)
    const path = storageRelativePath.parse([input.parentPath, input.name].filter(Boolean).join('/'))
    await transaction(this.pool, async client => {
      const actor = await requireBrowserAccount(client, credentialToken, { audience: 'agent', lock: 'update' })
      if (actor.userId !== user.userId) throw new PlatformError(401, 'unauthorized')
      const prior = await client.query<DirectoryRow>('SELECT * FROM pe_storage_directory_requests WHERE user_id=$1 AND request_id=$2', [user.userId, input.requestId])
      if (prior.rows[0]) {
        if (prior.rows[0].space_id !== input.spaceId || prior.rows[0].parent_path !== input.parentPath || prior.rows[0].name !== input.name) {
          throw new PlatformError(409, 'request_id_conflict')
        }
        return
      }
      await this.noWriter(client, user.userId)
      const space = await this.space(client, user.userId, input.spaceId)
      if (space.root_state !== 'ready' || !await this.present(this.location(space, input.parentPath))) throw unavailable()
      if (await this.present(this.location(space, path))) throw new PlatformError(409, 'storage_directory_exists')
      await client.query("INSERT INTO pe_storage_directory_requests(user_id,request_id,space_id,parent_path,name,state) VALUES($1,$2,$3,$4,$5,'accepted')",
        [user.userId, input.requestId, input.spaceId, input.parentPath, input.name])
    })
    return transaction(this.pool, async client => {
      await requireActiveAccount(client, user.userId, 'update')
      const selected = await client.query<DirectoryRow>('SELECT * FROM pe_storage_directory_requests WHERE user_id=$1 AND request_id=$2 FOR UPDATE', [user.userId, input.requestId])
      const row = selected.rows[0]!
      if (row.state === 'completed') return storageDirectoryView.parse(row.result)
      await this.noWriter(client, user.userId)
      const space = await this.space(client, user.userId, input.spaceId)
      if (space.root_state !== 'ready' || !await this.present(this.location(space, input.parentPath))) throw unavailable()
      await this.safe.createDirectory(this.location(space), split(input.parentPath), input.name)
      const result = storageDirectoryView.parse({ name: input.name, path })
      await client.query("UPDATE pe_storage_directory_requests SET state='completed',result=$3,updated_at=clock_timestamp() WHERE user_id=$1 AND request_id=$2", [user.userId, input.requestId, result])
      return result
    })
  }

  /** Persist missing state for previously usable bindings; only recovering/blocked exposes a current request. */
  async missing(user: Identity): Promise<z.infer<typeof workspaceBindingsMissingView>> {
    return transaction(this.pool, async client => {
      await requireActiveAccount(client, user.userId, 'update')
      const ids = await client.query<{ id: string }>('SELECT id FROM pe_workspaces WHERE user_id=$1 ORDER BY created_at,id LIMIT 201', [user.userId])
      if (ids.rows.length > 200) throw new PlatformError(413, 'workspace_limit')
      const items = []
      for (const { id } of ids.rows) {
        const row = await this.owned(client, user.userId, id)
        if (row.binding_state === 'provisioning') continue
        if (row.binding_state === 'ready' && (row.space_id === null || row.root_state !== 'ready' || !await this.present(this.binding(row)))) {
          await client.query("UPDATE pe_workspaces SET binding_state='missing',binding_updated_at=GREATEST(clock_timestamp(),binding_updated_at+interval '1 millisecond') WHERE id=$1 AND binding_state='ready'", [id])
          row.binding_state = 'missing'
        }
        if (row.binding_state === 'ready') continue
        const target = workspaceStorageTarget.safeParse({ spaceId: row.space_id, rootRelativePath: row.root_relative_path })
        items.push({ workspaceId: row.id, title: row.title, generation: Number(row.binding_generation),
          state: row.binding_state,
          recoveryRequestId: row.binding_state === 'recovering' || row.binding_state === 'blocked'
            ? row.recovery_request_id : null, target: target.success ? target.data : null })
      }
      return workspaceBindingsMissingView.parse({ items })
    })
  }

  private async captureStop(client: PoolClient, userId: string): Promise<RecoveryStopTarget> {
    await assertCloudResolutionCleanup(client, userId)
    const active = await client.query(`SELECT id FROM pe_cloud_executions WHERE user_id=$1
      AND state IN ('queued','starting','running','cancelling','uncertain') LIMIT 1`, [userId])
    if (active.rowCount) throw new PlatformError(409, 'workspace_execution_active')
    const slots = await client.query<{ state: string; generation: string; session_id: string | null;
      pod_uid: string | null; runner_instance_id: string | null }>('SELECT * FROM pe_mount_slots WHERE user_id=$1 FOR UPDATE', [userId])
    const slot = slots.rows[0]
    const instances = await client.query<{ state: string; session_id: string; pod_uid: string | null;
      runner_instance_id: string | null }>("SELECT * FROM pe_sandbox_instances WHERE user_id=$1 AND state<>'deleted' FOR UPDATE", [userId])
    if (!slot || slot.state === 'free') {
      if (instances.rowCount) throw new PlatformError(409, 'workspace_writer_unconfirmed')
      return recoveryStopTarget.parse({ kind: 'no_writer', mountGeneration: slot?.generation ?? '0' })
    }
    if (!['ready', 'stopping'].includes(slot.state) || !slot.session_id || !slot.pod_uid || !slot.runner_instance_id) {
      throw new PlatformError(409, 'workspace_writer_unconfirmed')
    }
    if (instances.rows.length !== 1 || instances.rows[0]!.session_id !== slot.session_id
      || instances.rows[0]!.pod_uid !== slot.pod_uid || instances.rows[0]!.runner_instance_id !== slot.runner_instance_id
      || !['ready', 'deleting'].includes(instances.rows[0]!.state)) throw new PlatformError(409, 'workspace_writer_unconfirmed')
    return recoveryStopTarget.parse({ kind: 'pod', mountGeneration: slot.generation, sessionId: slot.session_id,
      podUid: slot.pod_uid, runnerInstanceId: slot.runner_instance_id })
  }

  /** Save a stable target and exact old writer under the owner, Workspace and mount locks. */
  async restore(user: Identity, request: WorkspaceBindingRestoreRequest, credentialToken: string): Promise<WorkspaceBindingReceipt> {
    const input = parsed(workspaceBindingRestoreRequest, request)
    return transaction(this.pool, async client => {
      const actor = await requireBrowserAccount(client, credentialToken, { audience: 'agent', lock: 'update' })
      if (actor.userId !== user.userId) throw new PlatformError(401, 'unauthorized')
      const prior = await client.query<RequestRow>('SELECT * FROM pe_workspace_binding_requests WHERE user_id=$1 AND request_id=$2', [user.userId, input.requestId])
      if (prior.rows[0]) {
        const row = prior.rows[0]
        if (row.workspace_id !== input.workspaceId || row.space_id !== input.spaceId
          || row.root_relative_path !== input.rootRelativePath || Number(row.expected_generation) !== input.expectedGeneration) {
          throw new PlatformError(409, 'request_id_conflict')
        }
        if (row.state === 'blocked') {
          const current = await this.owned(client, user.userId, input.workspaceId)
          if (current.recovery_request_id === input.requestId && current.binding_state === 'blocked'
            && Number(current.binding_generation) === input.expectedGeneration) {
            const active = await client.query(`SELECT id FROM pe_cloud_executions WHERE user_id=$1
              AND state IN ('queued','starting','running','cancelling','uncertain') LIMIT 1`, [user.userId])
            if (active.rowCount) throw new PlatformError(409, 'workspace_execution_active')
            const retry = await client.query<RequestRow>(`UPDATE pe_workspace_binding_requests SET state='accepted',
              error_code=NULL,lease_owner=NULL,lease_until=NULL,updated_at=clock_timestamp()
              WHERE user_id=$1 AND request_id=$2 RETURNING *`, [user.userId, input.requestId])
            await client.query("UPDATE pe_workspaces SET binding_state='recovering',binding_updated_at=GREATEST(clock_timestamp(),binding_updated_at+interval '1 millisecond') WHERE id=$1", [input.workspaceId])
            return receipt(retry.rows[0]!)
          }
        }
        return receipt(row)
      }
      const workspace = await this.owned(client, user.userId, input.workspaceId)
      if (Number(workspace.binding_generation) !== input.expectedGeneration) throw new PlatformError(409, 'workspace_binding_changed')
      if (workspace.binding_state === 'recovering') throw new PlatformError(409, 'workspace_recovery_busy')
      const stop = await this.captureStop(client, user.userId)
      const space = await this.space(client, user.userId, input.spaceId)
      if (space.root_state !== 'ready' || !await this.present(this.location(space, input.rootRelativePath))) throw unavailable()
      await this.noOverlap(client, input.workspaceId, input)
      const inserted = await client.query<RequestRow>(`INSERT INTO pe_workspace_binding_requests(
        user_id,request_id,workspace_id,space_id,root_relative_path,expected_generation,state,stop_target)
        VALUES($1,$2,$3,$4,$5,$6,'accepted',$7) RETURNING *`,
      [user.userId, input.requestId, input.workspaceId, input.spaceId, input.rootRelativePath, input.expectedGeneration, stop])
      await client.query("UPDATE pe_workspaces SET binding_state='recovering',recovery_request_id=$2,binding_updated_at=GREATEST(clock_timestamp(),binding_updated_at+interval '1 millisecond') WHERE id=$1", [input.workspaceId, input.requestId])
      return receipt(inserted.rows[0]!)
    })
  }

  /** Query only this owner's persisted request; status never creates a writer. */
  async status(user: Identity, request: { requestId: string }): Promise<WorkspaceBindingReceipt> {
    const input = parsed(workspaceBindingStatusRequest, request)
    return transaction(this.pool, async client => {
      await requireActiveAccount(client, user.userId)
      const selected = await client.query<RequestRow>('SELECT * FROM pe_workspace_binding_requests WHERE user_id=$1 AND request_id=$2', [user.userId, input.requestId])
      if (!selected.rows[0]) throw new PlatformError(404, 'workspace_recovery_not_found')
      return receipt(selected.rows[0])
    })
  }

  private async lease(client: PoolClient, row: RequestRow, worker: StorageBindingWorker): Promise<boolean> {
    await assertCloudResolutionCleanup(client, row.user_id)
    const current = await client.query(`SELECT r.request_id FROM pe_workspace_binding_requests r JOIN pe_workspaces w
      ON w.id=r.workspace_id WHERE r.user_id=$1 AND r.request_id=$2 AND r.lease_owner=$3 AND r.lease_epoch=$4
      AND r.lease_until>clock_timestamp() AND r.state='stopping' AND w.recovery_request_id=r.request_id
      AND w.binding_state='recovering' AND w.binding_generation=r.expected_generation
      AND r.stop_target=$5::jsonb FOR UPDATE OF r`, [row.user_id, row.request_id, worker.ownerId, row.lease_epoch, JSON.stringify(row.stop_target)])
    return !!current.rowCount
  }

  /** Claim one durable intent; shutdown releases its lease and retains the captured writer, proof and Workspace fence for takeover. */
  async poll(stopWriter: StopWorkspaceWriter, signal: AbortSignal, worker: StorageBindingWorker): Promise<boolean> {
    const configuration = workerRecord.parse(worker)
    if (signal.aborted) return false
    const hint = await this.pool.query<RequestRow>(`SELECT * FROM pe_workspace_binding_requests
      WHERE state IN ('accepted','stopping') AND (lease_until IS NULL OR lease_until<=clock_timestamp())
      ORDER BY created_at,request_id LIMIT 1`)
    if (!hint.rows[0]) return false
    const row = await transaction(this.pool, async client => {
      const candidate = hint.rows[0]!
      await lockAccountAuthorities(client, [accountUserId.parse(candidate.user_id)], 'update')
      const workspace = await this.owned(client, candidate.user_id, candidate.workspace_id)
      if (workspace.recovery_request_id !== candidate.request_id || workspace.binding_state !== 'recovering'
        || workspace.binding_generation !== candidate.expected_generation) return null
      const claimed = await client.query<RequestRow>(`UPDATE pe_workspace_binding_requests SET state='stopping',
        lease_owner=$3,lease_until=clock_timestamp()+$4::double precision*interval '1 millisecond',
        lease_epoch=lease_epoch+1,updated_at=clock_timestamp()
        WHERE user_id=$1 AND request_id=$2 AND state IN ('accepted','stopping')
        AND (lease_until IS NULL OR lease_until<=clock_timestamp()) RETURNING *`,
      [candidate.user_id, candidate.request_id, configuration.ownerId, configuration.leaseMs])
      return claimed.rows[0] ?? null
    })
    if (!row) return false
    const assertLease = async (client?: PoolClient) => {
      signal.throwIfAborted()
      const renew = async (current: PoolClient) => {
        await lockAccountAuthorities(current, [accountUserId.parse(row.user_id)], 'update')
        await this.owned(current, row.user_id, row.workspace_id)
        if (!await this.lease(current, row, configuration)) throw new PlatformError(409, 'workspace_recovery_lease_lost')
        await current.query(`UPDATE pe_workspace_binding_requests SET lease_until=clock_timestamp()+$3::double precision*interval '1 millisecond'
          WHERE user_id=$1 AND request_id=$2`, [row.user_id, row.request_id, configuration.leaseMs])
      }
      if (client) await renew(client)
      else await transaction(this.pool, renew)
    }
    try {
      const claim = workspaceRecoveryClaim.parse({ userId: row.user_id, requestId: row.request_id,
        workspaceId: row.workspace_id, expectedGeneration: Number(row.expected_generation), stopTarget: row.stop_target })
      await assertLease()
      const proof = recoveryStopProof.parse(row.stop_proof !== null ? row.stop_proof : claim.stopTarget.kind === 'no_writer'
        ? await transaction(this.pool, async client => {
          await lockAccountAuthorities(client, [claim.userId], 'update')
          await this.owned(client, row.user_id, row.workspace_id)
          if (!await this.lease(client, row, configuration)) throw new PlatformError(409, 'workspace_recovery_lease_lost')
          const generation = await this.noWriter(client, row.user_id)
          if (generation !== claim.stopTarget.mountGeneration) throw new PlatformError(409, 'workspace_writer_changed')
          return { kind: 'no_writer', mountGeneration: generation }
        })
        : await stopWriter(claim, assertLease))
      if (proof.mountGeneration !== claim.stopTarget.mountGeneration
        || claim.stopTarget.kind === 'pod' && (proof.kind !== 'kubelet_stopped' || proof.podUid !== claim.stopTarget.podUid)
        || claim.stopTarget.kind === 'no_writer' && proof.kind !== 'no_writer') {
        throw new PlatformError(409, 'workspace_stop_proof_mismatch')
      }
      await assertLease()
      await transaction(this.pool, async client => {
        await lockAccountAuthorities(client, [claim.userId], 'update')
        await this.owned(client, row.user_id, row.workspace_id)
        if (!await this.lease(client, row, configuration)) throw new PlatformError(409, 'workspace_recovery_lease_lost')
        await client.query('UPDATE pe_workspace_binding_requests SET stop_proof=$3 WHERE user_id=$1 AND request_id=$2',
          [row.user_id, row.request_id, proof])
      })
      await transaction(this.pool, async client => {
        await requireActiveAccount(client, accountUserId.parse(row.user_id), 'update')
        await this.owned(client, row.user_id, row.workspace_id)
        if (!await this.lease(client, row, configuration)) throw new PlatformError(409, 'workspace_recovery_lease_lost')
        signal.throwIfAborted()
        if (await this.noWriter(client, row.user_id) !== proof.mountGeneration) throw new PlatformError(409, 'workspace_writer_changed')
        const space = await this.space(client, row.user_id, row.space_id)
        if (space.root_state !== 'ready' || !await this.present(this.location(space, row.root_relative_path))) throw unavailable()
        const target = workspaceStorageTarget.parse({ spaceId: row.space_id, rootRelativePath: row.root_relative_path })
        await this.noOverlap(client, row.workspace_id, target)
        await client.query(`INSERT INTO pe_workspace_bindings(workspace_id,user_id,space_id,root_relative_path)
          VALUES($1,$2,$3,$4) ON CONFLICT(workspace_id) DO UPDATE SET space_id=$3,root_relative_path=$4`,
        [row.workspace_id, row.user_id, row.space_id, row.root_relative_path])
        const result = workspaceBindingReceipt.parse({ requestId: row.request_id, workspaceId: row.workspace_id,
          state: 'completed', expectedGeneration: Number(row.expected_generation),
          bindingGeneration: Number(row.expected_generation) + 1, errorCode: null })
        const updated = await client.query(`UPDATE pe_workspaces SET binding_generation=binding_generation+1,
          binding_state='ready',recovery_request_id=NULL,binding_updated_at=GREATEST(clock_timestamp(),binding_updated_at+interval '1 millisecond') WHERE id=$1 AND recovery_request_id=$2
          AND binding_generation=$3 AND binding_state='recovering' RETURNING id`, [row.workspace_id, row.request_id, row.expected_generation])
        if (!updated.rowCount) throw new PlatformError(409, 'workspace_binding_changed')
        await client.query(`UPDATE pe_workspace_binding_requests SET state='completed',stop_proof=$3,result=$4,
          lease_owner=NULL,lease_until=NULL,updated_at=clock_timestamp() WHERE user_id=$1 AND request_id=$2`,
        [row.user_id, row.request_id, proof, result])
        signal.throwIfAborted()
      })
    } catch (error) {
      await transaction(this.pool, async client => {
        await lockAccountAuthorities(client, [accountUserId.parse(row.user_id)], 'update')
        await this.owned(client, row.user_id, row.workspace_id)
        if (!await this.lease(client, row, configuration)) return
        if (signal.aborted) {
          await client.query(`UPDATE pe_workspace_binding_requests SET lease_owner=NULL,lease_until=NULL,
            updated_at=clock_timestamp() WHERE user_id=$1 AND request_id=$2`, [row.user_id, row.request_id])
          return
        }
        const code = error instanceof PlatformError ? error.code : 'workspace_stop_unconfirmed'
        await client.query(`UPDATE pe_workspace_binding_requests SET state='blocked',error_code=$3,
          lease_owner=NULL,lease_until=NULL,updated_at=clock_timestamp() WHERE user_id=$1 AND request_id=$2`, [row.user_id, row.request_id, code])
        await client.query("UPDATE pe_workspaces SET binding_state='blocked',binding_updated_at=GREATEST(clock_timestamp(),binding_updated_at+interval '1 millisecond') WHERE id=$1 AND recovery_request_id=$2", [row.workspace_id, row.request_id])
      })
    }
    return true
  }
}
