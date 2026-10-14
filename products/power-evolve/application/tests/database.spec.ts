/** Real PostgreSQL initialization and transactional failure behavior; no external providers are simulated. */
import { randomUUID } from 'node:crypto'
import { readFile } from 'node:fs/promises'
import { afterEach, expect, test } from 'vitest'
import { Pool } from 'pg'
import { CURRENT_SCHEMA_VERSION, initializeDatabase, transaction } from '../src/platform/database.ts'
import { currentCloudTableNames } from './cloud-fixture.ts'

const path = process.env.PE_TEST_DATABASE_URL_FILE
if (!path) throw new Error('Cloud PG tests require PE_TEST_DATABASE_URL_FILE; missing infrastructure cannot count as acceptance')
const address = new URL((await readFile(path, 'utf8')).trim())
const admin = new Pool({ connectionString: address.href, max: 1 })
const databases: Array<{ name: string; pool: Pool }> = []
const roles: string[] = []
async function database(): Promise<Pool> {
  const name = `pe_cloud_spec_${randomUUID().replaceAll('-', '')}`
  await admin.query(`CREATE DATABASE "${name}"`)
  const url = new URL(address); url.pathname = `/${name}`
  const pool = new Pool({ connectionString: url.href, max: 8 })
  databases.push({ name, pool })
  return pool
}
afterEach(async () => {
  for (const { name, pool } of databases.splice(0)) {
    await pool.end()
    await admin.query(`DROP DATABASE "${name}"`)
  }
  for (const role of roles.splice(0)) await admin.query(`DROP ROLE "${role}"`)
})
import { afterAll } from 'vitest'
afterAll(() => admin.end())

test('two concurrent bootstraps create one cloud schema and retain every included table', async () => {
  const pool = await database()
  await Promise.all([initializeDatabase(pool), initializeDatabase(pool)])
  expect((await pool.query('SELECT family,version FROM pe_schema')).rows).toEqual([{ family: 'cloud-native', version: CURRENT_SCHEMA_VERSION }])
  const names = (await pool.query<{ tablename: string }>("SELECT tablename FROM pg_tables WHERE schemaname='public'")).rows.map(row => row.tablename)
  expect(names.sort()).toEqual(currentCloudTableNames)
  expect(names).toContain('pe_native_writers')
  expect(names).toContain('pe_native_input_claims')
  expect(names).toContain('pe_native_turn_frames')
  expect(names).toContain('pe_native_turn_transitions_v2')
  expect(names).not.toContain('pe_native_turn_transitions')
  expect(names).toContain('pe_native_presentations')
  expect(names).toContain('pe_native_presentation_entries')
  expect(names).toContain('pe_stdio_v2_no_start_closures')
  expect(names).toContain('pe_office_preview_jobs')
  for (const name of ['pe_devices', 'pe_desktop_executions', 'pe_artifacts', 'pe_workspace_binding_requests', 'pe_file_mutations']) expect(names).not.toContain(name)
  await initializeDatabase(pool)
})

test('an old schema is rejected without changing its version or data', async () => {
  const pool = await database()
  await pool.query('CREATE TABLE pe_schema(version integer PRIMARY KEY); INSERT INTO pe_schema VALUES(37); CREATE TABLE old_data(value text); INSERT INTO old_data VALUES(\'preserved\')')
  await expect(initializeDatabase(pool)).rejects.toThrow('isolated cloud import')
  expect((await pool.query('SELECT version FROM pe_schema')).rows).toEqual([{ version: 37 }])
  expect((await pool.query('SELECT value FROM old_data')).rows).toEqual([{ value: 'preserved' }])
})

test.each([0, CURRENT_SCHEMA_VERSION + 1])('cloud version %i refuses unsupported generations', async (version) => {
  const pool = await database(); await initializeDatabase(pool)
  await pool.query('UPDATE pe_schema SET version=$1', [version])
  await expect(initializeDatabase(pool)).rejects.toThrow('Unsupported')
  expect((await pool.query<{ version: number }>('SELECT version FROM pe_schema')).rows).toEqual([{ version }])
})

test('a partial database with a valid family and version does not become ready', async () => {
  const pool = await database()
  await pool.query("CREATE TABLE pe_schema(version integer,family text); INSERT INTO pe_schema VALUES(1,'cloud-native')")
  await expect(initializeDatabase(pool)).rejects.toThrow('Incomplete')
  expect((await pool.query<{ count: number }>('SELECT count(*)::integer AS count FROM pg_tables WHERE schemaname=\'public\'')).rows)
    .toEqual([{ count: 1 }])
})

test('a complete preceding cloud generation upgrades atomically without replacing existing records', async () => {
  const pool = await database()
  await pool.query('SET check_function_bodies=false')
  await pool.query(await readFile(new URL('../assets/cloud-schema-v1.sql', import.meta.url), 'utf8'))
  await pool.query("INSERT INTO pe_schema VALUES(1,'cloud-native')")
  await pool.query(`INSERT INTO pe_users(id,username,password_hash,settings,display_name)
    VALUES($1,'preceding-user','fixture-not-a-login','{"model":"trial-model","maxTokens":1000,"revision":1}','Preceding User')`, [randomUUID()])
  await initializeDatabase(pool)
  expect((await pool.query('SELECT version FROM pe_schema')).rows).toEqual([{ version: CURRENT_SCHEMA_VERSION }])
  expect((await pool.query('SELECT username FROM pe_users')).rows).toEqual([{ username: 'preceding-user' }])
  await initializeDatabase(pool)
})

