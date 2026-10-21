/** PG-only private allocation persistence; backend creation, reconciliation and stop proof remain Root-owned. */
import { Buffer } from 'node:buffer'
import type { AccountId, OwnerEpoch } from '@deepseek-ai/dsh-pe-cloud-runtime/types'
import type { SessionId } from '@deepseek-ai/dsh-session'
import type { WorkspaceId } from '@deepseek-ai/dsh-workspace'
import { allocationMigrationSql } from './migrations/allocations.ts'
import type {
  AllocationBeginResult, AllocationChange, AllocationCreateIntent, AllocationEpochScope, AllocationExpectation,
  AllocationId, AllocationPage, AllocationQuery, AllocationScope, AllocationState, AllocationStoreLimits, SandboxAllocation,
} from './allocation-types.ts'
import type { ExecutionCapability } from './types.ts'

/** Only store admission or the actual driver adapter may establish a never-submitted, settled statement. */
export abstract class AllocationQueryNotSubmittedError extends Error {
  /** @param options - optional private driver cause; no SQL, parameters or credentials enter the public message. */
  protected constructor(options?: ErrorOptions) {
    super('Allocation statement was not submitted.', options)
    this.name = 'AllocationQueryNotSubmittedError'
  }
}

/** Private, sanitized persistence failure; unknown writes retain responsibility until trusted recovery. */
export class AllocationStoreError extends Error {
  /**
   * @param code - handling-relevant classification, independent of backend resource state.
   * @param options - optional private cause without exposing it in the message.
   */
  constructor(readonly code: 'invalid-input' | 'capacity' | 'conflict' | 'unavailable' | 'invalid-row' | 'unknown', options?: ErrorOptions) {
    super(`Allocation store ${code}.`, options)
    this.name = 'AllocationStoreError'
  }
}

/** A store-owned admission refusal before this write reserves bytes, registers responsibility or calls its driver. */
class AllocationAdmissionNotSubmittedError extends AllocationQueryNotSubmittedError {
  constructor(readonly code: 'capacity' | 'invalid-input', cause: AllocationStoreError) {
    super({ cause })
    this.name = 'AllocationAdmissionNotSubmittedError'
  }
}

const nonterminal = "('creating','ready','uncertain','stopping')"
const projection = `jsonb_build_object(
 'allocationId',allocation_id,'accountId',account_id,'sessionId',session_id,'workspaceId',workspace_id,'epoch',epoch::text,
 'environmentVersion',environment_version,'provider',provider,'state',state,'sandboxId',sandbox_id,
 'projectMountVersion',project_mount_version,
 'requestedAt',to_char(requested_at AT TIME ZONE 'UTC','YYYY-MM-DD"T"HH24:MI:SS.MS"Z"'),
 'createDeadlineAt',to_char(create_deadline_at AT TIME ZONE 'UTC','YYYY-MM-DD"T"HH24:MI:SS.MS"Z"'),
 'lastActivityAt',to_char(last_activity_at AT TIME ZONE 'UTC','YYYY-MM-DD"T"HH24:MI:SS.MS"Z"'),
 'lastCheckedAt',to_char(last_checked_at AT TIME ZONE 'UTC','YYYY-MM-DD"T"HH24:MI:SS.MS"Z"'),
 'runtimeIdentity',runtime_identity,'executionProtocolVersion',execution_protocol_version,
 'executionCapabilities',execution_capabilities,'failureCode',failure_code) AS allocation`
const exact = 'allocation_id=$1 AND account_id=$2 AND session_id=$3 AND workspace_id=$4 AND epoch=$5::bigint'
const beginSql = `WITH inserted AS (
 INSERT INTO public.pe_sandbox_allocations (allocation_id,account_id,session_id,workspace_id,epoch,
 environment_version,provider,project_mount_version,requested_at,create_deadline_at,state,last_activity_at,last_checked_at)
 VALUES ($1,$2,$3,$4,$5::bigint,$6,$7,$8,$9::timestamptz,$10::timestamptz,'creating',$9::timestamptz,$9::timestamptz)
 ON CONFLICT DO NOTHING RETURNING ${projection})
 SELECT allocation,true AS inserted FROM inserted UNION ALL
 SELECT ${projection},false AS inserted FROM public.pe_sandbox_allocations
 WHERE (allocation_id=$1 OR (account_id=$2 AND session_id=$3 AND epoch=$5::bigint AND state IN ${nonterminal}))
 AND NOT EXISTS (SELECT 1 FROM inserted) LIMIT 2`
