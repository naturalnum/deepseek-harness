/** Opt-in actual PG cases for a Root-provisioned empty isolated database. Importing this module connects nowhere. */
import { expect } from 'vitest'
import { brandString } from '@deepseek-ai/dsh-brand'
import { PostgresOwnerStore } from '../src/owner-store.ts'
import { instanceMigrationSql } from '../src/migrations/instances.ts'
import { recoverReleasedSql } from '../src/owner-sql.ts'
import type { OwnerPgExecutor, OwnerRecoveryAuthority, OwnerRecoveryExpectation, OwnerRecoveryProof, RecoveryAuditRef } from '../src/owner-types.ts'
import { account, epoch, instance, limits } from './owner-fixture.ts'

const replacement = brandString<typeof instance>('recovery-pg-replacement')
const empty = 'TRUNCATE public.pe_recovery_audit, public.pe_account_owners, public.pe_sandbox_allocations, public.pe_instances'
const seedAllocation = `INSERT INTO public.pe_sandbox_allocations(
  allocation_id,account_id,session_id,workspace_id,epoch,environment_version,provider,state,project_mount_version,
  requested_at,create_deadline_at,last_activity_at,last_checked_at)
VALUES($1,$2,'fixture-session','fixture-workspace',$3::bigint,'fixture-env','fixture-provider',$4,'fixture-mount',
  statement_timestamp(),statement_timestamp()+interval '1 minute',statement_timestamp(),statement_timestamp())`

/** Execute only on a newly provisioned dedicated fixture; creates no service/database and discovers no credentials.
 * @param executor Root-owned per-statement executor with finite connection, statement and lock budgets.
 * @param identity Explicit newly-created database and dedicated login role; rejects existing application tables.
 * @param migrateAllocations Original execution owner's migration callback for this same fresh fixture.
 * @returns Completed case names. Root must close the actual executor and destroy its fixture separately.
 */
