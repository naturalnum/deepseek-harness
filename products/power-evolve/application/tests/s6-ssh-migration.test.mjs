/** Real PG V23-to-V24 migration: historical versions, unchanged ciphertext and atomic refusal. */
import test from 'node:test'
import assert from 'node:assert/strict'
import { createCipheriv, createDecipheriv, randomBytes, randomUUID } from 'node:crypto'
import { readFile } from 'node:fs/promises'
import { homedir } from 'node:os'
import { join } from 'node:path'
import { Pool } from 'pg'
import { initializeDatabase, transaction } from '../lib/platform/database.js'
import * as migrations from '../lib/platform/schema.js'
import { sshConnectionValue } from '../lib/ssh-management-contracts.js'

const privateDir = process.env.PE_PRIVATE_DIR ?? join(homedir(), '.config/power-evolve/shared-host-s6-mcp-restored')
const databaseUrl = (await readFile(join(privateDir, 'database-url'), 'utf8')).trim()

async function oldDatabase(t) {
  const database = `pe_ssh_migration_${randomBytes(9).toString('hex')}`
  const admin = new Pool({ connectionString: databaseUrl, max: 1 })
  let pool, created = false
  t.after(async () => {
    await pool?.end()
    if (created) await admin.query(`DROP DATABASE "${database}"`)
    await admin.end()
  })
  await admin.query(`CREATE DATABASE "${database}"`)
  created = true
  const url = new URL(databaseUrl); url.pathname = `/${database}`
  pool = new Pool({ connectionString: url.href, max: 2 })
  await transaction(pool, async client => {
    await client.query(migrations.schema)
    await client.query('INSERT INTO pe_schema(version) VALUES(1)')
    for (let version = 2; version <= 23; version++) await client.query(migrations[`schemaV${version}`])
  })
  return pool
}

async function seed(pool) {
  const userId = randomUUID(), bobId = randomUUID(), connectionId = randomUUID(), installId = randomUUID()
  const toggleId = randomUUID(), pendingId = randomUUID(), sessionId = randomUUID(), operationId = randomUUID()
  const workspaceId = randomUUID(), callId = randomUUID(), actionId = randomUUID()
  const key = randomBytes(32)
  // A JSON-shaped legacy password must remain raw password bytes after migration.
  const password = '{"formatVersion":2,"password":"not-an-envelope"}'
  const iv = randomBytes(12), cipher = createCipheriv('aes-256-gcm', key, iv)
  cipher.setAAD(Buffer.from(['power-evolve-ssh-v1', userId, installId, '1'].join('\0')))
  const encrypted = Buffer.concat([cipher.update(password, 'utf8'), cipher.final()])
  const sealed = Buffer.concat([iv, cipher.getAuthTag(), encrypted])
  const metadata = { connectionId, displayName: 'Old target', host: 'fixture.example.test', port: 2222,
    username: 'alice', hostKeySha256: `SHA256:${'A'.repeat(43)}`, credentialRevision: 1 }
  for (const [id, name] of [[userId, 'alice'], [bobId, 'bob']]) await pool.query(
    'INSERT INTO pe_users(id,username,password_hash,settings) VALUES($1,$2,$3,$4)',
    [id, name, 'fixture', { model: 'fixture', maxTokens: 64, revision: 1 }])
  await pool.query(`INSERT INTO pe_ssh_connections(id,user_id,install_request_id,install_digest,
    display_name,host,port,username,host_key_sha256,credential_kind,encrypted_credential,enabled,revision)
    VALUES($1,$2,$3,$4,$5,$6,$7,$8,$9,'password',$10,true,4)`,
  [connectionId, userId, installId, 'a'.repeat(64), metadata.displayName, metadata.host,
    metadata.port, metadata.username, metadata.hostKeySha256, sealed])
  await pool.query(`INSERT INTO pe_ssh_upload_intents(request_id,user_id,request_digest,config,size_bytes,
    secret_digest,token_digest,expires_at,consumed_at,result)
    VALUES($1,$2,$3,$4,$5,$6,$7,now()+interval '1 minute',now(),$8)`,
  [installId, userId, 'a'.repeat(64), { requestId: installId, ...metadata, enabled: true },
    Buffer.byteLength(password), 'b'.repeat(64), 'c'.repeat(64),
    { item: { ...metadata, revision: 1, enabled: true }, failedVerifications: 2 }])
  await pool.query(`INSERT INTO pe_ssh_upload_intents(request_id,user_id,request_digest,config,size_bytes,
    token_digest,expires_at) VALUES($1,$2,$3,$4,5,$5,now()+interval '1 minute')`,
  [pendingId, bobId, 'd'.repeat(64), { requestId: pendingId }, 'e'.repeat(64)])
  await pool.query(`INSERT INTO pe_ssh_updates(user_id,request_id,connection_id,request_digest,result)
    VALUES($1,$2,$3,$4,$5)`, [userId, toggleId, connectionId, 'f'.repeat(64),
    { ...metadata, revision: 2, enabled: false }])
  await pool.query('INSERT INTO pe_workspaces(id,user_id,title,is_default) VALUES($1,$2,$3,true)',
    [workspaceId, userId, 'Migration workspace'])
  await pool.query(`INSERT INTO pe_sessions(id,user_id,create_request_id,header,workspace_id)
    VALUES($1,$2,$3,$4,$5)`, [sessionId, userId, randomUUID(), {}, workspaceId])
  const selection = [{ connectionId, revision: 3, credentialRevision: 1, displayName: metadata.displayName,
    host: metadata.host, port: metadata.port, username: metadata.username }]
  await pool.query(`INSERT INTO pe_operations(id,session_id,request_id,input,settings,state,ssh_selection)
    VALUES($1,$2,$3,'legacy task',$4,'completed',$5)`,
  [operationId, sessionId, randomUUID(), {}, JSON.stringify(selection)])
  await pool.query(`INSERT INTO pe_ssh_calls(id,user_id,request_id,connection_id,connection_revision,
    credential_revision,kind,request_digest,state)
    VALUES($1,$2,$3,$4,2,1,'ssh.authenticate',$5,'failed')`,
  [callId, userId, randomUUID(), connectionId, 'a'.repeat(64)])
  await pool.query(`INSERT INTO pe_ssh_execute_actions(id,user_id,session_id,operation_id,call_key,
    connection_id,connection_revision,credential_revision,command_sealed,request_digest,state)
    VALUES($1,$2,$3,$4,'legacy',$5,3,1,$6,$7,'pending')`,
  [actionId, userId, sessionId, operationId, connectionId, randomBytes(29), 'b'.repeat(64)])
  return { userId, bobId, connectionId, installId, toggleId, pendingId, key, sealed, password, metadata, callId }
}

