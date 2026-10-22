/** Explicitly opted-in PostgreSQL17 fixture; never connects to the application database or discovers credentials. */
import { constants, openSync, readSync, closeSync, writeFileSync } from 'node:fs'
import { dirname, join } from 'node:path'
import { Client } from 'pg'
import { expect, it, vi } from 'vitest'
import { brandString } from '@deepseek-ai/dsh-brand'
import { PgOwnerExecutor } from '../src/owner-pg-executor.ts'
import { PostgresOwnerStore } from '../src/owner-store.ts'
import { AccountRuntimeError } from '../src/errors.ts'
import { recoverReleasedSql, closeRecoveredInstanceSql } from '../src/owner-sql.ts'
import type { OwnerRecoveryAuthority, OwnerRecoveryExpectation, OwnerRecoveryProof, RecoveryAuditRef } from '../src/owner-types.ts'
import { allocationMigrationSql } from '../../pe-opensandbox/src/migrations/allocations.ts'
import { runOwnerRecoveryPostgresCases } from './owner-recovery-postgres-cases.ts'
import { account, epoch, instance, limits } from './owner-fixture.ts'

const fixturePath = process.env.DSH_CLOUD_RECOVERY_PG_FIXTURE
interface Fixture { readonly port: number; readonly database: string; readonly role: string }
function readFixture(path: string): Fixture {
  const fd = openSync(path, constants.O_RDONLY | constants.O_NOFOLLOW)
  let value: unknown
  try {
    const bytes = Buffer.alloc(16385)
    let size = 0
    while (size < bytes.length) {
      const count = readSync(fd, bytes, size, bytes.length - size, size)
      if (count === 0) break
      size += count
    }
    if (size > 16384) throw new Error('Recovery fixture manifest exceeded its byte bound')
    value = JSON.parse(new TextDecoder('utf8', { fatal: true }).decode(bytes.subarray(0, size)))
  } finally { closeSync(fd) }
  if (value === null || typeof value !== 'object' || Array.isArray(value)) throw new Error('Explicit recovery fixture required')
  const row = value as Record<string, unknown>
  if (typeof row.port !== 'number' || !Number.isInteger(row.port) || row.port < 1 || row.port > 65535
    || typeof row.database !== 'string' || !/^s4_recovery_worker1_[a-f0-9]{32}$/.test(row.database)
    || typeof row.role !== 'string' || row.role !== row.database.replace('s4_recovery_worker1_', 's4_recovery_worker1_role_')) {
    throw new Error('Only the exact owned loopback recovery fixture may run these cases')
  }
  return { port: row.port, database: row.database, role: row.role }
}

function connection(fixture: Fixture, user: string) {
  return { host: '127.0.0.1', port: fixture.port, database: fixture.database, user, password: '', ssl: false as const,
    connectionTimeoutMillis: 2000, statement_timeout: 5000, lock_timeout: 1000, query_timeout: 0 }
}