test.each([2, 3, 4, 5])('cloud version %i retains its records through an ordinary-role adjacent upgrade and permission failure', async (version) => {
  const pool = await database()
  await pool.query('SET check_function_bodies=false')
  for (const generation of Array.from({ length: version }, (_unused, index) => index + 1)) {
    await pool.query(await readFile(new URL(`../assets/cloud-schema-v${generation}.sql`, import.meta.url), 'utf8'))
  }
  await pool.query("INSERT INTO pe_schema VALUES($1,'cloud-native')", [version])
  await pool.query(`INSERT INTO pe_users(id,username,password_hash,settings,display_name)
    VALUES($1,'retained-v2-user','fixture-not-a-login','{"model":"trial-model","maxTokens":1000,"revision":1}','Retained User')`,
  [randomUUID()])
  const before = (await pool.query<{ id: string; username: string; settings: unknown; display_name: string }>(
    'SELECT id,username,settings,display_name FROM pe_users')).rows
  const beforeTables = (await pool.query<{ tablename: string }>(
    "SELECT tablename FROM pg_tables WHERE schemaname='public' ORDER BY tablename")).rows
  const role = `pe_adjacent_role_${randomUUID().replaceAll('-', '')}`
  const password = randomUUID()
  await admin.query(`CREATE ROLE "${role}" LOGIN NOSUPERUSER NOCREATEDB NOCREATEROLE PASSWORD '${password}'`)
  roles.push(role)
  await pool.query('REVOKE CREATE ON SCHEMA public FROM PUBLIC')
  await pool.query(`GRANT ALL ON ALL TABLES IN SCHEMA public TO "${role}"`)
  const url = new URL(address)
  const databaseName = (await pool.query<{ name: string }>('SELECT current_database() AS name')).rows[0]?.name
  if (!databaseName) throw new Error('Expected the owned test database identity')
  url.pathname = `/${databaseName}`
  url.username = role
  url.password = password
  const limited = new Pool({ connectionString: url.href, max: 4 })
  try {
    expect((await limited.query<{ super: boolean; create: boolean; roles: boolean }>(
      'SELECT rolsuper AS super,rolcreatedb AS create,rolcreaterole AS roles FROM pg_roles WHERE rolname=current_user')).rows)
      .toEqual([{ super: false, create: false, roles: false }])
    await expect(initializeDatabase(limited)).rejects.toMatchObject({ code: '42501' })
    expect((await pool.query<{ version: number }>('SELECT version FROM pe_schema')).rows).toEqual([{ version }])
    expect((await pool.query<{ tablename: string }>(
      "SELECT tablename FROM pg_tables WHERE schemaname='public' ORDER BY tablename")).rows).toEqual(beforeTables)
    expect((await pool.query<{ id: string; username: string; settings: unknown; display_name: string }>(
      'SELECT id,username,settings,display_name FROM pe_users')).rows).toEqual(before)
    await pool.query(`GRANT CREATE ON SCHEMA public TO "${role}"`)
    for (const { tablename } of beforeTables) await pool.query(`ALTER TABLE "${tablename}" OWNER TO "${role}"`)
    await pool.query(`REVOKE UPDATE ON pe_schema FROM "${role}"`)
    await expect(initializeDatabase(limited)).rejects.toMatchObject({
      code: '42501', message: 'permission denied for table pe_schema',
    })
    expect((await pool.query<{ version: number }>('SELECT version FROM pe_schema')).rows).toEqual([{ version }])
    expect((await pool.query<{ tablename: string }>(
      "SELECT tablename FROM pg_tables WHERE schemaname='public' ORDER BY tablename")).rows).toEqual(beforeTables)
    expect((await pool.query<{ id: string; username: string; settings: unknown; display_name: string }>(
      'SELECT id,username,settings,display_name FROM pe_users')).rows).toEqual(before)
    await pool.query(`GRANT UPDATE ON pe_schema TO "${role}"`)
    await Promise.all([initializeDatabase(limited), initializeDatabase(limited)])
    expect((await limited.query<{ version: number }>('SELECT version FROM pe_schema')).rows)
      .toEqual([{ version: CURRENT_SCHEMA_VERSION }])
    expect((await limited.query<{ count: number }>(
      "SELECT count(*)::integer AS count FROM pg_tables WHERE schemaname='public'")).rows).toEqual([{ count: currentCloudTableNames.length }])
    expect((await limited.query<{ id: string; username: string; settings: unknown; display_name: string }>(
      'SELECT id,username,settings,display_name FROM pe_users')).rows).toEqual(before)
    await initializeDatabase(limited)
  } finally {
    await limited.end()
  }
})

test('a missing column is rejected before the Platform can serve requests', async () => {
  const pool = await database(); await initializeDatabase(pool)
  await pool.query('ALTER TABLE pe_users DROP COLUMN display_name')
  await expect(initializeDatabase(pool)).rejects.toThrow('Incomplete')
})

test('a transaction publishes committed work and rolls back the original failure', async () => {
  const pool = await database(); await pool.query('CREATE TABLE values_test(value text)')
  expect(await transaction(pool, async (client) => { await client.query("INSERT INTO values_test VALUES('kept')"); return 23 })).toBe(23)
  const failure = new Error('operation failed')
  await expect(transaction(pool, async (client) => { await client.query("INSERT INTO values_test VALUES('discarded')"); throw failure })).rejects.toBe(failure)
  expect((await pool.query('SELECT value FROM values_test')).rows).toEqual([{ value: 'kept' }])
})