const updateSql = `UPDATE public.pe_sandbox_allocations SET state=$7,
 sandbox_id=COALESCE($8,sandbox_id),runtime_identity=COALESCE($9,runtime_identity),
 execution_protocol_version=COALESCE($10,execution_protocol_version),
 execution_capabilities=COALESCE($11::jsonb,execution_capabilities),
 failure_code=CASE WHEN $7='ready' THEN NULL ELSE COALESCE($12,failure_code) END,
 last_checked_at=statement_timestamp(),
 last_activity_at=CASE WHEN $7='ready' THEN statement_timestamp() ELSE last_activity_at END
 WHERE ${exact} AND state=$6 AND (sandbox_id IS NULL OR $8::text IS NULL OR sandbox_id=$8)
 RETURNING ${projection}`
const fields = ['allocationId', 'accountId', 'sessionId', 'workspaceId', 'epoch', 'environmentVersion', 'provider', 'state',
  'sandboxId', 'projectMountVersion', 'requestedAt', 'createDeadlineAt', 'lastActivityAt', 'lastCheckedAt',
  'runtimeIdentity', 'executionProtocolVersion', 'executionCapabilities', 'failureCode']
const capabilities: readonly ExecutionCapability[] = ['argv-collect', 'pipes', 'control', 'inherit', 'terminal']

interface Postimage {
  readonly scope: AllocationScope
  readonly fields: Readonly<Record<string, string | null | readonly ExecutionCapability[]>>
}
interface Responsibility {
  readonly bytes: number
  readonly postimage?: Postimage
  phase: 'pending' | 'unknown'
  reconciliation?: Promise<SandboxAllocation>
}
interface BeginWork { readonly fingerprint: string; readonly actual: Promise<AllocationBeginResult> }

/** One PG authority with bounded actual queries and retained mutation uncertainty; no in-memory durable fallback. */
export class PostgresAllocationStore {
  private readonly limits: AllocationStoreLimits
  private readonly begins = new Map<string, BeginWork>()
  private readonly responsibilities = new Map<string, Responsibility>()
  private readonly state: { migrated: boolean; migration?: Promise<void>; pending: number; bytes: number } = {
    migrated: false, pending: 0, bytes: 0,
  }

  /**
   * @param driver - real single-statement adapter, whose promise includes actual driver settlement.
   * @param limits - explicit finite serialized-byte, result-row and pending/unknown capacities.
   */
  constructor(private readonly driver: AllocationQuery, limits: AllocationStoreLimits) {
    const names: readonly (keyof AllocationStoreLimits)[] = ['maxFieldBytes', 'maxInputBytes', 'maxRowBytes', 'maxResultBytes',
      'maxRows', 'maxCapabilities', 'maxPendingQueries', 'maxMutationResponsibilities', 'maxRetainedBytes']
    for (const name of names) {
      const value = limits[name]
      if (!Number.isSafeInteger(value) || value < 1) throw new AllocationStoreError('invalid-input')
    }
    if (limits.maxFieldBytes > 4096 || limits.maxCapabilities > capabilities.length || limits.maxRows < 2
      || limits.maxRows > 2_147_483_647 || limits.maxResultBytes < 2 || limits.maxResultBytes < limits.maxRowBytes) {
      throw new AllocationStoreError('invalid-input')
    }
    this.limits = Object.freeze({ ...limits })
  }

  /**
   * Apply and validate one atomic DDL statement. A submitted migration failure remains unknown and closed.
   * @returns the same actual migration promise; only trusted never-submitted failure permits another attempt.
   */
  migrate(): Promise<void> {
    this.state.migration ??= this.write('migration', allocationMigrationSql, [], 0, (rows) => {
      if (rows.length !== 0) throw new AllocationStoreError('invalid-row')
      this.state.migrated = true
    }).catch((error: unknown) => {
      if (error instanceof AllocationQueryNotSubmittedError) delete this.state.migration
      throw error
    })
    return this.state.migration
  }

