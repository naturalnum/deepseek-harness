/** Named built DSH Profiles with owned PG, original-image history and a model SSE fixture. */
import { strict as assert } from 'node:assert'
import { spawn } from 'node:child_process'
import { randomBytes, randomUUID } from 'node:crypto'
import { once } from 'node:events'
import { mkdir, mkdtemp, readFile, rm, writeFile } from 'node:fs/promises'
import { createServer } from 'node:http'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import test from 'node:test'
import { setTimeout as delay } from 'node:timers/promises'
import { fileURLToPath } from 'node:url'
import { Context } from '@deepseek-ai/cordis'
import AttachmentLocal from '@deepseek-ai/dsh-attachment-local'
import { MessageId } from '@deepseek-ai/dsh-llm'
import { Session } from '@deepseek-ai/dsh-session'
import { Pool } from 'pg'
import { requestId } from '../lib/contracts.js'
import { seedNewUser } from '../lib/platform/account-settings.js'
import { initializeDatabase } from '../lib/platform/database.js'
import { EventStore } from '../lib/platform/events.js'
import { hashPassword, IdentityService } from '../lib/platform/identity.js'
import { TaskStore } from '../lib/platform/tasks.js'
import { renderProfile } from '../../deploy/start.mjs'

/** Admin-created owned PG case; ordinary-role and full migration acceptance require separate cases. */
async function cloudFixture(run) {
  const urlFile = process.env.PE_TEST_DATABASE_URL_FILE
  if (!urlFile) throw new Error('Built image Profile test requires PE_TEST_DATABASE_URL_FILE')
  const address = new URL((await readFile(urlFile, 'utf8')).trim())
  const name = 'pe_image_profile_' + randomUUID().replaceAll('-', '')
  const target = new URL(address)
  target.pathname = '/' + name
  const admin = new Pool({ connectionString: address.href, max: 1 })
  const pool = new Pool({ connectionString: target.href, max: 8 })
  const root = await mkdtemp(join(tmpdir(), 'pe-image-profile-'))
  let created = false
  try {
    await admin.query('CREATE DATABASE "' + name + '"')
    created = true
    await initializeDatabase(pool)
    const password = randomUUID()
    const settings = { model: 'trial-model', maxTokens: 1000, revision: 1 }
    await seedNewUser(pool, 'image-owner', await hashPassword(password), settings)
    const alice = await new IdentityService(pool, 60000).login('image-owner', password)
    return await run({ pool, root, alice, databaseUrl: target.href })
  } finally {
    await pool.end()
    try {
      if (created) await admin.query('DROP DATABASE "' + name + '"')
    } finally {
      await admin.end()
      await rm(root, { recursive: true, force: true })
    }
  }
}

async function unusedPort() {
  const server = createServer()
  server.listen(0, '127.0.0.1')
  await once(server, 'listening')
  const address = server.address()
  if (!address || typeof address === 'string') throw new Error('Missing allocated port')
  await new Promise((done) => { server.close(() => done()) })
  return address.port
}

async function waitUntil(check, label) {
  for (let attempt = 0; attempt < 400; attempt++) {
    if (await check()) return
    await delay(100)
  }
  throw new Error(label + ' deadline')
}

const textEvents = [
  { type: 'message_start', message: { id: 'msg_1', model: 'deepseek-flash', usage: { input_tokens: 3, output_tokens: 0 } } },
  { type: 'content_block_start', index: 0, content_block: { type: 'text', text: '' } },
  { type: 'content_block_delta', index: 0, delta: { type: 'text_delta', text: 'hello' } },
  { type: 'content_block_stop', index: 0 },
  { type: 'message_delta', delta: { stop_reason: 'end_turn' }, usage: { output_tokens: 1 } },
  { type: 'message_stop' },
].map(event => JSON.stringify(event))
const repository = fileURLToPath(new URL('../../../..', import.meta.url))

