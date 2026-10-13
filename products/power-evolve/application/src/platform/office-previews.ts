/** Durable native Office previews; isolated parsers never receive live Workspace or Home mounts. */
import { createHash, randomUUID } from 'node:crypto'
import { constants } from 'node:fs'
import { lstat, mkdir, open, rename, type FileHandle } from 'node:fs/promises'
import { isAbsolute, join, resolve } from 'node:path'
import type { Pool, PoolClient } from 'pg'
import { z } from 'zod'
import { accountUserId } from '@power-evolve/contracts/account'
import { officePreviewPrepareRequest, officePreviewSourcePrepareRequest, officePreviewRefRequest, officePreviewCancelRequest,
  officePreviewGenerationView, officePreviewJobView, officePreviewContentView, officePreviewJobSchema,
  officePreviewResultSchema, officePreviewFailureSchema, officePreviewErrorCode, officePreviewLimits,
  type OfficePreviewSourcePrepareRequest, type OfficePreviewRefRequest, type OfficePreviewCancelRequest,
  type OfficePreviewJobView, type OfficePreviewContentView, type OfficePreviewErrorCode } from '@power-evolve/contracts/office-preview'
import { PlatformError, type Identity } from '../contracts.ts'
import { transaction as databaseTransaction } from './database.ts'
import { lockAccountAuthorities, requireBrowserAccount } from './account-authority.ts'
import type { FileService } from './files.ts'
import type { KubernetesClient } from './kubernetes.ts'
import { storageBinding } from './cloud-storage-types.ts'
import { isSessionBusinessBlockedInTransaction } from './native-workspace-layout.ts'
import { requestOfficePreviewStopInTransaction } from './native-session-activity-stop.ts'
import { OfficePreviewPods, OfficePreviewPodBlocked, officePreviewPodIntent, officePreviewPodIdentity, officePreviewStopProof,
  officePreviewWorkerExit, type OfficePreviewPodConfig, type OfficePreviewPodObservation } from './office-preview-pod.ts'

/** This lock serializes preview slot assignment across Platform replicas, independently of Cloud execution capacity. */
const CAPACITY_LOCK = 72819536
const digest = z.string().regex(/^[a-f0-9]{64}$/u)
const podConfiguration = z.object({
  namespace: z.string(), image: z.string(), volumeClaimName: z.string(), volumeSubPath: z.string(),
  runtimeClassName: z.string().optional(),
  terminationGraceSeconds: z.number().int().nonnegative(), cpuMilliCores: z.number().int().positive(),
  memoryMiB: z.number().int().positive(), temporaryMiB: z.number().int().positive(), safetyVersion: z.union([z.literal(1), z.literal(2)]),
}).strict().refine(value => value.safetyVersion === 1 ? value.runtimeClassName === undefined : value.runtimeClassName !== undefined)
const converter = z.object({ protocolVersion: z.literal(1), kitVersion: z.literal('0.1.1'),
  fontPolicyDigest: digest, limits: officePreviewLimits, pod: podConfiguration }).strict()
const workerObservation = z.object({ exit: officePreviewWorkerExit,
  failure: officePreviewFailureSchema.nullable(), errorCode: officePreviewErrorCode.nullable() }).strict()
const notSubmittedProof = z.object({ status: z.literal('NOT_SUBMITTED'), jobId: officePreviewJobSchema.shape.jobId,
  nonce: officePreviewJobSchema.shape.nonce, generation: officePreviewJobSchema.shape.generation,
  intentDigest: digest, observedAt: z.iso.datetime() }).strict()
const stopProof = z.union([officePreviewStopProof, notSubmittedProof])
const rowSchema = z.object({
  id: officePreviewJobSchema.shape.jobId, user_id: accountUserId,
  request_id: officePreviewPrepareRequest.shape.requestId, generation: officePreviewJobSchema.shape.generation,
  request_digest: digest.nullable(), request: officePreviewSourcePrepareRequest.nullable(),
  session_id: officePreviewPrepareRequest.shape.sessionId.nullable(), workspace_id: z.uuid().nullable(),
  binding_snapshot: storageBinding.nullable(),
  source_snapshot: officePreviewJobSchema.nullable(), converter_snapshot: converter.nullable(),
  state: officePreviewJobView.shape.state, cancel_requested: z.boolean(), error_code: officePreviewErrorCode.nullable(),
  deadline_at: z.date().nullable(), lease_owner: z.uuid().nullable(), lease_epoch: z.number().int().nonnegative(),
  lease_until: z.date().nullable(), attempts: z.number().int().nonnegative(), parser_slot: z.number().int().nonnegative().nullable(),
  creation_intent: officePreviewPodIntent.nullable(), pod_identity: officePreviewPodIdentity.nullable(),
  worker_observation: workerObservation.nullable(), stop_evidence: stopProof.nullable(),
  result: officePreviewResultSchema.nullable(), created_at: z.date(), updated_at: z.date(), completed_at: z.date().nullable(),
}).strict()
type Row = z.infer<typeof rowSchema>
const terminal = new Set<Row['state']>(['succeeded', 'failed', 'cancelled'])

