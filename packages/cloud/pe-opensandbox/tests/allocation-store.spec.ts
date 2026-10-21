/** Scripted-driver component evidence only: no test here executes PostgreSQL or creates a sandbox. */
import { Buffer } from 'node:buffer'
import { brandString } from '@deepseek-ai/dsh-brand'
import { SessionId } from '@deepseek-ai/dsh-session'
import type { AccountId, OwnerEpoch } from '@deepseek-ai/dsh-pe-cloud-runtime/types'
import type { WorkspaceId } from '@deepseek-ai/dsh-workspace'
import { expect, it } from 'vitest'
import { AllocationQueryNotSubmittedError, AllocationStoreError, PostgresAllocationStore } from '../src/allocation-store.ts'
import type {
  AllocationCreateIntent, AllocationId, AllocationQuery, AllocationState, AllocationStoreLimits, SandboxAllocation,
} from '../src/allocation-types.ts'
import { allocationMigrationSql } from '../src/migrations/allocations.ts'
import { PROTOCOL } from '../src/agent-data/constants.ts'

const limits: AllocationStoreLimits = {
  maxFieldBytes: 256, maxInputBytes: 65536, maxRowBytes: 4096, maxResultBytes: 16384,
  maxRows: 4, maxCapabilities: 5, maxPendingQueries: 2, maxMutationResponsibilities: 2, maxRetainedBytes: 262144,
}
const intent: AllocationCreateIntent = Object.freeze({
  allocationId: brandString<AllocationId>('allocation-1'), accountId: brandString<AccountId>('account-1'),
  sessionId: SessionId('session-1'), workspaceId: brandString<WorkspaceId>('workspace-1'), epoch: brandString<OwnerEpoch>('1'),
  environmentVersion: 'image-v1', provider: 'opensandbox', projectMountVersion: 'mount-v1',
  requestedAt: '2026-10-20T00:00:00.000Z', createDeadlineAt: '2026-10-20T00:01:00.000Z',
})
const ready = { to: 'ready' as const, sandboxId: 'sandbox-1', runtimeIdentity: 'runtime-1',
  executionProtocolVersion: 'exec-v1', executionCapabilities: ['argv-collect'] as const }

function allocation(state: AllocationState = 'creating', change: Partial<SandboxAllocation> = {}): SandboxAllocation {
  const running = state === 'ready' || state === 'stopping' || state === 'released'
  return { ...intent, state, sandboxId: running ? 'sandbox-1' : null,
    lastActivityAt: intent.requestedAt, lastCheckedAt: intent.requestedAt,
    runtimeIdentity: running ? 'runtime-1' : null, executionProtocolVersion: running ? 'exec-v1' : null,
    executionCapabilities: running ? ['argv-collect'] : [],
    failureCode: state === 'uncertain' || state === 'failed' ? 'CREATE_FAILED' : null, ...change }
}
const row = (value: unknown = allocation()) => ({ allocation: value })
type Rows = Awaited<ReturnType<AllocationQuery['query']>>
type Handler = (sql: string, values: readonly (string | null)[]) => Rows | Promise<Rows>
function fixture(handler: Handler, changes: Partial<AllocationStoreLimits> = {}) {
  const calls: { sql: string; values: readonly (string | null)[] }[] = []
  const query: AllocationQuery = { query: async (sql, values) => {
    calls.push({ sql, values })
    return sql === allocationMigrationSql ? { rows: [] } : handler(sql, values)
  } }
  return { store: new PostgresAllocationStore(query, { ...limits, ...changes }), calls, query }
}
class NeverSubmitted extends AllocationQueryNotSubmittedError {
  constructor() { super(); this.name = 'FixtureNeverSubmitted' }
}

async function admissionFailure(actual: Promise<unknown>, code: 'capacity' | 'invalid-input'): Promise<void> {
  await expect(actual).rejects.toBeInstanceOf(AllocationQueryNotSubmittedError)
  await expect(actual).rejects.toMatchObject({ code, message: 'Allocation statement was not submitted.',
    cause: { code, message: `Allocation store ${code}.` } })
  await expect(actual).rejects.toHaveProperty('cause', expect.any(AllocationStoreError))
}

