/** Adjacent Office schema checks against a disposable real PG database; no parser or stop proof is simulated. */
import assert from 'node:assert/strict'
import test from 'node:test'
import { randomBytes, randomUUID } from 'node:crypto'
import { readFile } from 'node:fs/promises'
import { homedir } from 'node:os'
import { join } from 'node:path'
import { Pool, Client } from 'pg'
import * as predecessors from '../lib/platform/schema.js'
import { schemaV27 } from '../lib/platform/storage-binding-schema.js'
import { schemaV28 } from '../lib/platform/execution-resolution-schema.js'
import { schemaV29 } from '../lib/platform/device-execution-schema.js'
import { schemaV30 } from '../lib/platform/device-resolution-schema.js'
import { schemaV31 } from '../lib/platform/device-claim-closure-schema.js'
import { initializeDatabase, transaction } from '../lib/platform/database.js'
import { revokeAccountExecutions } from '../lib/platform/account-execution-revocation.js'
import { lockAccountAuthorities } from '../lib/platform/account-authority.js'
import { identity } from '../lib/contracts.js'
import { inspectBackupState, requireIdleBackupState } from '../../scripts/backup-state.mjs'

test('Office migration retains prior Session bytes, durable early cancellation and unreleased parser slots',
  { timeout: 30_000 }, async t => {
    const privateDir = process.env.PE_PRIVATE_DIR ?? join(homedir(), '.config/power-evolve/shared-host-desktop-owned-20261004')
    const databaseUrl = process.env.PE_TEST_DATABASE_URL ?? (await readFile(join(privateDir, 'database-url'), 'utf8')).trim()
    const databaseName = `pe_office_v32_${randomBytes(10).toString('hex')}`
    const admin = new Pool({ connectionString: databaseUrl, max: 1, idleTimeoutMillis: 0 })
    let pool, created = false
    try {
      await admin.query(`CREATE DATABASE "${databaseName}"`); created = true
      const url = new URL(databaseUrl); url.pathname = `/${databaseName}`
      pool = new Pool({ connectionString: url.href, max: 2, idleTimeoutMillis: 0 })
      await transaction(pool, async client => {
        await client.query(predecessors.schema)
        await client.query('INSERT INTO pe_schema(version) VALUES(1)')
        for (let version = 2; version <= 26; version++) await client.query(predecessors[`schemaV${version}`])
        for (const migration of [schemaV27, schemaV28, schemaV29, schemaV30, schemaV31]) await client.query(migration)
      })
      const alice = randomUUID(), bob = randomUUID(), workspace = randomUUID(), session = randomUUID()
      const generation = 'a'.repeat(64), requestId = randomUUID(), cancelled = randomUUID()
      for (const [user, name] of [[alice, 'alice'], [bob, 'bob']]) {
        await pool.query('INSERT INTO pe_users(id,username,password_hash,settings) VALUES($1,$2,$3,$4)',
          [user, name, 'fixture-only', {}])
      }
      await pool.query('INSERT INTO pe_workspaces(id,user_id) VALUES($1,$2)', [workspace, alice])
      await pool.query('INSERT INTO pe_sessions(id,user_id,workspace_id,create_request_id,header) VALUES($1,$2,$3,$4,$5)',
        [session, alice, workspace, randomUUID(), { title: '原会话😀' }])
      await pool.query('INSERT INTO pe_events(session_id,seq,event) VALUES($1,0,$2)', [session, { text: '原字节\u0000😀' }])
      const original = (await pool.query('SELECT * FROM pe_sessions WHERE id=$1', [session])).rows[0]
      const events = (await pool.query('SELECT * FROM pe_events WHERE session_id=$1', [session])).rows

      await t.test('adjacent initialization preserves legacy facts and is repeatable', async () => {
        assert.equal((await pool.query('SELECT version FROM pe_schema')).rows[0].version, 31)
        await initializeDatabase(pool); await initializeDatabase(pool)
        assert.equal((await pool.query('SELECT version FROM pe_schema')).rows[0].version, predecessors.CURRENT_SCHEMA_VERSION)
        assert.deepEqual((await pool.query('SELECT * FROM pe_sessions WHERE id=$1', [session])).rows[0], original)
        assert.deepEqual((await pool.query('SELECT * FROM pe_events WHERE session_id=$1', [session])).rows, events)
        assert.equal((await pool.query('SELECT count(*)::int AS n FROM pe_office_preview_jobs')).rows[0].n, 0)
      })

      const placeholder = (id, owner, key, cancelFlag = true) => pool.query(`INSERT INTO pe_office_preview_jobs
        (id,user_id,request_id,generation,state,cancel_requested,completed_at)
        VALUES($1,$2,$3,$4,'cancelled',$5,now())`, [id, owner, key, generation, cancelFlag])
      const admission = (id, owner = alice, key = randomUUID()) => pool.query(`INSERT INTO pe_office_preview_jobs
        (id,user_id,request_id,generation,request_digest,request,session_id,workspace_id,binding_snapshot,
          source_snapshot,converter_snapshot,state,deadline_at)
        VALUES($1,$2,$3,$4,$4,'{}',$5,$6,'{}','{}','{}','queued',now()+interval '2 minutes')`,
      [id, owner, key, generation, session, workspace])

      await t.test('early cancellation has a permanent identity and cannot be promoted or rebound', async () => {
        await placeholder(cancelled, alice, requestId)
        await assert.rejects(placeholder(randomUUID(), alice, requestId), { code: '23505' })
        await placeholder(randomUUID(), bob, requestId)
        await assert.rejects(placeholder(randomUUID(), alice, randomUUID(), false), { code: '23514' })
        await assert.rejects(pool.query(`UPDATE pe_office_preview_jobs SET request_digest=$2,request='{}',
          session_id=$3,workspace_id=$4,binding_snapshot='{}',source_snapshot='{}',converter_snapshot='{}',
          deadline_at=now(),state='queued',completed_at=NULL WHERE id=$1`, [cancelled, generation, session, workspace]),
        { code: '23514' })
        await assert.rejects(pool.query('UPDATE pe_office_preview_jobs SET generation=$2 WHERE id=$1',
          [cancelled, 'b'.repeat(64)]), { code: '23514' })
        assert.equal((await pool.query('SELECT state FROM pe_office_preview_jobs WHERE id=$1', [cancelled])).rows[0].state, 'cancelled')
      })

      await t.test('admission cannot attach another user to the original Workspace or Session', async () => {
        await assert.rejects(admission(randomUUID(), bob), { code: '23503' })
      })

      await t.test('lease expiry and blocked termination retain the exact occupied parser slot', async () => {
        const first = randomUUID(), second = randomUUID(), third = randomUUID()
        for (const id of [first, second, third]) await admission(id)
        await pool.query(`UPDATE pe_office_preview_jobs SET state='creating',creation_intent='{}',parser_slot=0,
          lease_owner=$2,lease_epoch=1,lease_until=now()-interval '1 second' WHERE id=$1`, [first, randomUUID()])
        await assert.rejects(pool.query(`UPDATE pe_office_preview_jobs SET state='creating',creation_intent='{}',
          parser_slot=0 WHERE id=$1`, [second]), { code: '23505' })
        await pool.query(`UPDATE pe_office_preview_jobs SET state='blocked',error_code='unavailable' WHERE id=$1`, [first])
        await assert.rejects(pool.query(`UPDATE pe_office_preview_jobs SET parser_slot=NULL WHERE id=$1`, [first]), { code: '23514' })
        await assert.rejects(pool.query(`UPDATE pe_office_preview_jobs SET state='cancelled',error_code=NULL,
          cancel_requested=true,completed_at=now(),parser_slot=NULL WHERE id=$1`, [first]), { code: '23514' })
        await assert.rejects(pool.query(`UPDATE pe_office_preview_jobs SET state='creating',creation_intent='{}',
          parser_slot=0 WHERE id=$1`, [third]), { code: '23505' })
        await pool.query(`UPDATE pe_office_preview_jobs SET state='creating',creation_intent='{}',parser_slot=1 WHERE id=$1`, [second])
        assert.deepEqual((await pool.query('SELECT parser_slot FROM pe_office_preview_jobs WHERE parser_slot IS NOT NULL ORDER BY parser_slot'))
          .rows.map(row => row.parser_slot), [0, 1])
      })

      await t.test('account disablement cancels admission while preserving occupied slots and other owners', async () => {
        const owner = identity.parse({ userId: alice, username: 'alice' })
        const beforeBob = (await pool.query('SELECT * FROM pe_office_preview_jobs WHERE user_id=$1', [bob])).rows
        const beforeSlots = (await pool.query(`SELECT id,parser_slot,creation_intent,lease_owner,lease_epoch,lease_until
          FROM pe_office_preview_jobs WHERE parser_slot IS NOT NULL ORDER BY id`)).rows
        const revoke = () => transaction(pool, async client => {
          await lockAccountAuthorities(client, [owner.userId], 'update')
          await client.query('UPDATE pe_users SET enabled=false WHERE id=$1', [owner.userId])
          return revokeAccountExecutions(client, owner.userId)
        })
        assert.equal((await revoke()).executions, 3)
        assert.equal((await revoke()).executions, 0)
        assert.deepEqual((await pool.query('SELECT * FROM pe_office_preview_jobs WHERE user_id=$1', [bob])).rows, beforeBob)
        assert.deepEqual((await pool.query(`SELECT id,parser_slot,creation_intent,lease_owner,lease_epoch,lease_until
          FROM pe_office_preview_jobs WHERE parser_slot IS NOT NULL ORDER BY id`)).rows, beforeSlots)
        assert.equal((await pool.query(`SELECT count(*)::int AS n FROM pe_office_preview_jobs
          WHERE user_id=$1 AND NOT cancel_requested`, [alice])).rows[0].n, 0)
        assert.equal((await pool.query(`SELECT count(*)::int AS n FROM pe_office_preview_jobs
          WHERE user_id=$1 AND request_digest IS NOT NULL AND creation_intent IS NULL AND state='cancelled'`, [alice])).rows[0].n, 1)
      })

      await t.test('backup admission refuses durable parser reservations after cancellation and expired leases', async () => {
        const state = await inspectBackupState(Client, url.href)
        assert.equal(state.schema, predecessors.CURRENT_SCHEMA_VERSION)
        assert.equal(state.active.officePreviews, 2)
        assert.throws(() => requireIdleBackupState(state), /no active operations/u)
      })
    } finally {
      await pool?.end()
      try { if (created) await admin.query(`DROP DATABASE "${databaseName}"`) }
      finally { await admin.end() }
    }
  })