/** Validated deployment budgets; values are copied and frozen when the service is constructed. */
export interface OfficePreviewConfig extends OfficePreviewPodConfig {
  readonly localRoot: string
  readonly fontPolicyDigest: string
  readonly limits: z.infer<typeof officePreviewLimits>
  readonly maxConcurrentParsers: number
  readonly maxRetainedJobsPerUser: number
  readonly leaseMs: number
  readonly jobDeadlineMs: number
}
type PreviewFiles = Pick<FileService, 'bindingForId' | 'readInWorkspace'>
class LeaseLost extends Error {}
function sha(bytes: Uint8Array): string { return createHash('sha256').update(bytes).digest('hex') }
function canonical(value: unknown): string {
  if (Array.isArray(value)) return `[${value.map(canonical).join(',')}]`
  if (value && typeof value === 'object') return `{${Object.keys(value).sort().map(key =>
    `${JSON.stringify(key)}:${canonical(Reflect.get(value, key))}`).join(',')}}`
  return JSON.stringify(value)
}
function hash(value: object): string { return sha(Buffer.from(canonical(value))) }
function error(reason: OfficePreviewErrorCode, status = 503): PlatformError {
  return new PlatformError(status, `office_render_${reason}`)
}
function required<T>(value: T | null | undefined): T {
  if (value === null || value === undefined) throw error('unavailable')
  return value
}
async function transaction<T>(pool: Pool, action: (client: PoolClient) => Promise<T>): Promise<T> {
  try { return await databaseTransaction(pool, action) }
  catch (cause) { if (cause instanceof PlatformError || cause instanceof LeaseLost) throw cause; throw error('unavailable') }
}
function equal(a: object, b: object): boolean { return canonical(a) === canonical(b) }
function validatedRow(value: unknown): Row {
  const parsed = rowSchema.safeParse(value)
  if (!parsed.success) throw error('unavailable')
  const row = parsed.data
  if (row.request_digest === null) {
    if (row.state !== 'cancelled' || !row.cancel_requested || row.request !== null || row.session_id !== null
      || row.workspace_id !== null || row.binding_snapshot !== null || row.source_snapshot !== null
      || row.converter_snapshot !== null || row.creation_intent !== null || row.pod_identity !== null
      || row.worker_observation !== null || row.stop_evidence !== null || row.result !== null
      || row.parser_slot !== null || row.lease_owner !== null || row.deadline_at !== null) throw error('unavailable')
    return row
  }
  const source = row.source_snapshot, request = row.request, conversion = row.converter_snapshot
  if (!source || !request || !conversion || !row.binding_snapshot || !row.workspace_id || !row.session_id || !row.deadline_at
    || hash(request) !== row.request_digest || request.requestId !== row.request_id || request.sessionId !== row.session_id
    || request.generation !== row.generation || row.binding_snapshot.workspaceId !== row.workspace_id
    || source.jobId !== row.id || source.generation !== row.generation || hash(conversion) !== row.generation
    || !equal(source.limits, conversion.limits)) throw error('unavailable')

  const intent = row.creation_intent
  if (intent && (intent.userId !== row.user_id || !equal(intent.job, source)
    || intent.template.spec.containers[0].image !== conversion.pod.image
    || intent.template.spec.runtimeClassName !== conversion.pod.runtimeClassName)) throw error('unavailable')
  if (row.pod_identity && (!intent || row.pod_identity.name !== intent.template.metadata.name)) throw error('unavailable')
  if (row.stop_evidence) {
    if (!intent || row.stop_evidence.jobId !== row.id || row.stop_evidence.nonce !== source.nonce
      || row.stop_evidence.generation !== row.generation) throw error('unavailable')
    if (row.stop_evidence.status === 'NOT_SUBMITTED') {
      if (intent.submittedAt !== null || row.pod_identity !== null || row.stop_evidence.intentDigest !== intent.templateDigest
        || row.state === 'succeeded') throw error('unavailable')
    } else if (!row.pod_identity || !equal(row.stop_evidence.identity, row.pod_identity)) throw error('unavailable')
  }
  if (row.result && (row.result.jobId !== row.id || row.result.nonce !== source.nonce
    || row.result.generation !== row.generation || row.result.sourceSha256 !== source.sourceSha256)) throw error('unavailable')
  return row
}

/** Platform-owned preview admission, cancellation, reconciliation and authorized PDF delivery. */
export class OfficePreviewService {
  private readonly config: OfficePreviewConfig
  private readonly conversion: z.infer<typeof converter>
  private readonly providerGeneration: z.infer<typeof officePreviewGenerationView>['generation']
  private readonly pods: OfficePreviewPods
  private readonly ownerId = randomUUID()
  private readonly root: string
  private readonly stopped = new AbortController()
  private pending: Promise<void> | null = null
  private rootReady: Promise<void> | null = null

  constructor(private readonly pool: Pool, private readonly files: PreviewFiles,
    kube: Pick<KubernetesClient, 'call' | 'resourcePath'>, config: OfficePreviewConfig) {
    if (!isAbsolute(config.localRoot)) throw new Error('Office preview root must be absolute')
    this.config = Object.freeze({ ...config, limits: Object.freeze({ ...config.limits }) })
    this.root = resolve(config.localRoot)
    this.conversion = converter.parse({ protocolVersion: 1, kitVersion: '0.1.1', fontPolicyDigest: config.fontPolicyDigest,
      limits: config.limits, pod: { namespace: config.namespace, image: config.image, volumeClaimName: config.volumeClaimName,
        runtimeClassName: config.runtimeClassName,
        volumeSubPath: config.volumeSubPath, terminationGraceSeconds: config.terminationGraceSeconds,
        cpuMilliCores: config.cpuMilliCores, memoryMiB: config.memoryMiB, temporaryMiB: config.temporaryMiB, safetyVersion: 2 } })
    this.providerGeneration = officePreviewGenerationView.parse({ generation: hash(this.conversion) }).generation
    this.pods = new OfficePreviewPods(kube, this.config)
  }

  /**
   * Return the fixed converter generation after validating the current Agent browser credential.
   * @param token Original request bearer; no token is retained by the service.
   * @returns Identical configuration digests for identically configured Platform replicas.
   */
  async generation(token: string): Promise<z.infer<typeof officePreviewGenerationView>> {
    return transaction(this.pool, async (client) => {
      await requireBrowserAccount(client, token, { lock: 'update' })
      return { generation: this.providerGeneration }
    })
  }

