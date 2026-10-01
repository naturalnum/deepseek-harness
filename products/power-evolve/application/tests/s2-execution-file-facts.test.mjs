/** Real isolated PostgreSQL and descriptor-relative facts/publication regressions. */
import test from 'node:test'
import assert from 'node:assert/strict'
import { createHash, randomBytes, randomUUID } from 'node:crypto'
import { mkdir, mkdtemp, readFile, readdir, rm, symlink, writeFile } from 'node:fs/promises'
import { homedir, tmpdir } from 'node:os'
import { join } from 'node:path'
import { Pool } from 'pg'
import { initializeDatabase, transaction } from '../lib/platform/database.js'
import * as schemaVersions from '../lib/platform/schema.js'
import { FileService } from '../lib/platform/files.js'
import { ArtifactService } from '../lib/platform/artifacts.js'
import { ExecutionFileFactsService } from '../lib/platform/execution-file-facts.js'
import { identity } from '../lib/contracts.js'

const sha256 = bytes => createHash('sha256').update(bytes).digest('hex')
const fact = (path, bytes) => ({ path, sizeBytes: bytes.length, sha256: sha256(bytes) })
const observation = (files, status = 'complete', reasons = []) => ({ status, files, reasons })
const request = (sessionId, executionIds) => ({ sessionId, executionIds })

async function isolated(run, initialVersion = 26) {
  const privateDir = process.env.PE_PRIVATE_DIR ?? join(homedir(), '.config/power-evolve/shared-host-s3-account-v25-qa')
  const databaseUrl = (await readFile(join(privateDir, 'database-url'), 'utf8')).trim()
  const name = `pe_s2_facts_e2_${randomBytes(10).toString('hex')}`
  const root = await mkdtemp(join(tmpdir(), 'pe-s2-facts-'))
  const admin = new Pool({ connectionString: databaseUrl, max: 2, idleTimeoutMillis: 0 })
  let pool
  try {
    await admin.query(`CREATE DATABASE "${name}"`)
    const url = new URL(databaseUrl)
    url.pathname = `/${name}`
    pool = new Pool({ connectionString: url.href, max: 8, idleTimeoutMillis: 0 })
    if (initialVersion === 25) {
      await transaction(pool, async client => {
        await client.query(schemaVersions.schema)
        await client.query('INSERT INTO pe_schema(version) VALUES(1)')
        for (let version = 2; version <= 25; version += 1) {
          const migration = schemaVersions[`schemaV${version}`]
          assert.equal(typeof migration, 'string')
          await client.query(migration)
        }
      })
    } else await initializeDatabase(pool)
    assert.equal((await pool.query('SELECT version FROM pe_schema')).rows[0].version, initialVersion)
    const files = new FileService(pool, join(root, 'workspaces'))
    await files.init()
    await run(pool, root, files)
  } finally {
    await pool?.end()
    try { await admin.query(`DROP DATABASE IF EXISTS "${name}"`) }
    finally { await admin.end(); await rm(root, { recursive: true, force: true }) }
  }
}

async function owner(pool, files) {
  const userId = randomUUID()
  const user = identity.parse({ userId, username: `u-${userId}` })
  await pool.query('INSERT INTO pe_users(id,username,password_hash,settings) VALUES($1,$2,$3,$4)',
    [userId, user.username, 'fixture-only', { model: 'fixture', maxTokens: 100, revision: 1 }])
  const workspace = await files.workspaceForUser(userId)
  return { user, workspace }
}

async function session(pool, files, user, separate = false) {
  let workspace
  if (separate) {
    const workspaceId = randomUUID()
    await pool.query('INSERT INTO pe_workspaces(id,user_id,title,is_default) VALUES($1,$2,$3,false)',
      [workspaceId, user.userId, 'Separate fixture'])
    workspace = await files.workspaceForId(user.userId, workspaceId)
  } else workspace = await files.workspaceForUser(user.userId)
  const id = randomUUID()
  await pool.query('INSERT INTO pe_sessions(id,user_id,create_request_id,header,workspace_id) VALUES($1,$2,$3,$4,$5)',
    [id, user.userId, randomUUID(), {}, workspace.id])
  return { id, workspace }
}

