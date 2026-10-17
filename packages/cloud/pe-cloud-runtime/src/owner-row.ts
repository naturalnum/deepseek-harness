/** Validate persisted PostgreSQL rows before branding account or owner identifiers. */
import { brandString } from '@deepseek-ai/dsh-brand'
import { AccountRuntimeError } from './errors.ts'
import type { AccountId, AccountOwner, AccountOwnerPhase, InstanceId, OwnerEpoch } from './types.ts'

/**
 * Admit a positive PostgreSQL bigint without passing through Number.
 * @param value Decimal text from a database row or trusted claim input.
 * @returns The same lossless value.
 */
export function ownerEpoch(value: string): OwnerEpoch {
  if (!/^[1-9][0-9]{0,18}$/.test(value) || BigInt(value) > 9_223_372_036_854_775_807n) {
    throw new AccountRuntimeError('cloud/invalid-config', 'Owner epoch must be a positive PostgreSQL bigint string')
  }
  return brandString<OwnerEpoch>(value)
}

function record(value: unknown): Record<string, unknown> {
  if (typeof value !== 'object' || value === null || Array.isArray(value)) invalidRow()
  return value as Record<string, unknown>
}

function text(value: unknown): string {
  if (typeof value !== 'string' || value.length === 0) invalidRow()
  return value
}

function phase(value: unknown): AccountOwnerPhase {
  switch (value) {
    case 'unowned': case 'mounting': case 'ready': case 'draining': case 'parked': case 'reconfiguring': case 'quarantined': return value
    default: return invalidRow()
  }
}

function timestamp(value: unknown): string {
  const input = text(value)
  if (!/^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}\.\d{6}Z$/.test(input) || !Number.isFinite(Date.parse(input))) invalidRow()
  return new Date(input).toISOString()
}

function invalidRow(): never {
  throw new AccountRuntimeError('cloud/account-unavailable', 'Persisted owner data is not trusted; stop owner admission')
}

/**
 * Decode the owned query projection; database JSON is not an AccountBinding or browser credential.
 * @param input Driver row containing one owner JSON projection.
 * @returns A validated immutable control record.
 */
export function readOwnerRow(input: unknown): AccountOwner {
  const row = record(record(input)['owner'])
  const currentPhase = phase(row['phase'])
  const instance = row['ownerInstanceId'] === null ? null : brandString<InstanceId>(text(row['ownerInstanceId']))
  if ((currentPhase === 'unowned') !== (instance === null)) invalidRow()
  return Object.freeze({
    accountId: brandString<AccountId>(text(row['accountId'])),
    ownerInstanceId: instance,
    epoch: ownerEpoch(text(row['epoch'])),
    phase: currentPhase,
    recipeVersion: text(row['recipeVersion']),
    heartbeatAt: timestamp(row['heartbeatAt']),
    updatedAt: timestamp(row['updatedAt']),
  })
}