  /**
   * Accept one immutable source snapshot, or return the owner's original admission or early cancellation.
   * @param token Current Agent browser credential, rechecked inside acceptance.
   * @param input Stable native RPC key, original owned Session, Workspace path or exact immutable Artifact, priority and fixed generation.
   * @returns Durable job view; key conflicts, quota, changed authority or unsafe source reads reject.
   */
  async prepare(token: string, input: OfficePreviewSourcePrepareRequest): Promise<OfficePreviewJobView> {
    const request = officePreviewSourcePrepareRequest.parse(input)
    return transaction(this.pool, async (client) => {
      const user = await requireBrowserAccount(client, token, { lock: 'update' })
      const prior = await this.byKey(client, user.userId, request.requestId)
      if (prior) {
        this.matchGeneration(prior, request.generation)
        if (prior.request_digest !== null && prior.request_digest !== hash(request)) throw new PlatformError(409, 'request_id_conflict')
        return this.view(prior)
      }
      this.currentGeneration(request.generation)
      await this.budget(client, user.userId)
      const session = (await client.query<{ workspace_id: string }>(
        'SELECT workspace_id FROM pe_sessions WHERE id=$1 AND user_id=$2 FOR UPDATE', [request.sessionId, user.userId])).rows[0]
      if (!session) throw new PlatformError(404, 'session_not_found')
      if (await isSessionBusinessBlockedInTransaction(client, user.userId, request.sessionId)) {
        throw new PlatformError(409, 'native_session_archived')
      }
      const binding = await this.files.bindingForId(user.userId, session.workspace_id, client)
      const source = await this.files.readInWorkspace(user, session.workspace_id, request.path, client)
      const bytes = Buffer.from(source.data, 'base64'), sourceSha256 = source.revision, filename = request.path
      if (bytes.length !== source.size || sha(bytes) !== source.revision) throw error('source-changed', 409)

      const extension = filename.slice(filename.lastIndexOf('.') + 1).toLowerCase()
      if (!['doc', 'docx', 'ppt', 'pptx'].includes(extension)) throw error('unsupported-format', 400)
      if (bytes.length > this.config.limits.inputBytes) throw error('input-too-large', 413)
      const job = officePreviewJobSchema.parse({ protocolVersion: 1, jobId: randomUUID(), nonce: randomUUID(),
        generation: this.providerGeneration, sourceSha256, sourceBytes: bytes.length, extension, limits: this.conversion.limits })
      await this.writeInput(job, bytes)
      const inserted = await client.query(`INSERT INTO pe_office_preview_jobs(id,user_id,request_id,generation,
        request_digest,request,session_id,workspace_id,binding_snapshot,source_snapshot,converter_snapshot,state,deadline_at)
        VALUES($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11,'queued',clock_timestamp()+$12::double precision*interval '1 millisecond') RETURNING *`,
      [job.jobId, user.userId, request.requestId, job.generation, hash(request), JSON.stringify(request), request.sessionId,
        session.workspace_id, JSON.stringify(binding), JSON.stringify(job), JSON.stringify(this.conversion), this.config.jobDeadlineMs])
      return this.view(validatedRow(inserted.rows[0]))
    })
  }

  /**
   * Read the owner's durable job; status does not create, retry or authorize a parser.
   * @param token Current Agent browser credential.
   * @param input Owner-scoped original job and generation.
   * @returns Current bounded state; foreign identities return 404.
   */
  async status(token: string, input: OfficePreviewRefRequest): Promise<OfficePreviewJobView> {
    const ref = officePreviewRefRequest.parse(input)
    return transaction(this.pool, async (client) => {
      const user = await requireBrowserAccount(client, token, { lock: 'update' })
      let row = await this.owned(client, user.userId, ref.jobId)
      this.matchGeneration(row, ref.generation)
      if (row.workspace_id) await client.query('SELECT id FROM pe_workspaces WHERE id=$1 AND user_id=$2 FOR UPDATE',
        [row.workspace_id, row.user_id])
      row = validatedRow((await client.query('SELECT * FROM pe_office_preview_jobs WHERE id=$1 AND user_id=$2 FOR UPDATE',
        [row.id, row.user_id])).rows[0])
      return this.view(row)
    })
  }

  /**
   * Persist cancellation even when prepare's response was lost or has not arrived yet.
   * @param token Current Agent credential; account revocation uses the separate trusted transaction hook.
   * @param input Original request key or job id and its frozen generation.
   * @returns Durable original or cancelled-placeholder view; existing terminal facts remain unchanged.
   */
  async cancel(token: string, input: OfficePreviewCancelRequest): Promise<OfficePreviewJobView> {
    const ref = officePreviewCancelRequest.parse(input)
    return transaction(this.pool, async (client) => {
      const user = await requireBrowserAccount(client, token, { lock: 'update' })
      let row = 'jobId' in ref ? await this.owned(client, user.userId, ref.jobId)
        : await this.byKey(client, user.userId, ref.requestId)
      if (!row) {
        if (!('requestId' in ref)) throw new PlatformError(404, 'office_preview_not_found')
        this.currentGeneration(ref.generation)
        await this.budget(client, user.userId)
        const inserted = await client.query(`INSERT INTO pe_office_preview_jobs(id,user_id,request_id,generation,state,cancel_requested,completed_at)
          VALUES($1,$2,$3,$4,'cancelled',true,clock_timestamp()) RETURNING *`, [randomUUID(), user.userId, ref.requestId, ref.generation])
        return this.view(validatedRow(inserted.rows[0]))
      }
      this.matchGeneration(row, ref.generation)
      if (row.workspace_id) await client.query('SELECT id FROM pe_workspaces WHERE id=$1 AND user_id=$2 FOR UPDATE',
        [row.workspace_id, row.user_id])
      row = validatedRow((await client.query('SELECT * FROM pe_office_preview_jobs WHERE id=$1 AND user_id=$2 FOR UPDATE',
        [row.id, row.user_id])).rows[0])
      if (!terminal.has(row.state)) {
        row = validatedRow(await requestOfficePreviewStopInTransaction(client, row))
      }
      return this.view(row)
    })
  }

