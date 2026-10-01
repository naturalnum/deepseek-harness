/** Real PG/POSIX downloads and deterministic transfer-lifetime regressions. */
import test from 'node:test'
import assert from 'node:assert/strict'
import { randomBytes, randomUUID } from 'node:crypto'
import { mkdtemp, readFile, rm, symlink, writeFile } from 'node:fs/promises'
import { homedir, tmpdir } from 'node:os'
import { join } from 'node:path'
import { Pool } from 'pg'
import { unzipSync } from 'fflate'
import { initializeDatabase } from '../lib/platform/database.js'
import { FileService } from '../lib/platform/files.js'
import { FileDownloadService } from '../lib/platform/file-downloads.js'
import { identity, PlatformError } from '../lib/contracts.js'
import { fileDownloadPrepareRequest, fileDownloadContentRequest } from '../../contracts/lib/file-download.js'

const limits = { maxFiles: 32, maxTotalBytes: 32 * 1024 * 1024, maxConcurrentTransfers: 4,
  maxUserConcurrentTransfers: 2, transferTimeoutMs: 60000 }
const signal = () => new AbortController().signal
const deferred = () => Promise.withResolvers()
const request = (sessionId, paths) => fileDownloadPrepareRequest.parse({ sessionId, paths })
const content = (input, view) => fileDownloadContentRequest.parse({ ...input, revision: view.revision })

async function isolated(run) {
  const privateDir = process.env.PE_PRIVATE_DIR ?? join(homedir(), '.config/power-evolve/shared-host-s3-account-v25-qa')
  const databaseUrl = (await readFile(join(privateDir, 'database-url'), 'utf8')).trim()
  const name = `pe_s2_download_e2_${randomBytes(10).toString('hex')}`
  const root = await mkdtemp(join(tmpdir(), 'pe-s2-download-'))
  const admin = new Pool({ connectionString: databaseUrl, max: 2, idleTimeoutMillis: 0 })
  let pool
  try {
    await admin.query(`CREATE DATABASE "${name}"`)
    const url = new URL(databaseUrl)
    url.pathname = `/${name}`
    pool = new Pool({ connectionString: url.href, max: 8, idleTimeoutMillis: 0 })
    await initializeDatabase(pool)
    await run(pool, root)
  } finally {
    await pool?.end()
    try { await admin.query(`DROP DATABASE IF EXISTS "${name}"`) }
    finally { await admin.end(); await rm(root, { recursive: true, force: true }) }
  }
}

async function fixture(pool, root, entries = { 'one.bin': Buffer.from([0, 1, 255, 128]) }) {
  const userId = randomUUID()
  const user = identity.parse({ userId, username: `u-${userId}` })
  await pool.query('INSERT INTO pe_users(id,username,password_hash,settings) VALUES($1,$2,$3,$4)',
    [userId, user.username, 'fixture-only', { model: 'fixture', maxTokens: 100, revision: 1 }])
  const files = new FileService(pool, join(root, 'workspaces'))
  await files.init()
  const workspace = await files.workspaceForUser(userId)
  const session = randomUUID()
  await pool.query('INSERT INTO pe_sessions(id,user_id,create_request_id,header,workspace_id) VALUES($1,$2,$3,$4,$5)',
    [session, userId, randomUUID(), {}, workspace.id])
  for (const [path, bytes] of Object.entries(entries)) {
    await files.put(user, randomUUID(), path, null, bytes.toString('base64'), workspace.id)
  }
  return { user, files, workspace, session }
}

async function bytes(body) {
  const chunks = []
  for await (const chunk of body) chunks.push(Buffer.from(chunk))
  return Buffer.concat(chunks)
}

function controlled(files) {
  let calls = 0
  let blockAt = -1
  let pending
  const entered = deferred(), release = deferred()
  return {
    entered, release,
    get pending() { return pending },
    get calls() { return calls },
    blockNext() { blockAt = calls + 1 },
    readBytesInWorkspace(...args) {
      const count = ++calls
      pending = (async () => {
        const value = await files.readBytesInWorkspace(...args)
        if (count === blockAt) { entered.resolve(); await release.promise }
        return value
      })()
      return pending
    },
  }
}

async function readOnlyCounts(pool) {
  return (await pool.query(`SELECT
    (SELECT count(*) FROM pe_workspaces)::int AS workspaces,
    (SELECT count(*) FROM pe_file_mutations)::int AS mutations,
    (SELECT count(*) FROM pe_operations)::int AS operations,
    (SELECT count(*) FROM pe_credentials)::int AS credentials`)).rows[0]
}

