/** Private C-12 process registration; no root admission, routing or account ownership authority. */
import { brandString } from '@deepseek-ai/dsh-brand'
import { AccountRuntimeError } from './errors.ts'
import { createProcessInstanceIdentity } from './instance-identity.ts'
import { instanceMigrationSql } from './migrations/instances.ts'
import { registerInstanceSql, locateInstanceSql, heartbeatInstanceSql, closeInstanceSql } from './instance-sql.ts'
import { OwnerPgNotSubmittedError } from './owner-pg-errors.ts'
import type { OwnerPgExecutor, OwnerStoreIdentity } from './owner-types.ts'
import type { InstanceId } from './types.ts'

/** Trusted root deployment metadata; it has no selectable instance-id field. */
export interface InstanceDeployment {
  readonly internalAddress: string
  readonly recipeVersion: string
}

/** Only the five C-12 instance metadata fields; phase grants no account readiness. */
export interface RuntimeInstanceRecord extends InstanceDeployment {
  readonly instanceId: InstanceId
  readonly phase: 'registered' | 'closed'
  readonly heartbeatAt: string
}

/** Closing a component with no submitted registration creates no synthetic database row. */
export type InstanceCloseResult =
  | Readonly<{ status: 'closed'; record: RuntimeInstanceRecord }>
  | Readonly<{ status: 'not-registered'; instanceId: InstanceId }>

type Operation = 'migrate' | 'register' | 'read' | 'heartbeat' | 'close'
type Outcome = 'not-submitted' | 'unknown' | 'conflict' | 'invalid-record' | 'unavailable'
type InstanceState = 'new' | 'registered' | 'closed' | 'conflict' | 'unknown'

/** Private typed failure; causes and deployment addresses are never wire diagnostics. */
export class InstanceControlError extends AccountRuntimeError {
  /**
   * @param operation The process-control operation that failed.
   * @param outcome What the actual control result established.
   * @param message Safe diagnostic without deployment secrets.
   * @param options Optional original private failure.
   */
  constructor(readonly operation: Operation, readonly outcome: Outcome, message: string, options?: ErrorOptions) {
    super(outcome === 'conflict' ? 'cloud/config-conflict' : 'cloud/account-unavailable', message, options)
    this.name = 'InstanceControlError'
  }
}

function invalidRecord(operation: Operation): never {
  throw new InstanceControlError(operation, 'invalid-record', 'Persisted instance metadata is not trusted')
}

function object(value: unknown, operation: Operation): Record<string, unknown> {
  if (typeof value !== 'object' || value === null || Array.isArray(value)) invalidRecord(operation)
  return value as Record<string, unknown>
}

function text(value: unknown, operation: Operation): string {
  if (typeof value !== 'string' || value.length === 0) invalidRecord(operation)
  return value
}

function decode(input: unknown, operation: Operation): RuntimeInstanceRecord {
  const row = object(object(input, operation)['instance'], operation)
  const phase = row['phase']
  if (phase !== 'registered' && phase !== 'closed') invalidRecord(operation)
  const heartbeatAt = text(row['heartbeatAt'], operation)
  if (!/^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}\.\d{6}Z$/.test(heartbeatAt)
    || !Number.isFinite(Date.parse(heartbeatAt))) invalidRecord(operation)
  return Object.freeze({
    instanceId: brandString<InstanceId>(text(row['instanceId'], operation)),
    internalAddress: text(row['internalAddress'], operation), recipeVersion: text(row['recipeVersion'], operation),
    phase, heartbeatAt: new Date(heartbeatAt).toISOString(),
  })
}

/**
 * One process-registration component owns one generated identity and at most one actual mutation.
 * Construct once at Node startup, then share identity with PostgresOwnerStore. This does not
 * install itself into PeAccountRuntime or schedule heartbeat/recovery tasks.
 * Its owner reports typed failures and retains unknown submitted mutations for reconciliation;
 * a read cannot clear uncertainty. Only definitely unsubmitted writes permit an explicit retry.
 */