  /**
   * Deliver a verified PDF only while its source identity, owner, original Session and configuration remain current.
   * Artifact snapshots ignore mutable Workspace files and storage bindings; Workspace sources retain their frozen binding checks.
   * @param token Current Agent browser credential, rechecked after filesystem reads.
   * @param input Original completed job and converter generation.
   * @returns Complete bounded PDF bytes and both source/PDF hashes; stale or revoked access rejects.
   */
  async content(token: string, input: OfficePreviewRefRequest): Promise<OfficePreviewContentView> {
    const ref = officePreviewRefRequest.parse(input)
    this.currentGeneration(ref.generation)
    return transaction(this.pool, async (client) => {
      const user = await requireBrowserAccount(client, token, { lock: 'update' })
      const row = await this.owned(client, user.userId, ref.jobId)
      this.matchGeneration(row, ref.generation)
      if (row.state !== 'succeeded' || !row.result || !row.source_snapshot || !row.request || !row.stop_evidence) throw error('unavailable', 409)
      await this.currentSource(client, user, row)
      const bytes = await this.pdf(row)
      await this.currentSource(client, user, row)
      await requireBrowserAccount(client, token, { lock: 'update' })
      const absolutePath = `/workspace/${row.request.path}`
      return officePreviewContentView.parse({ absolutePath, version: row.source_snapshot.sourceSha256,
        bytes: bytes.length, offset: 0, eof: true, data: bytes.toString('base64'), generation: row.generation,
        missingFonts: row.result.missingFonts, pdfSha256: row.result.pdfSha256 })
    })
  }

  /**
   * Reconcile one durable task; overlapping ticks in this process share the same bounded attempt.
   * @returns Resolves after this attempt settles or retains its original reservation for recovery.
   */
  async tick(): Promise<void> {
    if (this.stopped.signal.aborted) return
    if (this.pending) return this.pending
    const task = this.step().catch((cause: unknown) => {
      if (cause instanceof PlatformError) throw cause
      throw error('unavailable')
    }).finally(() => { this.pending = null })
    this.pending = task
    return task
  }

  /**
   * Stop new claims, await current I/O and retain every unconfirmed Pod reservation for another Platform.
   * @returns Resolves when this service's active tick has settled; it never fabricates a stopped Pod.
   */
  async stop(): Promise<void> { this.stopped.abort(); await this.pending }

  private currentGeneration(value: string): void {
    if (value !== this.providerGeneration) throw error('unavailable', 409)
  }
  private matchGeneration(row: Row, value: string): void {
    if (row.generation !== value) throw new PlatformError(409, 'request_id_conflict')
  }
  private view(row: Row): OfficePreviewJobView {
    return officePreviewJobView.parse({ jobId: row.id, generation: row.generation, state: row.state, errorCode: row.error_code })
  }
  private async byKey(client: PoolClient, userId: string, key: string): Promise<Row | null> {
    const found = (await client.query<Record<string, unknown>>('SELECT * FROM pe_office_preview_jobs WHERE user_id=$1 AND request_id=$2', [userId, key])).rows[0]
    return found ? validatedRow(found) : null
  }
  private async owned(client: PoolClient, userId: string, jobId: string): Promise<Row> {
    const found = (await client.query<Record<string, unknown>>('SELECT * FROM pe_office_preview_jobs WHERE user_id=$1 AND id=$2', [userId, jobId])).rows[0]
    if (!found) throw new PlatformError(404, 'office_preview_not_found')
    return validatedRow(found)
  }