async function execution(pool, user, sessionId, state, result) {
  const operationId = randomUUID(), id = randomUUID(), callId = `call-${randomUUID()}`
  await pool.query('INSERT INTO pe_operations(id,session_id,request_id,input,settings,state) VALUES($1,$2,$3,$4,$5,$6)',
    [operationId, sessionId, randomUUID(), 'fixture command', { model: 'fixture', maxTokens: 100, revision: 1 }, 'completed'])
  await pool.query(`INSERT INTO pe_cloud_executions(id,user_id,session_id,operation_id,call_id,command,cwd,request_digest,state,result)
    VALUES($1,$2,$3,$4,$5,$6,$7,$8,$9,$10)`,
    [id, user.userId, sessionId, operationId, callId, 'true', '', sha256('fixture'), state, result])
  return { id, callId }
}

async function put(files, user, workspace, path, bytes) {
  return files.put(user, randomUUID(), path, null, bytes.toString('base64'), workspace.id)
}

async function counts(pool) {
  return (await pool.query(`SELECT
    (SELECT count(*) FROM pe_artifacts)::int AS artifacts,
    (SELECT count(*) FROM pe_cloud_executions)::int AS executions,
    (SELECT count(*) FROM pe_file_mutations)::int AS mutations`)).rows[0]
}