it('keeps operations closed before atomic migration and declares the required unique/schema checks', async () => {
  const f = fixture(() => ({ rows: [] }))
  expect(() => f.store.begin(intent)).toThrow('unavailable')
  await expect(f.store.get(intent)).rejects.toMatchObject({ code: 'unavailable' })
  const first = f.store.migrate()
  expect(f.store.migrate()).toBe(first)
  await first
  expect(f.calls).toHaveLength(1)
  expect(allocationMigrationSql).toContain('pg_advisory_xact_lock')
  expect(allocationMigrationSql).toContain('CREATE UNIQUE INDEX IF NOT EXISTS pe_sandbox_allocations_nonterminal')
  expect(allocationMigrationSql).toContain("WHERE state IN ('creating','ready','uncertain','stopping')")
  expect(allocationMigrationSql).toContain('incompatible pe_sandbox_allocations indexes')
  expect(allocationMigrationSql).toContain('NOT convalidated')
  expect(allocationMigrationSql).not.toMatch(/DROP TABLE|TRUNCATE|DELETE FROM/)
})

it('coalesces identical begin calls into the same actual promise and keeps capacity after an observer leaves', async () => {
  const finish = Promise.withResolvers<Rows>()
  const f = fixture(() => finish.promise, { maxPendingQueries: 1 })
  await f.store.migrate()
  const actual = f.store.begin(intent)
  const others = Array.from({ length: 8 }, () => f.store.begin({ ...intent }))
  expect(others.every(value => value === actual)).toBe(true)
  expect(() => f.store.begin({ ...intent, environmentVersion: 'other' })).toThrow('conflict')
  expect(await Promise.race([actual.then(() => 'settled'), Promise.resolve('observer-left')])).toBe('observer-left')
  expect(f.store.inspect()).toMatchObject({ pendingQueries: 1, mutationResponsibilities: 1 })
  await expect(f.store.begin({ ...intent, sessionId: SessionId('other') })).rejects.toMatchObject({ code: 'capacity' })
  expect(f.calls).toHaveLength(2)
  const submitted = f.calls[1]
  expect(submitted?.sql).not.toContain(intent.accountId)
  expect(submitted?.values.slice(0, 5)).toEqual([
    intent.allocationId, intent.accountId, intent.sessionId, intent.workspaceId, intent.epoch,
  ])
  expect(Object.isFrozen(submitted?.values)).toBe(true)
  finish.resolve({ rows: [{ ...row(), inserted: true }] })
  await expect(actual).resolves.toMatchObject({ inserted: true, allocation: { state: 'creating' } })
  expect(f.store.inspect()).toEqual({ pendingQueries: 0, mutationResponsibilities: 0, unknownMutations: 0, retainedBytes: 0 })
})

it('returns an existing durable row without authorizing create replay and rejects conflicting immutable input', async () => {
  const f = fixture(() => ({ rows: [{ ...row(allocation('ready')), inserted: false }] }))
  await f.store.migrate()
  await expect(f.store.begin(intent)).resolves.toMatchObject({ inserted: false, allocation: { state: 'ready' } })
  await expect(f.store.begin({ ...intent, workspaceId: brandString<WorkspaceId>('other') })).rejects.toMatchObject({ code: 'conflict' })
  expect(f.store.inspect().unknownMutations).toBe(0)
})

it('treats zero-row unique/CAS misses as conflicts and binds every scope field including old epochs', async () => {
  const f = fixture(() => ({ rows: [] }))
  await f.store.migrate()
  await expect(f.store.begin(intent)).rejects.toMatchObject({ code: 'conflict' })
  await expect(f.store.transition({ ...intent, epoch: brandString<OwnerEpoch>('2'), state: 'creating' }, ready))
    .rejects.toMatchObject({ code: 'conflict' })
  expect(f.calls[2]?.values.slice(0, 7)).toEqual([
    intent.allocationId, intent.accountId, intent.sessionId, intent.workspaceId, '2', 'creating', 'ready',
  ])
  expect(f.calls[2]?.sql).toContain('allocation_id=$1 AND account_id=$2 AND session_id=$3 AND workspace_id=$4 AND epoch=$5::bigint')
  expect(f.store.inspect().mutationResponsibilities).toBe(0)
  expect(() => f.store.transition({ ...intent, state: 'ready' }, ready)).toThrow('invalid-input')
})