  /**
   * Persist Root's allocation id before any Sandbox.create. Matching local calls share exactly this DB promise.
   * Existing rows never authorize a create replay; Root must coalesce the entire backend-create operation too.
   * @param input - fixed Root-generated identity and approved immutable create metadata.
   * @returns a durable row and whether this statement inserted it; no backend work is performed.
   */
  begin(input: AllocationCreateIntent): Promise<AllocationBeginResult> {
    this.assertMigrated()
    const scope = this.copyScope(input)
    const requestedAt = this.date(input.requestedAt), deadline = this.date(input.createDeadlineAt)
    const environmentVersion = this.token(input.environmentVersion), provider = this.token(input.provider)
    const projectMountVersion = this.token(input.projectMountVersion)
    const values = [...this.scopeValues(scope), environmentVersion, provider, projectMountVersion, requestedAt, deadline]
    if (deadline < requestedAt) throw new AllocationStoreError('invalid-input')
    const key = this.key(scope), fingerprint = JSON.stringify(values)
    const pending = this.begins.get(key)
    if (pending !== undefined) {
      if (pending.fingerprint !== fingerprint) throw new AllocationStoreError('conflict')
      return pending.actual
    }
    const actual = this.write(key, beginSql, values, 2, (rows): AllocationBeginResult | undefined => {
      if (rows.length === 0) return undefined
      if (rows.length !== 1) throw new AllocationStoreError('invalid-row')
      const envelope = this.object(rows[0])
      if (typeof envelope['inserted'] !== 'boolean') throw new AllocationStoreError('invalid-row')
      const allocation = this.row(envelope['allocation'])
      if (envelope['inserted'] && (!this.sameIntent(allocation, values) || allocation.state !== 'creating')) {
        throw new AllocationStoreError('invalid-row')
      }
      return Object.freeze({ allocation, inserted: envelope['inserted'] })
    }, Object.freeze({ scope, fields: Object.freeze({ state: 'creating', environmentVersion, provider, projectMountVersion,
      requestedAt, createDeadlineAt: deadline, lastActivityAt: requestedAt, lastCheckedAt: requestedAt,
      sandboxId: null, runtimeIdentity: null, executionProtocolVersion: null,
      executionCapabilities: Object.freeze([]), failureCode: null }) })).then((result) => {
      if (result === undefined || !this.sameIntent(result.allocation, values)) throw new AllocationStoreError('conflict')
      return result
    })
    this.begins.set(key, { fingerprint, actual })
    void actual.then(() => { this.begins.delete(key) }, () => { this.begins.delete(key) })
    return actual
  }

  /**
   * Read one exact durable identity without changing uncertainty or authorizing recreation.
   * @param scope - allocation id plus its complete native scope.
   * @returns the matching row, or undefined on confirmed absence; absence does not clear a retained write.
   */
  async get(scope: AllocationScope): Promise<SandboxAllocation | undefined> {
    this.assertMigrated()
    const values = this.scopeValues(scope)
    const rows = await this.query(`SELECT ${projection} FROM public.pe_sandbox_allocations WHERE ${exact}`,
      values, 1, false)
    return this.single(rows, values)
  }

  /**
   * Confirm one locally settled unknown business write against its captured exact PG postimage.
   * Missing/mismatched rows and read failures retain the original responsibility; no write is replayed.
   * Root checks its current owner/epoch before and after this call. This grants no SDK create/stop authority.
   * @param scope - all five immutable identity fields, matching the original retained write.
   * @returns the committed row after releasing only that DB responsibility; concurrent checks share one actual promise.
   */
  reconcileCommitted(scope: AllocationScope): Promise<SandboxAllocation> {
    this.assertMigrated()
    const values = this.scopeValues(scope), key = this.key(scope), record = this.responsibilities.get(key)
    if (record === undefined) return Promise.reject(new AllocationStoreError('conflict'))
    if (record.phase !== 'unknown') return Promise.reject(new AllocationStoreError('unknown'))
    const postimage = record.postimage
    if (postimage === undefined || JSON.stringify(values) !== JSON.stringify(this.scopeValues(postimage.scope))) {
      return Promise.reject(new AllocationStoreError('conflict'))
    }
    if (record.reconciliation !== undefined) return record.reconciliation
    const actual = this.get(postimage.scope).then((allocation) => {
      if (allocation === undefined) throw new AllocationStoreError('unknown')
      const durable = this.object(allocation)
      if (Object.entries(postimage.fields).some(([field, value]) => JSON.stringify(durable[field]) !== JSON.stringify(value))) {
        throw new AllocationStoreError('unknown')
      }
      this.release(key, record)
      return allocation
    })
    record.reconciliation = actual
    void actual.then(() => { delete record.reconciliation }, () => { delete record.reconciliation })
    return actual
  }