  private async locked(client: PoolClient, original: Row): Promise<Row> {
    await lockAccountAuthorities(client, [original.user_id], 'update')
    if (original.workspace_id) {
      const workspace = await client.query('SELECT id FROM pe_workspaces WHERE id=$1 AND user_id=$2 FOR UPDATE',
        [original.workspace_id, original.user_id])
      if (!workspace.rowCount) throw new LeaseLost()
    }
    const found = (await client.query<Record<string, unknown>>(`SELECT * FROM pe_office_preview_jobs WHERE id=$1 AND user_id=$2
      AND lease_owner=$3 AND lease_epoch=$4 AND lease_until>clock_timestamp()
      AND state IN ('creating','running','stopping','blocked') FOR UPDATE`,
    [original.id, original.user_id, this.ownerId, original.lease_epoch])).rows[0]
    if (!found) throw new LeaseLost()
    const row = validatedRow(found)
    if (row.request_digest !== original.request_digest || row.generation !== original.generation
      || !row.source_snapshot || !original.source_snapshot || !equal(row.source_snapshot, original.source_snapshot)) throw new LeaseLost()
    if (original.creation_intent && (!row.creation_intent
      || original.creation_intent.templateDigest !== row.creation_intent.templateDigest
      || original.creation_intent.submittedAt !== null
      && row.creation_intent.submittedAt !== original.creation_intent.submittedAt)) throw new LeaseLost()
    return row
  }
  private async guard(original: Row): Promise<Row> {
    this.stopped.signal.throwIfAborted()
    return transaction(this.pool, async (client) => {
      const row = await this.locked(client, original)
      const result = await client.query(`UPDATE pe_office_preview_jobs SET lease_until=clock_timestamp()+$2::double precision*interval '1 millisecond'
        WHERE id=$1 RETURNING *`, [row.id, this.config.leaseMs])
      return validatedRow(result.rows[0])
    })
  }
  private async claim(): Promise<Row | null> {
    const hint = (await this.pool.query<Record<string, unknown>>(`SELECT * FROM pe_office_preview_jobs
      WHERE state IN ('queued','creating','running','stopping','blocked') AND (lease_until IS NULL OR lease_until<=clock_timestamp())
      AND (parser_slot IS NOT NULL OR cancel_requested OR deadline_at<=clock_timestamp()
        OR EXISTS(SELECT 1 FROM generate_series(0,$1::integer-1) AS s(slot)
          WHERE NOT EXISTS(SELECT 1 FROM pe_office_preview_jobs j WHERE j.parser_slot=s.slot)))
      ORDER BY updated_at,id LIMIT 1`, [this.config.maxConcurrentParsers])).rows[0]
    if (!hint) return null
    const candidate = validatedRow(hint)
    return transaction(this.pool, async (client) => {
      const authority = required((await lockAccountAuthorities(client, [candidate.user_id], 'update'))[0])
      if (candidate.workspace_id) await client.query('SELECT id FROM pe_workspaces WHERE id=$1 AND user_id=$2 FOR UPDATE',
        [candidate.workspace_id, candidate.user_id])
      await client.query('SELECT pg_advisory_xact_lock($1)', [CAPACITY_LOCK])
      const found = (await client.query<Record<string, unknown>>(`SELECT * FROM pe_office_preview_jobs WHERE id=$1
        AND state IN ('queued','creating','running','stopping','blocked')
        AND (lease_until IS NULL OR lease_until<=clock_timestamp()) FOR UPDATE`, [candidate.id])).rows[0]
      if (!found) return null
      const row = validatedRow(found)
      const expired = required((await client.query<{ expired: boolean }>(
        'SELECT $1::timestamptz<=clock_timestamp() AS expired', [row.deadline_at])).rows[0]).expired
      const disabled = !authority.enabled || authority.deletedAt !== null
      if (row.creation_intent === null && (row.cancel_requested || disabled || expired || row.generation !== this.providerGeneration)) {
        await client.query(`UPDATE pe_office_preview_jobs SET state=$2,cancel_requested=$3,error_code=$4,
          completed_at=clock_timestamp(),updated_at=clock_timestamp() WHERE id=$1`,
        [row.id, row.cancel_requested || disabled ? 'cancelled' : 'failed', row.cancel_requested || disabled,
          row.cancel_requested || disabled ? null : expired ? 'timeout' : 'unavailable'])
        return null
      }
      let intent = row.creation_intent, slot = row.parser_slot
      if (!intent) {
        if (!row.source_snapshot || !row.workspace_id) throw error('unavailable')
        try { await this.currentSource(client, authority, row) }
        catch (cause) {
          if (!(cause instanceof PlatformError && [400, 404, 409].includes(cause.status))) throw cause
          await client.query(`UPDATE pe_office_preview_jobs SET state='failed',error_code='source-changed',
            completed_at=clock_timestamp(),updated_at=clock_timestamp() WHERE id=$1`, [row.id])
          return null
        }
        const free = (await client.query<{ slot: number }>(`SELECT slot FROM generate_series(0,$1::integer-1) AS s(slot)
          WHERE NOT EXISTS(SELECT 1 FROM pe_office_preview_jobs j WHERE j.parser_slot=s.slot) ORDER BY slot LIMIT 1`,
        [this.config.maxConcurrentParsers])).rows[0]
        if (!free) return null
        slot = free.slot
        intent = this.pods.intent(row.source_snapshot, row.user_id)
      }
      const claimed = await client.query(`UPDATE pe_office_preview_jobs SET state=CASE WHEN state='queued' THEN 'creating'
        WHEN $2 THEN 'stopping' ELSE state END,cancel_requested=cancel_requested OR $2,
        error_code=CASE WHEN $2 THEN NULL ELSE error_code END,lease_owner=$3,lease_epoch=lease_epoch+1,
        lease_until=clock_timestamp()+$4::double precision*interval '1 millisecond',attempts=attempts+1,
        parser_slot=$5,creation_intent=$6,updated_at=clock_timestamp() WHERE id=$1 RETURNING *`,
      [row.id, disabled, this.ownerId, this.config.leaseMs, slot, JSON.stringify(intent)])
      return validatedRow(claimed.rows[0])
    })
  }
  private async budget(client: PoolClient, userId: string): Promise<void> {
    const count = required((await client.query<{ n: number }>('SELECT count(*)::integer AS n FROM pe_office_preview_jobs WHERE user_id=$1', [userId])).rows[0]).n
    if (count >= this.config.maxRetainedJobsPerUser) throw error('busy', 429)
  }
  private async currentSource(client: PoolClient, user: Identity, row: Row): Promise<void> {
    if (!row.request || !row.source_snapshot || !row.binding_snapshot || !row.workspace_id) throw error('unavailable')
    const session = await client.query<{ workspace_id: string }>('SELECT workspace_id FROM pe_sessions WHERE id=$1 AND user_id=$2', [row.session_id, row.user_id])
    if (session.rows[0]?.workspace_id !== row.workspace_id) throw new PlatformError(404, 'session_not_found')

    const binding = await this.files.bindingForId(row.user_id, row.workspace_id, client)
    if (!equal(binding, row.binding_snapshot)) throw error('source-changed', 409)
    const value = await this.files.readInWorkspace(user, row.workspace_id, row.request.path, client)
    const bytes = Buffer.from(value.data, 'base64')
    if (bytes.length !== row.source_snapshot.sourceBytes || sha(bytes) !== row.source_snapshot.sourceSha256
      || value.revision !== row.source_snapshot.sourceSha256) throw error('source-changed', 409)
  }



