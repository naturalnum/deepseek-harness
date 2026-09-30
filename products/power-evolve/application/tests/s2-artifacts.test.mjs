/** PostgreSQL and private POSIX regression for S2 artifact publication. */
import test from 'node:test'
import assert from 'node:assert/strict'
import { randomBytes, randomUUID } from 'node:crypto'
import { mkdtemp, readFile, rm } from 'node:fs/promises'
import { homedir, tmpdir } from 'node:os'
import { join } from 'node:path'
import { Pool } from 'pg'
import { initializeDatabase } from '../lib/platform/database.js'
import { FileService } from '../lib/platform/files.js'
import { ArtifactService } from '../lib/platform/artifacts.js'
import { TaskFixtureStore as TaskStore } from './task-credential-fixture.mjs'
import { identity, requestId } from '../lib/contracts.js'

const privateDir = process.env.PE_PRIVATE_DIR ?? join(homedir(), '.config/power-evolve/shared-host-slice2')
const databaseUrl = (await readFile(join(privateDir, 'database-url'), 'utf8')).trim()

async function isolated(run) {
  const name = `pe_artifacts_${randomBytes(10).toString('hex')}`
  const root = await mkdtemp(join(tmpdir(), 'pe-s2-artifacts-'))
  const admin = new Pool({ connectionString: databaseUrl, max: 2 })
  let pool
  try {
    await admin.query(`CREATE DATABASE "${name}"`)
    const url = new URL(databaseUrl)
    url.pathname = `/${name}`
    pool = new Pool({ connectionString: url.href, max: 8 })
    await initializeDatabase(pool)
    await run(pool, root)
  } finally {
    await pool?.end()
    await admin.query(`DROP DATABASE IF EXISTS "${name}"`)
    await admin.end()
    await rm(root, { recursive: true, force: true })
  }
}

async function user(pool, username) {
  const id = randomUUID()
  await pool.query('INSERT INTO pe_users(id,username,password_hash,settings) VALUES($1,$2,$3,$4)',
    [id, username, 'test-only', { model: 'fixture', maxTokens: 100, revision: 1 }])
  return identity.parse({ userId: id, username })
}

test('published bytes survive source edits and enforce user, Session, and request ownership', { timeout: 30000 }, async () => {
  await isolated(async (pool, root) => {
    const alice = await user(pool, 'alice')
    const bob = await user(pool, 'bob')
    const files = new FileService(pool, join(root, 'workspaces'))
    await files.init()
    const artifacts = new ArtifactService(pool, files, join(root, 'artifacts'))
    await artifacts.init()
    const tasks = new TaskStore(pool, { maxEventBytes: 524288, leaseMs: 3000, maxPendingPerUser: 8, maxActivePerUser: 1 })
    const session = (await tasks.create(alice, requestId.parse(randomUUID()))).sessionId
    const firstFile = await files.put(alice, randomUUID(), 'result.txt', null, Buffer.from('first result').toString('base64'))
    const publishId = randomUUID()
    const published = await artifacts.publish(alice, publishId, session, 'result.txt')
    assert.equal(published.artifactId, publishId)
    assert.equal(published.sessionId, session)
    assert.equal(published.sizeBytes, Buffer.byteLength('first result'))
    assert.deepEqual(await artifacts.publish(alice, publishId, session, 'result.txt'), published)
    await assert.rejects(artifacts.publish(alice, publishId, session, 'other.txt'),
      { status: 409, code: 'request_id_conflict' })

    await files.put(alice, randomUUID(), 'result.txt', firstFile.revision, Buffer.from('later edit').toString('base64'))
    assert.equal((await artifacts.bytes(alice, published.artifactId)).bytes.toString(), 'first result')
    assert.equal((await artifacts.preview(alice, published.artifactId)).text, 'first result')
    assert.equal((await artifacts.list(alice, { sessionId: session, limit: 10 })).items.length, 1)
    assert.equal((await artifacts.list(alice, { limit: 10 })).nextCursor, null)
    assert.deepEqual((await artifacts.list(bob, { limit: 10 })).items, [])
    await assert.rejects(artifacts.bytes(bob, published.artifactId), { status: 404, code: 'artifact_not_found' })
    await assert.rejects(artifacts.publish(bob, randomUUID(), session, 'result.txt'),
      { status: 404, code: 'session_not_found' })
    await assert.rejects(artifacts.list(bob, { sessionId: session, limit: 10 }),
      { status: 404, code: 'session_not_found' })

    await files.put(alice, randomUUID(), 'another.txt', null, Buffer.from('another').toString('base64'))
    const second = await artifacts.publish(alice, randomUUID(), session, 'another.txt')
    const firstPage = await artifacts.list(alice, { limit: 1 })
    assert.equal(firstPage.items.length, 1)
    assert.equal(firstPage.nextCursor, firstPage.items[0].artifactId)
    const nextPage = await artifacts.list(alice, { limit: 1, cursor: firstPage.nextCursor })
    assert.equal(nextPage.items.length, 1)
    assert.notEqual(nextPage.items[0].artifactId, firstPage.items[0].artifactId)
    assert.deepEqual(new Set([firstPage.items[0].artifactId, nextPage.items[0].artifactId]),
      new Set([published.artifactId, second.artifactId]))
    await assert.rejects(artifacts.list(bob, { limit: 1, cursor: firstPage.nextCursor }),
      { status: 400, code: 'invalid_cursor' })

    const boundary = Buffer.concat([Buffer.alloc(128 * 1024 - 1, 65), Buffer.from('世界')])
    await files.put(alice, randomUUID(), 'boundary.txt', null, boundary.toString('base64'))
    const boundaryArtifact = await artifacts.publish(alice, randomUUID(), session, 'boundary.txt')
    const preview = await artifacts.preview(alice, boundaryArtifact.artifactId)
    assert.equal(preview.truncated, true)
    assert.equal(preview.text, 'A'.repeat(128 * 1024 - 1))
  })
})