export class RuntimeInstanceControl {
  /** Server-generated startup identity shared unchanged with the owner store. */
  readonly identity: OwnerStoreIdentity = createProcessInstanceIdentity()
  private readonly deployment: InstanceDeployment
  private migrated = false
  private migration: Promise<void> | undefined
  private registration: Promise<RuntimeInstanceRecord> | undefined
  private mutation: { operation: Operation; actual: Promise<RuntimeInstanceRecord> } | undefined
  private closing: Promise<InstanceCloseResult> | undefined
  private closeRequested = false
  private state: InstanceState = 'new'

  /**
   * @param executor Existing bounded actual PgOwnerExecutor, shared with root control work.
   * @param deployment Trusted nonempty address and recipe; no account/wire-selected identity.
   */
  constructor(private readonly executor: OwnerPgExecutor, deployment: InstanceDeployment) {
    if (deployment.internalAddress.length === 0 || deployment.recipeVersion.length === 0) {
      throw new AccountRuntimeError('cloud/invalid-config', 'Instance deployment address and recipe must be explicit')
    }
    this.deployment = Object.freeze({ internalAddress: deployment.internalAddress, recipeVersion: deployment.recipeVersion })
  }

  /**
   * Validate or create the atomic instance schema; an explicit retry only repeats schema validation.
   * @returns The shared actual schema operation; no process registration or ready is published.
   */
  migrate(): Promise<void> {
    this.assertOpen('migrate')
    this.migration ??= this.executor.query(instanceMigrationSql, []).then(() => { this.migrated = true }).catch((cause: unknown) => {
      this.migration = undefined
      throw this.failure('migrate', cause)
    })
    return this.migration
  }

  /**
   * Register only the generated startup id; identical local calls share the original operation.
   * Later calls return its registration receipt, not a fresh heartbeat or current status.
   * @returns The actual registration record after driver settlement, never account readiness.
   */
  register(): Promise<RuntimeInstanceRecord> {
    this.assertWritable('register')
    if (this.registration !== undefined) return this.registration
    const actual = this.write('register', registerInstanceSql)
    this.registration = actual
    void actual.catch((cause: unknown) => {
      if (cause instanceof InstanceControlError && cause.outcome === 'not-submitted') this.registration = undefined
    })
    return actual
  }

  /**
   * Read one registry row without repairing local uncertainty or choosing a network destination.
   * @param instanceId Trusted internal lookup id, such as an existing owner reference.
   * @returns Immutable metadata, or undefined only after a successful absent-row result.
   */
  async locate(instanceId: InstanceId): Promise<RuntimeInstanceRecord | undefined> {
    if (!this.migrated) throw new InstanceControlError('read', 'unavailable', 'Instance schema is not established')
    try {
      const { rows } = await this.executor.query(locateInstanceSql, [instanceId])
      if (rows.length === 0) return undefined
      if (rows.length !== 1) invalidRecord('read')
      const record = decode(rows[0], 'read')
      if (record.instanceId !== instanceId) invalidRecord('read')
      return record
    } catch (cause) { throw this.failure('read', cause) }
  }

  /**
   * Observe this registration only; repeated concurrent calls coalesce, without owner/epoch changes.
   * @returns The actual heartbeat record; staleness never grants takeover permission.
   */
  heartbeat(): Promise<RuntimeInstanceRecord> {
    this.assertWritable('heartbeat')
    if (this.state !== 'registered') throw new InstanceControlError('heartbeat', 'unavailable', 'Instance registration is not established')
    if (this.mutation?.operation === 'heartbeat') return this.mutation.actual
    return this.write('heartbeat', heartbeatInstanceSql)
  }

  /**
   * Close this registration after its actual schema/register/heartbeat work settles.
   * The root must separately settle accounts/resources; a closed row is not process-death proof.
   * A definitely unsubmitted failure allows an explicit close retry with admission still closed.
   * @returns The same actual close operation, retained past any external observation deadline.
   */
  close(): Promise<InstanceCloseResult> {
    this.closeRequested = true
    if (this.closing === undefined) {
      const actual = this.finishClose()
      this.closing = actual
      void actual.catch((cause: unknown) => {
        if (cause instanceof InstanceControlError && cause.outcome === 'not-submitted') this.closing = undefined
      })
    }
    return this.closing
  }