it('records ready/stopping only by CAS and terminal facts only through explicit Root methods', async () => {
  const f = fixture((_sql, values) => {
    const state = values[6]
    if (state !== 'ready' && state !== 'stopping' && state !== 'failed' && state !== 'released') throw new Error('fixture state')
    return { rows: [row(allocation(state, { failureCode: state === 'failed' ? 'NOT_CREATED' : null }))] }
  })
  await f.store.migrate()
  await expect(f.store.transition({ ...intent, state: 'creating' }, ready)).resolves.toMatchObject({ state: 'ready' })
  await expect(f.store.transition({ ...intent, state: 'ready' }, { to: 'stopping' })).resolves.toMatchObject({ state: 'stopping' })
  await expect(f.store.releaseStopped({ ...intent, state: 'stopping' })).resolves.toMatchObject({ state: 'released' })
  await expect(f.store.failNotCreated({ ...intent, state: 'creating' }, 'NOT_CREATED')).resolves.toMatchObject({ state: 'failed' })
  expect(() => f.store.failNotCreated({ ...intent, state: 'ready' }, 'NO')).toThrow('invalid-input')
  expect(() => f.store.releaseStopped({ ...intent, state: 'uncertain' })).toThrow('invalid-input')
})

it('persists the original namespaced agent protocol without relaxing allocation identifiers', async () => {
  const f = fixture(() => ({ rows: [row(allocation('ready', { executionProtocolVersion: PROTOCOL }))] }))
  await f.store.migrate()
  const stored = await f.store.transition({ ...intent, state: 'creating' }, { ...ready, executionProtocolVersion: PROTOCOL })
  expect(stored.executionProtocolVersion).toBe(PROTOCOL)
  expect(f.calls[1]?.values[9]).toBe(PROTOCOL)
  expect((await f.store.get(intent))?.executionProtocolVersion).toBe(PROTOCOL)
  expect(() => f.store.begin({ ...intent, provider: PROTOCOL })).toThrow('invalid-input')
  for (const executionProtocolVersion of ['bad protocol', 'bad\0protocol', 'x'.repeat(257)]) {
    expect(() => f.store.transition({ ...intent, state: 'creating' }, { ...ready, executionProtocolVersion }))
      .toThrow('invalid-input')
  }
  expect(f.calls).toHaveLength(3)
  expect(f.store.inspect()).toEqual({ pendingQueries: 0, mutationResponsibilities: 0, unknownMutations: 0, retainedBytes: 0 })
})

it('pins submitted unknown writes and bytes; absent exact reads or empty lists never clear them', async () => {
  let writes = 0
  const f = fixture((sql) => {
    if (sql.startsWith('WITH inserted')) { writes++; throw new Error('driver lost response after submit') }
    return { rows: [] }
  }, { maxMutationResponsibilities: 1 })
  await f.store.migrate()
  await expect(f.store.begin(intent)).rejects.toMatchObject({ code: 'unknown' })
  const retained = f.store.inspect().retainedBytes
  expect(retained).toBeGreaterThan(0)
  await expect(f.store.get(intent)).resolves.toBeUndefined()
  await expect(f.store.listNonterminal(null, null, 1)).resolves.toEqual({ allocations: [], nextCursor: null })
  await expect(f.store.begin(intent)).rejects.toMatchObject({ code: 'unknown' })
  await expect(f.store.begin({ ...intent, sessionId: SessionId('other') })).rejects.toMatchObject({ code: 'capacity' })
  expect(f.store.inspect()).toEqual({ pendingQueries: 0, mutationResponsibilities: 1, unknownMutations: 1, retainedBytes: retained })
  expect(writes).toBe(1)
})

it('releases only trusted never-submitted writes and can explicitly try that id again', async () => {
  let attempts = 0
  const f = fixture(() => {
    if (++attempts === 1) throw new NeverSubmitted()
    return { rows: [{ ...row(), inserted: true }] }
  })
  await f.store.migrate()
  await expect(f.store.begin(intent)).rejects.toBeInstanceOf(NeverSubmitted)
  expect(f.store.inspect().retainedBytes).toBe(0)
  await expect(f.store.begin(intent)).resolves.toMatchObject({ inserted: true })
  expect(attempts).toBe(2)
})

