/** Exact original binding persisted alongside Root's owned allocation transitions. */
import type { PreparedSandbox } from './allocation-owner.ts'
import { AllocationReceiptError, type OriginalDeletionBinding } from './allocation-receipt-outbox.ts'
import type { AllocationQuery, AllocationScope, SandboxAllocation } from './allocation-types.ts'
import { allocationBindingMigrationSql } from './migrations/allocation-bindings.ts'

const table = 'public.pe_sandbox_allocation_bindings_v1'
const scopeFields = ['allocationId', 'accountId', 'sessionId', 'workspaceId', 'epoch'] as const
const bindingFields = [...scopeFields, 'sandboxId', 'containerId', 'providerGeneration', 'policyDigest'] as const
const capabilitySet = new Set(['argv-collect', 'pipes', 'control', 'inherit', 'terminal'])
const durable = "current_setting('fsync') = 'on' AND current_setting('synchronous_commit') IN ('on', 'remote_apply')"
const scopeSql = 'a.allocation_id=$1 AND a.account_id=$2 AND a.session_id=$3 AND a.workspace_id=$4 AND a.epoch=$5::bigint'
const exactOriginal = `${scopeSql}
  AND a.sandbox_id IS NOT DISTINCT FROM $10::text AND a.runtime_identity IS NOT DISTINCT FROM $11::text
  AND a.environment_version=$12 AND a.provider=$13 AND a.project_mount_version=$14
  AND a.requested_at=$15::timestamptz AND a.create_deadline_at=$16::timestamptz AND ${durable}`
const insert = `INSERT INTO ${table} (allocation_id, account_id, session_id, workspace_id, epoch, sandbox_id,
  container_id, provider_generation, policy_digest)
  SELECT allocation_id, account_id, session_id, workspace_id, epoch, $6, $7, $8, $9 FROM selected`
const ready = `WITH selected AS (
  UPDATE public.pe_sandbox_allocations AS a SET state='ready', sandbox_id=$6, runtime_identity=$17,
    execution_protocol_version=$18, execution_capabilities=$19::jsonb, failure_code=NULL,
    last_activity_at=statement_timestamp(), last_checked_at=statement_timestamp()
    WHERE ${exactOriginal} AND a.state='creating' AND (a.sandbox_id IS NULL OR a.sandbox_id=$6)
    RETURNING allocation_id, account_id, session_id, workspace_id, epoch
  ) ${insert} RETURNING true AS recorded`
const stopping = `WITH selected AS (
  SELECT a.allocation_id, a.account_id, a.session_id, a.workspace_id, a.epoch FROM public.pe_sandbox_allocations AS a
  WHERE ${exactOriginal} AND a.state='stopping' AND a.sandbox_id=$6 FOR UPDATE
  ) ${insert} ON CONFLICT (allocation_id) DO NOTHING RETURNING true AS recorded`
const readSql = `SELECT jsonb_build_object(
  'state',a.state,'runtimeIdentity',a.runtime_identity,'protocolVersion',a.execution_protocol_version,
  'capabilities',a.execution_capabilities,'binding',jsonb_build_object(
    'allocationId',b.allocation_id,'accountId',b.account_id,'sessionId',b.session_id,'workspaceId',b.workspace_id,
    'epoch',b.epoch::text,'sandboxId',b.sandbox_id,'containerId',b.container_id,
    'providerGeneration',b.provider_generation,'policyDigest',b.policy_digest)) AS retained
  FROM ${table} AS b JOIN public.pe_sandbox_allocations AS a
    ON a.allocation_id=b.allocation_id AND a.account_id=b.account_id AND a.session_id=b.session_id
    AND a.workspace_id=b.workspace_id AND a.epoch=b.epoch AND a.sandbox_id=b.sandbox_id
  WHERE ${scopeSql} AND a.state IN ('ready','stopping','released')`

/** The exact original allocation identity read back from the same durable database. */
export interface RetainedAllocationBinding {
  readonly state: 'ready' | 'stopping' | 'released'
  readonly binding: OriginalDeletionBinding
  readonly runtimeIdentity: string | null
  readonly protocolVersion: string | null
  readonly capabilities: readonly string[]
}