  private async ensureRoot(): Promise<void> {
    if (!this.rootReady) this.rootReady = (async () => {
      await mkdir(this.root, { recursive: true, mode: 0o700 })
      const stat = await lstat(this.root)
      if (!stat.isDirectory() || stat.isSymbolicLink() || (stat.mode & 0o077) !== 0) throw error('unavailable')
    })().catch((_rootUnavailable: unknown) => { this.rootReady = null; throw error('unavailable') })
    await this.rootReady
  }
  private async syncDirectory(path: string): Promise<void> {
    const folder = await open(path, constants.O_RDONLY | constants.O_DIRECTORY | constants.O_NOFOLLOW)
    try { await folder.sync() } finally { await folder.close() }
  }
  private async parserOwner(handle: FileHandle): Promise<void> {
    if (process.getuid?.() === 0) await handle.chown(1000, 1000)
  }
  private async writeInput(job: z.infer<typeof officePreviewJobSchema>, bytes: Buffer): Promise<void> {
    await this.ensureRoot()
    const base = join(this.root, job.jobId), input = join(base, 'input'), output = join(base, 'output')
    try {
      await mkdir(base, { mode: 0o700 }); await mkdir(input, { mode: 0o700 }); await mkdir(output, { mode: 0o700 })
      for (const directory of [input, output]) {
        const handle = await open(directory, constants.O_RDONLY | constants.O_DIRECTORY | constants.O_NOFOLLOW)
        try { await this.parserOwner(handle); await handle.sync() } finally { await handle.close() }
      }
      for (const [name, content] of [[`source.${job.extension}`, bytes], ['job.json', Buffer.from(JSON.stringify(job))]] as const) {
        const temporary = join(input, `.${randomUUID()}.part`), file = await open(temporary,
          constants.O_CREAT | constants.O_EXCL | constants.O_WRONLY | constants.O_NOFOLLOW, 0o400)
        try { await file.writeFile(content); await this.parserOwner(file); await file.sync() } finally { await file.close() }
        await rename(temporary, join(input, name))
      }
      await this.syncDirectory(input); await this.syncDirectory(output); await this.syncDirectory(base); await this.syncDirectory(this.root)
    } catch (_filesystemUnavailable) { throw error('unavailable') }
  }
  private async readManaged(jobId: string, directory: 'input' | 'output', name: string, maximum: number): Promise<Buffer | null> {
    await this.ensureRoot()
    const base = join(this.root, jobId), selected = join(base, directory)
    try {
      for (const path of [this.root, base, selected]) {
        const stat = await lstat(path)
        if (!stat.isDirectory() || stat.isSymbolicLink() || (stat.mode & 0o077) !== 0) throw error('unavailable')
      }
    } catch (_directoryUnavailable) { throw error('unavailable') }
    let file: FileHandle
    try { file = await open(join(selected, name), constants.O_RDONLY | constants.O_NOFOLLOW | constants.O_NONBLOCK) }
    catch (cause) { if (cause instanceof Error && 'code' in cause && cause.code === 'ENOENT') return null; throw error('unavailable') }
    try {
      const stat = await file.stat()
      if (!stat.isFile() || stat.nlink !== 1 || stat.size > maximum) throw error(stat.size > maximum ? 'output-too-large' : 'invalid-output')
      const chunks: Buffer[] = []
      let length = 0
      while (length <= maximum) {
        const chunk = Buffer.alloc(Math.min(64 * 1024, maximum + 1 - length))
        const read = await file.read(chunk, 0, chunk.length, length)
        if (read.bytesRead === 0) break
        chunks.push(chunk.subarray(0, read.bytesRead)); length += read.bytesRead
      }
      if (length > maximum) throw error('output-too-large')
      const bytes = Buffer.concat(chunks, length), after = await file.stat(), current = await lstat(join(selected, name))
      if (bytes.length !== stat.size || after.size !== stat.size || after.mtimeMs !== stat.mtimeMs
        || current.dev !== stat.dev || current.ino !== stat.ino || current.isSymbolicLink()) throw error('invalid-output')
      return bytes
    } catch (cause) { if (cause instanceof PlatformError) throw cause; throw error('unavailable') }
    finally { await file.close() }
  }
  private async pdf(row: Row): Promise<Buffer> {
    const result = row.result
    if (!result) throw error('invalid-output')
    const bytes = await this.readManaged(row.id, 'output', 'result.pdf', required(row.source_snapshot).limits.outputBytes)
    if (!bytes || bytes.length !== result.pdfBytes || sha(bytes) !== result.pdfSha256
      || bytes.subarray(0, 5).toString('ascii') !== '%PDF-' || !bytes.subarray(-1024).includes(Buffer.from('%%EOF'))) throw error('invalid-output')
    return bytes
  }

  private async step(): Promise<void> {
    const row = await this.claim()
    if (!row) return
    try { await this.reconcile(row) }
    catch (cause) {
      if (cause instanceof LeaseLost || this.stopped.signal.aborted) return
      if (cause instanceof OfficePreviewPodBlocked) await transaction(this.pool, async (client) => {
        const current = await this.locked(client, row)
        await client.query(`UPDATE pe_office_preview_jobs SET state='blocked',error_code='unavailable',updated_at=clock_timestamp()
          WHERE id=$1`, [current.id])
      }).catch((caught: unknown) => { if (!(caught instanceof LeaseLost)) throw caught })
      // Ambiguous infrastructure or persistence failures keep the original intent and slot for a later fenced observation.
    } finally {
      await transaction(this.pool, async (client) => {
        await lockAccountAuthorities(client, [row.user_id], 'update')
        if (row.workspace_id) await client.query('SELECT id FROM pe_workspaces WHERE id=$1 AND user_id=$2 FOR UPDATE',
          [row.workspace_id, row.user_id])
        await client.query(`UPDATE pe_office_preview_jobs SET lease_owner=NULL,lease_until=NULL,updated_at=clock_timestamp()
          WHERE id=$1 AND lease_owner=$2 AND lease_epoch=$3`, [row.id, this.ownerId, row.lease_epoch])
      })
    }
  }

