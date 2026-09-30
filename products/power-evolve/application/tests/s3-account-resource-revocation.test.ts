/** Real PostgreSQL resource mutations after account revocation; no browser or execution substitute. */
import assert from 'node:assert/strict'
import { randomBytes, randomUUID } from 'node:crypto'
import { mkdtemp, readFile, rm } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { setTimeout as delay } from 'node:timers/promises'
import { test } from 'node:test'
import { Pool } from 'pg'
import { identity } from '../src/contracts.ts'
import { initializeDatabase } from '../src/platform/database.ts'
import { FileService } from '../src/platform/files.ts'
import { ArtifactService } from '../src/platform/artifacts.ts'
import { SkillService } from '../src/platform/skills.ts'
import { PluginService } from '../src/platform/plugins.ts'

const privateDir = process.env.PE_ACCOUNT_TEST_PRIVATE_DIR
test('a mutation waiting behind disable cannot write files or metadata with a stale identity',
  { skip: !privateDir, timeout: 30000 }, async t => {
    const source = new URL((await readFile(join(privateDir!, 'database-url'), 'utf8')).trim())
    const name = `pe_account_resources_${randomBytes(8).toString('hex')}`
    const adminUrl = new URL(source); adminUrl.pathname = '/postgres'
    const admin = new Pool({ connectionString: adminUrl.href, max: 1 })
    const target = new URL(source); target.pathname = `/${name}`
    const pool = new Pool({ connectionString: target.href, max: 5 })
    const directory = await mkdtemp(join(tmpdir(), 'pe-account-resources-'))
    let created = false
    t.after(async () => {
      await pool.end()
      if (created) await admin.query(`DROP DATABASE "${name}"`)
      await admin.end()
      await rm(directory, { recursive: true, force: true })
    })
    await admin.query(`CREATE DATABASE "${name}"`); created = true
    await initializeDatabase(pool)
    const alice = identity.parse({ userId: randomUUID(), username: 'alice' })
    const bob = identity.parse({ userId: randomUUID(), username: 'bob' })
    for (const user of [alice, bob]) await pool.query(
      'INSERT INTO pe_users(id,username,password_hash,settings) VALUES($1,$2,$3,$4)',
      [user.userId, user.username, 'unused-fixture-hash', { model: 'fixture-model', maxTokens: 64, revision: 1 }])
    const files = new FileService(pool, join(directory, 'workspaces'))
    await files.init()
    const workspace = await files.workspaceForUser(alice.userId)
    const held = await pool.connect()
    try {
      await held.query('BEGIN')
      await held.query('UPDATE pe_users SET enabled=false WHERE id=$1', [alice.userId])
      const pid = (await held.query<{ pid: number }>('SELECT pg_backend_pid() AS pid')).rows[0]!.pid
      const writing = assert.rejects(files.put(alice, randomUUID(), 'late.txt', null, Buffer.from('late bytes').toString('base64'), workspace.id),
        { status: 401, code: 'account_disabled' })
      try {
        const until = Date.now() + 3000
        for (;;) {
          const waiting = await pool.query<{ waiting: boolean }>(`SELECT EXISTS(SELECT 1 FROM pg_stat_activity
            WHERE datname=current_database() AND $1=ANY(pg_blocking_pids(pid))) AS waiting`, [pid])
          if (waiting.rows[0]!.waiting) break
          assert(Date.now() < until, 'File mutation did not reach the held account lock')
          await delay(10)
        }
      } finally { await held.query('COMMIT'); await writing }
    } finally { await held.query('ROLLBACK'); held.release() }
    assert.equal((await pool.query('SELECT 1 FROM pe_file_mutations WHERE user_id=$1', [alice.userId])).rowCount, 0)
    await assert.rejects(readFile(join(workspace.path, 'late.txt')), { code: 'ENOENT' })
    const artifacts = new ArtifactService(pool, files, join(directory, 'artifacts'))
    await artifacts.init()
    const skills = new SkillService(pool, join(directory, 'workspaces'), '', 64)
    await skills.init()
    const plugins = new PluginService(pool)
    for (const mutation of [
      () => artifacts.publish(alice, randomUUID(), randomUUID(), 'late.txt'),
      () => skills.install(alice, randomUUID(), 'late-skill', 'fixture', 'fixture instructions'),
      () => plugins.notesSetEnabled(alice, { requestId: randomUUID(), expectedRevision: 1, enabled: true }),
      () => plugins.list(alice),
    ]) await assert.rejects(mutation(), { status: 401, code: 'account_disabled' })
    await files.put(bob, randomUUID(), 'available.txt', null, Buffer.from('bob bytes').toString('base64'))
    assert.equal(Buffer.from((await files.read(bob, 'available.txt')).data, 'base64').toString(), 'bob bytes')
  })