  /**
   * Enumerate durable nonterminal metadata; empty pages never clear unknown create responsibilities.
   * @param scope - exact account/epoch filter, or null for trusted Root's global startup reconciliation.
   * @param cursor - last allocation id, or null for the first page.
   * @param limit - positive page length no greater than configured maxRows.
   * @returns bounded keyset metadata; concurrent writes require Root's repeated reconciliation, not create replay.
   */
  async listNonterminal(scope: AllocationEpochScope | null, cursor: AllocationId | null, limit: number): Promise<AllocationPage> {
    this.assertMigrated()
    if (!Number.isSafeInteger(limit) || limit < 1 || limit > this.limits.maxRows) throw new AllocationStoreError('invalid-input')
    const values = [scope === null ? null : this.token(scope.accountId), scope === null ? null : this.epoch(scope.epoch),
      cursor === null ? null : this.token(cursor), String(limit)]
    const rows = await this.query(`SELECT ${projection} FROM public.pe_sandbox_allocations WHERE state IN ${nonterminal}
      AND ($1::text IS NULL OR account_id=$1) AND ($2::bigint IS NULL OR epoch=$2::bigint)
      AND ($3::text IS NULL OR allocation_id > $3 COLLATE "C") ORDER BY allocation_id COLLATE "C" LIMIT $4::integer`, values, limit, false)
    const allocations = rows.map(value => this.row(this.object(value)['allocation']))
    let previous: string | null = cursor
    for (const value of allocations) {
      if (value.state === 'failed' || value.state === 'released' || (previous !== null && value.allocationId <= previous)
        || (scope !== null && (value.accountId !== values[0] || value.epoch !== values[1]))) {
        throw new AllocationStoreError('invalid-row')
      }
      previous = value.allocationId
    }
    const last = allocations.at(-1)
    return Object.freeze({ allocations: Object.freeze(allocations),
      nextCursor: rows.length === limit && last !== undefined ? last.allocationId : null })
  }

  /**
   * CAS only reviewed nonterminal transitions; Root supplies actual readiness/reconciliation observations.
   * @param expected - complete identity and exact prior state.
   * @param change - ready, uncertain or stopping metadata; it cannot choose a backend or replace scope.
   * @returns the matching durable row; zero-row CAS is a conflict, never a successful overwrite.
   */
  transition(expected: AllocationExpectation, change: AllocationChange): Promise<SandboxAllocation> {
    const allowed = change.to === 'stopping' ? ['creating', 'ready', 'uncertain'] : ['creating']
    if (!allowed.includes(expected.state)) throw new AllocationStoreError('invalid-input')
    return this.change(expected, change.to, change.sandboxId ?? null,
      change.to === 'ready' ? change.runtimeIdentity : null,
      change.to === 'ready' ? change.executionProtocolVersion : null,
      change.to === 'ready' ? this.readCapabilities(change.executionCapabilities, true) : null,
      change.to === 'ready' ? null : change.failureCode ?? null)
  }

  /**
   * Record Root's explicit trustworthy finding that no sandbox was created. This method produces no proof.
   * @param expected - exact creating row and scope.
   * @param failureCode - safe finite diagnostic code, never backend text or a path.
   * @returns failed metadata only after the exact creating CAS succeeds.
   */
  failNotCreated(expected: AllocationExpectation, failureCode: string): Promise<SandboxAllocation> {
    if (expected.state !== 'creating') throw new AllocationStoreError('invalid-input')
    return this.change(expected, 'failed', null, null, null, null, this.token(failureCode))
  }