function object(value: unknown): Record<string, unknown> {
  if (typeof value !== 'object' || value === null || Array.isArray(value)) throw new AllocationReceiptError('invalid-evidence')
  return value as Record<string, unknown>
}

function token(value: unknown): value is string {
  return typeof value === 'string' && value.length <= 4096 && /^[A-Za-z0-9]/u.test(value) && !/[^A-Za-z0-9._:-]/u.test(value)
}

function validScope(scope: AllocationScope): void {
  if (![scope.allocationId, scope.accountId, scope.sessionId, scope.workspaceId].every(token)
    || typeof scope.epoch !== 'string' || scope.epoch.length > 19
    || !/^[1-9]/u.test(scope.epoch) || /[^0-9]/u.test(scope.epoch) || BigInt(scope.epoch) > 9_223_372_036_854_775_807n) {
    throw new AllocationReceiptError('invalid-evidence')
  }
}

function validatedBinding(raw: unknown): OriginalDeletionBinding {
  const row = object(raw)
  if (Object.keys(row).length !== bindingFields.length || !bindingFields.every(key => Object.hasOwn(row, key) && token(row[key]))) {
    throw new AllocationReceiptError('invalid-evidence')
  }
  const value = row as unknown as OriginalDeletionBinding
  validScope(value)
  if (value.sandboxId.length !== 36 || !/^[a-f0-9]{8}(?:-[a-f0-9]{4}){3}-[a-f0-9]{12}$/u.test(value.sandboxId)
    || ![value.containerId, value.providerGeneration, value.policyDigest].every(item => item.length === 64 && !/[^0-9a-f]/u.test(item))) {
    throw new AllocationReceiptError('invalid-evidence')
  }
  return Object.freeze({ ...value })
}

function bindingParameters(expected: SandboxAllocation, raw: OriginalDeletionBinding): {
  binding: OriginalDeletionBinding
  values: readonly (string | null)[]
} {
  const binding = validatedBinding(raw)
  if (!scopeFields.every(key => binding[key] === expected[key])
    || (expected.sandboxId !== null && binding.sandboxId !== expected.sandboxId)) {
    throw new AllocationReceiptError('conflict')
  }
  return { binding, values: [...bindingFields.map(key => binding[key]), expected.sandboxId, expected.runtimeIdentity,
    expected.environmentVersion, expected.provider, expected.projectMountVersion, expected.requestedAt, expected.createDeadlineAt] }
}

function capabilities(value: unknown): readonly string[] {
  if (!Array.isArray(value) || value.length > capabilitySet.size || new Set(value).size !== value.length
    || !value.every((item: unknown) => typeof item === 'string' && capabilitySet.has(item))) {
    throw new AllocationReceiptError('invalid-evidence')
  }
  return Object.freeze([...value as string[]].sort())
}

/** Atomic ready publication and immutable original provider identity, separate from the predecessor schema. */
export class PostgresAllocationBindingStorage {
  private migration?: Promise<void>

  /** @param driver Same private Root metadata capability used by the original allocation owner. */
  constructor(private readonly driver: AllocationQuery) {}

  /** @returns The actual, sticky additive migration after the original allocation table is verified. */
  migrate(): Promise<void> {
    return this.migration ??= this.driver.query(allocationBindingMigrationSql, []).then(({ rows }) => {
      if (rows.length !== 0) throw new AllocationReceiptError('invalid-evidence')
    })
  }