it('pins malformed mutation results while malformed reads fail without inventing an absent row', async () => {
  const bad = row({ ...allocation('ready'), sandboxId: null })
  const f = fixture(sql => ({ rows: sql.startsWith('WITH inserted') ? [{ ...bad, inserted: true }] : [bad] }))
  await f.store.migrate()
  await expect(f.store.begin(intent)).rejects.toMatchObject({ code: 'unknown' })
  await expect(f.store.get(intent)).rejects.toMatchObject({ code: 'invalid-row' })
  expect(f.store.inspect().unknownMutations).toBe(1)
})

it('bounds metadata, row/result bytes, row counts and retained pending input before reuse', async () => {
  const one = row(), size = Buffer.byteLength(JSON.stringify(one))
  const f = fixture(() => ({ rows: [one, row(allocation('creating', {
    allocationId: brandString<AllocationId>('allocation-2'), sessionId: SessionId('session-2'),
  }))] }), { maxRowBytes: size + 8, maxResultBytes: size + 8 })
  await f.store.migrate()
  await expect(f.store.listNonterminal(null, null, 2)).rejects.toMatchObject({ code: 'invalid-row' })
  await expect(f.store.get(intent)).rejects.toMatchObject({ code: 'invalid-row' })
  expect(() => f.store.begin({ ...intent, provider: 'https://not-a-backend' })).toThrow('invalid-input')
  expect(() => f.store.begin({ ...intent, environmentVersion: 'x'.repeat(257) })).toThrow('invalid-input')
  expect(() => f.store.begin({ ...intent, createDeadlineAt: 'not-a-date' })).toThrow('invalid-input')
  const held = Promise.withResolvers<Rows>()
  const migrationBytes = Buffer.byteLength(allocationMigrationSql) + 2 * Buffer.byteLength('[]') + Buffer.byteLength('migration')
  const bounded = fixture(() => held.promise, { maxRetainedBytes: migrationBytes, maxPendingQueries: 32 })
  await bounded.store.migrate()
  const actual: Promise<unknown>[] = []
  let exhausted = false
  for (let index = 0; index < 16; index++) {
    const before = bounded.store.inspect().pendingQueries
    const read = bounded.store.get(intent)
    if (bounded.store.inspect().pendingQueries === before) {
      await expect(read).rejects.toMatchObject({ code: 'capacity' })
      exhausted = true
      break
    }
    actual.push(read)
  }
  expect(exhausted).toBe(true)
  const pendingBytes = bounded.store.inspect().retainedBytes
  expect(pendingBytes).toBeGreaterThan(0)
  expect(pendingBytes).toBeLessThanOrEqual(migrationBytes)
  held.resolve({ rows: [] })
  await Promise.all(actual)
  expect(bounded.store.inspect().retainedBytes).toBe(0)
})

it('restores only durable rows in bounded ordered pages with no automatic create/exec replay', async () => {
  const durable = allocation('uncertain')
  const f = fixture((_sql, values) => ({ rows: values[2] === null ? [row(durable)] : [] }))
  await f.store.migrate()
  const page = await f.store.listNonterminal({ accountId: intent.accountId, epoch: intent.epoch }, null, 1)
  expect(page.allocations).toEqual([durable])
  expect(page.nextCursor).toBe(intent.allocationId)
  await expect(f.store.listNonterminal({ accountId: intent.accountId, epoch: intent.epoch }, page.nextCursor, 1))
    .resolves.toEqual({ allocations: [], nextCursor: null })
  expect(f.calls[1]?.values).toEqual([intent.accountId, intent.epoch, null, '1'])
  expect(f.calls.slice(1).every(call => call.sql.startsWith('SELECT'))).toBe(true)
})

it('rejects incompatible migration failure without resetting schema or retrying submitted DDL', async () => {
  let statements = 0
  const store = new PostgresAllocationStore({ query: async () => { statements++; throw new Error('incompatible schema') } }, limits)
  const actual = store.migrate()
  await expect(actual).rejects.toMatchObject({ code: 'unknown' })
  expect(store.migrate()).toBe(actual)
  expect(store.inspect()).toMatchObject({ mutationResponsibilities: 1, unknownMutations: 1, pendingQueries: 0 })
  expect(() => store.reconcileCommitted(intent)).toThrow('unavailable')
  expect(statements).toBe(1)
})

