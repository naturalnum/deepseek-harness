/** Owned Linux Node test entry; ordinary PG business role and current source producer imports remain explicit. */
import assert from 'node:assert/strict'
import { randomBytes, randomUUID } from 'node:crypto'
import { chmod, mkdtemp, readFile, rm, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { test } from 'node:test'
import { setTimeout as delay } from 'node:timers/promises'
import { Pool } from 'pg'
import { z } from 'zod'
import { initializeDatabase } from '../src/platform/database.ts'
import { seedNewUser } from '../src/platform/account-settings.ts'
import { hashPassword, IdentityService } from '../src/platform/identity.ts'
import { FileService } from '../src/platform/files.ts'
import { runWorkerFlow } from './employee6-stdio-worker-source-flows.ts'

const file = process.env.PE_EMPLOYEE6_STDIO_INPUT_FILE
assert(file, 'Owned private Linux input file is required')
const config = z.object({ adminUrl: z.string(), tlsRoot: z.string(), imageId: z.string(),
  imageArchitecture: z.enum(['amd64', 'arm64']), receipt: z.string(),
  job: z.enum(['unallocated-cancel-drain', 'discover-call-once-and-reconcile', 'lease-lost-cancel-original']) })
  .parse(JSON.parse(await readFile(file, 'utf8')))
const quote = (value: string) => '"' + value.replaceAll('"', '""') + '"'
process.umask(0o022)
const safeState = new Set(['pending', 'observed', 'finalized', 'deferred', 'lease-lost', 'stopped', 'blocked',
  'succeeded', 'cancelled', 'uncertain', 'completed', 'running', 'failed'])
const safeValue = (value: unknown) => typeof value === 'boolean' || typeof value === 'number'
  || typeof value === 'string' && safeState.has(value) ? value : undefined
const failureObservation = (error: unknown) => {
  const known = error instanceof Error ? error : undefined
  return { name: known?.name,
    code: known && 'code' in known && typeof known.code === 'string' && /^[A-Z0-9_]{1,80}$/u.test(known.code) ? known.code : undefined,
    publicCode: known && /^stdio_v2_[a-z0-9_]+$/u.test(known.message) ? known.message : undefined,
    operator: known && 'operator' in known && typeof known.operator === 'string' ? known.operator : undefined,
    actual: known && 'actual' in known ? safeValue(known.actual) : undefined,
    expected: known && 'expected' in known ? safeValue(known.expected) : undefined,
    fixtureLocation: known?.stack?.match(/employee6-stdio-worker-(?:source-flows|protocol|runtime)\.ts:\d+:\d+/u)?.[0] }
}

await test('current source STDIO Worker ' + config.job, { timeout: 60_000 }, async (t) => {
  assert.equal(process.platform, 'linux')
  assert.equal(process.arch === 'x64' ? 'amd64' : process.arch, config.imageArchitecture,
    'Actual Linux Node architecture must match the inspected immutable image')
  const database = 'pe_e6_stdio_' + randomUUID().replaceAll('-', ''), role = 'pe_e6_role_' + randomUUID().replaceAll('-', '')
  const admin = new Pool({ connectionString: config.adminUrl, max: 1, connectionTimeoutMillis: 1000,
    query_timeout: 10_000, statement_timeout: 10_000 })
  const root = await mkdtemp(join(tmpdir(), 'pe-e6-stdio-')); await chmod(root, 0o755)
  const password = randomBytes(32).toString('hex'), businessUrl = new URL(config.adminUrl)
  businessUrl.pathname = '/' + database; businessUrl.username = role; businessUrl.password = password
  const pool = new Pool({ connectionString: businessUrl.href, max: 10, connectionTimeoutMillis: 1000,
    query_timeout: 10_000, statement_timeout: 10_000 })
  let roleCreated = false, databaseCreated = false
  let outcome: { kind: 'success'; value: Awaited<ReturnType<typeof runWorkerFlow>> } | { kind: 'failure'; error: unknown } | undefined
  const cleanupErrors: string[] = []
  let flowObservations: unknown
  try {
    for (let attempt = 0; ; attempt++) {
      t.signal.throwIfAborted()
      try { await admin.query('SELECT 1'); break }
      catch (error) { if (attempt >= 60) throw error; await delay(100, undefined, { signal: t.signal }) }
    }
    await admin.query(`CREATE ROLE ${quote(role)} LOGIN NOSUPERUSER NOCREATEDB NOCREATEROLE NOREPLICATION NOBYPASSRLS PASSWORD '${password}'`)
    roleCreated = true
    await admin.query(`CREATE DATABASE ${quote(database)} OWNER ${quote(role)}`); databaseCreated = true
    assert.deepEqual((await pool.query('SELECT rolsuper,rolcreatedb,rolcreaterole,rolreplication,rolbypassrls FROM pg_roles WHERE rolname=current_user')).rows,
      [{ rolsuper: false, rolcreatedb: false, rolcreaterole: false, rolreplication: false, rolbypassrls: false }])
    await initializeDatabase(pool)
    const browserPassword = randomUUID()
    await seedNewUser(pool, 'owned-stdio', await hashPassword(browserPassword), { model: 'owned-no-model-request', maxTokens: 64, revision: 1 })
    const identities = new IdentityService(pool, 300_000)
    const owner = await identities.login('owned-stdio', browserPassword), approval = await identities.login('owned-stdio', browserPassword, 'approval')
    const files = new FileService(pool, root, { uid: 1000, gid: 1000 }); await files.init()
    const value = await runWorkerFlow(config.job, { pool, root, files, owner, approval,
      observe: (value) => { flowObservations = value } }, config.tlsRoot, config.imageId, t.signal)
    outcome = { kind: 'success', value }
  } catch (error) { outcome = { kind: 'failure', error } }
  finally {
    try { await pool.end() } catch (_poolCloseFailure) { cleanupErrors.push('business_pool_close_failed') }
    try { if (databaseCreated) await admin.query(`DROP DATABASE ${quote(database)}`); databaseCreated = false }
    catch (_databaseDropFailure) { cleanupErrors.push('owned_database_drop_failed') }
    try { if (roleCreated) await admin.query(`DROP ROLE ${quote(role)}`); roleCreated = false }
    catch (_roleDropFailure) { cleanupErrors.push('owned_role_drop_failed') }
    try { await admin.end() } catch (_adminCloseFailure) { cleanupErrors.push('admin_pool_close_failed') }
    try { await rm(root, { recursive: true, force: true }) } catch (_temporaryCleanupFailure) { cleanupErrors.push('owned_storage_cleanup_failed') }
    await writeFile(config.receipt, JSON.stringify({ job: config.job, pid: process.pid, node: process.version,
      nodeArchitecture: process.arch, imageArchitecture: config.imageArchitecture,
      outcome: outcome?.kind, value: outcome?.kind === 'success' ? outcome.value : undefined,
      failure: outcome?.kind === 'failure' ? failureObservation(outcome.error) : undefined,
      flowObservations,
      roleRemoved: !roleCreated, databaseRemoved: !databaseCreated, cleanupErrors,
      physicalPodQualified: false, sourceServiceFixture: true }, null, 2) + '\n', { mode: 0o600 })
  }
  if (outcome?.kind === 'failure') throw new Error('Owned flow failed: ' + JSON.stringify(failureObservation(outcome.error)))
  assert(outcome?.kind === 'success'); assert.deepEqual(cleanupErrors, [])
})