test('S2 B file facts and conditional artifacts use real isolated PG and private POSIX files', { timeout: 90000 }, async t => {
  await isolated(async (pool, root, files) => {
    await t.test('verification resolves the selected owned Workspace, preserving bounded Unicode/binary/empty bytes', async () => {
      const alice = await owner(pool, files), bob = await owner(pool, files)
      const a = await session(pool, files, alice.user), other = await session(pool, files, alice.user, true)
      const b = await session(pool, files, bob.user)
      const originals = { '目录/result.bin': randomBytes(200000), 'empty.txt': Buffer.alloc(0) }
      for (const [path, bytes] of Object.entries(originals)) await put(files, alice.user, a.workspace, path, bytes)
      await put(files, alice.user, other.workspace, '目录/result.bin', Buffer.from('other owned Workspace'))
      await put(files, bob.user, b.workspace, '目录/result.bin', Buffer.from('other user'))
      const service = new ExecutionFileFactsService(pool, files)
      const input = observation(Object.entries(originals).map(([path, bytes]) => fact(path, bytes)))
      const before = await counts(pool)
      assert.deepEqual(await service.verify(alice.user.userId, a.id, input), input)
      assert.deepEqual(await service.verify(alice.user.userId, a.id, input), input)
      const different = await service.verify(alice.user.userId, other.id, observation([input.files[0]]))
      assert.equal(different.status, 'partial')
      assert.deepEqual(different.files, [])
      assert(different.reasons.includes('verification_failed'))
      const otherFiles = observation([fact('目录/result.bin', Buffer.from('other owned Workspace'))])
      assert.deepEqual(await service.verify(alice.user.userId, other.id, otherFiles), otherFiles)
      const bobFiles = observation([fact('目录/result.bin', Buffer.from('other user'))])
      assert.deepEqual(await service.verify(bob.user.userId, b.id, bobFiles), bobFiles)
      await assert.rejects(service.verify(bob.user.userId, a.id, input), { status: 404 })
      assert.deepEqual(await counts(pool), before)
    })

    await t.test('unsafe links, missing files, oversized bytes, size and SHA mismatches are discarded', async () => {
      const { user } = await owner(pool, files), s = await session(pool, files, user)
      const safe = Buffer.from('verified inside')
      await put(files, user, s.workspace, 'good.txt', safe)
      const outside = join(root, `outside-${randomUUID()}`)
      await writeFile(outside, 'outside file')
      await symlink(outside, join(s.workspace.path, 'link.txt'))
      await symlink(root, join(s.workspace.path, 'linked-directory'))
      await writeFile(join(s.workspace.path, 'large.bin'), Buffer.alloc(2 * 1024 * 1024 + 1))
      const service = new ExecutionFileFactsService(pool, files)
      const input = observation([
        fact('good.txt', safe), fact('link.txt', Buffer.from('outside file')),
        fact('linked-directory/absent', Buffer.alloc(0)), fact('missing.txt', Buffer.alloc(0)),
        { ...fact('good.txt', safe), path: 'large.bin' },
      ])
      const result = await service.verify(user.userId, s.id, input)
      assert.equal(result.status, 'partial')
      assert.deepEqual(result.files, [input.files[0]])
      assert.deepEqual(result.reasons, ['verification_failed'])
      for (const mismatch of [{ ...fact('good.txt', safe), sizeBytes: safe.length + 1 },
        { ...fact('good.txt', safe), sha256: sha256('different') }]) {
        const rejected = await service.verify(user.userId, s.id, observation([mismatch]))
        assert.equal(rejected.status, 'partial')
        assert.deepEqual(rejected.files, [])
      }
      assert.equal(await readFile(outside, 'utf8'), 'outside file')
    })

    await t.test('partial, unavailable and legacy observations retain explicit completeness', async () => {
      const { user } = await owner(pool, files), s = await session(pool, files, user)
      const source = Buffer.from('actual')
      await put(files, user, s.workspace, 'actual.txt', source)
      const service = new ExecutionFileFactsService(pool, files)
      const partial = observation([fact('actual.txt', source)], 'partial', ['budget_exceeded', 'excluded_paths'])
      assert.deepEqual(await service.verify(user.userId, s.id, partial), partial)
      const unavailable = observation([], 'unavailable', ['scan_unavailable'])
      assert.deepEqual(await service.verify(user.userId, s.id, unavailable), unavailable)
      assert.deepEqual(await service.verify(user.userId, s.id, undefined),
        observation([], 'unavailable', ['legacy_runner']))
    })

    await t.test('stored facts preserve request order, original callIds and prior versions without rescanning', async () => {
      const { user } = await owner(pool, files), s = await session(pool, files, user)
      const source = Buffer.from('before edit')
      await put(files, user, s.workspace, 'result.txt', source)
      const service = new ExecutionFileFactsService(pool, files)
      const verified = await service.verify(user.userId, s.id, observation([fact('result.txt', source)]))
      const first = await execution(pool, user, s.id, 'succeeded', { stdout: 'claim other.txt', verifiedFiles: verified })
      const second = await execution(pool, user, s.id, 'failed', { verifiedFiles: observation([], 'partial', ['read_failed']) })
      await writeFile(join(s.workspace.path, 'result.txt'), 'after edit')
      const readOnly = new ExecutionFileFactsService(pool, {
        async readBytesInWorkspace() { throw new Error('Stored facts must not read current file bytes') },
      })
      const before = await counts(pool)
      const view = await readOnly.read(user, request(s.id, [second.id, first.id]))
      assert.equal(view.sessionId, s.id)
      assert.equal(view.workspaceId, s.workspace.id)
      assert.deepEqual(view.items.map(item => item.executionId), [second.id, first.id])
      assert.deepEqual(view.items.map(item => item.callId), [second.callId, first.callId])
      assert.deepEqual(view.items[1].files, verified.files)
      assert.equal(view.items[0].state, 'failed')
      assert.equal(view.items[0].status, 'partial')
      assert.deepEqual(await counts(pool), before)
    })

    await t.test('queries are all-or-404 across users/Sessions; pending and old results invent no file facts', async () => {
      const alice = await owner(pool, files), bob = await owner(pool, files)
      const a = await session(pool, files, alice.user), other = await session(pool, files, alice.user, true)
      const b = await session(pool, files, bob.user)
      const old = await execution(pool, alice.user, a.id, 'succeeded', { stdout: 'created result.txt' })
      const pending = await execution(pool, alice.user, a.id, 'queued', null)
      const elsewhere = await execution(pool, alice.user, other.id, 'succeeded', null)
      const foreign = await execution(pool, bob.user, b.id, 'succeeded', null)
      const service = new ExecutionFileFactsService(pool, files)
      const view = await service.read(alice.user, request(a.id, [old.id, pending.id]))
      assert.equal(view.items[0].status, 'unavailable')
      assert.deepEqual(view.items[0].files, [])
      assert.deepEqual(view.items[0].reasons, ['legacy_runner'])
      assert.equal(view.items[1].status, 'pending')
      assert.deepEqual(view.items[1].files, [])
      const uncertain = await execution(pool, alice.user, other.id, 'uncertain', {
        verifiedFiles: observation([fact('claimed.txt', Buffer.from('unconfirmed'))]),
      })
      const unknown = (await service.read(alice.user, request(other.id, [uncertain.id]))).items[0]
      assert.equal(unknown.status, 'unavailable')
      assert.deepEqual(unknown.files, [])
      assert.deepEqual(unknown.reasons, ['execution_unavailable'])
      for (const ids of [[old.id, foreign.id], [old.id, elsewhere.id], [old.id, randomUUID()]]) {
        await assert.rejects(service.read(alice.user, request(a.id, ids)), { status: 404 })
      }
      await assert.rejects(service.read(bob.user, request(a.id, [old.id])), { status: 404 })
      await assert.rejects(service.read(alice.user, request(a.id, [old.id, old.id])), { status: 400 })
      await assert.rejects(service.read(alice.user, request(a.id, Array.from({ length: 21 }, randomUUID))), { status: 400 })
      await pool.query('UPDATE pe_cloud_executions SET result=$2 WHERE id=$1', [old.id, { verifiedFiles: { status: 'complete', files: [{ path: '../outside' }], reasons: [] } }])
      await assert.rejects(service.read(alice.user, request(a.id, [old.id])), { status: 503 })
    })

    await t.test('cancellation and current account/Session ownership remain fatal rather than partial file outcomes', async () => {
      const { user } = await owner(pool, files), s = await session(pool, files, user)
      const source = Buffer.from('original')
      await put(files, user, s.workspace, 'result.txt', source)
      const entered = Promise.withResolvers(), release = Promise.withResolvers()
      const controlled = { async readBytesInWorkspace(...args) {
        const bytes = await files.readBytesInWorkspace(...args)
        entered.resolve(); await release.promise
        return bytes
      } }
      const service = new ExecutionFileFactsService(pool, controlled)
      const input = observation([fact('result.txt', source)])
      const controller = new AbortController()
      controller.abort()
      await assert.rejects(service.verify(user.userId, s.id, input, controller.signal), { name: 'AbortError' })
      const verifying = service.verify(user.userId, s.id, input)
      const rejected = assert.rejects(verifying, { status: 401 })
      await entered.promise
      await pool.query('UPDATE pe_users SET enabled=false WHERE id=$1', [user.userId])
      release.resolve()
      await rejected
      await assert.rejects(service.read(user, request(s.id, [randomUUID()])), { status: 401 })
    })

    await t.test('conditional publication is idempotent over Session/path/revision and retains immutable original bytes', async () => {
      const { user } = await owner(pool, files), s = await session(pool, files, user)
      const source = Buffer.from('first artifact bytes')
      const revision = await put(files, user, s.workspace, 'result.txt', source)
      const artifacts = new ArtifactService(pool, files, join(root, `artifacts-${randomUUID()}`))
      await artifacts.init()
      const id = randomUUID()
      const published = await artifacts.publish(user, id, s.id, 'result.txt', revision.revision)
      assert.deepEqual(await artifacts.publish(user, id, s.id, 'result.txt', revision.revision), published)
      for (const expected of [undefined, sha256('different')]) {
        await assert.rejects(artifacts.publish(user, id, s.id, 'result.txt', expected), { status: 409, code: 'request_id_conflict' })
      }
      await assert.rejects(artifacts.publish(user, id, s.id, 'other.txt', revision.revision), { status: 409, code: 'request_id_conflict' })
      const other = await session(pool, files, user, true)
      await assert.rejects(artifacts.publish(user, id, other.id, 'result.txt', revision.revision), { status: 409, code: 'request_id_conflict' })
      assert.equal((await pool.query('SELECT expected_revision FROM pe_artifacts WHERE id=$1', [id])).rows[0].expected_revision, revision.revision)
      await writeFile(join(s.workspace.path, 'result.txt'), 'edited source')
      assert.deepEqual(await artifacts.publish(user, id, s.id, 'result.txt', revision.revision), published)
      assert.deepEqual((await artifacts.bytes(user, id)).bytes, source)
      assert.equal((await artifacts.preview(user, id)).text, source.toString())
      assert.equal((await artifacts.list(user, { sessionId: s.id, limit: 10 })).items[0].artifactId, id)
    })

    await t.test('a changed expected revision fails before creating any artifact; legacy null retries stay compatible', async () => {
      const { user } = await owner(pool, files), s = await session(pool, files, user)
      const source = Buffer.from('current bytes')
      await put(files, user, s.workspace, 'result.txt', source)
      const artifactRoot = join(root, `artifacts-${randomUUID()}`)
      const artifacts = new ArtifactService(pool, files, artifactRoot)
      await artifacts.init()
      const rejectedId = randomUUID(), before = await counts(pool)
      await assert.rejects(artifacts.publish(user, rejectedId, s.id, 'result.txt', sha256('old bytes')),
        { status: 409, code: 'artifact_source_changed' })
      assert.deepEqual(await counts(pool), before)
      assert.deepEqual(await readdir(artifactRoot), [])
      const id = randomUUID()
      const legacy = await artifacts.publish(user, id, s.id, 'result.txt')
      assert.equal((await pool.query('SELECT expected_revision FROM pe_artifacts WHERE id=$1', [id])).rows[0].expected_revision, null)
      assert.deepEqual(await artifacts.publish(user, id, s.id, 'result.txt'), legacy)
      await assert.rejects(artifacts.publish(user, id, s.id, 'result.txt', sha256(source)), { status: 409, code: 'request_id_conflict' })
      const bob = await owner(pool, files)
      await assert.rejects(artifacts.bytes(bob.user, id), { status: 404 })
    })
  })
})