it('reconciles only after actual write settlement, captures input copies and coalesces one exact read and release', async () => {
  const write = Promise.withResolvers<Rows>(), read = Promise.withResolvers<Rows>()
  const f = fixture(sql => sql.startsWith('WITH inserted') ? write.promise : read.promise, { maxPendingQueries: 1 })
  await f.store.migrate()
  const mutable = { ...intent }
  const actualWrite = f.store.begin(mutable)
  await expect(f.store.reconcileCommitted(intent)).rejects.toMatchObject({ code: 'unknown' })
  expect(f.calls).toHaveLength(2)
  Object.assign(mutable, { allocationId: brandString<AllocationId>('mutated'), accountId: brandString<AccountId>('mutated'),
    sessionId: SessionId('mutated'), workspaceId: brandString<WorkspaceId>('mutated'), epoch: brandString<OwnerEpoch>('2'),
    environmentVersion: 'mutated', provider: 'mutated', projectMountVersion: 'mutated',
    requestedAt: '2026-10-21T00:00:00.000Z', createDeadlineAt: '2026-10-21T00:01:00.000Z' })
  write.reject(new Error('settled write lost receipt'))
  await expect(actualWrite).rejects.toMatchObject({ code: 'unknown' })
  const retained = f.store.inspect().retainedBytes
  const actual = f.store.reconcileCommitted(intent)
  const others = Array.from({ length: 8 }, () => f.store.reconcileCommitted({ ...intent }))
  expect(others.every(value => value === actual)).toBe(true)
  await expect(f.store.reconcileCommitted({ ...intent, workspaceId: brandString<WorkspaceId>('other') }))
    .rejects.toMatchObject({ code: 'conflict' })
  expect(f.store.inspect()).toMatchObject({ pendingQueries: 1, mutationResponsibilities: 1, unknownMutations: 1 })
  expect(f.store.inspect().retainedBytes).toBeGreaterThan(retained)
  await expect(f.store.get(intent)).rejects.toMatchObject({ code: 'capacity' })
  expect(f.calls).toHaveLength(3)
  expect(f.calls[2]?.values).toEqual([intent.allocationId, intent.accountId, intent.sessionId, intent.workspaceId, intent.epoch])
  read.resolve({ rows: [row()] })
  await expect(actual).resolves.toEqual(allocation())
  await Promise.all(others)
  expect(f.store.inspect()).toEqual({ pendingQueries: 0, mutationResponsibilities: 0, unknownMutations: 0, retainedBytes: 0 })
  await expect(f.store.reconcileCommitted(intent)).rejects.toMatchObject({ code: 'conflict' })
  expect(f.calls).toHaveLength(3)
})

it.each([
  { allocationId: brandString<AllocationId>('other') }, { accountId: brandString<AccountId>('other') },
  { sessionId: SessionId('other') }, { workspaceId: brandString<WorkspaceId>('other') }, { epoch: brandString<OwnerEpoch>('2') },
])('rejects a different reconciliation scope without issuing a read: %j', async (changed) => {
  const f = fixture(() => { throw new Error('settled write lost receipt') })
  await f.store.migrate()
  await expect(f.store.begin(intent)).rejects.toMatchObject({ code: 'unknown' })
  const before = f.store.inspect()
  await expect(f.store.reconcileCommitted({ ...intent, ...changed })).rejects.toMatchObject({ code: 'conflict' })
  expect(f.store.inspect()).toEqual(before)
  expect(f.calls).toHaveLength(2)
})

it.each([
  ['absent', undefined], ['advanced ready', allocation('ready')],
  ['different intent', allocation('creating', { environmentVersion: 'different' })],
  ['different initial fields', allocation('creating', { executionCapabilities: ['argv-collect'] })],
  ['wrong row scope', allocation('creating', { epoch: brandString<OwnerEpoch>('2') })],
] as const)('keeps an unknown begin when PG reports %s', async (_name, durable) => {
  const f = fixture((sql) => {
    if (sql.startsWith('WITH inserted')) throw new Error('settled write lost receipt')
    return { rows: durable === undefined ? [] : [row(durable)] }
  })
  await f.store.migrate()
  await expect(f.store.begin(intent)).rejects.toMatchObject({ code: 'unknown' })
  const before = f.store.inspect()
  await expect(f.store.reconcileCommitted(intent)).rejects.toBeInstanceOf(Error)
  expect(f.store.inspect()).toEqual(before)
  expect(f.calls).toHaveLength(3)
})