async function snapshotCases(executor: PgOwnerExecutor, fixture: Fixture): Promise<readonly string[]> {
  const replacement = brandString<typeof instance>('snapshot-fixture-replacement')
  const expected: OwnerRecoveryExpectation = { accountId: account, oldInstanceId: instance, epoch,
    auditRef: brandString<RecoveryAuditRef>('snapshot-fixture-audit') }
  const old = new PostgresOwnerStore(executor, { instanceId: instance }, limits)
  await old.migrate()
  const makeProof = (): OwnerRecoveryProof => {
    const at = new Date(Date.now() - 1).toISOString()
    return { ...expected, verifierId: 'local-original-process-and-provider-v1', verifiedAt: at, writersVerifiedAt: at,
      databaseRole: fixture.role, oldProcessEvidenceRef: 'fixture:process', writerLossEvidenceRef: 'fixture:writers',
      lateCreateFenceEvidenceRef: 'fixture:create-fence', lateSpawnFenceEvidenceRef: 'fixture:spawn-fence',
      evidenceRefs: ['fixture:publication'], allocations: [] }
  }
  const authority: OwnerRecoveryAuthority = { instanceId: replacement, verifierId: 'local-original-process-and-provider-v1',
    limits: { maxAllocations: 8, maxEvidenceRefs: 4, maxReferenceBytes: 256, maxProofBytes: 16384,
      maxAuditRows: 32, maxProofAgeMs: 30000 }, verify: () => Promise.resolve(makeProof()) }
  const store = new PostgresOwnerStore(executor, { instanceId: replacement }, limits, authority)
  await store.migrate(); await store.migrateRecovery()
  const completed: string[] = []
  const closing = { ...expected, internalAddress: 'fixture-old:1234', recipeVersion: 'fixture' }
  const reset = async () => {
    await executor.query('TRUNCATE public.pe_recovery_audit,public.pe_account_owners,public.pe_sandbox_allocations,public.pe_instances', [])
    await old.claim({ accountId: account, expectedEpoch: null, recipeVersion: 'fixture' })
    await executor.query(`INSERT INTO public.pe_instances(instance_id,internal_address,recipe_version,phase)
      VALUES($1,'fixture-old:1234','fixture','registered')`, [instance])
  }
  for (const target of ['allocation', 'owner'] as const) {
    await reset()
    if (target === 'owner') await store.recoverReleased(expected)
    const locker = new Client(connection(fixture, 'postgres'))
    let committed = false
    let outcome: Promise<{ ok: boolean; code?: string }> | undefined
    try {
      await locker.connect()
      await locker.query('BEGIN')
      if (target === 'allocation') {
        await locker.query(`INSERT INTO public.pe_sandbox_allocations(allocation_id,account_id,session_id,workspace_id,epoch,
          environment_version,provider,state,project_mount_version,requested_at,create_deadline_at,last_activity_at,last_checked_at)
          VALUES('late-fixture',$1,'fixture-session','fixture-workspace',$2::bigint,'fixture-env','fixture-provider','creating',
          'fixture-mount',statement_timestamp(),statement_timestamp()+interval '1 minute',statement_timestamp(),statement_timestamp())`, [account, epoch])
      } else {
        await locker.query(`INSERT INTO public.pe_account_owners(account_id,owner_instance_id,epoch,phase,recipe_version)
          VALUES('late-fixture-account',$1,1,'mounting','fixture')`, [instance])
      }
      const work = target === 'allocation' ? store.recoverReleased(expected) : store.closeRecoveredInstance(closing)
      outcome = work.then(() => ({ ok: true }), (cause: unknown) => ({ ok: false,
        ...(cause instanceof AccountRuntimeError ? { code: cause.code } : {}) }))
      const table = target === 'allocation' ? 'public.pe_sandbox_allocations' : 'public.pe_account_owners'
      await vi.waitFor(async () => {
        // The locker transaction predates the new recovery backend; refresh PostgreSQL's cached activity snapshot.
        await locker.query('SELECT pg_stat_clear_snapshot()')
        const waiting = await locker.query<{ count: number }>(`SELECT count(*)::integer AS count FROM pg_locks l JOIN pg_stat_activity a USING(pid)
          WHERE l.relation=$1::regclass AND l.mode='ShareLock' AND NOT l.granted AND a.usename=$2`, [table, fixture.role])
        expect(waiting.rows[0]?.count).toBe(1)
      }, { timeout: 2000, interval: 10 })
      // A different-role writer prevents the old-client guard from masking the post-lock MVCC assertion.
      await locker.query('COMMIT'); committed = true
      expect(await outcome).toEqual({ ok: false, code: 'cloud/stale-generation' })
      completed.push(target + ': committed late row observed after actual ShareLock wait')
    } finally {
      try { if (!committed) await locker.query('ROLLBACK') }
      finally { await locker.end(); await outcome }
    }
  }
  for (const isolation of ['REPEATABLE READ', 'SERIALIZABLE'] as const) {
    for (const target of ['allocation', 'owner'] as const) {
      await reset()
      if (target === 'owner') await store.recoverReleased(expected)
      const client = new Client(connection(fixture, fixture.role))
      try {
        await client.connect()
        await client.query('BEGIN ISOLATION LEVEL ' + isolation)
        const proof = JSON.stringify(makeProof())
        const result = target === 'allocation'
          ? await client.query(recoverReleasedSql, [account, instance, epoch, expected.auditRef, proof, '8', '32', '30000'])
          : await client.query(closeRecoveredInstanceSql, [account, instance, epoch, expected.auditRef,
            closing.internalAddress, closing.recipeVersion, proof, '30000'])
        expect(result.rows).toEqual([])
        completed.push(target + ': ' + isolation + ' refused before recovery write')
      } finally {
        try { await client.query('ROLLBACK') } finally { await client.end() }
      }
    }
  }
  return completed
}

it.skipIf(fixturePath === undefined)('executes guarded recovery and post-lock snapshot cases in the owned PG17 fixture', async () => {
  if (fixturePath === undefined) throw new Error('Explicit recovery fixture required')
  const fixture = readFixture(fixturePath)
  const executor = new PgOwnerExecutor({ host: '127.0.0.1', port: fixture.port, user: fixture.role, password: '',
    database: fixture.database, ssl: false }, { maxConnections: 4, maxQueued: 8, queueTimeoutMs: 5000,
    connectionTimeoutMs: 2000, statementTimeoutMs: 5000, lockTimeoutMs: 1000, maxObservedOperations: 8, maxObservers: 8 })
  const cases: string[] = []
  let passed = false
  try {
    cases.push(...await runOwnerRecoveryPostgresCases(executor, fixture, async () => { await executor.query(allocationMigrationSql, []) }))
    cases.push(...await snapshotCases(executor, fixture))
    passed = true
  } finally {
    await executor.close()
    writeFileSync(join(dirname(fixturePath), 'root-postgres-cases.json'), JSON.stringify({ passed, cases,
      executor: executor.inspect(), realPostgres: true, productionDatabaseUsed: false }, null, 2) + '\n', { flag: 'wx', mode: 0o600 })
  }
}, 60000) // One actual fixture run includes the bounded two-second live-backend negative and many new driver connections.