export async function runOwnerRecoveryPostgresCases(
  executor: OwnerPgExecutor, identity: { readonly database: string; readonly role: string },
  migrateAllocations: () => Promise<void>,
): Promise<readonly string[]> {
  if (!/^s4_recovery_worker1_[a-z0-9_]+$/.test(identity.database)) throw new Error('A fresh dedicated recovery fixture is required')
  const initial = await executor.query(`SELECT current_database() AS database,current_user::text AS role,
    (SELECT count(*)::integer FROM pg_tables WHERE schemaname='public') AS tables`, [])
  expect(initial.rows).toEqual([{ database: identity.database, role: identity.role, tables: 0 }])
  const old = new PostgresOwnerStore(executor, { instanceId: instance }, limits)
  await old.migrate()
  await executor.query(instanceMigrationSql, [])
  await migrateAllocations()
  const completed: string[] = []
  let verifyCount = 0
  let expected: OwnerRecoveryExpectation = { accountId: account, oldInstanceId: instance, epoch,
    auditRef: brandString<RecoveryAuditRef>('fixture-audit') }
  let allocationIds: string[] = [], role = identity.role
  let beforeProof: (() => Promise<void>) | undefined
  const authority: OwnerRecoveryAuthority = { instanceId: replacement, verifierId: 'local-original-process-and-provider-v1',
    limits: { maxAllocations: 8, maxEvidenceRefs: 4, maxReferenceBytes: 256, maxProofBytes: 16384,
      maxAuditRows: 32, maxProofAgeMs: 30_000 },
    verify: async (actual) => {
      verifyCount++
      const at = new Date().toISOString()
      const proof: OwnerRecoveryProof = { ...actual, verifiedAt: at, writersVerifiedAt: at,
        verifierId: 'local-original-process-and-provider-v1', databaseRole: role,
        oldProcessEvidenceRef: 'fixture:dead-process', writerLossEvidenceRef: 'fixture:old-writers-stopped',
        lateCreateFenceEvidenceRef: 'fixture:permanent-create-fence', lateSpawnFenceEvidenceRef: 'fixture:permanent-spawn-fence',
        evidenceRefs: ['fixture:root-publication'], allocations: allocationIds.map(allocationId => ({
          allocationId, evidenceRefs: ['fixture:destroyed'] })) }
      await beforeProof?.()
      return proof
    } }
  const store = new PostgresOwnerStore(executor, { instanceId: replacement }, limits, authority)
  await store.migrate(); await store.migrateRecovery(); await store.migrateRecovery()
  async function reset() {
    await executor.query(empty, [])
    allocationIds = []; role = identity.role; beforeProof = undefined
    await old.claim({ accountId: account, expectedEpoch: null, recipeVersion: 'fixture' })
    await executor.query(`INSERT INTO public.pe_instances(instance_id,internal_address,recipe_version,phase)
      VALUES($1,'fixture-old:1234','fixture','registered')`, [instance])
  }
  async function refused(label: string) {
    await expect(store.recoverReleased(expected)).rejects.toMatchObject({ code: 'cloud/stale-generation' })
    expect(await store.locate(account)).toMatchObject({ ownerInstanceId: instance, epoch: '1' })
    const count = await executor.query('SELECT count(*)::integer AS count FROM public.pe_recovery_audit', [])
    expect(count.rows).toEqual([{ count: 0 }])
    completed.push(label)
  }
  for (const phase of ['mounting', 'ready', 'draining', 'quarantined'] as const) {
    await reset()
    if (phase === 'ready') await old.ready(expected, 'fixture')
    if (phase === 'draining') await old.beginDrain(expected)
    if (phase === 'quarantined') await old.quarantine(expected)
    await executor.query(seedAllocation, ['allocation-one', account, epoch, 'released'])
    allocationIds = ['allocation-one']
    const before = verifyCount, audit = await store.recoverReleased(expected)
    expect(audit.postimage).toMatchObject({ phase: 'unowned', ownerInstanceId: null, epoch: '1' })
    expect(await store.recoverReleased(expected)).toEqual(audit)
    expect(verifyCount).toBe(before + 1)
    expect(await store.claim({ accountId: account, expectedEpoch: epoch, recipeVersion: 'next' })).toMatchObject({ epoch: '2' })
    expect((await store.inspectRecovery(expected)).matchesPostimage).toBe(false)
    completed.push(phase + ': atomic release/audit, duplicate, next epoch')
  }
  await reset()
  await executor.query(seedAllocation, ['allocation-one', account, epoch, 'creating'])
  allocationIds = ['allocation-one']
  await refused('creating with null sandbox id')
  await reset()
  beforeProof = async () => { await executor.query(seedAllocation, ['late-allocation', account, epoch, 'creating']) }
  await refused('late row inserted after verifier observation')
  await reset()
  await executor.query(seedAllocation, ['uncovered-terminal', account, epoch, 'released'])
  await refused('uncovered retained allocation')
  await reset(); role = 'wrong-dedicated-role'
  await refused('wrong database role')
  await reset()
  const exact = expected
  expected = { ...exact, oldInstanceId: brandString<typeof instance>('wrong-old') }
  await refused('wrong old instance')
  expected = { ...exact, epoch: brandString<typeof epoch>('2') }
  await refused('wrong epoch')
  expected = exact

  await reset()
  const oldBackend = executor.query('SELECT pg_sleep(2)', [])
  try {
    let observed = false
    for (let attempt = 0; attempt < 20; attempt++) {
      const active = await executor.query(`SELECT count(*)::integer AS count FROM pg_stat_activity
        WHERE usename=current_user AND pid<>pg_backend_pid() AND query='SELECT pg_sleep(2)'`, [])
      if (JSON.stringify(active.rows) === '[{"count":1}]') { observed = true; break }
      await new Promise(resolve => setTimeout(resolve, 10))
    }
    expect(observed).toBe(true)
    await refused('same-role old client backend remains alive')
  } finally { await oldBackend }

  await reset()
  const preparedSupport = await executor.query("SELECT current_setting('max_prepared_transactions')::integer AS maximum", [])
  const maximum: unknown = Reflect.get(preparedSupport.rows[0] as object, 'maximum')
  if (typeof maximum !== 'number' || maximum < 1) {
    throw new Error('The dedicated PG fixture must enable prepared transactions to execute the required negative case')
  }
  // identity.database has already matched a closed identifier regex and current_database().
  const gid = 's4recovery_' + identity.database
  await executor.query('BEGIN; UPDATE public.pe_account_owners SET heartbeat_at=clock_timestamp() '
    + "WHERE account_id='owner-store-test-account'; PREPARE TRANSACTION '" + gid + "'", [])
  try { await refused('same-role prepared transaction survives old client exit') }
  finally { await executor.query("ROLLBACK PREPARED '" + gid + "'", []) }
  completed.push('prepared transaction explicitly rolled back by fixture teardown')

  await reset()
  await store.recoverReleased(expected)
  const closing = { ...expected, internalAddress: 'fixture-old:1234', recipeVersion: 'fixture' }
  const other = brandString<typeof account>('fixture-other-account')
  await old.claim({ accountId: other, expectedEpoch: null, recipeVersion: 'fixture' })
  await expect(store.closeRecoveredInstance(closing)).rejects.toMatchObject({ code: 'cloud/stop-unconfirmed' })
  await store.recoverReleased({ ...expected, accountId: other, auditRef: brandString<RecoveryAuditRef>('fixture-other-audit') })
  await expect(store.closeRecoveredInstance({ ...closing, internalAddress: 'wrong-address' }))
    .rejects.toMatchObject({ code: 'cloud/stale-generation' })
  expect(await store.closeRecoveredInstance(closing)).toMatchObject({ instanceId: instance, alreadyClosed: false })
  const beforeDuplicate = verifyCount
  expect(await store.closeRecoveredInstance(closing)).toMatchObject({ alreadyClosed: true })
  expect(verifyCount).toBe(beforeDuplicate)
  expect(await store.inspectRecoveredInstance(closing)).toMatchObject({ audited: true, closed: true, retainedOwners: false })
  completed.push('independent exact old-instance closure: retained foreign account blocks, wrong address refuses, duplicate skips verifier')

  await reset()
  let mutations = 0
  const losing: OwnerPgExecutor = { query: async (sql, values) => {
    const result = await executor.query(sql, values)
    if (sql === recoverReleasedSql) { mutations++; throw new Error('Synthetic reply loss after actual PostgreSQL commit') }
    return result
  } }
  const uncertain = new PostgresOwnerStore(losing, { instanceId: replacement }, limits, authority)
  await uncertain.migrate(); await uncertain.migrateRecovery()
  await expect(uncertain.recoverReleased(expected)).rejects.toMatchObject({ code: 'cloud/account-unavailable' })
  expect(await uncertain.inspectRecovery(expected)).toMatchObject({ matchesPostimage: true, responsibilityRetained: true })
  await expect(uncertain.recoverReleased(expected)).rejects.toMatchObject({ code: 'cloud/account-quarantined' })
  expect(mutations).toBe(1)
  completed.push('unknown committed reply: exact read-only reconciliation, no replay, responsibility retained')
  return Object.freeze(completed)
}