it('retains the original write after a read failure and allows another explicit confirmation without write replay', async () => {
  let readFailed = false
  const f = fixture((sql) => {
    if (sql.startsWith('WITH inserted')) throw new Error('settled write lost receipt')
    if (!readFailed) { readFailed = true; throw new Error('read transport failed') }
    return { rows: [row()] }
  })
  await f.store.migrate()
  await expect(f.store.begin(intent)).rejects.toMatchObject({ code: 'unknown' })
  const before = f.store.inspect()
  await expect(f.store.reconcileCommitted(intent)).rejects.toMatchObject({ code: 'unavailable' })
  expect(f.store.inspect()).toEqual(before)
  await expect(f.store.reconcileCommitted(intent)).resolves.toMatchObject({ state: 'creating' })
  expect(f.calls.filter(call => call.sql.startsWith('WITH inserted'))).toHaveLength(1)
  expect(f.store.inspect().retainedBytes).toBe(0)
})

const changeCases: {
  name: string
  before: SandboxAllocation
  after: SandboxAllocation
  run: (store: PostgresAllocationStore) => Promise<SandboxAllocation>
}[] = [
  { name: 'ready', before: allocation(), after: allocation('ready'),
    run: store => store.transition({ ...intent, state: 'creating' }, ready) },
  { name: 'uncertain', before: allocation(), after: allocation('uncertain', { sandboxId: 'late-sandbox', failureCode: 'CREATE_UNKNOWN' }),
    run: store => store.transition({ ...intent, state: 'creating' }, { to: 'uncertain', sandboxId: 'late-sandbox', failureCode: 'CREATE_UNKNOWN' }) },
  { name: 'stopping', before: allocation('ready'), after: allocation('stopping', { failureCode: 'STOP_CHECK' }),
    run: store => store.transition({ ...intent, state: 'ready' }, { to: 'stopping', sandboxId: 'sandbox-1', failureCode: 'STOP_CHECK' }) },
  { name: 'failed', before: allocation(), after: allocation('failed', { failureCode: 'NEVER_CREATED' }),
    run: store => store.failNotCreated({ ...intent, state: 'creating' }, 'NEVER_CREATED') },
  { name: 'released', before: allocation('stopping'), after: allocation('released'),
    run: store => store.releaseStopped({ ...intent, state: 'stopping' }) },
]
it.each(changeCases)('retains the preimage and releases only the committed $name postimage', async (sample) => {
  let durable = sample.before
  const f = fixture((sql) => {
    if (sql.startsWith('UPDATE')) throw new Error('settled update lost receipt')
    return { rows: [row(durable)] }
  })
  await f.store.migrate()
  await expect(sample.run(f.store)).rejects.toMatchObject({ code: 'unknown' })
  const before = f.store.inspect()
  await expect(f.store.reconcileCommitted(intent)).rejects.toMatchObject({ code: 'unknown' })
  expect(f.store.inspect()).toEqual(before)
  durable = sample.after
  await expect(f.store.reconcileCommitted(intent)).resolves.toEqual(sample.after)
  expect(f.store.inspect()).toEqual({ pendingQueries: 0, mutationResponsibilities: 0, unknownMutations: 0, retainedBytes: 0 })
  expect(f.calls.filter(call => call.sql.startsWith('UPDATE'))).toHaveLength(1)
})

it.each([
  { sandboxId: 'other' }, { runtimeIdentity: 'other' }, { executionProtocolVersion: 'other' },
  { executionCapabilities: ['pipes'] as const },
])('retains a ready write with conflicting given metadata: %j', async (changed) => {
  const f = fixture((sql) => {
    if (sql.startsWith('UPDATE')) throw new Error('settled update lost receipt')
    return { rows: [row(allocation('ready', changed))] }
  })
  await f.store.migrate()
  await expect(f.store.transition({ ...intent, state: 'creating' }, ready)).rejects.toMatchObject({ code: 'unknown' })
  const before = f.store.inspect()
  await expect(f.store.reconcileCommitted(intent)).rejects.toMatchObject({ code: 'unknown' })
  expect(f.store.inspect()).toEqual(before)
})