  /**
   * Record Root's explicit trustworthy stop fact; no SDK deletion, timeout or empty list is interpreted as proof.
   * @param expected - exact stopping row and scope already verified by the trusted stop owner.
   * @returns released metadata after the exact stopping CAS; the store performs no resource cleanup.
   */
  releaseStopped(expected: AllocationExpectation): Promise<SandboxAllocation> {
    if (expected.state !== 'stopping') throw new AllocationStoreError('invalid-input')
    return this.change(expected, 'released', null, null, null, null, null)
  }

  /**
   * Snapshot local query, mutation and retained-memory accounting without submitting SQL.
   * @returns Bounded ownership counts without SQL, parameters, identities or credentials.
   */
  inspect(): Readonly<{ pendingQueries: number; mutationResponsibilities: number; unknownMutations: number; retainedBytes: number }> {
    return Object.freeze({ pendingQueries: this.state.pending, mutationResponsibilities: this.responsibilities.size,
      unknownMutations: [...this.responsibilities.values()].filter(value => value.phase === 'unknown').length, retainedBytes: this.state.bytes })
  }

  private change(expected: AllocationExpectation, to: AllocationState, sandboxId: string | null, runtimeIdentity: string | null,
    protocol: string | null, modes: readonly ExecutionCapability[] | null, failureCode: string | null): Promise<SandboxAllocation> {
    this.assertMigrated()
    const copiedScope = this.copyScope(expected), scope = this.scopeValues(copiedScope)
    const values = [...scope, expected.state, to, sandboxId === null ? null : this.token(sandboxId),
      runtimeIdentity === null ? null : this.token(runtimeIdentity), protocol === null ? null : this.protocol(protocol),
      modes === null ? null : JSON.stringify(modes), failureCode === null ? null : this.token(failureCode)]
    return this.write(this.key(copiedScope), updateSql, values, 1, (rows) => {
      const allocation = this.single(rows, scope)
      if (allocation !== undefined && allocation.state !== to) throw new AllocationStoreError('invalid-row')
      return allocation
    }, Object.freeze({ scope: copiedScope, fields: Object.freeze({ state: to,
      ...(sandboxId === null ? {} : { sandboxId }), ...(runtimeIdentity === null ? {} : { runtimeIdentity }),
      ...(protocol === null ? {} : { executionProtocolVersion: protocol }),
      ...(modes === null ? {} : { executionCapabilities: modes }),
      ...(to === 'ready' ? { failureCode: null } : failureCode === null ? {} : { failureCode }) }) })).then((allocation) => {
      if (allocation === undefined) throw new AllocationStoreError('conflict')
      return allocation
    })
  }

  private async write<T>(key: string, sql: string, values: readonly (string | null)[], maxRows: number,
    decode: (rows: readonly unknown[]) => T, postimage?: Postimage): Promise<T> {
    const existing = this.responsibilities.get(key)
    if (existing !== undefined) throw new AllocationStoreError(existing.phase === 'unknown' ? 'unknown' : 'conflict')
    let bytes: number
    try {
      bytes = this.inputBytes(sql, values, key) + (postimage === undefined ? 0 : Buffer.byteLength(JSON.stringify(postimage)))
      if (this.responsibilities.size >= this.limits.maxMutationResponsibilities || this.state.pending >= this.limits.maxPendingQueries) {
        throw new AllocationStoreError('capacity')
      }
      this.reserve(bytes)
    } catch (cause) {
      if (cause instanceof AllocationStoreError && (cause.code === 'capacity' || cause.code === 'invalid-input')) {
        throw new AllocationAdmissionNotSubmittedError(cause.code, cause)
      }
      throw cause
    }
    const record: Responsibility = { bytes, phase: 'pending', ...(postimage === undefined ? {} : { postimage }) }
    this.responsibilities.set(key, record)
    let result: T
    try { result = decode(await this.query(sql, values, maxRows, true)) }
    catch (cause) {
      if (cause instanceof AllocationQueryNotSubmittedError) this.release(key, record)
      else record.phase = 'unknown'
      throw cause instanceof AllocationQueryNotSubmittedError ? cause : new AllocationStoreError('unknown', { cause })
    }
    this.release(key, record)
    return result
  }

