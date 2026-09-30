/** Runtime reads fence real PG grants before and after controlled filesystem access. */
import test from 'node:test'
import assert from 'node:assert/strict'
import { randomBytes, randomUUID } from 'node:crypto'
import { mkdtemp, readFile, rm } from 'node:fs/promises'
import { homedir, tmpdir } from 'node:os'
import { join } from 'node:path'
import { Pool } from 'pg'
import { initializeDatabase } from '../lib/platform/database.js'
import { TaskStore } from '../lib/platform/tasks.js'
import { SkillService } from '../lib/platform/skills.js'
import { readRuntimeSkill, readRuntimeSkillResource } from '../lib/platform/runtime-skills.js'

const privateDir = process.env.PE_PRIVATE_DIR ?? join(homedir(), '.config/power-evolve/shared-host-slice2')
const databaseUrl = (await readFile(join(privateDir, 'database-url'), 'utf8')).trim()

test('runtime skills use accepted owner and version, reject foreign IDs and fence loss during reads',
  { timeout: 30000 }, async t => {
    const database = `pe_s8_reads_${randomBytes(10).toString('hex')}`
    const root = await mkdtemp(join(tmpdir(), 'pe-s8-runtime-'))
    const admin = new Pool({ connectionString: databaseUrl, max: 1 })
    let pool, created = false
    t.after(async () => {
      await pool?.end()
      if (created) await admin.query(`DROP DATABASE "${database}"`)
      await admin.end()
      await rm(root, { recursive: true, force: true })
    })
    await admin.query(`CREATE DATABASE "${database}"`)
    created = true
    const url = new URL(databaseUrl)
    url.pathname = `/${database}`
    // A single connection also catches nested pool acquisitions around file reads.
    pool = new Pool({ connectionString: url.href, max: 1 })
    await initializeDatabase(pool)
    const alice = { userId: randomUUID(), username: 'alice' }
    const bob = { userId: randomUUID(), username: 'bob' }
    for (const user of [alice, bob]) {
      await pool.query('INSERT INTO pe_users(id,username,password_hash,settings) VALUES($1,$2,$3,$4)',
        [user.userId, user.username, 'fixture', { model: 'fixture', maxTokens: 128, revision: 1 }])
      await pool.query(`INSERT INTO pe_user_models(user_id,model_id,label,max_tokens,enabled)
        VALUES($1,'fixture','Fixture',256,true)`, [user.userId])
    }
    const skills = new SkillService(pool, root)
    await skills.init()
    const a = await skills.install(alice, randomUUID(), 'alice-skill', 'Alice description', 'Alice private body')
    const b = await skills.install(bob, randomUUID(), 'bob-skill', 'Bob description', 'Bob private body')
    const tasks = new TaskStore(pool, { maxEventBytes: 524288, leaseMs: 30000, maxPendingPerUser: 4, maxActivePerUser: 1 })
    const session = await tasks.create(alice, randomUUID())
    await tasks.accept(alice, session.sessionId, randomUUID(), 'Explain my skill')
    const grant = await tasks.claim(randomUUID())
    await skills.toggle(alice, a.skillId, false)
    assert.equal((await readRuntimeSkill(tasks, skills, grant.token, a.skillId)).instructions, 'Alice private body')
    assert.equal((await readRuntimeSkillResource(tasks, skills, grant.token, a.skillId, 'SKILL.md')).text, 'Alice private body')
    assert.equal((await readRuntimeSkillResource(tasks, skills, grant.token, a.skillId)).files.length, 1)
    await assert.rejects(readRuntimeSkill(tasks, skills, grant.token, b.skillId), { code: 'skill_not_found' })
    await assert.rejects(readRuntimeSkillResource(tasks, skills, grant.token, b.skillId, 'SKILL.md'), { code: 'skill_not_found' })
    await assert.rejects(readRuntimeSkillResource(tasks, skills, grant.token, a.skillId, '../SKILL.md'),
      { code: 'invalid_skill_resource_path' })
    const expire = () => pool.query("UPDATE pe_sessions SET lease_until=now()-interval '1 second' WHERE id=$1", [session.sessionId])
    const interrupted = {
      readSelected: skills.readSelected.bind(skills),
      async runtimeResourceBase(...args) {
        const value = await skills.runtimeResourceBase(...args)
        await expire()
        return value
      },
      async readSelectedResource(...args) {
        const value = await skills.readSelectedResource(...args)
        await expire()
        return value
      },
    }
    await assert.rejects(readRuntimeSkill(tasks, interrupted, grant.token, a.skillId), { code: 'lease_lost' })
    await pool.query("UPDATE pe_sessions SET lease_until=now()+interval '30 seconds' WHERE id=$1", [session.sessionId])
    await assert.rejects(readRuntimeSkillResource(tasks, interrupted, grant.token, a.skillId, 'SKILL.md'), { code: 'lease_lost' })
    await assert.rejects(readRuntimeSkillResource(tasks, skills, grant.token, a.skillId), { code: 'lease_lost' })
    assert.equal((await pool.query('SELECT count(*)::int AS n FROM pe_cloud_executions')).rows[0].n, 0)
  })
