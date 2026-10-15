/** Real Schema 15 PostgreSQL transport checks; formal Profile and business acceptance remain separate. */
import assert from 'node:assert/strict'
import { spawnSync } from 'node:child_process'
import { createHash, randomBytes, randomUUID } from 'node:crypto'
import { copyFile, lstat, mkdir, mkdtemp, readFile, rm, writeFile } from 'node:fs/promises'
import { createRequire } from 'node:module'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { test } from 'node:test'
import { CURRENT_SCHEMA_VERSION, connectDatabase, databaseCensus, dumpDatabase, requireCurrentSchema,
  requireEmptyDatabase, requireQuiescentDatabase, verifyTools } from './backup-postgres.mjs'
import { restoreBackup } from './backup.mjs'
import { copyTree, inventoryTree } from './backup-tree.mjs'
import { durableJson } from './lifecycle.mjs'
import { CURRENT_SCHEMA_VERSION as APPLICATION_SCHEMA_VERSION, initializeDatabase } from '../application/src/platform/database.ts'

const { Client, Pool } = createRequire(new URL('../application/package.json', import.meta.url))('pg')
const pgImage = 'postgres:16-bookworm@sha256:0ea6700a3b4f0ae6ce746519073558aed4d88a79d8d07622a9a644946c7319c4'
const ownerLabel = 'org.power-evolve.employee4'
const labels = ['privateConfig', 'workspaces', 'homes', 'skillPackages', 'attachments', 'officeCache']
const currentTableCount = Object.keys(JSON.parse(await readFile(new URL(`../application/assets/cloud-schema-v${CURRENT_SCHEMA_VERSION}.manifest.json`, import.meta.url), 'utf8'))).length
const nativeTables = ['pe_native_input_origins', 'pe_native_input_commands', 'pe_native_input_revisions',
  'pe_native_input_cohorts', 'pe_native_input_claims', 'pe_native_turn_frames', 'pe_native_turn_transitions_v2']

function docker(args, env = process.env) {
  const result = spawnSync('docker', args, { encoding: 'utf8', env, timeout: 60000 })
  if (result.error || result.signal || result.status !== 0) throw new Error('Owned Schema 15 PostgreSQL container action failed')
  return result.stdout.trim()
}

async function schema(client, version) {
  await client.query('BEGIN; SET LOCAL check_function_bodies=false')
  try {
    await client.query(await readFile(new URL('../application/assets/cloud-schema-v1.sql', import.meta.url), 'utf8'))
    await client.query("INSERT INTO pe_schema(version,family) VALUES(1,'cloud-native')")
    for (let current = 2; current <= version; current++) {
      await client.query(await readFile(new URL(`../application/assets/cloud-schema-v${current}.sql`, import.meta.url), 'utf8'))
      await client.query('UPDATE pe_schema SET version=$1', [current])
    }
    await client.query('COMMIT')
  } catch (error) { await client.query('ROLLBACK'); throw error }
}

async function census(client) {
  await client.query('BEGIN ISOLATION LEVEL REPEATABLE READ READ ONLY')
  try { return await databaseCensus(client) }
  finally { await client.query('ROLLBACK') }
}

async function nativeFacts(client) {
  const facts = {}
  for (const table of nativeTables) {
    facts[table] = (await client.query(`SELECT to_jsonb(fact)::text AS value FROM ${table} AS fact ORDER BY value`)).rows
  }
  return facts
}