  private async query(sql: string, values: readonly (string | null)[], maxRows: number, reserved: boolean): Promise<readonly unknown[]> {
    const bytes = this.inputBytes(sql, values)
    if (this.state.pending >= this.limits.maxPendingQueries) throw new AllocationStoreError('capacity')
    if (!reserved) this.reserve(bytes)
    this.state.pending++
    try {
      const result = await this.driver.query(sql, Object.freeze([...values]))
      if (result.rows.length > maxRows || result.rows.length > this.limits.maxRows) throw new AllocationStoreError('invalid-row')
      let total = 2
      for (const row of result.rows) {
        const envelope = this.object(row)
        const names = Object.keys(envelope)
        if (names.some(name => name !== 'allocation' && name !== 'inserted')
          || (Object.hasOwn(envelope, 'inserted') && typeof envelope['inserted'] !== 'boolean')) {
          throw new AllocationStoreError('invalid-row')
        }
        this.row(envelope['allocation'])
        const size = Buffer.byteLength(JSON.stringify(row))
        total += size + 1
        if (size > this.limits.maxRowBytes || total > this.limits.maxResultBytes) throw new AllocationStoreError('invalid-row')
      }
      return result.rows
    } catch (cause) {
      if (cause instanceof AllocationQueryNotSubmittedError || cause instanceof AllocationStoreError) throw cause
      throw new AllocationStoreError(reserved ? 'unknown' : 'unavailable', { cause })
    } finally {
      this.state.pending--
      if (!reserved) this.state.bytes -= bytes
    }
  }