test('S2 downloads use real isolated PostgreSQL and descriptor-relative workspace files', { timeout: 90000 }, async t => {
  await isolated(async (pool, root) => {
    await t.test('single-file bytes, ordered Unicode ZIP entries, framing and repeated preparation are read-only', async () => {
      const originals = { 'one.bin': randomBytes(180000), '目录/空.txt': Buffer.alloc(0), '目录/文字.txt': Buffer.from('世界\r\n') }
      const f = await fixture(pool, root, originals)
      const service = new FileDownloadService(pool, f.files, limits)
      const before = await readOnlyCounts(pool)
      const single = request(f.session, ['one.bin'])
      const view = await service.prepare(f.user, single, signal())
      assert.equal(view.fileName, 'one.bin')
      assert.equal(view.contentType, 'application/octet-stream')
      assert.equal(view.totalBytes, originals['one.bin'].length)
      assert.deepEqual(await service.prepare(f.user, single, signal()), view)
      const opened = await service.open(f.user, content(single, view), signal())
      assert.deepEqual(await bytes(opened.body), originals['one.bin'])
      const selection = request(f.session, ['目录/文字.txt', 'one.bin', '目录/空.txt'])
      const zipView = await service.prepare(f.user, selection, signal())
      const zip = await bytes((await service.open(f.user, content(selection, zipView), signal())).body)
      assert.equal(zip.length, zipView.totalBytes)
      assert.equal(zipView.sourceBytes, Object.values(originals).reduce((sum, value) => sum + value.length, 0))
      const expanded = unzipSync(zip)
      assert.deepEqual(Object.keys(expanded), selection.paths)
      for (const path of selection.paths) assert.deepEqual(Buffer.from(expanded[path]), originals[path])
      const sourceLimit = new FileDownloadService(pool, f.files, { ...limits, maxTotalBytes: zipView.sourceBytes })
      const boundedZip = await bytes((await sourceLimit.open(f.user, content(selection, zipView), signal())).body)
      assert.equal(boundedZip.length, zipView.totalBytes)
      assert(boundedZip.length > zipView.sourceBytes)
      const reverse = await service.prepare(f.user, request(f.session, [...selection.paths].reverse()), signal())
      assert.notEqual(reverse.revision, zipView.revision)
      assert.deepEqual(await readOnlyCounts(pool), before)
    })

    await t.test('a new binding generation invalidates prepared downloads even when bytes match', async () => {
      const f = await fixture(pool, root)
      const service = new FileDownloadService(pool, f.files, limits)
      const input = request(f.session, ['one.bin'])
      const prepared = await service.prepare(f.user, input, signal())
      await pool.query('UPDATE pe_workspaces SET binding_generation=binding_generation+1 WHERE id=$1', [f.workspace.id])
      await assert.rejects(service.open(f.user, content(input, prepared), signal()), { status: 409, code: 'download_changed' })
      const current = await service.prepare(f.user, input, signal())
      assert.notEqual(current.revision, prepared.revision)
      assert.equal(current.sourceBytes, prepared.sourceBytes)
    })

    await t.test('one preparation cannot combine reads from different binding generations', async () => {
      const f = await fixture(pool, root, { 'a.txt': Buffer.from('a'), 'b.txt': Buffer.from('b') })
      const wrapped = controlled(f.files)
      const service = new FileDownloadService(pool, wrapped, limits)
      wrapped.blockNext()
      const pending = service.prepare(f.user, request(f.session, ['a.txt', 'b.txt']), signal())
      const rejected = assert.rejects(pending, { status: 409, code: 'download_changed' })
      await wrapped.entered.promise
      await pool.query('UPDATE pe_workspaces SET binding_generation=binding_generation+1 WHERE id=$1', [f.workspace.id])
      wrapped.release.resolve()
      await rejected
      assert.equal(wrapped.calls, 1)
    })

    await t.test('foreign Session, missing, unsafe and oversized selections are denied', async () => {
      const f = await fixture(pool, root)
      const bob = await fixture(pool, root)
      const service = new FileDownloadService(pool, f.files, limits)
      await assert.rejects(service.prepare(bob.user, request(f.session, ['one.bin']), signal()), { status: 404, code: 'session_not_found' })
      await assert.rejects(service.prepare(f.user, request(f.session, ['missing']), signal()), { status: 404, code: 'file_not_found' })
      for (const paths of [['../secret'], ['/one.bin'], ['a\\b'], ['one.bin', 'one.bin'], ['e\u0301.txt'], ['C:x'], ['a\0b']]) {
        await assert.rejects(service.prepare(f.user, { sessionId: f.session, paths }, signal()), { status: 400 })
      }
      await assert.rejects(service.prepare(f.user, { sessionId: f.session, paths: Array.from({ length: 33 }, (_, i) => `${i}`) }, signal()), { status: 413 })
      const long = Array.from({ length: 32 }, (_, i) => `${i}-${'世'.repeat(90)}`)
      await assert.rejects(service.prepare(f.user, request(f.session, long), signal()), { status: 413 })
      const small = new FileDownloadService(pool, f.files, { ...limits, maxTotalBytes: 3 })
      await assert.rejects(small.prepare(f.user, request(f.session, ['one.bin']), signal()), { status: 413 })
      const outside = join(root, `outside-${randomUUID()}`)
      await writeFile(outside, 'private outside')
      await symlink(outside, join(f.workspace.path, 'link'))
      await assert.rejects(service.prepare(f.user, request(f.session, ['link']), signal()), { status: 400, code: 'invalid_path' })
      await writeFile(join(f.workspace.path, 'large.bin'), Buffer.alloc(2 * 1024 * 1024 + 1))
      await assert.rejects(service.prepare(f.user, request(f.session, ['large.bin']), signal()), { status: 413 })
    })

    await t.test('same-size changed content fails before opening and can be prepared again', async () => {
      const f = await fixture(pool, root)
      const service = new FileDownloadService(pool, f.files, limits)
      const input = request(f.session, ['one.bin'])
      const view = await service.prepare(f.user, input, signal())
      await writeFile(join(f.workspace.path, 'one.bin'), Buffer.from([9, 8, 7, 6]))
      await assert.rejects(service.open(f.user, content(input, view), signal()), { status: 409, code: 'download_changed' })
      const next = await service.prepare(f.user, input, signal())
      assert.notEqual(next.revision, view.revision)
      assert.deepEqual(await bytes((await service.open(f.user, content(input, next), signal())).body), Buffer.from([9, 8, 7, 6]))
      const limited = new FileDownloadService(pool, f.files, { ...limits, maxTotalBytes: 4 })
      await writeFile(join(f.workspace.path, 'one.bin'), 'expanded')
      await assert.rejects(limited.open(f.user, content(input, next), signal()), { status: 409, code: 'download_changed' })
      await assert.rejects(limited.prepare(f.user, input, signal()), { status: 413 })
      await rm(join(f.workspace.path, 'one.bin'))
      await assert.rejects(service.open(f.user, content(input, next), signal()), { status: 409, code: 'download_changed' })
    })

    await t.test('a later entry changed after headers errors the stream before a complete ZIP', async () => {
      const f = await fixture(pool, root, { 'a.bin': randomBytes(200000), 'b.bin': Buffer.from('old') })
      const service = new FileDownloadService(pool, f.files, limits)
      const input = request(f.session, ['a.bin', 'b.bin'])
      const view = await service.prepare(f.user, input, signal())
      const opened = await service.open(f.user, content(input, view), signal())
      const reader = opened.body.getReader()
      const partial = [Buffer.from((await reader.read()).value)]
      await writeFile(join(f.workspace.path, 'b.bin'), 'new')
      await assert.rejects((async () => {
        while (true) {
          const part = await reader.read()
          if (part.done) return
          partial.push(Buffer.from(part.value))
        }
      })(), { status: 409, code: 'download_changed' })
      assert.throws(() => unzipSync(Buffer.concat(partial)))
      assert((await service.prepare(f.user, input, signal())).revision !== view.revision)
    })

    await t.test('account disable and Session removal during a read are checked again before metadata returns', async () => {
      for (const change of ['disable', 'remove']) {
        const f = await fixture(pool, root)
        const wrapped = controlled(f.files)
        wrapped.blockNext()
        const service = new FileDownloadService(pool, wrapped, limits)
        const preparation = service.prepare(f.user, request(f.session, ['one.bin']), signal())
        const rejection = assert.rejects(preparation, { status: change === 'disable' ? 401 : 404 })
        await wrapped.entered.promise
        if (change === 'disable') await pool.query('UPDATE pe_users SET enabled=false WHERE id=$1', [f.user.userId])
        else await pool.query('DELETE FROM pe_sessions WHERE id=$1', [f.session])
        wrapped.release.resolve()
        await rejection
      }
    })

    await t.test('request-local credential revalidation resumes after backpressure and rejects revoked credentials', async () => {
      const f = await fixture(pool, root, { 'one.bin': randomBytes(300000) })
      const service = new FileDownloadService(pool, f.files, limits)
      const input = request(f.session, ['one.bin'])
      let valid = true, checks = 0
      const authorize = async () => { checks += 1; if (!valid) throw new PlatformError(401, 'unauthorized') }
      const view = await service.prepare(f.user, input, signal(), authorize)
      const opened = await service.open(f.user, content(input, view), signal(), authorize)
      const reader = opened.body.getReader()
      assert.equal((await reader.read()).done, false)
      valid = false
      await assert.rejects((async () => { while (!(await reader.read()).done) {} })(), { status: 401 })
      assert(checks >= 5)
    })

    await t.test('canceled preparation retains its user and replica permit until the underlying read settles', async () => {
      const f = await fixture(pool, root), bob = await fixture(pool, root)
      const wrapped = controlled(f.files)
      const service = new FileDownloadService(pool, wrapped, { ...limits, maxConcurrentTransfers: 1, maxUserConcurrentTransfers: 1 })
      wrapped.blockNext()
      const controller = new AbortController()
      const pending = service.prepare(f.user, request(f.session, ['one.bin']), controller.signal)
      const rejection = assert.rejects(pending, { name: 'AbortError' })
      await wrapped.entered.promise
      controller.abort()
      await rejection
      await assert.rejects(service.prepare(f.user, request(f.session, ['one.bin']), signal()), { status: 429 })
      await assert.rejects(service.prepare(bob.user, request(bob.session, ['one.bin']), signal()), { status: 429 })
      wrapped.release.resolve()
      await wrapped.pending
      await service.prepare(f.user, request(f.session, ['one.bin']), signal())
    })

    await t.test('per-user capacity leaves another user a replica permit', async () => {
      const f = await fixture(pool, root), bob = await fixture(pool, root)
      const wrapped = controlled(f.files)
      const service = new FileDownloadService(pool, wrapped, { ...limits, maxConcurrentTransfers: 2, maxUserConcurrentTransfers: 1 })
      wrapped.blockNext()
      const pending = service.prepare(f.user, request(f.session, ['one.bin']), signal())
      await wrapped.entered.promise
      await assert.rejects(service.prepare(f.user, request(f.session, ['one.bin']), signal()), { status: 429 })
      await service.prepare(bob.user, request(bob.session, ['one.bin']), signal())
      wrapped.release.resolve()
      await pending
    })

    await t.test('consumer cancellation waits for an in-flight underlying file read', async () => {
      const f = await fixture(pool, root)
      const wrapped = controlled(f.files)
      const service = new FileDownloadService(pool, wrapped, { ...limits, maxConcurrentTransfers: 1, maxUserConcurrentTransfers: 1 })
      const input = request(f.session, ['one.bin'])
      const view = await service.prepare(f.user, input, signal())
      const opened = await service.open(f.user, content(input, view), signal())
      wrapped.blockNext()
      const reader = opened.body.getReader()
      await wrapped.entered.promise
      let canceled = false
      const cancel = reader.cancel().then(() => { canceled = true })
      await assert.rejects(service.prepare(f.user, input, signal()), { status: 429 })
      assert.equal(canceled, false)
      wrapped.release.resolve()
      await cancel
      await service.prepare(f.user, input, signal())
    })

    await t.test('timeout returns 504 while holding admission through late read completion', async clockTest => {
      const f = await fixture(pool, root)
      const wrapped = controlled(f.files)
      wrapped.blockNext()
      clockTest.mock.timers.enable({ apis: ['setTimeout'] })
      const service = new FileDownloadService(pool, wrapped, { ...limits, transferTimeoutMs: 100, maxConcurrentTransfers: 1, maxUserConcurrentTransfers: 1 })
      const input = request(f.session, ['one.bin'])
      const pending = service.prepare(f.user, input, signal())
      const rejection = assert.rejects(pending, { status: 504, code: 'download_timeout' })
      await wrapped.entered.promise
      clockTest.mock.timers.tick(100)
      await rejection
      await assert.rejects(service.prepare(f.user, input, signal()), { status: 429 })
      wrapped.release.resolve()
      await wrapped.pending
      await service.prepare(f.user, input, signal())
      clockTest.mock.timers.reset()
    })

    await t.test('ZIP backpressure keeps the second file unread until the first is consumed', async () => {
      const f = await fixture(pool, root, { 'a.bin': randomBytes(300000), 'b.bin': Buffer.from('b') })
      const wrapped = controlled(f.files)
      const service = new FileDownloadService(pool, wrapped, limits)
      const input = request(f.session, ['a.bin', 'b.bin'])
      const view = await service.prepare(f.user, input, signal())
      const opened = await service.open(f.user, content(input, view), signal())
      const reader = opened.body.getReader()
      await reader.read()
      assert.equal(wrapped.calls, 5) // Two prepare reads, two GET checks, then the first output file.
      await reader.cancel()
      assert.equal(wrapped.calls, 5)
      await service.prepare(f.user, input, signal())
    })
  })
})