test('ordinary roles restore native facts, foreground executions and writer tombstones while refusing old or active state', { timeout: 180000 }, async (t) => {
  assert.deepEqual(Object.keys(process.env).filter(name => /^PE_NATIVE_.*_DDL$/u.test(name)), [])
  assert.equal(APPLICATION_SCHEMA_VERSION, 15)
  const root = await mkdtemp(join(tmpdir(), 'pe-employee4-schema12-'))
  const id = randomUUID(), suffix = id.replaceAll('-', ''), adminPassword = randomUUID()
  const sourceRole = 'pe_employee4_src_' + suffix, targetRole = 'pe_employee4_dst_' + suffix
  const names = ['source', 'target', 'old2', 'occupied', 'temporary', 'live'].map(name => 'pe_employee4_' + name + '_' + suffix)
  const clients = new Set()
  let container = null, admin = null, passed = false
  t.after(async () => {
    for (const client of clients) await client.end()
    await admin?.end()
    if (container) {
      assert.equal(docker(['inspect', '--format', '{{index .Config.Labels "' + ownerLabel + '"}}', container]), id)
      const logs = spawnSync('docker', ['logs', container], { encoding: 'utf8', timeout: 30000 })
      await writeFile(join(root, 'postgres-private.log'), (logs.stdout ?? '') + (logs.stderr ?? ''), { mode: 0o600 })
      docker(['stop', '--time', '5', container])
      docker(['rm', '--volumes', container])
      assert.equal(docker(['ps', '-a', '--filter', 'label=' + ownerLabel + '=' + id, '--format', '{{.ID}}']), '')
    }
    if (process.env.PE_SCHEMA12_BACKUP_EVIDENCE_DIR) {
      const evidence = process.env.PE_SCHEMA12_BACKUP_EVIDENCE_DIR
      await mkdir(evidence, { recursive: true, mode: 0o700 })
      await writeFile(join(evidence, 'fixture-cleanup.json'), JSON.stringify({ id, containersRemaining: 0, passed, fixtureDirectory: root }) + '\n', { mode: 0o600 })
    }
    if (passed) await rm(root, { recursive: true, force: true })
  })
  container = docker(['run', '-d', '--name', 'pe-employee4-schema12-' + id, '--label', ownerLabel + '=' + id,
    '--publish', '127.0.0.1::5432', '--env', 'POSTGRES_PASSWORD', pgImage], { ...process.env, POSTGRES_PASSWORD: adminPassword })
  const deadline = Date.now() + 30000
  for (;;) {
    const ready = spawnSync('docker', ['exec', container, 'pg_isready', '--host', '127.0.0.1'], { timeout: 10000 })
    if (ready.status === 0) break
    if (Date.now() >= deadline) throw new Error('Owned PostgreSQL final TCP startup was not observed')
    await new Promise(resolve => setTimeout(resolve, 50))
  }
  const port = docker(['port', container, '5432/tcp']).match(/^127\.0\.0\.1:(\d+)$/u)?.[1]
  assert.ok(port)
  const toolHost = docker(['inspect', '--format', '{{range .NetworkSettings.Networks}}{{.IPAddress}}{{end}}', container])
  assert.match(toolHost, /^\d+\.\d+\.\d+\.\d+$/u)
  const adminUrl = new URL('postgresql://postgres@127.0.0.1:' + port + '/postgres'); adminUrl.password = adminPassword
  admin = new Client({ connectionString: adminUrl.href }); await admin.connect()
  const passwords = new Map([[sourceRole, randomUUID()], [targetRole, randomUUID()]])
  for (const [role, password] of passwords) await admin.query(`CREATE ROLE "${role}" LOGIN PASSWORD '${password}' NOSUPERUSER NOCREATEDB NOCREATEROLE`)
  for (const [index, name] of names.entries()) {
    await admin.query(`CREATE DATABASE "${name}" OWNER "${[1, 4, 5].includes(index) ? targetRole : sourceRole}"`)
  }
  const connect = async (name, role) => {
    const url = new URL(adminUrl.href); url.pathname = '/' + name; url.username = role; url.password = passwords.get(role)
    const urlFile = join(root, name + '-url'); await writeFile(urlFile, url.href, { mode: 0o600 })
    const config = { urlFile, database: name, role, tools: { container, host: toolHost, port: '5432' } }
    const database = await connectDatabase(config); clients.add(database.client)
    const flags = (await database.client.query('SELECT rolsuper,rolcreatedb,rolcreaterole FROM pg_roles WHERE rolname=current_user')).rows[0]
    assert.deepEqual(flags, { rolsuper: false, rolcreatedb: false, rolcreaterole: false })
    verifyTools(database, config)
    return { ...database, config }
  }
  const source = await connect(names[0], sourceRole)
  const roots = Object.fromEntries(labels.map(label => [label, join(root, 'source-' + label)]))
  const profiles = [join(root, 'archived-host'), join(root, 'archived-platform')]
  for (const directory of [...Object.values(roots), ...profiles]) {
    await mkdir(directory, { mode: 0o700 })
    await writeFile(join(directory, 'fixture.txt'), 'archival fixture bytes\n中文😀', { mode: 0o600 })
  }
  const nativeIntentKeyFile = join(roots.privateConfig, 'native-intent-key')
  const nativeIntentKeyBytes = Buffer.from(randomBytes(32).toString('base64url') + '\n')
  await writeFile(nativeIntentKeyFile, nativeIntentKeyBytes, { mode: 0o600 })
  const nativeIntentKey = { path: 'native-intent-key', size: nativeIntentKeyBytes.length,
    sha256: createHash('sha256').update(nativeIntentKeyBytes).digest('hex') }
  const archive = async (name, dumpPath, snapshot) => {
    const bundle = join(root, name), inventories = { profiles: [] }
    await mkdir(bundle, { mode: 0o700 }); await mkdir(join(bundle, 'roots'), { mode: 0o700 })
    await mkdir(join(bundle, 'profiles'), { mode: 0o700 }); await copyFile(dumpPath, join(bundle, 'database.dump'))
    for (const label of labels) {
      inventories[label] = await inventoryTree(roots[label])
      await copyTree(roots[label], join(bundle, 'roots', label), inventories[label])
    }
    for (const [index, directory] of profiles.entries()) {
      inventories.profiles.push(await inventoryTree(directory))
      await copyTree(directory, join(bundle, 'profiles', String(index)), inventories.profiles[index])
    }
    const manifest = { format: 1, kind: 'power-evolve-current-cloud-backup', schema: 15, family: 'cloud-native',
      database: source.identity, sourceRoots: roots, sourceProfiles: profiles, nativeIntentKey, census: snapshot, inventories,
      files: (await inventoryTree(bundle)).filter(entry => entry.path !== '') }
    await durableJson(join(bundle, 'manifest.json'), manifest)
    await durableJson(join(bundle, 'manifest-digest.json'), { sha256: createHash('sha256').update(JSON.stringify(manifest) + '\n').digest('hex') })
    return bundle
  }
  const restoreConfig = (bundle, database, prefix) => ({ format: 1, bundle, postgres: database.config,
    nativeIntentKeyFile: join(root, prefix + '-privateConfig', nativeIntentKey.path),
    roots: Object.fromEntries(labels.map(label => [label, join(root, prefix + '-' + label)])),
    profiles: [join(root, prefix + '-host'), join(root, prefix + '-platform')] })
  await requireEmptyDatabase(source.client)
  const pool = new Pool({ connectionString: source.url, max: 1, connectionTimeoutMillis: 10000,
    query_timeout: 60000, statement_timeout: 60000 })
  try { await initializeDatabase(pool) }
  finally { await pool.end() }
  assert.equal(CURRENT_SCHEMA_VERSION, 15)
  await requireCurrentSchema(source.client)
  await requireQuiescentDatabase(source.client)
  const old = await connect(names[2], sourceRole)
  await schema(old.client, 2)
  const oldBefore = (await old.client.query('SELECT family,version FROM pe_schema')).rows
  await assert.rejects(requireCurrentSchema(old.client), /Schema 15/u)
  assert.deepEqual((await old.client.query('SELECT family,version FROM pe_schema')).rows, oldBefore)
  assert.equal((await old.client.query("SELECT count(*)::integer AS n FROM information_schema.tables WHERE table_schema='public' AND table_type='BASE TABLE'")).rows[0].n, 71)
  await old.client.query('BEGIN')
  try {
    await old.client.query(await readFile(new URL('../application/assets/cloud-schema-v3.sql', import.meta.url), 'utf8'))
    await old.client.query('UPDATE pe_schema SET version=3 WHERE version=2')
    await old.client.query('COMMIT')
  } catch (error) { await old.client.query('ROLLBACK'); throw error }
  const old3Before = (await old.client.query('SELECT family,version FROM pe_schema')).rows
  assert.deepEqual(old3Before, [{ family: 'cloud-native', version: 3 }])
  await assert.rejects(requireCurrentSchema(old.client), /Schema 15/u)
  assert.deepEqual((await old.client.query('SELECT family,version FROM pe_schema')).rows, old3Before)
  assert.equal((await old.client.query("SELECT count(*)::integer AS n FROM information_schema.tables WHERE table_schema='public' AND table_type='BASE TABLE'")).rows[0].n, 73)
  await old.client.query('BEGIN')
  try {
    await old.client.query(await readFile(new URL('../application/assets/cloud-schema-v4.sql', import.meta.url), 'utf8'))
    await old.client.query('UPDATE pe_schema SET version=4 WHERE version=3')
    await old.client.query('COMMIT')
  } catch (error) { await old.client.query('ROLLBACK'); throw error }
  const old4Before = (await old.client.query('SELECT family,version FROM pe_schema')).rows
  assert.deepEqual(old4Before, [{ family: 'cloud-native', version: 4 }])
  await assert.rejects(requireCurrentSchema(old.client), /Schema 15/u)
  assert.deepEqual((await old.client.query('SELECT family,version FROM pe_schema')).rows, old4Before)
  assert.equal((await old.client.query("SELECT count(*)::integer AS n FROM information_schema.tables WHERE table_schema='public' AND table_type='BASE TABLE'")).rows[0].n, 74)
  for (const version of [5, 6, 7, 8, 9, 10, 11, 12, 13, 14]) {
    await old.client.query('BEGIN')
    try {
      await old.client.query(await readFile(new URL(`../application/assets/cloud-schema-v${version}.sql`, import.meta.url), 'utf8'))
      await old.client.query('UPDATE pe_schema SET version=$1', [version])
      await old.client.query('COMMIT')
    } catch (error) { await old.client.query('ROLLBACK'); throw error }
    const historical = (await old.client.query('SELECT family,version FROM pe_schema')).rows
    assert.deepEqual(historical, [{ family: 'cloud-native', version }])
    await assert.rejects(requireCurrentSchema(old.client), /Schema 15/u)
    assert.deepEqual((await old.client.query('SELECT family,version FROM pe_schema')).rows, historical)
  }
  await old.client.end(); clients.delete(old.client)
  const user = randomUUID(), workspace = randomUUID(), session = randomUUID(), publisher = randomUUID()
  await source.client.query('INSERT INTO pe_users(id,username,password_hash,settings,display_name) VALUES($1,$2,$3,$4,$2)',
    [user, 'employee4-schema12', 'opaque-hash', { unicode: '中文😀', revision: 1 }])
  await source.client.query("INSERT INTO pe_workspaces(id,user_id,binding_state) VALUES($1,$2,'ready')", [workspace, user])
  await source.client.query('INSERT INTO pe_sessions(id,user_id,create_request_id,header,workspace_id) VALUES($1,$2,$3,$4,$5)',
    [session, user, randomUUID(), { fixture: 'opaque persisted header' }, workspace])
  const event = { fixture: 'canonical persisted bytes', text: '保留日志\n😀', value: 123 }
  await source.client.query('INSERT INTO pe_events(session_id,seq,event) VALUES($1,0,$2)', [session, event])
  const operation = randomUUID(), request = randomUUID(), message = randomUUID(), origin = randomUUID()
  const admission = randomUUID(), claim = randomUUID(), cohort = randomUUID()
  const frame = { fixture: 'persisted execution frame', message: { id: message, text: '执行输入\n😀' }, revision: 1 }
  const grant = { operationId: operation, operationEpoch: 1, sessionId: session, writerEpoch: 41 }
  const receipt = { version: 2, from: { operationId: operation, operationEpoch: 1 },
    result: { kind: 'completed', grant }, fixture: '版本二回执\n😀' }
  await source.client.query('BEGIN')
  try {
    await source.client.query(`INSERT INTO pe_operations(id,session_id,request_id,input,settings,state,attempts,completed_at)
      VALUES($1,$2,$3,'persisted native input','{}','completed',1,'2001-01-01T00:00:00.123456Z')`,
    [operation, session, request])
    await source.client.query(`INSERT INTO pe_attempts(operation_id,epoch,worker_id,ended_at)
      VALUES($1,1,$2,'2001-01-01T00:00:00.123456Z')`, [operation, randomUUID()])
    await source.client.query(`INSERT INTO pe_native_turn_frames(operation_id,operation_epoch,session_id,writer_epoch,
      request_id,message_id,grant_digest,frame_json,grant_json,prepared_event_count)
      VALUES($1,1,$2,41,$3,$4,$5,$6,$7,1)`, [operation, session, request, message, 'd'.repeat(64), frame, grant])
    await source.client.query(`INSERT INTO pe_native_input_origins(origin_input_id,session_id,origin_operation_id,
      original_request_id,message_id,accepted_snapshot_digest,accepted_audit_json) VALUES($1,$2,$3,$4,$5,$6,$7)`,
    [origin, session, operation, request, message, 'e'.repeat(64), { fixture: 'immutable accepted audit', text: '输入😀' }])
    await source.client.query(`INSERT INTO pe_native_input_commands(command_id,session_id,user_id,actor_kind,actor_id,
      writer_epoch,transport_nonce,payload_digest,kind,target_origin_input_id,committed_event_count,receipt_json)
      VALUES($1,$2,$3,'browser',$3,NULL,'admission-nonce',$4,'admission',$5,1,$6),
        ($7,$2,$3,'writer',$8,41,'claim-nonce',$9,'claim',NULL,1,$10)`,
    [admission, session, user, 'f'.repeat(64), origin, { fixture: 'admission receipt', accepted: true },
      claim, randomUUID(), '1'.repeat(64), { fixture: 'claim receipt', cohortId: cohort }])
    await source.client.query(`INSERT INTO pe_native_input_revisions(origin_input_id,session_id,input_revision,
      previous_revision,cause,message_json,input_digest,committed_splice_seq,command_id,command_kind)
      VALUES($1,$2,1,NULL,'admission',$3,$4,0,$5,'admission')`,
    [origin, session, { id: message, text: 'immutable message\n中文😀' }, '2'.repeat(64), admission])
    await source.client.query(`INSERT INTO pe_native_input_cohorts(cohort_id,session_id,execution_operation_id,
      operation_epoch,writer_epoch,frozen_snapshot_digest,owner_kind,owner_origin_input_id,owner_input_revision,
      owner_input_digest,turn_start_seq,turn_number,boundary_ordinal,step_start_seq,claim_count,command_id)
      VALUES($1,$2,$3,1,41,$4,'current-frame',$5,1,$6,0,1,0,NULL,1,$7)`,
    [cohort, session, operation, '3'.repeat(64), origin, '2'.repeat(64), claim])
    await source.client.query(`INSERT INTO pe_native_input_claims(origin_input_id,session_id,input_revision,input_digest,
      cohort_id,claim_splice_seq,splice_item_ordinal,cohort_ordinal,target) VALUES($1,$2,1,$3,$4,0,0,0,'next-step')`,
    [origin, session, '2'.repeat(64), cohort])
    await source.client.query(`INSERT INTO pe_native_turn_transitions_v2(session_id,writer_epoch,transition_id,
      intent_digest,candidate_digest,from_operation_id,from_operation_epoch,receipt_json) VALUES($1,41,$2,$3,$4,$5,1,$6)`,
    [session, randomUUID(), '4'.repeat(64), '5'.repeat(64), operation, receipt])
    await source.client.query('COMMIT')
  } catch (error) { await source.client.query('ROLLBACK'); throw error }
  const nativeFactsBefore = await nativeFacts(source.client)
  for (const table of nativeTables) assert.ok(nativeFactsBefore[table].length > 0)
  const presentation = '{"text":"temporary\\u0000中文"}'
  await source.client.query('INSERT INTO pe_native_presentations(session_id,epoch,publisher_id,last_ordinal,state_json,expires_at) VALUES($1,1,$2,0,$3,$4)',
    [session, publisher, presentation, '2026-10-09T00:00:00.123456Z'])
  const temporaryBefore = (await source.client.query('SELECT * FROM pe_native_presentations')).rows
  await assert.rejects(requireQuiescentDatabase(source.client), /temporary presentation state remains in pe_native_presentations;/u)
  assert.deepEqual((await source.client.query('SELECT * FROM pe_native_presentations')).rows, temporaryBefore)
  const item = '{"text":"temporary entry\\u0000😀"}'
  await source.client.query('INSERT INTO pe_native_presentation_entries(session_id,ordinal,item_json,item_bytes) VALUES($1,1,$2,$3)',
    [session, item, Buffer.byteLength(item)])
  const entriesBefore = (await source.client.query('SELECT * FROM pe_native_presentation_entries')).rows
  await assert.rejects(requireQuiescentDatabase(source.client), /temporary presentation state remains in pe_native_presentation_entries;/u)
  assert.deepEqual((await source.client.query('SELECT * FROM pe_native_presentation_entries')).rows, entriesBefore)
  assert.deepEqual((await source.client.query('SELECT * FROM pe_native_presentations')).rows, temporaryBefore)
  const retained = await census(source.client)
  assert.equal(retained.tables.pe_native_presentations.rows, 1)
  assert.equal(retained.tables.pe_native_presentation_entries.rows, 1)
  const temporaryDump = join(root, 'temporary.dump')
  await source.client.query('BEGIN ISOLATION LEVEL REPEATABLE READ READ ONLY')
  try {
    const snapshot = (await source.client.query('SELECT pg_export_snapshot() AS value')).rows[0].value
    dumpDatabase(temporaryDump, source, source.config, snapshot)
  } finally { await source.client.query('ROLLBACK') }
  const temporaryBundle = await archive('temporary-bundle', temporaryDump, retained)
  const temporaryTarget = await connect(names[4], targetRole)
  await temporaryTarget.client.end(); clients.delete(temporaryTarget.client)
  const temporaryConfig = restoreConfig(temporaryBundle, temporaryTarget, 'refused-temporary')
  await assert.rejects(restoreBackup(temporaryConfig), /temporary presentation state remains in pe_native_presentation_entries;/u)
  for (const directory of [...Object.values(temporaryConfig.roots), ...temporaryConfig.profiles]) {
    await assert.rejects(lstat(directory), { code: 'ENOENT' })
  }
  // Only this fixture removes its own rows; the backup implementation must merely refuse them.
  await source.client.query('DELETE FROM pe_native_presentations WHERE session_id=$1', [session])
  await requireQuiescentDatabase(source.client)
  assert.deepEqual((await source.client.query('SELECT event FROM pe_events WHERE session_id=$1', [session])).rows, [{ event }])
  const expiredSession = randomUUID(), liveSession = randomUUID()
  for (const id of [expiredSession, liveSession]) {
    await source.client.query('INSERT INTO pe_sessions(id,user_id,create_request_id,header,workspace_id) VALUES($1,$2,$3,$4,$5)',
      [id, user, randomUUID(), { fixture: 'writer fencing history' }, workspace])
  }
  await source.client.query(`INSERT INTO pe_native_writers(session_id,worker_id,epoch,token_digest,expires_at)
    VALUES($1,$2,41,$3,NULL),($4,$5,9007199254740991,$6,'2001-01-01T00:00:00.123456Z'),
      ($7,$8,77,$9,clock_timestamp()+interval '10 minutes')`,
  [session, randomUUID(), 'a'.repeat(64), expiredSession, randomUUID(), 'b'.repeat(64), liveSession, randomUUID(), 'c'.repeat(64)])
  const writersQuery = 'SELECT session_id,worker_id,epoch::text,token_digest,expires_at::text FROM pe_native_writers ORDER BY session_id'
  const liveBefore = (await source.client.query(writersQuery)).rows
  await assert.rejects(requireQuiescentDatabase(source.client), /active or uncertain in pe_native_writers/u)
  assert.deepEqual((await source.client.query(writersQuery)).rows, liveBefore)
  const liveCensus = await census(source.client), liveDump = join(root, 'live-writer.dump')
  await source.client.query('BEGIN ISOLATION LEVEL REPEATABLE READ READ ONLY')
  try {
    const snapshot = (await source.client.query('SELECT pg_export_snapshot() AS value')).rows[0].value
    dumpDatabase(liveDump, source, source.config, snapshot)
  } finally { await source.client.query('ROLLBACK') }
  const liveBundle = await archive('live-writer-bundle', liveDump, liveCensus)
  const liveTarget = await connect(names[5], targetRole)
  await liveTarget.client.end(); clients.delete(liveTarget.client)
  const liveConfig = restoreConfig(liveBundle, liveTarget, 'refused-live-writer')
  await assert.rejects(restoreBackup(liveConfig), /active or uncertain in pe_native_writers/u)
  for (const directory of [...Object.values(liveConfig.roots), ...liveConfig.profiles]) {
    await assert.rejects(lstat(directory), { code: 'ENOENT' })
  }
  // The fixture simulates release by clearing occupancy, retaining the row and its fencing identity.
  await source.client.query('UPDATE pe_native_writers SET expires_at=NULL WHERE session_id=$1', [liveSession])
  const writerTombstones = (await source.client.query(writersQuery)).rows
  assert.equal(writerTombstones.length, 3)
  for (const row of writerTombstones) {
    const original = liveBefore.find(value => value.session_id === row.session_id)
    assert.deepEqual(row, row.session_id === liveSession ? { ...original, expires_at: null } : original)
  }
  assert.equal(writerTombstones.find(row => row.session_id === expiredSession).epoch, '9007199254740991')
  assert.equal(writerTombstones.find(row => row.session_id === expiredSession).expires_at, '2001-01-01 00:00:00.123456+00')
  await requireQuiescentDatabase(source.client)
  for (const phase of ['creating', 'ready', 'stopping']) {
    await source.client.query('BEGIN')
    try {
      await source.client.query(`INSERT INTO pe_native_runtime_instances(runtime_id,user_id,generation,phase,namespace,config_digest)
        VALUES($1,$2,1,$3,'fixture',$4)`, [randomUUID(), user, phase, 'c'.repeat(64)])
      await assert.rejects(requireQuiescentDatabase(source.client), /active or uncertain in pe_native_runtime_instances/u)
    } finally { await source.client.query('ROLLBACK') }
  }
  for (const state of ['admitted', 'creating', 'running', 'stopping', 'uncertain']) {
    await source.client.query('BEGIN')
    try {
      const worldId = randomUUID()
      await source.client.query(`INSERT INTO pe_native_execution_worlds(id,user_id,session_id,agent_id,operation_id,
        operation_epoch,grant_digest,workspace_id,storage_generation,permission_generation,mode,binding_snapshot)
        VALUES($1,$2,$3::uuid,$3::text,$4,1,$5,$6,1,1,'read-only','{}')`,
      [worldId, user, session, operation, 'a'.repeat(64), workspace])
      await source.client.query(`INSERT INTO pe_native_execution_processes(id,world_id,kind,namespace,pod_name,state,request_digest)
        VALUES($1,$2,'process','fixture','original-pod',$3,$4)`, [randomUUID(), worldId, state, 'b'.repeat(64)])
      await assert.rejects(requireQuiescentDatabase(source.client), /active or uncertain in pe_native_execution_processes/u)
    } finally { await source.client.query('ROLLBACK') }
  }
  await source.client.query('BEGIN')
  try {
    const credential = randomUUID(), runtime = randomUUID()
    await source.client.query(`INSERT INTO pe_runtime_credentials(id,digest,user_id,runtime_id,generation,credential_version,expires_at)
      VALUES($1,$2,$3,$4,1,1,clock_timestamp()+interval '1 hour')`, [credential, 'e'.repeat(64), user, runtime])
    await source.client.query(`INSERT INTO pe_native_interactive_grants(operation_id,session_id,user_id,runtime_credential_id,
      runtime_id,runtime_generation,browser_digest,credential_version,request_id,expires_at)
      VALUES($1,$2,$3,$4,$5,1,$6,1,$7,clock_timestamp()+interval '1 hour')`,
    [operation, session, user, credential, runtime, 'f'.repeat(64), randomUUID()])
    await assert.rejects(requireQuiescentDatabase(source.client), /active or uncertain in pe_native_interactive_grants/u)
    await source.client.query('UPDATE pe_native_interactive_grants SET released_at=clock_timestamp() WHERE operation_id=$1', [operation])
    await requireQuiescentDatabase(source.client)
  } finally { await source.client.query('ROLLBACK') }
  await source.client.query('BEGIN')
  try {
    await source.client.query(`INSERT INTO pe_operations(id,session_id,request_id,input,settings,state)
      VALUES($1,$2,$3,'queued fixture','{}','queued')`, [randomUUID(), session, randomUUID()])
    await assert.rejects(requireQuiescentDatabase(source.client), /active or uncertain in pe_operations/u)
  } finally { await source.client.query('ROLLBACK') }
  await source.client.query('BEGIN')
  try {
    await source.client.query("INSERT INTO pe_mount_slots(user_id,session_id,workspace_id,state) VALUES($1,$2,$3,'unknown')",
      [user, session, workspace])
    await assert.rejects(requireQuiescentDatabase(source.client), /active or uncertain in pe_mount_slots/u)
  } finally { await source.client.query('ROLLBACK') }
  for (const state of ['queued', 'starting', 'running', 'cancelling', 'uncertain']) {
    await source.client.query('BEGIN')
    try {
      await source.client.query(`INSERT INTO pe_cloud_executions
        (id,user_id,session_id,operation_id,call_id,command,cwd,request_digest,state,cancel_requested,
          result_delivery,requested_timeout_ms,command_timeout_ms,native_tool_grant_digest,native_tool_credential_version,
          native_tool_cancel_cause)
        VALUES($1,$2,$3,$4,$5,'printf native','','${'6'.repeat(64)}',$6,true,'native_tool',5000,3000,'${'7'.repeat(64)}',1,'abort')`,
      [randomUUID(), user, session, operation, randomUUID(), state])
      const original = (await source.client.query('SELECT to_jsonb(e)::text AS value FROM pe_cloud_executions e')).rows
      await assert.rejects(requireQuiescentDatabase(source.client), /active or uncertain in pe_cloud_executions/u)
      assert.deepEqual((await source.client.query('SELECT to_jsonb(e)::text AS value FROM pe_cloud_executions e')).rows, original)
    } finally { await source.client.query('ROLLBACK') }
  }
  await source.client.query('BEGIN')
  try {
    await source.client.query(`INSERT INTO pe_mount_slots
      (user_id,session_id,workspace_id,state,pod_uid,runner_instance_id)
      VALUES($1,$2,$3,'stopping',$4,$5)`, [user, session, workspace, randomUUID(), randomUUID()])
    await assert.rejects(requireQuiescentDatabase(source.client), /active or uncertain in pe_mount_slots/u)
  } finally { await source.client.query('ROLLBACK') }
  const nativeStopped = randomUUID(), nativeCompleted = randomUUID(), nativeCancelled = randomUUID(), stopRequestId = randomUUID()
  const stoppedPodUid = randomUUID(), stoppedRunnerId = randomUUID()
  const stopTarget = { userId: user, sessionId: session, workspaceId: workspace, generation: randomUUID(),
    name: 'owned-stopped-fixture', podUid: stoppedPodUid, runnerInstanceId: stoppedRunnerId,
    binding: { fixture: 'captured immutable storage binding' } }
  const nativeResult = { exitCode: 0, stdout: '真实输出\n😀', stderr: '', stdoutTruncated: false,
    stderrTruncated: false, timedOut: false }
  await source.client.query(`INSERT INTO pe_cloud_executions
    (id,user_id,session_id,operation_id,call_id,command,cwd,request_digest,state,cancel_requested,result,error_code,
      sandbox_name,pod_uid,runner_instance_id,result_delivery,requested_timeout_ms,command_timeout_ms,
      native_tool_grant_digest,native_tool_credential_version,native_tool_stop_request_id,native_tool_stop_target,native_tool_cancel_cause)
    VALUES($1,$2,$3,$4,$5,'printf native','','${'6'.repeat(64)}','closed_unknown',true,NULL,'native_tool_outcome_unknown',
      $6,$7,$8,'native_tool',5000,3000,'${'7'.repeat(64)}',1,$9,$10,'timeout'),
      ($11,$2,$3,$4,$12,'printf complete','','${'8'.repeat(64)}','succeeded',false,$13,NULL,
        NULL,NULL,NULL,'native_tool',5000,3000,'${'7'.repeat(64)}',1,NULL,NULL,NULL),
      ($14,$2,$3,$4,$15,'printf cancelled','','${'9'.repeat(64)}','cancelled',true,NULL,NULL,
        NULL,NULL,NULL,'native_tool',5000,3000,'${'7'.repeat(64)}',1,NULL,NULL,'abort')`,
  [nativeStopped, user, session, operation, randomUUID(), stopTarget.name, stoppedPodUid, stoppedRunnerId,
    stopRequestId, stopTarget, nativeCompleted, randomUUID(), JSON.stringify(nativeResult), nativeCancelled, randomUUID()])
  const nativeExecutionsQuery = 'SELECT to_jsonb(e)::text AS value FROM pe_cloud_executions e ORDER BY id'
  const nativeExecutionsBefore = (await source.client.query(nativeExecutionsQuery)).rows
  await requireQuiescentDatabase(source.client)
  const competing = await connectDatabase(source.config); clients.add(competing.client)
  try { await assert.rejects(requireQuiescentDatabase(source.client), /another connection/u) }
  finally { await competing.client.end(); clients.delete(competing.client) }
  await requireQuiescentDatabase(source.client)
  await source.client.query("CREATE SEQUENCE employee4_schema12_counter START 9; SELECT nextval('employee4_schema12_counter')")
  await source.client.query('BEGIN ISOLATION LEVEL REPEATABLE READ READ ONLY')
  let before
  const dump = join(root, 'schema12.dump')
  try {
    const snapshot = (await source.client.query('SELECT pg_export_snapshot() AS value')).rows[0].value
    before = await databaseCensus(source.client)
    dumpDatabase(dump, source, source.config, snapshot)
  } finally { await source.client.query('ROLLBACK') }
  assert.equal(before.schema, 15); assert.equal(Object.keys(before.tables).length, currentTableCount)
  assert.equal(before.tables.pe_native_presentations.rows, 0)
  assert.equal(before.tables.pe_native_presentation_entries.rows, 0)
  assert.equal(before.tables.pe_events.rows, 1)
  assert.equal(before.tables.pe_native_writers.rows, 3)
  assert.equal(before.tables.pe_cloud_executions.rows, 3)
  for (const [name, member] of [['pe_cloud_executions', 'pe_cloud_execution_keep_delivery'],
    ['pe_operations', 'pe_operation_require_continuation_delivery'],
    ['pe_cloud_executions', 'pe_cloud_execution_capture_native_cancel']]) {
    assert.ok(before.definitions.some(row => row.kind === 'trigger' && row.name === name && row.member === member
      && row.definition.startsWith('O:CREATE TRIGGER')))
  }
  for (const table of nativeTables) assert.equal(before.tables[table].rows, nativeFactsBefore[table].length)
  assert.deepEqual(await nativeFacts(source.client), nativeFactsBefore)
  assert.deepEqual((await source.client.query(writersQuery)).rows, writerTombstones)
  const target = await connect(names[1], targetRole)
  await requireEmptyDatabase(target.client)
  await target.client.end(); clients.delete(target.client)
  const bundle = await archive('schema12-bundle', dump, before)
  const restore = await restoreBackup(restoreConfig(bundle, target, 'restored'))
  assert.equal(restore.schema, 15); assert.equal(restore.tables, currentTableCount)
  assert.equal(restore.allRowsVerified, true); assert.equal(restore.allFilesVerified, true)
  assert.deepEqual(await readFile(restoreConfig(bundle, target, 'restored').nativeIntentKeyFile), nativeIntentKeyBytes)
  assert.equal(restore.readinessChecked, false); assert.equal(restore.profilesRequireRebinding, true)
  const restoredConnection = await connectDatabase(target.config)
  clients.add(restoredConnection.client); target.client = restoredConnection.client
  await requireCurrentSchema(target.client)
  await requireQuiescentDatabase(target.client)
  const after = await census(target.client)
  assert.deepEqual(after, before)
  assert.deepEqual((await target.client.query(nativeExecutionsQuery)).rows, nativeExecutionsBefore)
  assert.deepEqual((await target.client.query('SELECT native_tool_stop_request_id,native_tool_stop_target,native_tool_cancel_cause,result FROM pe_cloud_executions WHERE id=$1',
    [nativeStopped])).rows, [{ native_tool_stop_request_id: stopRequestId, native_tool_stop_target: stopTarget,
    native_tool_cancel_cause: 'timeout', result: null }])
  for (const mutation of ["result_delivery='continuation'", "command='replayed command'", 'command_timeout_ms=4000',
    "native_tool_cancel_cause='abort'"]) {
    await assert.rejects(target.client.query(`UPDATE pe_cloud_executions SET ${mutation} WHERE id=$1`, [nativeStopped]), { code: '23514' })
  }
  await assert.rejects(target.client.query(`INSERT INTO pe_operations
    (id,session_id,request_id,input,settings,state,source,source_execution_id)
    VALUES($1,$2,$3,'unexpected native continuation','{}','queued','sandbox_result',$4)`,
  [randomUUID(), session, randomUUID(), nativeCompleted]), { code: '23514' })
  assert.deepEqual(await nativeFacts(target.client), nativeFactsBefore)
  assert.deepEqual((await target.client.query('SELECT frame_json,grant_json FROM pe_native_turn_frames')).rows,
    [{ frame_json: frame, grant_json: grant }])
  assert.deepEqual((await target.client.query('SELECT receipt_json FROM pe_native_turn_transitions_v2')).rows,
    [{ receipt_json: receipt }])
  for (const table of ['pe_native_input_origins', 'pe_native_input_commands',
    'pe_native_input_revisions', 'pe_native_input_claims']) {
    await target.client.query('BEGIN')
    try {
      await assert.rejects(target.client.query(`DELETE FROM ${table}`), { code: '23514' })
    } finally { await target.client.query('ROLLBACK') }
  }
  assert.deepEqual(await nativeFacts(target.client), nativeFactsBefore)
  assert.deepEqual((await target.client.query(writersQuery)).rows, writerTombstones)
  assert.deepEqual((await target.client.query('SELECT event FROM pe_events WHERE session_id=$1', [session])).rows, [{ event }])
  assert.deepEqual((await target.client.query('SELECT last_value::text,is_called FROM employee4_schema12_counter')).rows, [{ last_value: '9', is_called: true }])
  await assert.rejects(requireEmptyDatabase(target.client), /not empty/u)
  const occupied = await connect(names[3], sourceRole)
  await occupied.client.query('CREATE TABLE employee4_existing(value text)')
  await assert.rejects(requireEmptyDatabase(occupied.client), /not empty/u)
  assert.equal((await occupied.client.query('SELECT count(*)::text AS n FROM employee4_existing')).rows[0].n, '0')
  if (process.env.PE_SCHEMA12_BACKUP_EVIDENCE_DIR) {
    await mkdir(process.env.PE_SCHEMA12_BACKUP_EVIDENCE_DIR, { recursive: true, mode: 0o700 })
    await writeFile(join(process.env.PE_SCHEMA12_BACKUP_EVIDENCE_DIR, 'postgres-acceptance.json'), JSON.stringify({ schema: 15,
      tables: currentTableCount, ordinarySource: true, ordinaryTarget: true, old2RefusedWithoutWrites: true,
      old3RefusedWithoutWrites: true, old4RefusedWithoutWrites: true, old5RefusedWithoutWrites: true,
      old6RefusedWithoutWrites: true, old7RefusedWithoutWrites: true,
      presentationsRefusedWithoutWrites: true, entriesRefusedWithoutWrites: true, allRowsDefinitionsSequencesEqual: true,
      temporaryDumpRefusedBeforeFileRestore: true, publicRestoreAllFilesVerified: true,
      liveWriterRefusedWithoutWrites: true, liveWriterDumpRefusedBeforeFileRestore: true,
      writerTombstoneRows: 3, releasedAndExpiredWritersPreserved: true, writerEpochsPreserved: true,
      nativeInputFactsFramesReceiptsPreserved: true, restoredInputFactsImmutable: true,
      nativeExecutionsAndStopIdentityPreserved: true, nativeDeliveryTriggersPreserved: true,
      nativeCancellationFirstCausePreserved: true,
      activeNativeCancellationRefusedWithoutWrites: true, stoppingMountRefused: true,
      activeOperationRefused: true, uncertainMountRefused: true, otherConnectionRefused: true,
      emptyTemporaryTables: true, occupiedTargetRefused: true, formalProfilesChecked: false, businessReadinessChecked: false,
      sourceCensus: before, restoredCensus: after }, null, 2) + '\n', { mode: 0o600 })
  }
  passed = true
})