  private reserve(bytes: number): void {
    if (bytes > this.limits.maxRetainedBytes - this.state.bytes) throw new AllocationStoreError('capacity')
    this.state.bytes += bytes
  }
  private release(key: string, record: Responsibility): void {
    if (this.responsibilities.get(key) !== record) throw new AllocationStoreError('conflict')
    this.responsibilities.delete(key)
    this.state.bytes -= record.bytes
  }
  private inputBytes(sql: string, values: readonly (string | null)[], key = ''): number {
    const bytes = Buffer.byteLength(sql) + 2 * Buffer.byteLength(JSON.stringify(values)) + Buffer.byteLength(key)
    if (bytes > this.limits.maxInputBytes) throw new AllocationStoreError('invalid-input')
    return bytes
  }
  private assertMigrated(): void {
    if (!this.state.migrated) throw new AllocationStoreError('unavailable')
  }
  private key(scope: AllocationScope): string { return JSON.stringify([scope.accountId, scope.sessionId, scope.epoch]) }
  private copyScope(scope: AllocationScope): AllocationScope {
    return Object.freeze({ allocationId: scope.allocationId, accountId: scope.accountId, sessionId: scope.sessionId,
      workspaceId: scope.workspaceId, epoch: scope.epoch })
  }
  private scopeValues(scope: AllocationScope): string[] {
    return [this.token(scope.allocationId), this.token(scope.accountId), this.token(scope.sessionId),
      this.token(scope.workspaceId), this.epoch(scope.epoch)]
  }
  private sameIntent(value: SandboxAllocation, values: readonly (string | null)[]): boolean {
    return JSON.stringify([...this.scopeValues(value), value.environmentVersion, value.provider, value.projectMountVersion,
      value.requestedAt, value.createDeadlineAt]) === JSON.stringify(values)
  }
  private object(value: unknown): Record<string, unknown> {
    if (typeof value !== 'object' || value === null || Array.isArray(value)) throw new AllocationStoreError('invalid-row')
    return value as Record<string, unknown>
  }
  private token(value: string): string {
    if (typeof value !== 'string' || value.length > this.limits.maxFieldBytes || !/^[A-Za-z0-9][A-Za-z0-9._:-]*$/.test(value)
      || Buffer.byteLength(value) > this.limits.maxFieldBytes) throw new AllocationStoreError('invalid-input')
    return value
  }
  private protocol(value: string): string {
    if (typeof value !== 'string' || value.length > this.limits.maxFieldBytes || !/^[A-Za-z0-9][A-Za-z0-9._:/-]*$/.test(value)
      || Buffer.byteLength(value) > this.limits.maxFieldBytes) throw new AllocationStoreError('invalid-input')
    return value
  }
  private epoch(value: string): OwnerEpoch {
    if (!/^[1-9][0-9]{0,18}$/.test(value) || BigInt(value) > 9_223_372_036_854_775_807n) throw new AllocationStoreError('invalid-input')
    return value as OwnerEpoch
  }
  private date(value: string): string {
    if (typeof value !== 'string' || value.length !== 24
      || !/^[1-9]\d{3}-\d\d-\d\dT\d\d:\d\d:\d\d\.\d{3}Z$/.test(value)) {
      throw new AllocationStoreError('invalid-input')
    }
    const parsed = new Date(value)
    if (!Number.isFinite(parsed.getTime()) || parsed.toISOString() !== value) {
      throw new AllocationStoreError('invalid-input')
    }
    return value
  }
  private readCapabilities(value: readonly unknown[], ready: boolean): readonly ExecutionCapability[] {
    if (!Array.isArray(value) || value.length > this.limits.maxCapabilities || (ready && value.length === 0)
      || new Set(value).size !== value.length) {
      throw new AllocationStoreError('invalid-input')
    }
    return Object.freeze(value.map((item: unknown): ExecutionCapability => {
      if (!capabilities.some(allowed => allowed === item)) throw new AllocationStoreError('invalid-input')
      return item as ExecutionCapability
    }).sort())
  }
  private single(rows: readonly unknown[], scope: readonly string[]): SandboxAllocation | undefined {
    if (rows.length === 0) return undefined
    if (rows.length !== 1) throw new AllocationStoreError('invalid-row')
    const value = this.row(this.object(rows[0])['allocation'])
    if (JSON.stringify(this.scopeValues(value)) !== JSON.stringify(scope)) throw new AllocationStoreError('invalid-row')
    return value
  }
  private row(input: unknown): SandboxAllocation {
    try {
      const value = this.object(input)
      if (Object.keys(value).length !== fields.length || fields.some(field => !Object.hasOwn(value, field))) throw new Error('fields')
      const text = (key: string): string => {
        const field = value[key]
        if (typeof field !== 'string') throw new Error('text')
        return key === 'executionProtocolVersion' ? this.protocol(field) : this.token(field)
      }
      const date = (key: string): string => {
        const field = value[key]
        if (typeof field !== 'string') throw new Error('date')
        return this.date(field)
      }
      const optional = (key: string): string | null => value[key] === null ? null : text(key)
      const state = text('state')
      if (!['creating', 'ready', 'uncertain', 'stopping', 'failed', 'released'].includes(state)) throw new Error('state')
      const modes = value['executionCapabilities']
      if (!Array.isArray(modes)) throw new Error('capabilities')
      const result: SandboxAllocation = Object.freeze({ allocationId: text('allocationId') as AllocationId,
        accountId: text('accountId') as AccountId, sessionId: text('sessionId') as SessionId, workspaceId: text('workspaceId') as WorkspaceId,
        epoch: this.epoch(text('epoch')), environmentVersion: text('environmentVersion'), provider: text('provider'),
        projectMountVersion: text('projectMountVersion'), requestedAt: date('requestedAt'), createDeadlineAt: date('createDeadlineAt'),
        state: state as AllocationState, sandboxId: optional('sandboxId'), lastActivityAt: date('lastActivityAt'),
        lastCheckedAt: date('lastCheckedAt'), runtimeIdentity: optional('runtimeIdentity'),
        executionProtocolVersion: optional('executionProtocolVersion'), executionCapabilities: this.readCapabilities(modes, state === 'ready'),
        failureCode: optional('failureCode') })
      if (result.createDeadlineAt < result.requestedAt
        || (state === 'ready' && (result.sandboxId === null || result.runtimeIdentity === null
          || result.executionProtocolVersion === null || result.failureCode !== null))
        || (state === 'failed' && (result.sandboxId !== null || result.failureCode === null))) throw new Error('state fields')
      return result
    } catch (cause) { throw new AllocationStoreError('invalid-row', { cause }) }
  }
}