  private async reconcile(original: Row): Promise<void> {
    let row = await this.guard(original)
    if (!row.creation_intent || !row.source_snapshot) throw error('unavailable')
    const intent = row.creation_intent
    let observed = await this.pods.observe(intent, row.pod_identity ?? undefined)
    row = observed ? await this.capture(row, observed) : await this.guard(row)
    const mustStop = row.cancel_requested || await this.expired(row)
      || row.generation !== this.providerGeneration || row.state === 'stopping'
    if (!observed) {
      if (row.stop_evidence) { await this.finalize(row); return }
      if (intent.submittedAt !== null || row.pod_identity !== null) throw new OfficePreviewPodBlocked()
      if (mustStop) { await this.finishNeverSubmitted(row); return }
      await this.verifyInput(row)
      row = await transaction(this.pool, async (client) => {
        const current = await this.locked(client, row)
        const authority = required((await lockAccountAuthorities(client, [row.user_id], 'update'))[0])
        if (current.cancel_requested || !authority.enabled || authority.deletedAt
          || !current.creation_intent || current.creation_intent.submittedAt !== null
          || await this.expired(current, client)) throw new LeaseLost()
        const permitted = { ...current.creation_intent, submittedAt: new Date().toISOString() }
        const saved = await client.query('UPDATE pe_office_preview_jobs SET creation_intent=$2,updated_at=clock_timestamp() WHERE id=$1 RETURNING *',
          [row.id, JSON.stringify(permitted)])
        return validatedRow(saved.rows[0])
      })
      await this.guard(row)
      await this.pods.submit(required(row.creation_intent))
      await this.guard(row)
      observed = await this.pods.observe(required(row.creation_intent), row.pod_identity ?? undefined)
      if (!observed) throw new OfficePreviewPodBlocked()
      row = await this.capture(row, observed)
    }
    if (!observed.retained && !row.stop_evidence) throw new OfficePreviewPodBlocked()
    if (observed.workerExit && row.worker_observation === null) row = await this.readOutcome(row, observed)
    const latest = await this.guard(row)
    if (!(latest.cancel_requested || await this.expired(latest)
      || latest.generation !== this.providerGeneration || observed.deleting || observed.workerExit || latest.state === 'stopping')) return
    row = await transaction(this.pool, async (client) => {
      const current = await this.locked(client, latest)
      const saved = await client.query(`UPDATE pe_office_preview_jobs SET state='stopping',error_code=NULL,updated_at=clock_timestamp()
        WHERE id=$1 RETURNING *`, [current.id])
      return validatedRow(saved.rows[0])
    })
    await this.guard(row)
    if (!observed.deleting) await this.pods.delete(required(row.creation_intent), observed.identity)
    await this.guard(row)
    const stopped = await this.pods.observe(required(row.creation_intent), row.pod_identity ?? undefined)
    if (!stopped) {
      if (!row.stop_evidence) throw new OfficePreviewPodBlocked()
      await this.finalize(row); return
    }
    row = await this.capture(row, stopped)
    if (!stopped.stopProof) return
    if (!row.stop_evidence) row = await transaction(this.pool, async (client) => {
      const current = await this.locked(client, row)
      const saved = await client.query('UPDATE pe_office_preview_jobs SET stop_evidence=$2,updated_at=clock_timestamp() WHERE id=$1 RETURNING *',
        [current.id, JSON.stringify(stopped.stopProof)])
      return validatedRow(saved.rows[0])
    })
    const proof = required(row.stop_evidence)
    if (proof.status === 'NOT_SUBMITTED') throw error('unavailable')
    await this.guard(row)
    await this.pods.release(required(row.creation_intent), stopped, proof)
    await this.guard(row)
    if (!await this.pods.observe(required(row.creation_intent), row.pod_identity ?? undefined)) await this.finalize(row)
  }
  private async capture(original: Row, observation: OfficePreviewPodObservation): Promise<Row> {
    return transaction(this.pool, async (client) => {
      const row = await this.locked(client, original)
      if (row.pod_identity && (row.pod_identity.uid !== observation.identity.uid
        || row.pod_identity.containerId !== null && row.pod_identity.containerId !== observation.identity.containerId
        || row.pod_identity.nodeName !== null && row.pod_identity.nodeName !== observation.identity.nodeName
        || row.pod_identity.imageId !== null && row.pod_identity.imageId !== observation.identity.imageId)) throw error('unavailable')
      const saved = await client.query(`UPDATE pe_office_preview_jobs SET pod_identity=$2,state=CASE WHEN state IN ('creating','blocked')
        AND NOT cancel_requested AND stop_evidence IS NULL THEN 'running' ELSE state END,
        error_code=CASE WHEN state IN ('creating','blocked') AND NOT cancel_requested AND stop_evidence IS NULL THEN NULL ELSE error_code END,
        updated_at=clock_timestamp() WHERE id=$1 RETURNING *`,
      [row.id, JSON.stringify(observation.identity)])
      return validatedRow(saved.rows[0])
    })
  }
  private async expired(row: Row, client: Pool | PoolClient = this.pool): Promise<boolean> {
    return required((await client.query<{ expired: boolean }>('SELECT $1::timestamptz<=clock_timestamp() AS expired', [row.deadline_at])).rows[0]).expired
  }
  private async verifyInput(row: Row): Promise<void> {
    const job = required(row.source_snapshot)
    const [descriptor, source] = await Promise.all([
      this.readManaged(row.id, 'input', 'job.json', 64 * 1024),
      this.readManaged(row.id, 'input', `source.${job.extension}`, job.limits.inputBytes),
    ])
    let actual: unknown
    try { actual = descriptor && JSON.parse(descriptor.toString('utf8')) }
    catch (_invalidDescriptor) { throw error('invalid-document') }
    const parsed = officePreviewJobSchema.safeParse(actual)
    if (!parsed.success || !equal(parsed.data, job) || !source || source.length !== job.sourceBytes || sha(source) !== job.sourceSha256) throw error('source-changed')
  }
  private async finishNeverSubmitted(original: Row): Promise<void> {
    await transaction(this.pool, async (client) => {
      const row = await this.locked(client, original)
      if (!row.creation_intent || row.creation_intent.submittedAt !== null || row.pod_identity !== null) throw new LeaseLost()
      const proof = notSubmittedProof.parse({ status: 'NOT_SUBMITTED', jobId: row.id, nonce: required(row.source_snapshot).nonce,
        generation: row.generation, intentDigest: row.creation_intent.templateDigest, observedAt: new Date().toISOString() })
      const expired = required((await client.query<{ expired: boolean }>('SELECT $1::timestamptz<=clock_timestamp() AS expired', [row.deadline_at])).rows[0]).expired
      if (!row.cancel_requested && !expired && row.generation === this.providerGeneration) throw new LeaseLost()
      await client.query(`UPDATE pe_office_preview_jobs SET state=$2,error_code=$3,stop_evidence=$4,
        parser_slot=NULL,lease_owner=NULL,lease_until=NULL,completed_at=clock_timestamp(),updated_at=clock_timestamp() WHERE id=$1`,
      [row.id, row.cancel_requested ? 'cancelled' : 'failed', row.cancel_requested ? null : expired ? 'timeout' : 'unavailable', JSON.stringify(proof)])
    })
  }
  private async readOutcome(original: Row, observation: OfficePreviewPodObservation): Promise<Row> {
    const exit = required(observation.workerExit)
    let result: Row['result'] = null, failure: z.infer<typeof officePreviewFailureSchema> | null = null
    let outcome: OfficePreviewErrorCode | null = null
    try {
      const [successBytes, failureBytes] = await Promise.all([
        this.readManaged(original.id, 'output', 'result.json', 64 * 1024),
        this.readManaged(original.id, 'output', 'failure.json', 64 * 1024),
      ])
      if (successBytes && failureBytes) throw error('invalid-output')
      const job = required(original.source_snapshot)
      if (failureBytes) {
        failure = officePreviewFailureSchema.parse(JSON.parse(failureBytes.toString('utf8')))
        if (failure.jobId !== original.id || failure.nonce !== job.nonce || failure.generation !== original.generation
          || failure.sourceSha256 !== job.sourceSha256) throw error('invalid-output')
        outcome = failure.errorCode
      } else if (successBytes && exit.exitCode === 0) {
        result = officePreviewResultSchema.parse(JSON.parse(successBytes.toString('utf8')))
        if (result.jobId !== original.id || result.nonce !== job.nonce || result.generation !== original.generation
          || result.sourceSha256 !== job.sourceSha256 || result.pages > job.limits.pages) throw error('invalid-output')
        await this.pdf({ ...original, result })
      } else outcome = exit.exitCode === 0 ? 'invalid-output' : 'failed'
    } catch (cause) {
      result = null; failure = null
      outcome = cause instanceof PlatformError && cause.code === 'office_render_output-too-large' ? 'output-too-large' : 'invalid-output'
    }
    return transaction(this.pool, async (client) => {
      const row = await this.locked(client, original)
      if (!row.pod_identity || row.pod_identity.containerId !== exit.containerId
        || row.pod_identity.imageId !== exit.imageId) throw new LeaseLost()
      const saved = await client.query('UPDATE pe_office_preview_jobs SET worker_observation=$2,result=$3,updated_at=clock_timestamp() WHERE id=$1 RETURNING *',
        [row.id, JSON.stringify({ exit, failure, errorCode: outcome }), result ? JSON.stringify(result) : null])
      return validatedRow(saved.rows[0])
    })
  }
  private async finalize(original: Row): Promise<void> {
    await transaction(this.pool, async (client) => {
      const row = await this.locked(client, original)
      if (!row.stop_evidence || row.stop_evidence.status === 'NOT_SUBMITTED' || !row.pod_identity) throw new LeaseLost()
      const expired = required((await client.query<{ expired: boolean }>('SELECT $1::timestamptz<=clock_timestamp() AS expired', [row.deadline_at])).rows[0]).expired
      let state: 'succeeded' | 'failed' | 'cancelled' = 'failed'
      let reason: OfficePreviewErrorCode | null = row.worker_observation?.errorCode ?? 'failed'
      if (row.cancel_requested) { state = 'cancelled'; reason = null }
      else if (expired) reason = 'timeout'
      else if (row.generation !== this.providerGeneration) reason = 'unavailable'
      else if (row.result && row.worker_observation?.exit.exitCode === 0 && row.worker_observation.errorCode === null) {
        state = 'succeeded'; reason = null
      }
      await client.query(`UPDATE pe_office_preview_jobs SET state=$2,error_code=$3,parser_slot=NULL,
        lease_owner=NULL,lease_until=NULL,completed_at=clock_timestamp(),updated_at=clock_timestamp() WHERE id=$1`,
      [row.id, state, reason])
    })
  }
}