  /**
   * Commit creating-to-ready and its original provider identity in the same database transaction.
   * @param expected Exact original creating row from the caller that owns this create.
   * @param prepared Original trusted preparation result for the same sandbox.
   * @param raw Provider identity observed on the already validated original SDK connection.
   * @returns The independently read matching ready identity. A raced stop cannot publish ready.
   */
  async commitReady(expected: SandboxAllocation, prepared: PreparedSandbox,
    raw: OriginalDeletionBinding): Promise<RetainedAllocationBinding> {
    const { binding, values } = bindingParameters(expected, raw)
    const { sandboxId, runtimeIdentity, protocolVersion } = prepared
    const modes = capabilities(prepared.capabilities)
    if (expected.state !== 'creating' || sandboxId !== binding.sandboxId || !token(runtimeIdentity)
      || typeof protocolVersion !== 'string' || protocolVersion.length > 4096
      || !/^[A-Za-z0-9]/u.test(protocolVersion) || /[^A-Za-z0-9._:/-]/u.test(protocolVersion) || modes.length === 0) {
      throw new AllocationReceiptError('invalid-evidence')
    }
    await this.query(ready, [...values, runtimeIdentity, protocolVersion, JSON.stringify(modes)])
      .catch(() => { /* independent readback resolves uncertain mutation responses */ })
    const retained = await this.confirm(binding, 'ready')
    if (retained.runtimeIdentity !== runtimeIdentity || retained.protocolVersion !== protocolVersion
      || JSON.stringify(retained.capabilities) !== JSON.stringify(modes)) throw new AllocationReceiptError('conflict')
    return retained
  }

  /**
   * Attach already observed exact identity when Root's original admission has moved to stopping.
   * @param expected Exact original stopping row, including prior runtime identity when present.
   * @param raw Provider identity retained by the same original lifecycle owner before it lost admission.
   * @returns The same durable, stopping allocation binding without granting or releasing any writer.
   */
  async commitStopping(expected: SandboxAllocation, raw: OriginalDeletionBinding): Promise<RetainedAllocationBinding> {
    const { binding, values } = bindingParameters(expected, raw)
    if (expected.state !== 'stopping' || expected.sandboxId !== binding.sandboxId) throw new AllocationReceiptError('invalid-evidence')
    await this.query(stopping, values).catch(() => { /* independent readback resolves uncertain mutation responses */ })
    const retained = await this.confirm(binding, 'stopping')
    if (retained.runtimeIdentity !== expected.runtimeIdentity) throw new AllocationReceiptError('conflict')
    return retained
  }

  /**
   * Fetch original work identity after restart. Rows from before this migration have no binding.
   * @param scope Complete original allocation key.
   * @returns The durable original provider identity joined to its exact allocation, or no known binding.
   */
  async read(scope: AllocationScope): Promise<RetainedAllocationBinding | undefined> {
    validScope(scope)
    const rows = await this.query(readSql, scopeFields.map(key => scope[key]))
    if (rows.length === 0) return undefined
    if (rows.length !== 1) throw new AllocationReceiptError('invalid-evidence')
    const { state, runtimeIdentity, protocolVersion, binding: raw, capabilities: modes } = object(object(rows[0])['retained'])
    const binding = validatedBinding(raw)
    if ((state !== 'ready' && state !== 'stopping' && state !== 'released') || !scopeFields.every(key => scope[key] === binding[key])
      || (runtimeIdentity !== null && !token(runtimeIdentity)) || (protocolVersion !== null && (typeof protocolVersion !== 'string'
        || protocolVersion.length > 4096 || !/^[A-Za-z0-9]/u.test(protocolVersion) || /[^A-Za-z0-9._:/-]/u.test(protocolVersion)))) {
      throw new AllocationReceiptError('invalid-evidence')
    }
    return Object.freeze({ state, binding, runtimeIdentity, protocolVersion, capabilities: capabilities(modes) })
  }

  private async confirm(binding: OriginalDeletionBinding, state: RetainedAllocationBinding['state']): Promise<RetainedAllocationBinding> {
    const retained = await this.read(binding)
    if (retained === undefined) throw new AllocationReceiptError('release-unconfirmed')
    if (retained.state !== state || !bindingFields.every(key => retained.binding[key] === binding[key])) {
      throw new AllocationReceiptError('conflict')
    }
    return retained
  }

  private async query(sql: string, values: readonly (string | null)[]): Promise<readonly unknown[]> {
    if (this.migration === undefined) throw new AllocationReceiptError('unavailable')
    await this.migration
    return (await this.driver.query(sql, values)).rows
  }
}
