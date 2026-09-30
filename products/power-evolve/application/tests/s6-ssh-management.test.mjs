/** Owner, replay, immutable-history and concurrency checks against real PostgreSQL. */
import assert from 'node:assert/strict'
import { randomBytes, randomUUID } from 'node:crypto'
import { readFile } from 'node:fs/promises'
import { homedir } from 'node:os'
import { join } from 'node:path'
import { Readable } from 'node:stream'
import test from 'node:test'
import { Pool } from 'pg'
import { identity } from '../lib/contracts.js'
import { sshConnectionValue, sshCredentialTicketValue } from '../lib/ssh-management-contracts.js'
import { initializeDatabase } from '../lib/platform/database.js'
import { SshConnectionService } from '../lib/platform/ssh.js'

const privateDir = process.env.PE_PRIVATE_DIR ?? join(homedir(), '.config/power-evolve/shared-host-native-s5')
const databaseUrl = (await readFile(join(privateDir, 'database-url'), 'utf8')).trim()
const origin = 'http://127.0.0.1:19221'
const allowlist = 'fixture.example.test:2222,other.example.test:2223'
const base = { displayName: 'Managed fixture', host: 'fixture.example.test', port: 2222,
  username: 'alice', hostKeySha256: `SHA256:${'A'.repeat(43)}`, workingDirectory: " /srv/fixture's workspace ",
  authentication: { kind: 'password', password: 'replace' }, enabled: true }
const bytes = value => Buffer.from(JSON.stringify(value), 'utf8')
const stream = value => Readable.from([value])
const configuration = (item, authentication, changes = {}) => ({ displayName: item.displayName,
  host: item.host, port: item.port, username: item.username, hostKeySha256: item.hostKeySha256,
  workingDirectory: item.workingDirectory, enabled: item.enabled, authentication, ...changes })