it('classifies pending-query admission as never submitted without changing the original pending write or its conflict', async () => {
  const finish = Promise.withResolvers<Rows>()
  const f = fixture(() => finish.promise, { maxPendingQueries: 1 })
  await f.store.migrate()
  const pending = f.store.begin(intent)
  const before = f.store.inspect()
  f.calls.length = 0
  await admissionFailure(f.store.begin({ ...intent, sessionId: SessionId('other') }), 'capacity')
  const conflict = f.store.transition({ ...intent, state: 'creating' }, ready)
  await expect(conflict).rejects.toMatchObject({ code: 'conflict' })
  await expect(conflict).rejects.not.toBeInstanceOf(AllocationQueryNotSubmittedError)
  expect(f.calls).toHaveLength(0)
  expect(f.store.inspect()).toEqual(before)
  finish.resolve({ rows: [{ ...row(), inserted: true }] })
  await pending
  expect(f.store.inspect().retainedBytes).toBe(0)
})

it('classifies exhausted mutation admission without relabeling or releasing another unknown write', async () => {
  const f = fixture(() => { throw new AllocationStoreError('capacity') }, { maxMutationResponsibilities: 1 })
  await f.store.migrate()
  const submitted = f.store.begin(intent)
  await expect(submitted).rejects.toMatchObject({ code: 'unknown' })
  await expect(submitted).rejects.not.toBeInstanceOf(AllocationQueryNotSubmittedError)
  const before = f.store.inspect()
  f.calls.length = 0
  await admissionFailure(f.store.begin({ ...intent, sessionId: SessionId('other') }), 'capacity')
  const existing = f.store.begin(intent)
  await expect(existing).rejects.toMatchObject({ code: 'unknown' })
  await expect(existing).rejects.not.toBeInstanceOf(AllocationQueryNotSubmittedError)
  expect(f.calls).toHaveLength(0)
  expect(f.store.inspect()).toEqual(before)
})

it('classifies serialized-input refusal before any new driver call or responsibility', async () => {
  const f = fixture(() => { throw new Error('Unexpected driver submission') }, { maxInputBytes: 8000, maxFieldBytes: 4096 })
  await f.store.migrate()
  f.calls.length = 0
  await admissionFailure(f.store.begin({ ...intent, environmentVersion: 'x'.repeat(4096) }), 'invalid-input')
  expect(f.calls).toHaveLength(0)
  expect(f.store.inspect()).toEqual({ pendingQueries: 0, mutationResponsibilities: 0, unknownMutations: 0, retainedBytes: 0 })
})

it('classifies retained-byte refusal before a driver call and keeps ordinary read refusal unchanged', async () => {
  const migrationBytes = Buffer.byteLength(allocationMigrationSql) + 2 * Buffer.byteLength('[]') + Buffer.byteLength('migration')
  const f = fixture(() => { throw new Error('Unexpected driver submission') }, { maxRetainedBytes: migrationBytes })
  await f.store.migrate()
  f.calls.length = 0
  const large = { ...intent, allocationId: brandString<AllocationId>('a'.repeat(256)),
    accountId: brandString<AccountId>('a'.repeat(256)), sessionId: SessionId('s'.repeat(256)),
    workspaceId: brandString<WorkspaceId>('w'.repeat(256)), environmentVersion: 'e'.repeat(256),
    provider: 'p'.repeat(256), projectMountVersion: 'm'.repeat(256) }
  await admissionFailure(f.store.begin(large), 'capacity')
  expect(f.calls).toHaveLength(0)
  expect(f.store.inspect()).toEqual({ pendingQueries: 0, mutationResponsibilities: 0, unknownMutations: 0, retainedBytes: 0 })
  // A large read is still an ordinary bounded read, never a business-write admission certificate.
  const readLimited = fixture(() => ({ rows: [] }), { maxInputBytes: 8000, maxFieldBytes: 4096 })
  await readLimited.store.migrate()
  readLimited.calls.length = 0
  const read = readLimited.store.get({ ...intent, allocationId: brandString<AllocationId>('a'.repeat(4096)),
    accountId: brandString<AccountId>('a'.repeat(4096)), sessionId: SessionId('s'.repeat(4096)),
    workspaceId: brandString<WorkspaceId>('w'.repeat(4096)) })
  await expect(read).rejects.toMatchObject({ code: 'invalid-input' })
  await expect(read).rejects.not.toBeInstanceOf(AllocationQueryNotSubmittedError)
  expect(readLimited.calls).toHaveLength(0)
})