// Apply the real released migrations through V25, then exercise the ordinary V26 initializer.
test('V25 to V26 preserves an existing artifact, null expected revision and successful legacy retry', { timeout: 30000 }, async () => {
  await isolated(async (pool, root, files) => {
    const { user } = await owner(pool, files), s = await session(pool, files, user)
    const original = Buffer.from('published before migration')
    await put(files, user, s.workspace, 'result.txt', original)
    const artifactRoot = join(root, 'legacy-artifacts'), id = randomUUID()
    const directory = join(artifactRoot, user.userId)
    await mkdir(directory, { recursive: true, mode: 0o700 })
    await writeFile(join(directory, `${id}.bin`), original, { mode: 0o400 })
    await pool.query(`INSERT INTO pe_artifacts(id,user_id,workspace_id,session_id,request_id,source_path,filename,mime,size_bytes,sha256)
      VALUES($1,$2,$3,$4,$1,'result.txt','result.txt','text/plain',$5,$6)`,
    [id, user.userId, s.workspace.id, s.id, original.length, sha256(original)])
    assert.equal((await pool.query(`SELECT count(*)::int AS count FROM information_schema.columns
      WHERE table_schema='public' AND table_name='pe_artifacts' AND column_name='expected_revision'`)).rows[0].count, 0)
    const before = await counts(pool)
    await initializeDatabase(pool)
    assert.equal((await pool.query('SELECT version FROM pe_schema')).rows[0].version, 26)
    assert.deepEqual(await counts(pool), before)
    assert.equal((await pool.query('SELECT expected_revision FROM pe_artifacts WHERE id=$1', [id])).rows[0].expected_revision, null)
    await writeFile(join(s.workspace.path, 'result.txt'), 'later workspace edit')
    const artifacts = new ArtifactService(pool, files, artifactRoot)
    await artifacts.init()
    const listed = (await artifacts.list(user, { sessionId: s.id, limit: 10 })).items[0]
    assert.equal(listed.artifactId, id)
    assert.deepEqual(await artifacts.publish(user, id, s.id, 'result.txt'), listed)
    assert.deepEqual((await artifacts.bytes(user, id)).bytes, original)
    await assert.rejects(artifacts.publish(user, id, s.id, 'result.txt', sha256(original)),
      { status: 409, code: 'request_id_conflict' })
  }, 25)
})
