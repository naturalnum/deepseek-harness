/** Real PG checks for the catalog migration and metadata-only operation grants. */
import test from 'node:test'
import assert from 'node:assert/strict'
import { randomBytes, randomUUID } from 'node:crypto'
import { readFile } from 'node:fs/promises'
import { homedir } from 'node:os'
import { join } from 'node:path'
import { Pool } from 'pg'
import { identity } from '../lib/contracts.js'
import { initializeDatabase } from '../lib/platform/database.js'
import * as migrations from '../lib/platform/schema.js'
import { TaskStore } from '../lib/platform/tasks.js'

const privateDir = process.env.PE_PRIVATE_DIR ?? join(homedir(), '.config/power-evolve/shared-host-slice2')
const databaseUrl = (await readFile(join(privateDir, 'database-url'), 'utf8')).trim()

test('V19 upgrade preserves selections and grants nine skills without loading their bytes', { timeout: 30000 }, async t => {
  const database = `pe_s8_grants_${randomBytes(10).toString('hex')}`
  const admin = new Pool({ connectionString: databaseUrl, max: 1 })
  let pool, created = false
  t.after(async () => {
    await pool?.end()
    if (created) await admin.query(`DROP DATABASE "${database}"`)
    await admin.end()
  })
  await admin.query(`CREATE DATABASE "${database}"`)
  created = true
  const url = new URL(databaseUrl)
  url.pathname = `/${database}`
  pool = new Pool({ connectionString: url.href, max: 1 })
  await pool.query(migrations.schema)
  await pool.query('INSERT INTO pe_schema(version) VALUES(1)')
  for (let version = 2; version <= 19; version++) await pool.query(migrations[`schemaV${version}`])
  const alice = identity.parse({ userId: randomUUID(), username: 'alice' })
  const bob = identity.parse({ userId: randomUUID(), username: 'bob' })
  for (const user of [alice, bob]) {
    await pool.query('INSERT INTO pe_users(id,username,password_hash,settings) VALUES($1,$2,$3,$4)',
      [user.userId, user.username, 'fixture', { model: 'fixture', maxTokens: 128, revision: 1 }])
    await pool.query(`INSERT INTO pe_user_models(user_id,model_id,label,max_tokens,enabled)
      VALUES($1,'fixture','Fixture',256,true)`, [user.userId])
  }
  const ids = []
  for (let i = 0; i < 9; i++) {
    const id = randomUUID()
    ids.push(id)
    await pool.query('INSERT INTO pe_user_skills(id,user_id,name,description,digest) VALUES($1,$2,$3,$4,$5)',
      [id, alice.userId, `skill-${i}`, `Description ${i}`, 'a'.repeat(64)])
  }
  await initializeDatabase(pool)
  await initializeDatabase(pool)
  assert.equal((await pool.query('SELECT version FROM pe_schema')).rows[0].version, 21)
  assert.equal((await pool.query('SELECT count(*)::int AS n FROM pe_user_skills')).rows[0].n, 9)
  assert.equal((await pool.query('SELECT count(*)::int AS n FROM pe_builtin_skill_install_requests')).rows[0].n, 0)
  const tasks = new TaskStore(pool, { maxEventBytes: 524288, leaseMs: 30000, maxPendingPerUser: 4, maxActivePerUser: 1 })
  const a = await tasks.create(alice, randomUUID())
  const b = await tasks.create(bob, randomUUID())
  await tasks.accept(alice, a.sessionId, randomUUID(), 'hi')
  const claimed = await tasks.claim(randomUUID())
  assert.equal(claimed.userId, alice.userId)
  assert.equal(claimed.selection.length, 9)
  assert.deepEqual(claimed.skills, [])
  assert(claimed.selection.every(item => !Object.hasOwn(item, 'instructions')))
  const accepted = await tasks.selectedSkills(claimed.token)
  assert.equal(accepted.userId, alice.userId)
  assert.deepEqual(new Set(accepted.selection.map(item => item.skillId)), new Set(ids))
  await pool.query('UPDATE pe_user_skills SET enabled=false WHERE user_id=$1', [alice.userId])
  assert.equal((await tasks.selectedSkills(claimed.token)).selection.length, 9)
  await assert.rejects(tasks.selectedSkills('x'.repeat(43)), error => error.code === 'lease_lost')
  await pool.query("UPDATE pe_sessions SET lease_until=now()-interval '1 second' WHERE id=$1", [a.sessionId])
  await assert.rejects(tasks.selectedSkills(claimed.token), error => error.code === 'lease_lost')
  await tasks.accept(bob, b.sessionId, randomUUID(), 'hi')
  // Reclaimed Alice work may precede Bob; its former token remains fenced.
  let next = await tasks.claim(randomUUID())
  if (next.userId === alice.userId) {
    await tasks.finish(next.token, 'failed', 'fixture_interrupted')
    next = await tasks.claim(randomUUID())
  }
  assert.equal(next.userId, bob.userId)
  assert.deepEqual((await tasks.selectedSkills(next.token)).selection, [])
})