test('V24 retains all referenced configurations, legacy ciphertext and original owner receipts',
  { timeout: 60_000 }, async t => {
    const pool = await oldDatabase(t), fixture = await seed(pool)
    await initializeDatabase(pool)
    await initializeDatabase(pool)
    assert.equal((await pool.query('SELECT version FROM pe_schema')).rows[0].version, 24)
    const configs = (await pool.query('SELECT * FROM pe_ssh_configuration_versions ORDER BY revision')).rows
    assert.deepEqual(configs.map(row => row.revision), [1, 2, 3, 4])
    assert.ok(configs.every(row => row.host === fixture.metadata.host && row.working_directory === null))
    const credential = (await pool.query('SELECT * FROM pe_ssh_credential_versions')).rows[0]
    assert.equal(credential.format_version, 1)
    assert.equal(credential.aad_request_id, fixture.installId)
    assert.deepEqual(credential.encrypted_credential, fixture.sealed)
    const decipher = createDecipheriv('aes-256-gcm', fixture.key, credential.encrypted_credential.subarray(0, 12))
    decipher.setAAD(Buffer.from(['power-evolve-ssh-v1', fixture.userId, credential.aad_request_id,
      String(credential.credential_revision)].join('\0')))
    decipher.setAuthTag(credential.encrypted_credential.subarray(12, 28))
    assert.equal(Buffer.concat([decipher.update(credential.encrypted_credential.subarray(28)),
      decipher.final()]).toString('utf8'), fixture.password)
    const receipts = (await pool.query('SELECT * FROM pe_ssh_management_requests WHERE user_id=$1 ORDER BY purpose',
      [fixture.userId])).rows
    assert.equal(receipts.length, 2)
    assert.deepEqual(receipts.map(row => sshConnectionValue.parse(row.result).revision), [1, 2])
    assert.deepEqual(receipts.map(row => row.result.enabled), [true, false])
    assert.deepEqual(receipts.map(row => row.request_digest), ['a'.repeat(64), 'f'.repeat(64)])
    const pending = (await pool.query('SELECT * FROM pe_ssh_management_requests WHERE request_id=$1',
      [fixture.pendingId])).rows[0]
    assert.equal(pending.result, null)
    assert.equal(pending.connection_id, null)
    assert.equal(pending.completed_at, null)
    assert.equal((await pool.query('SELECT verification_failures FROM pe_ssh_upload_intents WHERE request_id=$1',
      [fixture.installId])).rows[0].verification_failures, 2)
    await assert.rejects(pool.query('UPDATE pe_ssh_configuration_versions SET host=$1 WHERE connection_id=$2',
      ['changed.example.test', fixture.connectionId]), /SSH versions are immutable/)
    await assert.rejects(pool.query('DELETE FROM pe_ssh_credential_versions WHERE connection_id=$1',
      [fixture.connectionId]), /SSH versions are immutable/)
    await assert.rejects(pool.query('UPDATE pe_ssh_connections SET revision=5 WHERE id=$1',
      [fixture.connectionId]), { code: '23503' })
    await assert.rejects(pool.query('UPDATE pe_ssh_calls SET user_id=$1 WHERE id=$2',
      [fixture.bobId, fixture.callId]), { code: '23503' })
  })

for (const scenario of ['missing-credential', 'changed-target', 'request-collision']) {
  test(`V24 refuses ${scenario} and leaves the entire V23 database unchanged`,
    { timeout: 60_000 }, async t => {
      const pool = await oldDatabase(t), fixture = await seed(pool)
      if (scenario === 'missing-credential') {
        await pool.query('UPDATE pe_ssh_calls SET credential_revision=2 WHERE id=$1', [fixture.callId])
      } else if (scenario === 'changed-target') {
        await pool.query(`UPDATE pe_ssh_updates SET result=jsonb_set(result,'{host}','"old.example.test"')
          WHERE request_id=$1`, [fixture.toggleId])
      } else {
        await pool.query('UPDATE pe_ssh_updates SET request_id=$1 WHERE request_id=$2',
          [fixture.installId, fixture.toggleId])
      }
      const before = (await pool.query('SELECT * FROM pe_ssh_connections ORDER BY id')).rows
      await assert.rejects(initializeDatabase(pool), /SSH migration:/)
      assert.equal((await pool.query('SELECT version FROM pe_schema')).rows[0].version, 23)
      assert.equal((await pool.query("SELECT to_regclass('public.pe_ssh_credential_versions') AS relation")).rows[0].relation, null)
      assert.deepEqual((await pool.query('SELECT * FROM pe_ssh_connections ORDER BY id')).rows, before)
    })
}