test('named built Profiles preserve exact model-visible original-image messages', { timeout: 90000 }, async () => {
  const evidence = await mkdtemp(join(tmpdir(), 'pe-image-profile-evidence-'))
  const requests = []
  const mock = createServer((req, res) => {
    const chunks = []
    req.on('data', chunk => chunks.push(chunk))
    req.on('end', () => {
      try {
        requests.push(JSON.parse(Buffer.concat(chunks).toString()))
        res.writeHead(200, { 'content-type': 'text/event-stream' })
        for (const event of textEvents) res.write('data: ' + event + '\n\n')
        res.end()
      } catch {
        res.writeHead(500).end()
      }
    })
  })
  const children = []
  async function boot(role, profile, home, privateDir) {
    const child = spawn(process.execPath, [join(repository, 'apps/cli/lib/bin.js'), '--profile', profile.name], {
      cwd: repository,
      env: { ...process.env, DSH_HOME: home, PE_PRIVATE_DIR: privateDir, DSH_TELEMETRY_DISABLED: '1' },
      stdio: ['ignore', 'pipe', 'pipe'],
    })
    const item = {
      child, role, output: '', error: undefined,
      closed: new Promise((done) => { child.once('close', (code, signal) => done({ code, signal })) }),
    }
    children.push(item)
    child.on('error', (error) => { item.error = error })
    child.stdout?.on('data', (chunk) => { item.output += String(chunk) })
    child.stderr?.on('data', (chunk) => { item.output += String(chunk) })
    await waitUntil(async () => {
      if (item.error) throw item.error
      if (child.exitCode !== null) throw new Error(role + ' exited')
      try {
        await readFile(profile.readyFile)
        return true
      } catch (error) {
        if (error instanceof Error && 'code' in error && error.code === 'ENOENT') return false
        throw error
      }
    }, role + ' readiness')
  }

  try {
    mock.listen(0, '127.0.0.1')
    await once(mock, 'listening')
    const modelAddress = mock.address()
    if (!modelAddress || typeof modelAddress === 'string') throw new Error('Missing mock address')
    await cloudFixture(async (db) => {
      const privateDir = join(db.root, 'config')
      const home = join(db.root, 'dsh-home')
      const attachmentRoot = join(privateDir, 'attachments')
      await mkdir(privateDir, { mode: 0o700 })
      await mkdir(home, { mode: 0o700 })
      for (const name of ['worker-token', 'model-key', 'connector-key']) {
        await writeFile(join(privateDir, name), randomUUID(), { mode: 0o600 })
      }
      await writeFile(join(privateDir, 'native-intent-key'), randomBytes(32).toString('base64url') + '\n', { mode: 0o600, flag: 'wx' })
      await writeFile(join(privateDir, 'database-url'), db.databaseUrl, { mode: 0o600 })
      await db.pool.query("UPDATE pe_users SET settings=jsonb_set(settings::jsonb,'{model}', '\"deepseek-flash\"'::jsonb)::json")
      await db.pool.query("UPDATE pe_user_models SET model_id='deepseek-flash' WHERE model_id='trial-model'")
      const tasks = new TaskStore(db.pool, {
        maxEventBytes: 524288, leaseMs: 30000, maxPendingPerUser: 8, maxActivePerUser: 1,
      })
      const events = new EventStore(tasks, { maxEventBytes: 524288, maxHistoryBytes: 8388608, maxHistoryEvents: 10000 })
      const created = await tasks.create(db.alice.user, requestId.parse(randomUUID()), db.alice.token)
      await tasks.accept(db.alice.user, created.sessionId, requestId.parse(randomUUID()), 'original image', db.alice.token)
      const grant = await tasks.claim(randomUUID())
      if (!grant) throw new Error('Missing original operation grant')
      const imageHome = join(attachmentRoot, grant.userId, grant.sessionId)
      await mkdir(imageHome, { recursive: true, mode: 0o700 })
      const ctx = new Context()
      let image
      try {
        const store = new AttachmentLocal(ctx, { dshHome: imageHome })
        image = await store.saveImage({
          data: Buffer.from('iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAIAAACQd1PeAAAACXBIWXMAAAPoAAAD6AG1e1JrAAAADElEQVQImWNgZGIGAAAOAAeCcsnOAAAAAElFTkSuQmCC', 'base64'),
          mediaType: 'image/png', name: 'migrated.png',
        })
      } finally {
        await ctx.fiber.dispose()
      }
      const session = Session.create(grant.sessionId, undefined, {
        id: grant.sessionId, version: 4, createdAt: 1, isSeeded: false,
      })
      session.append('turn/start', { turn: 1 })
      session.append('user/message', {
        id: MessageId(grant.requestId), role: 'user', source: { kind: 'user' },
        content: [{ type: 'text', text: 'Original image' }, { type: 'image', attachment: image }],
      }, { surfaceOp: 'append' })
      session.append('turn/end', { turn: 1, reason: { kind: 'completed' } })
      await events.append(grant.token, session.snapshotEvents())
      await tasks.finish(grant.token, 'completed', null)
      const ledger = {
        version: 1, userId: grant.userId, sessionId: grant.sessionId,
        bindings: [{
          kind: 'image', authority: 'verified-history-migration', migrationId: randomUUID(),
          userId: grant.userId, sessionId: grant.sessionId, storageSessionId: grant.sessionId,
          sourceRootId: 'owned-source', sourceRowSha256s: ['a'.repeat(64)], image,
          occurrences: [{ seq: 1, imageIndex: 0 }],
        }],
      }
      await db.pool.query('INSERT INTO pe_native_preferences(user_id,namespace,value,revision) VALUES($1,$2,$3,1)', [
        grant.userId, 'legacy-migration-v2-images:' + grant.sessionId, JSON.stringify(ledger),
      ])
      const hostPort = await unusedPort(), platformPort = await unusedPort()
      const hostOrigin = 'http://127.0.0.1:' + hostPort, platformOrigin = 'http://127.0.0.1:' + platformPort
      const config = {
        mode: 'local-http', privateDir, dshHome: home, hostOrigin, platformOrigin, platformInternalUrl: platformOrigin,
        rows: {
          host: { 'web-server': { port: hostPort }, 'power-evolve-host': { pollMs: 100, operationTimeoutMs: 30000 } },
          platform: {
            'web-server': { port: platformPort },
            'power-evolve-platform': {
              modelUrl: 'http://127.0.0.1:' + modelAddress.port + '/v1/messages',
              connectorUrl: 'http://127.0.0.1:' + modelAddress.port + '/connector',
              seedUsersFile: '', accountManagementFile: '', preinstalledSkills: [],
            },
          },
        },
      }
      const platform = await renderProfile('platform', config), host = await renderProfile('host', config)
      try {
        await boot('platform', platform, home, privateDir)
        await boot('host', host, home, privateDir)
        const nextRequest = requestId.parse(randomUUID())
        await tasks.accept(db.alice.user, grant.sessionId, nextRequest, 'Describe the original image', db.alice.token)
        await waitUntil(async () => {
          const row = (await db.pool.query('SELECT state,error_code FROM pe_operations WHERE request_id=$1', [nextRequest])).rows[0]
          if (row?.state === 'failed') throw new Error('Model operation failed: ' + JSON.stringify(row))
          return row?.state === 'completed'
        }, 'model operation')
        assert.equal(requests.length, 1)
        const expected = join(repository, 'products/power-evolve/application/tests/fixtures/native-image-model.expected.json')
        assert.deepEqual(requests[0].messages, JSON.parse(await readFile(expected, 'utf8')))
        const encoded = JSON.stringify(requests[0])
        assert(encoded.includes('"type":"image"'))
        assert(encoded.includes('"type":"base64"'))
        const history = (await db.pool.query('SELECT event FROM pe_events WHERE session_id=$1 ORDER BY seq', [grant.sessionId])).rows
        assert(history.some(row => JSON.stringify(row.event).includes(image.attachmentId)))
      } finally {
        // Stop every owned process before releasing its database, including a readiness failure.
        for (const item of children) item.child.kill('SIGTERM')
        const results = await Promise.allSettled(children.map(async (item) => {
          const killDeadline = setTimeout(() => item.child.kill('SIGKILL'), 5000)
          try {
            const result = await item.closed
            await writeFile(join(evidence, 'profile-' + item.role + '.log'), item.output, { mode: 0o600 })
            return result
          } finally {
            clearTimeout(killDeadline)
          }
        }))
        for (const result of results) {
          if (result.status === 'rejected') throw result.reason
          assert.equal(result.value.code, 0)
        }
      }
    })
  } finally {
    await new Promise((done) => { mock.close(() => done()); mock.closeAllConnections() })
    await rm(evidence, { recursive: true, force: true })
  }
})