test('managed SSH mutations preserve immutable authority, direct secrets and original receipts',
  { timeout: 60_000 }, async t => {
    const database = `pe_s6_ssh_management_${randomBytes(8).toString('hex')}`
    const admin = new Pool({ connectionString: databaseUrl, max: 2 })
    let pool, created = false
    t.after(async () => {
      await pool?.end()
      if (created) await admin.query(`DROP DATABASE IF EXISTS "${database}"`)
      await admin.end()
    })
    await admin.query(`CREATE DATABASE "${database}"`); created = true
    const url = new URL(databaseUrl); url.pathname = `/${database}`
    pool = new Pool({ connectionString: url.href, max: 2 })
    await initializeDatabase(pool)
    assert.equal((await pool.query('SELECT version FROM pe_schema')).rows[0].version, 24)
    const addUser = async name => {
      const user = identity.parse({ userId: randomUUID(), username: name })
      await pool.query('INSERT INTO pe_users(id,username,password_hash,settings) VALUES($1,$2,$3,$4)',
        [user.userId, user.username, 'test-only', { model: 'fixture', maxTokens: 64, revision: 1 }])
      return user
    }
    const alice = await addUser('alice'), bob = await addUser('bob')
    const key = randomBytes(32).toString('base64url')
    const ssh = new SshConnectionService(pool, key, allowlist)
    const create = async (service, user, config = base, upload = { formatVersion: 2, password: 'fixture-password' }) => {
      const payload = bytes(upload)
      const input = { requestId: randomUUID(), purpose: 'create', configuration: config, sizeBytes: payload.length }
      const ticket = await service.issueManagedTicket(user, input, origin)
      assert.equal(sshCredentialTicketValue.safeParse(ticket).success, true)
      const result = await service.upload(ticket.ticket, stream(payload))
      assert.equal(sshConnectionValue.safeParse(result.item).success, true)
      return { input, ticket, payload, item: result.item }
    }
    let current, initial

    await t.test('owner-scoped metadata retains ciphertext without decrypting and preserves the remote path', async () => {
      initial = await create(ssh, alice); current = initial.item
      assert.equal(current.workingDirectory, base.workingDirectory)
      assert.deepEqual(await ssh.receipt(alice, initial.input.requestId), { item: current })
      assert.deepEqual(await ssh.receipt(bob, initial.input.requestId), { item: null })
      assert.deepEqual(await ssh.receipt(alice, randomUUID()), { item: null })
      assert.deepEqual((await ssh.listManaged(alice)).items, [current])
      assert.deepEqual((await ssh.listManaged(bob)).items, [])
      await assert.rejects(ssh.update(bob, { requestId: randomUUID(), connectionId: current.connectionId,
        baseRevision: 1, configuration: configuration(current, { kind: 'password', password: 'retain' }) }),
      { status: 404, code: 'ssh_connection_not_found' })
      const oldCipher = (await pool.query('SELECT encrypted_credential FROM pe_ssh_connections WHERE id=$1',
        [current.connectionId])).rows[0].encrypted_credential
      const input = { requestId: randomUUID(), connectionId: current.connectionId, baseRevision: current.revision,
        configuration: configuration(current, { kind: 'password', password: 'retain' },
          { host: 'other.example.test', port: 2223, displayName: 'New target' }) }
      // A valid but unrelated backend key proves this pure metadata mutation does not decrypt.
      const wrongKey = new SshConnectionService(pool, randomBytes(32).toString('base64url'), allowlist)
      current = await wrongKey.update(alice, input)
      assert.equal(current.revision, 2); assert.equal(current.credentialRevision, 1)
      assert.deepEqual(await ssh.update(alice, input), current)
      assert.deepEqual((await pool.query('SELECT encrypted_credential FROM pe_ssh_connections WHERE id=$1',
        [current.connectionId])).rows[0].encrypted_credential, oldCipher)
      assert.equal((await ssh.credentialForCall(alice, current.connectionId, 2)).credential.password, 'fixture-password')
      assert.equal((await ssh.metadataForVersion(alice, current.connectionId, 1)).host, base.host)
      await assert.rejects(ssh.metadataForCall(alice, current.connectionId, 1), { code: 'ssh_connection_not_found' })
      await assert.rejects(ssh.update(alice, { ...input, configuration: { ...input.configuration, displayName: 'Conflict' } }),
        { status: 409, code: 'request_id_conflict' })
      for (const table of ['pe_ssh_configuration_versions', 'pe_ssh_credential_versions']) {
        await assert.rejects(pool.query(`DELETE FROM ${table} WHERE connection_id=$1`, [current.connectionId]),
          /SSH versions are immutable/u)
      }
    })

    await t.test('key replacement, passphrase retention/replacement/clear create only deliberate credential versions', async () => {
      const invalid = { requestId: randomUUID(), purpose: 'update', connectionId: current.connectionId,
        baseRevision: current.revision, configuration: configuration(current,
          { kind: 'private_key', privateKey: 'replace', passphrase: 'retain' }), sizeBytes: 42 }
      await assert.rejects(ssh.issueManagedTicket(alice, invalid, origin),
        { status: 409, code: 'ssh_credential_retention_invalid' })
      const replace = async (authentication, upload) => {
        const payload = bytes(upload), input = { requestId: randomUUID(), purpose: 'update',
          connectionId: current.connectionId, baseRevision: current.revision,
          configuration: configuration(current, authentication), sizeBytes: payload.length }
        const ticket = await ssh.issueManagedTicket(alice, input, origin)
        current = (await ssh.upload(ticket.ticket, stream(payload))).item
      }
      await replace({ kind: 'private_key', privateKey: 'replace', passphrase: 'clear' },
        { formatVersion: 2, privateKey: 'fixture-private-key' })
      assert.equal(current.credentialRevision, 2); assert.equal(current.passphraseConfigured, false)
      await replace({ kind: 'private_key', privateKey: 'retain', passphrase: 'replace' },
        { formatVersion: 2, passphrase: 'fixture-passphrase' })
      assert.equal(current.credentialRevision, 3); assert.equal(current.passphraseConfigured, true)
      assert.deepEqual((await ssh.credentialForCall(alice, current.connectionId, current.revision)).credential,
        { kind: 'private_key', privateKey: 'fixture-private-key', passphrase: 'fixture-passphrase' })
      current = await ssh.update(alice, { requestId: randomUUID(), connectionId: current.connectionId,
        baseRevision: current.revision, configuration: configuration(current,
          { kind: 'private_key', privateKey: 'retain', passphrase: 'retain' }, { displayName: 'Retained key' }) })
      assert.equal(current.credentialRevision, 3)
      current = await ssh.update(alice, { requestId: randomUUID(), connectionId: current.connectionId,
        baseRevision: current.revision, configuration: configuration(current,
          { kind: 'private_key', privateKey: 'retain', passphrase: 'clear' }) })
      assert.equal(current.credentialRevision, 4); assert.equal(current.passphraseConfigured, false)
      assert.deepEqual((await ssh.credentialForCall(alice, current.connectionId, current.revision)).credential,
        { kind: 'private_key', privateKey: 'fixture-private-key' })
      await replace({ kind: 'private_key', privateKey: 'replace', passphrase: 'retain' },
        { formatVersion: 2, privateKey: 'second-private-key' })
      assert.equal(current.credentialRevision, 5); assert.equal(current.passphraseConfigured, false)
      const publicRows = await pool.query('SELECT input,result FROM pe_ssh_management_requests WHERE user_id=$1', [alice.userId])
      for (const value of ['fixture-password', 'fixture-private-key', 'fixture-passphrase', 'second-private-key']) {
        assert.equal(JSON.stringify(publicRows.rows).includes(value), false)
      }
    })

    await t.test('a ticket fixes its source revision and rejects stale or extra credential fields', async () => {
      const payload = bytes({ formatVersion: 2, privateKey: 'third-private-key' })
      const input = { requestId: randomUUID(), purpose: 'update', connectionId: current.connectionId,
        baseRevision: current.revision, configuration: configuration(current,
          { kind: 'private_key', privateKey: 'replace', passphrase: 'clear' }), sizeBytes: payload.length }
      const ticket = await ssh.issueManagedTicket(alice, input, origin)
      current = await ssh.toggleManaged(alice, { requestId: randomUUID(), connectionId: current.connectionId,
        baseRevision: current.revision, enabled: false })
      await assert.rejects(ssh.upload(ticket.ticket, stream(payload)), { status: 409, code: 'revision_conflict' })
      assert.deepEqual(await ssh.receipt(alice, input.requestId), { item: null })
      await assert.rejects(ssh.issueManagedTicket(alice, input, origin), { status: 409, code: 'revision_conflict' })
      await assert.rejects(ssh.toggleManaged(alice, { requestId: input.requestId, connectionId: current.connectionId,
        baseRevision: current.revision, enabled: true }), { status: 409, code: 'request_id_conflict' })
      const extra = bytes({ formatVersion: 2, privateKey: 'new', passphrase: 'hidden' })
      const exactInput = { ...input, requestId: randomUUID(), baseRevision: current.revision, sizeBytes: extra.length }
      const exactTicket = await ssh.issueManagedTicket(alice, exactInput, origin)
      await assert.rejects(ssh.upload(exactTicket.ticket, stream(extra)), { status: 400, code: 'ssh_credential_plan_mismatch' })
      await assert.rejects(ssh.upload(exactTicket.ticket, stream(Buffer.alloc(extra.length + 1))),
        { status: 413, code: 'ssh_credential_too_large' })
    })

    await t.test('concurrent compare-and-swap edits commit exactly one immutable next version', async () => {
      const revision = current.revision
      const outcomes = await Promise.allSettled(['First', 'Second'].map(displayName => ssh.update(alice,
        { requestId: randomUUID(), connectionId: current.connectionId, baseRevision: revision,
          configuration: configuration(current, { kind: 'private_key', privateKey: 'retain', passphrase: 'retain' },
            { displayName }) })))
      assert.equal(outcomes.filter(value => value.status === 'fulfilled').length, 1)
      const failure = outcomes.find(value => value.status === 'rejected')
      assert.equal(failure.reason.code, 'revision_conflict')
      current = outcomes.find(value => value.status === 'fulfilled').value
      assert.equal(current.revision, revision + 1)
      assert.equal((await pool.query('SELECT count(*)::int AS n FROM pe_ssh_configuration_versions WHERE connection_id=$1',
        [current.connectionId])).rows[0].n, current.revision)
    })

    await t.test('disable/delete work without a key or allowlist and completed uploads replay the original receipt', async () => {
      const unavailable = new SshConnectionService(pool, '', '')
      current = await unavailable.toggleManaged(alice, { requestId: randomUUID(), connectionId: current.connectionId,
        baseRevision: current.revision, enabled: false })
      await assert.rejects(unavailable.toggleManaged(alice, { requestId: randomUUID(), connectionId: current.connectionId,
        baseRevision: current.revision, enabled: true }), { status: 503, code: 'ssh_unavailable' })
      const deletion = { requestId: randomUUID(), connectionId: current.connectionId, baseRevision: current.revision }
      current = await unavailable.remove(alice, deletion)
      assert.ok(current.deletedAt); assert.equal(current.enabled, false)
      assert.deepEqual(await unavailable.remove(alice, deletion), current)
      assert.deepEqual(await unavailable.receipt(alice, deletion.requestId), { item: current })
      assert.deepEqual(await unavailable.listManaged(alice), { available: false, items: [] })
      assert.equal((await unavailable.metadataForVersion(alice, current.connectionId, 1)).workingDirectory, base.workingDirectory)
      await assert.rejects(unavailable.metadataForVersion(bob, current.connectionId, 1), { code: 'ssh_connection_not_found' })
      await assert.rejects(ssh.credentialForCall(alice, current.connectionId, current.revision), { code: 'ssh_connection_not_found' })
      await assert.rejects(unavailable.remove(alice, { ...deletion, requestId: randomUUID(), baseRevision: current.revision }),
        { status: 404, code: 'ssh_connection_not_found' })
      // Receipt verification must survive target deletion and subsequent allowlist changes.
      const denied = new SshConnectionService(pool, key, 'elsewhere.example.test:22')
      const renewed = await denied.issueManagedTicket(alice, initial.input, origin)
      assert.deepEqual(await denied.upload(renewed.ticket, stream(initial.payload)), { item: initial.item })
      await assert.rejects(denied.upload(initial.ticket.ticket, stream(initial.payload)), { code: 'invalid_ssh_ticket' })
      await assert.rejects(denied.issueManagedTicket(alice, { ...initial.input,
        configuration: { ...initial.input.configuration, displayName: 'Changed replay metadata' } }, origin),
      { status: 409, code: 'request_id_conflict' })
      const changed = bytes({ formatVersion: 2, password: 'changed-password' })
      assert.equal(changed.length, initial.payload.length)
      await assert.rejects(denied.upload(renewed.ticket, stream(changed)), { status: 409, code: 'ssh_credential_conflict' })
      const again = await denied.issueManagedTicket(alice, initial.input, origin)
      assert.deepEqual(await denied.upload(again.ticket, stream(initial.payload)), { item: initial.item })
      const row = (await pool.query('SELECT verification_failures FROM pe_ssh_upload_intents WHERE request_id=$1',
        [initial.input.requestId])).rows[0]
      assert.equal(row.verification_failures, 1)
    })

    await t.test('create quota is rechecked at commit and ticket/mismatch budgets are configurable', async () => {
      const user = await addUser('quota')
      const limited = new SshConnectionService(pool, key, allowlist,
        { maxConnections: 1, maxPendingTickets: 2, maxCompletedMismatches: 1, ticketLifetimeMs: 60_000 })
      const payload = bytes({ formatVersion: 2, password: 'quota-secret' })
      const input = () => ({ requestId: randomUUID(), purpose: 'create', configuration: base, sizeBytes: payload.length })
      const firstInput = input(), secondInput = input()
      const first = await limited.issueManagedTicket(user, firstInput, origin)
      const second = await limited.issueManagedTicket(user, secondInput, origin)
      await assert.rejects(limited.issueManagedTicket(user, input(), origin), { status: 429, code: 'ssh_upload_limit' })
      const renewed = await limited.issueManagedTicket(user, firstInput, origin)
      assert.ok(Date.parse(renewed.expiresAt) - Date.now() <= 60_000)
      await assert.rejects(limited.upload(first.ticket, stream(payload)), { code: 'invalid_ssh_ticket' })
      const one = (await limited.upload(renewed.ticket, stream(payload))).item
      await assert.rejects(limited.upload(second.ticket, stream(payload)), { status: 413, code: 'ssh_connection_limit' })
      assert.deepEqual(await limited.receipt(user, secondInput.requestId), { item: null })
      await assert.rejects(limited.upload(renewed.ticket,
        stream(bytes({ formatVersion: 2, password: 'other-secret' }))), { code: 'ssh_credential_conflict' })
      await assert.rejects(limited.issueManagedTicket(user, firstInput, origin), { code: 'ssh_credential_retry_limit' })
      await assert.rejects(limited.upload(renewed.ticket, stream(payload)), { code: 'ssh_credential_retry_limit' })
      await limited.remove(user, { requestId: randomUUID(), connectionId: one.connectionId, baseRevision: one.revision })
      assert.equal((await limited.upload(second.ticket, stream(payload))).item.revision, 1)
      assert.equal((await limited.listManaged(user)).items.length, 1)
    })

    await t.test('concurrent foreign owners cannot replace each other\'s direct-upload capability', async () => {
      const users = [await addUser('race-a'), await addUser('race-b')]
      const payload = bytes({ formatVersion: 2, password: 'race-secret' })
      const sharedId = randomUUID()
      const input = { requestId: sharedId, purpose: 'create', configuration: base, sizeBytes: payload.length }
      const outcomes = await Promise.allSettled(users.map(user => ssh.issueManagedTicket(user, input, origin)))
      const winner = outcomes.findIndex(value => value.status === 'fulfilled')
      const loser = 1 - winner
      assert.ok(winner >= 0)
      assert.equal(outcomes[loser].status, 'rejected')
      assert.equal(outcomes[loser].reason.code, 'request_id_conflict')
      const item = (await ssh.upload(outcomes[winner].value.ticket, stream(payload))).item
      assert.equal((await ssh.credentialForCall(users[winner], item.connectionId, 1)).credential.password, 'race-secret')
      assert.deepEqual(await ssh.receipt(users[loser], sharedId), { item: null })
      assert.deepEqual((await ssh.listManaged(users[loser])).items, [])
    })
  })