  /**
   * Report only bounded process-control responsibility, not readiness or a liveness decision.
   * @returns Local state and whether one actual mutation remains retained.
   */
  inspect(): Readonly<{ state: InstanceState; pendingMutation: boolean; closeRequested: boolean }> {
    return Object.freeze({ state: this.state, pendingMutation: this.mutation !== undefined, closeRequested: this.closeRequested })
  }

  private async finishClose(): Promise<InstanceCloseResult> {
    await this.migration
    if (this.registration !== undefined) {
      try { await this.registration } catch (cause) {
        if (!(cause instanceof InstanceControlError) || cause.outcome !== 'not-submitted') throw cause
      }
    }
    if (this.mutation !== undefined) await this.mutation.actual
    if (this.state === 'new') {
      this.state = 'closed'
      return Object.freeze({ status: 'not-registered', instanceId: this.identity.instanceId })
    }
    if (this.state !== 'registered') {
      throw new InstanceControlError('close', this.state === 'unknown' ? 'unknown' : 'conflict', 'Instance closure is not confirmed')
    }
    const record = await this.write('close', closeInstanceSql)
    return Object.freeze({ status: 'closed', record })
  }

  private write(operation: 'register' | 'heartbeat' | 'close', sql: string): Promise<RuntimeInstanceRecord> {
    if (this.mutation !== undefined) throw new InstanceControlError(operation, 'unavailable', 'An instance mutation is already retained')
    const actual = this.executeWrite(operation, sql)
    this.mutation = { operation, actual }
    void actual.then(() => { this.mutation = undefined }, () => {
      if (this.state !== 'unknown') this.mutation = undefined
    })
    return actual
  }

  private async executeWrite(operation: 'register' | 'heartbeat' | 'close', sql: string): Promise<RuntimeInstanceRecord> {
    try {
      const { rows } = await this.executor.query(sql, [
        this.identity.instanceId, this.deployment.internalAddress, this.deployment.recipeVersion,
      ])
      if (rows.length === 0) throw new InstanceControlError(operation, 'conflict', 'Instance identity or registration metadata conflicts')
      if (rows.length !== 1) invalidRecord(operation)
      const record = decode(rows[0], operation)
      if (record.instanceId !== this.identity.instanceId || record.internalAddress !== this.deployment.internalAddress
        || record.recipeVersion !== this.deployment.recipeVersion || record.phase !== (operation === 'close' ? 'closed' : 'registered')) invalidRecord(operation)
      this.state = operation === 'close' ? 'closed' : 'registered'
      return record
    } catch (cause) {
      const error = this.failure(operation, cause)
      if (error.outcome === 'conflict') this.state = 'conflict'
      else if (error.outcome !== 'not-submitted') this.state = 'unknown'
      throw error
    }
  }

  private failure(operation: Operation, cause: unknown): InstanceControlError {
    if (cause instanceof InstanceControlError) return cause
    return new InstanceControlError(operation, cause instanceof OwnerPgNotSubmittedError ? 'not-submitted' : 'unknown',
      operation === 'read' ? 'Instance metadata lookup failed; absence is not established' : 'Instance control outcome is not confirmed', { cause })
  }

  private assertOpen(operation: Operation): void {
    if (this.closeRequested) throw new InstanceControlError(operation, 'unavailable', 'Instance control admission is closed')
  }

  private assertWritable(operation: Operation): void {
    this.assertOpen(operation)
    if (!this.migrated) throw new InstanceControlError(operation, 'unavailable', 'Instance schema is not established')
    if (this.state === 'unknown' || this.state === 'conflict' || this.state === 'closed') {
      throw new InstanceControlError(operation, this.state === 'unknown' ? 'unknown' : 'conflict', 'Instance mutation admission is unavailable')
    }
  }
}
