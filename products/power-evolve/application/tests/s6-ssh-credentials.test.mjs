/** Real PostgreSQL checks for direct SSH credential intake and per-user metadata. */
import test from 'node:test'
import assert from 'node:assert/strict'
import { randomBytes, randomUUID } from 'node:crypto'
import { Readable } from 'node:stream'
import { readFile } from 'node:fs/promises'
import { homedir } from 'node:os'
import { join } from 'node:path'
import { Pool } from 'pg'
import { identity, sshCreateTicketRequest } from '../lib/contracts.js'
import { initializeDatabase } from '../lib/platform/database.js'
import { SshConnectionService } from '../lib/platform/ssh.js'
import * as migrations from '../lib/platform/schema.js'

const privateDir = process.env.PE_PRIVATE_DIR ?? join(homedir(), '.config/power-evolve/shared-host-native-s5')
const databaseUrl = (await readFile(join(privateDir, 'database-url'), 'utf8')).trim()

test('S6 SSH credential ticket keeps password out of Host, encrypts it, and scopes metadata by user',
  { timeout: 60_000 }, async t => {
    const database = `pe_s6_ssh_${randomBytes(10).toString('hex')}`
    const admin = new Pool({ connectionString: databaseUrl, max: 2 })
    let pool, created = false
    t.after(async () => {
      await pool?.end()
      if (created) await admin.query(`DROP DATABASE IF EXISTS "${database}"`)
      await admin.end()
    })
    await admin.query(`CREATE DATABASE "${database}"`)
    created = true
    const url = new URL(databaseUrl); url.pathname = `/${database}`
    pool = new Pool({ connectionString: url.href, max: 8 })
    const alice = identity.parse({ userId: randomUUID(), username: 'alice' })
    const bob = identity.parse({ userId: randomUUID(), username: 'bob' })
    const client = await pool.connect()
    try {
      await client.query('BEGIN')
      await client.query(migrations.schema)
      await client.query('INSERT INTO pe_schema(version) VALUES(1)')
      for (const user of [alice, bob]) await client.query(
        'INSERT INTO pe_users(id,username,password_hash,settings) VALUES($1,$2,$3,$4)',
        [user.userId, user.username, 'test-only', { model: 'fixture', maxTokens: 64, revision: 1 }])
      for (let version = 2; version <= 14; version++) await client.query(migrations[`schemaV${version}`])
      await client.query('COMMIT')
    } catch (error) { await client.query('ROLLBACK'); throw error }
    finally { client.release() }
    await initializeDatabase(pool)
    await initializeDatabase(pool)
    assert.equal((await pool.query('SELECT version FROM pe_schema')).rows[0].version, 20)

    const key = randomBytes(32).toString('base64url')
    const ssh = new SshConnectionService(pool, key, 'fixture.example.test:2222')
    const bobSsh = new SshConnectionService(pool, key, 'fixture.example.test:2222')
    assert.deepEqual(await ssh.list(alice), { available: true, items: [] })
    const password = Buffer.from('test-only-password-γ', 'utf8')
    const input = { requestId: randomUUID(), displayName: 'Alice server', host: 'fixture.example.test',
      port: 2222, username: 'alice', hostKeySha256: `SHA256:${'A'.repeat(43)}`,
      credentialKind: 'password', sizeBytes: password.length, enabled: true }
    await assert.rejects(ssh.issueTicket(alice, { ...input, host: 'unlisted.example.test' }, 'http://127.0.0.1:19221'),
      { status: 403, code: 'ssh_destination_denied' })
    const issued = await ssh.issueTicket(alice, input, 'http://127.0.0.1:19221')
    assert.equal(issued.state, 'pending')
    assert.equal(issued.uploadUrl, 'http://127.0.0.1:19221/ssh/upload')
    assert.equal(JSON.stringify(issued).includes(password.toString()), false)
    const uploaded = await ssh.upload(issued.ticket, Readable.from([password]))
    assert.equal(uploaded.item.displayName, 'Alice server')
    assert.equal(uploaded.item.enabled, true)
    assert.deepEqual(await ssh.upload(issued.ticket, Readable.from([password])), uploaded)
    await assert.rejects(ssh.upload(issued.ticket, Readable.from([Buffer.from('x'.repeat(password.length))])),
      { status: 409, code: 'ssh_credential_conflict' })
    const retry = await ssh.issueTicket(alice, input, 'http://127.0.0.1:19221')
    assert.equal(retry.state, 'pending')
    assert.notEqual(retry.ticket, issued.ticket)
    await assert.rejects(ssh.upload(issued.ticket, Readable.from([password])),
      { status: 401, code: 'invalid_ssh_ticket' })
    await assert.rejects(ssh.upload(retry.ticket, Readable.from([Buffer.from('x'.repeat(password.length))])),
      { status: 409, code: 'ssh_credential_conflict' })
    assert.deepEqual(await ssh.upload(retry.ticket, Readable.from([password])), uploaded)
    await assert.rejects(ssh.upload(retry.ticket, Readable.from([Buffer.from('x'.repeat(password.length))])),
      { status: 409, code: 'ssh_credential_conflict' })
    await assert.rejects(ssh.upload(retry.ticket, Readable.from([password])),
      { status: 409, code: 'ssh_credential_retry_limit' })
    await assert.rejects(ssh.issueTicket(alice, input, 'http://127.0.0.1:19221'),
      { status: 409, code: 'ssh_credential_retry_limit' })
    const callCredential = await ssh.credentialForCall(alice, uploaded.item.connectionId, 1)
    assert.equal(callCredential.credential.password, password.toString('utf8'))
    assert.equal(callCredential.hostKeySha256, input.hostKeySha256)
    assert.deepEqual(await ssh.metadataForCall(alice, uploaded.item.connectionId, 1),
      { host: input.host, port: input.port, username: input.username,
        hostKeySha256: input.hostKeySha256, credentialRevision: 1 })
    await assert.rejects(ssh.metadataForCall(bob, uploaded.item.connectionId, 1),
      { status: 404, code: 'ssh_connection_not_found' })
    await assert.rejects(ssh.credentialForCall(bob, uploaded.item.connectionId, 1),
      { status: 404, code: 'ssh_connection_not_found' })
    await assert.rejects(new SshConnectionService(pool, randomBytes(32).toString('base64url'),
      'fixture.example.test:2222').credentialForCall(alice, uploaded.item.connectionId, 1),
    { status: 503, code: 'ssh_credential_unavailable' })
    await assert.rejects(ssh.issueTicket(alice, { ...input, displayName: 'changed' }, 'http://127.0.0.1:19221'),
      { status: 409, code: 'request_id_conflict' })
    const stored = await pool.query('SELECT encrypted_credential FROM pe_ssh_connections WHERE id=$1', [input.requestId])
    assert.equal(stored.rows[0].encrypted_credential.includes(password), false)
    assert.ok(stored.rows[0].encrypted_credential.length > password.length)
    const intent = await pool.query('SELECT config,result,secret_digest FROM pe_ssh_upload_intents WHERE request_id=$1', [input.requestId])
    assert.equal(JSON.stringify(intent.rows[0].config).includes(password.toString()), false)
    assert.equal(JSON.stringify(intent.rows[0].config).includes('secretDigest'), false)
    assert.equal(JSON.stringify(intent.rows[0]).includes(password.toString()), false)
    assert.equal(intent.rows[0].result.failedVerifications, 3)
    assert.match(intent.rows[0].secret_digest, /^[a-f0-9]{64}$/u)
    assert.deepEqual((await ssh.list(alice)).items, [uploaded.item])
    assert.deepEqual((await bobSsh.list(bob)).items, [])
    await assert.rejects(ssh.toggle(bob, uploaded.item.connectionId, randomUUID(), 1, false),
      { status: 404, code: 'ssh_connection_not_found' })
    const toggleId = randomUUID()
    const disabled = await ssh.toggle(alice, uploaded.item.connectionId, toggleId, 1, false)
    assert.equal(disabled.enabled, false)
    assert.equal(disabled.revision, 2)
    await assert.rejects(ssh.credentialForCall(alice, uploaded.item.connectionId, 2),
      { status: 404, code: 'ssh_connection_not_found' })
    assert.deepEqual(await ssh.toggle(alice, uploaded.item.connectionId, toggleId, 1, false), disabled)
    await assert.rejects(ssh.toggle(alice, uploaded.item.connectionId, toggleId, 1, true),
      { status: 409, code: 'request_id_conflict' })
    await assert.rejects(ssh.toggle(alice, uploaded.item.connectionId, randomUUID(), 1, true),
      { status: 409, code: 'revision_conflict' })
    assert.deepEqual((await new SshConnectionService(pool, key, 'fixture.example.test:2222').list(alice)).items,
      [disabled])
    const maximumPassword = Buffer.from('p'.repeat(4096))
    const maximumInput = { ...input, requestId: randomUUID(), sizeBytes: maximumPassword.length }
    assert.equal(sshCreateTicketRequest.safeParse(maximumInput).success, true)
    assert.equal(sshCreateTicketRequest.safeParse({ ...maximumInput, sizeBytes: 4097 }).success, false)
    const maximumTicket = await ssh.issueTicket(alice, maximumInput, 'http://127.0.0.1:19221')
    const maximumResult = await ssh.upload(maximumTicket.ticket, Readable.from([maximumPassword]))
    assert.equal((await ssh.credentialForCall(alice, maximumResult.item.connectionId, 1))
      .credential.password.length, 4096)
    const oversizedTicket = await ssh.issueTicket(alice,
      { ...input, requestId: randomUUID(), sizeBytes: 4096 }, 'http://127.0.0.1:19221')
    await assert.rejects(ssh.upload(oversizedTicket.ticket, Readable.from([Buffer.from('q'.repeat(4097))])),
      { status: 413, code: 'ssh_credential_too_large' })
    const unavailable = new SshConnectionService(pool, '', '')
    assert.equal((await unavailable.list(alice)).available, false)
    await assert.rejects(unavailable.issueTicket(alice, { ...input, requestId: randomUUID() },
      'http://127.0.0.1:19221'), { status: 503, code: 'ssh_unavailable' })
  })
