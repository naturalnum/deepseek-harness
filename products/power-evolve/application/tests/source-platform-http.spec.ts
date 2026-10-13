/** Current-source CLI/Profile account, settings and Session metadata HTTP with real schema6 PostgreSQL. */
import assert from 'node:assert/strict'
import { createHash, randomBytes, randomUUID } from 'node:crypto'
import { readFile } from 'node:fs/promises'
import { join } from 'node:path'
import { z } from 'zod'
import { storedFilePath } from '@deepseek-ai/dsh-attachment-local'
import { FILE_DOWNLOAD_CONTENT_PATH, FILE_DOWNLOAD_PLATFORM_PATH, FILE_DOWNLOAD_MAX_URL_BYTES,
  fileDownloadView } from '@power-evolve/contracts/file-download'
import { expect, test } from 'vitest'
import { accountMutationValue } from '@power-evolve/contracts/account'
import { ACCOUNT_ERROR_CODES, ACCOUNT_ROUTES, accountMeValue, accountModelCatalogValue,
  accountReceiptRequest, accountReceiptValue, accountUpdateRequest } from '../src/account-contracts.ts'
import { createRequest, identity, listRequest, pageRequest, sessionId, settings, settingsUpdateRequest } from '../src/contracts.ts'
import { nativePreferenceWrite } from '../src/platform/native-preferences.ts'
import { nativeSessionRename } from '../src/native-session-contracts.ts'
import { fileReceiptId, nativeFileAttachment } from '../src/native-attachment-contracts.ts'
import { sourceHttpTestTimeout, sourcePlatformHttpFixture, type SourceHttpFixture, type SourceHttpLifetime,
  type SourceHttpOptions, type SourceHttpReply, type SourceHttpBinaryOptions, type SourceHttpBinaryReply } from './source-platform-http-fixture.ts'

function accepted(reply: SourceHttpReply): unknown {
  expect(reply.status).toBe(200)
  return reply.value
}

async function rejected(fixture: SourceHttpFixture, path: string, body: unknown,
  status: number, error: string, options: SourceHttpOptions): Promise<void> {
  const before = await fixture.snapshot()
  const reply = await fixture.http(path, body, options)
  expect(reply.status).toBe(status)
  expect(reply.value).toEqual({ error })
  expect(await fixture.snapshot()).toEqual(before)
}

function settled(receipt: SourceHttpLifetime): void {
  expect(receipt.stop).toMatchObject({ code: 0, signal: null, ownedPgConnections: 0 })
  expect(receipt.temporaryRootRemoved).toBe(true)
  expect(receipt.ownedDatabaseRemoved).toBe(true)
  expect(receipt.source.pid).toBe(receipt.pid)
  expect(receipt.source.url.endsWith('/application/src/platform/index.ts')).toBe(true)
  expect(receipt.source.applyCount).toBeGreaterThan(0)
  console.info('Source Platform HTTP lifetime: ' + JSON.stringify(receipt))
}

test('source Profile returns current account identity, persists revisioned settings and reads owned Session metadata', { timeout: sourceHttpTestTimeout }, async (context) => {
  expect(context.task.timeout).toBe(sourceHttpTestTimeout)
  const receipt = await sourcePlatformHttpFixture(async (fixture) => {
    const { alice, bob } = fixture.actors
    const me = accountMeValue.parse(accepted(await fixture.http(ACCOUNT_ROUTES.me, {}, { token: alice.account })))
    expect(me).toEqual({ user: alice.user, restricted: false })
    const stored = (await fixture.pool.query<{ id: string; username: string; settings: unknown }>(
      'SELECT id,username,settings FROM pe_users WHERE id=$1', [alice.user.userId])).rows[0]
    assert(stored)
    expect(accepted(await fixture.http('/identity/me', {}, { token: alice.agent }))).toEqual({
      ...identity.parse({ userId: stored.id, username: stored.username }), settings: settings.parse(stored.settings),
    })
    expect(accepted(await fixture.http('/identity/models', {}, { token: alice.agent }))).toEqual({
      models: [{ id: 'trial-model', label: 'Trial', maxTokens: 2000 }],
    })
    const change = settingsUpdateRequest.parse({ requestId: randomUUID(), expectedRevision: 1, model: 'trial-model', maxTokens: 600 })
    const updated = settings.parse(accepted(await fixture.http('/identity/settings/update', change, { token: alice.agent })))
    expect(updated).toEqual({ model: 'trial-model', maxTokens: 600, revision: 2 })
    const afterSettings = await fixture.snapshot()
    expect(settings.parse(accepted(await fixture.http('/identity/settings/update', change, { token: alice.agent })))).toEqual(updated)
    expect(await fixture.snapshot()).toEqual(afterSettings)
    expect((await fixture.pool.query<{ settings: unknown }>('SELECT settings FROM pe_users WHERE id=$1', [alice.user.userId])).rows[0]?.settings).toEqual(updated)
    expect(accepted(await fixture.http('/identity/me', {}, { token: bob.agent }))).toEqual({
      userId: bob.user.userId, username: bob.user.username, settings: { model: 'trial-model', maxTokens: 1000, revision: 1 },
    })
    await rejected(fixture, '/identity/settings/update', { ...change, maxTokens: 700 }, 409, 'request_id_conflict', { token: alice.agent })
    await rejected(fixture, '/identity/settings/update', { ...change, requestId: randomUUID() }, 409, 'settings_revision_conflict', { token: alice.agent })
    await rejected(fixture, '/identity/settings/update', { ...change, requestId: randomUUID(), expectedRevision: 2,
      model: 'second-model', maxTokens: 256 }, 403, ACCOUNT_ERROR_CODES.modelNotAuthorized, { token: alice.agent })
    const preference = nativePreferenceWrite.parse({ ns: 'ui-settings', mode: 'replace', value: { enabled: true }, expectedRevision: 1 })
    expect(accepted(await fixture.http('/native/preferences/write', preference, { token: alice.agent }))).toEqual({ value: { enabled: true }, revision: 2 })
    expect(accepted(await fixture.http('/native/preferences/read', { ns: 'ui-settings' }, { token: alice.agent }))).toEqual({ value: { enabled: true }, revision: 2 })
    expect(accepted(await fixture.http('/native/preferences/read', { ns: 'ui-settings' }, { token: bob.agent }))).toEqual({ value: {}, revision: 1 })
    expect((await fixture.pool.query<{ user_id: string; value: unknown; revision: number }>(
      'SELECT user_id,value,revision FROM pe_native_preferences WHERE namespace=$1', ['ui-settings'])).rows).toEqual([
      { user_id: alice.user.userId, value: { enabled: true }, revision: 2 },
    ])
    await rejected(fixture, '/native/preferences/write', preference, 409, 'native_settings_conflict', { token: alice.agent })
    const request = createRequest.parse({ requestId: randomUUID() })
    const created = createdSessionId(accepted(await fixture.http('/sessions/create', request, { token: alice.agent })))
    const beforeRetry = await fixture.snapshot()
    expect(accepted(await fixture.http('/sessions/create', request, { token: alice.agent }))).toEqual({ sessionId: created })
    expect(await fixture.snapshot()).toEqual(beforeRetry)
    const session = (await fixture.pool.query<{
      id: string
      user_id: string
      workspace_id: string
      create_request_id: string
      header: unknown
      event_count: number
    }>('SELECT id,user_id,workspace_id,create_request_id,header,event_count FROM pe_sessions WHERE id=$1', [created])).rows[0]
    assert(session)
    expect(session).toMatchObject({ id: created, user_id: alice.user.userId, create_request_id: request.requestId, event_count: 0 })
    expect(accepted(await fixture.http('/sessions/list', listRequest.parse({ offset: 0, limit: 10 }), { token: alice.agent }))).toMatchObject({
      items: [{ sessionId: created, workspaceId: session.workspace_id, eventCount: 0, title: null }], offset: 0, limit: 10,
    })
    expect(accepted(await fixture.http('/sessions/list', { offset: 0, limit: 10 }, { token: bob.agent }))).toEqual({ items: [], offset: 0, limit: 10 })
    const page = pageRequest.parse({ sessionId: created, after: -1, limit: 10 })
    expect(accepted(await fixture.http('/sessions/page', page, { token: alice.agent }))).toEqual({
      header: session.header, events: [], watermark: -1, operations: [],
    })
    expect(accepted(await fixture.http('/native/sessions/rename', nativeSessionRename.parse({ sessionId: created, title: 'Owned metadata title' }),
      { token: alice.agent }))).toEqual({ title: 'Owned metadata title', seq: 0 })
    const event = (await fixture.pool.query<{ event: unknown }>('SELECT event FROM pe_events WHERE session_id=$1 ORDER BY seq', [created])).rows
    expect(event).toHaveLength(1)
    expect(event[0]?.event).toMatchObject({ seq: 0, type: 'session/title', data: {
      title: 'Owned metadata title', messageSeqs: [], source: { kind: 'user' },
    } })
    expect(accepted(await fixture.http('/sessions/page', page, { token: alice.agent }))).toEqual({
      header: session.header, events: event.map(row => row.event), watermark: 0, operations: [],
    })
    expect((await fixture.pool.query<{ event_count: number }>('SELECT event_count FROM pe_sessions WHERE id=$1', [created])).rows[0]?.event_count).toBe(1)
    expect((await fixture.snapshot()).counts.pe_operations).toBe(0)
  }, context)
  settled(receipt)
})

function createdSessionId(value: unknown): string {
  assert(value !== null && typeof value === 'object' && 'sessionId' in value)
  return sessionId.parse(value.sessionId)
}

test('source account administration returns replay receipts and keeps mutation receipts private to the actor', { timeout: sourceHttpTestTimeout }, async (context) => {
  expect(context.task.timeout).toBe(sourceHttpTestTimeout)
  const receipt = await sourcePlatformHttpFixture(async (fixture) => {
    const { admin, alice, bob } = fixture.actors
    const catalog = accountModelCatalogValue.parse(accepted(await fixture.http(ACCOUNT_ROUTES.models, {}, { token: admin.account })))
    expect(catalog.models).toEqual([{ id: 'trial-model', label: 'Trial', maxTokens: 2000 }, { id: 'second-model', label: 'Second', maxTokens: 512 }])
    const update = accountUpdateRequest.parse({ requestId: randomUUID(), userId: bob.user.userId,
      expectedRevision: bob.user.revision, displayName: 'Owned account metadata' })
    const result = accountMutationValue.parse(accepted(await fixture.http(ACCOUNT_ROUTES.update, update, { token: admin.account })))
    expect(result.replay).toBe(false)
    expect(result.receipt).toMatchObject({ requestId: update.requestId, kind: 'update', account: {
      userId: bob.user.userId, username: bob.user.username, displayName: update.displayName, revision: bob.user.revision + 1, role: 'USER', enabled: true,
    } })
    const pg = (await fixture.pool.query<{ displayName: string; revision: number }>(
      'SELECT display_name AS "displayName",account_revision AS revision FROM pe_users WHERE id=$1', [bob.user.userId])).rows[0]
    expect(pg).toEqual({ displayName: update.displayName, revision: bob.user.revision + 1 })
    const after = await fixture.snapshot()
    expect(accountMutationValue.parse(accepted(await fixture.http(ACCOUNT_ROUTES.update, update, { token: admin.account })))).toEqual({
      receipt: result.receipt, replay: true,
    })
    expect(accountReceiptValue.parse(accepted(await fixture.http(ACCOUNT_ROUTES.receipt,
      accountReceiptRequest.parse({ requestId: update.requestId }), { token: admin.account })))).toEqual({ receipt: result.receipt })
    expect(accountReceiptValue.parse(accepted(await fixture.http(ACCOUNT_ROUTES.receipt,
      { requestId: update.requestId }, { token: alice.account })))).toEqual({ receipt: null })
    expect(await fixture.snapshot()).toEqual(after)
    expect((await fixture.pool.query<{ actor_user_id: string; request_id: string; receipt: unknown }>(
      'SELECT actor_user_id,request_id,receipt FROM pe_account_mutations')).rows).toEqual([
      { actor_user_id: admin.user.userId, request_id: update.requestId, receipt: result.receipt },
    ])
    const current = accountMeValue.parse(accepted(await fixture.http(ACCOUNT_ROUTES.me, {}, { token: bob.account })))
    expect(current.user).toEqual(result.receipt.account)
    await rejected(fixture, ACCOUNT_ROUTES.update, { ...update, requestId: randomUUID(), expectedRevision: bob.user.revision + 1 },
      403, ACCOUNT_ERROR_CODES.forbidden, { token: alice.account })
    await rejected(fixture, ACCOUNT_ROUTES.update, { ...update, displayName: 'Conflicting metadata' },
      409, ACCOUNT_ERROR_CODES.requestConflict, { token: admin.account })
    await rejected(fixture, ACCOUNT_ROUTES.update, { ...update, requestId: randomUUID() },
      409, ACCOUNT_ERROR_CODES.revisionConflict, { token: admin.account })
  }, context)
  settled(receipt)
})

test('source HTTP rejects missing or wrong-audience credentials, other-account Sessions and malformed metadata without durable mutation', { timeout: sourceHttpTestTimeout }, async (context) => {
  expect(context.task.timeout).toBe(sourceHttpTestTimeout)
  const receipt = await sourcePlatformHttpFixture(async (fixture) => {
    const { admin, alice, bob } = fixture.actors
    const created = createdSessionId(accepted(await fixture.http('/sessions/create', createRequest.parse({ requestId: randomUUID() }), { token: alice.agent })))
    const page = pageRequest.parse({ sessionId: created, after: -1, limit: 10 })
    await rejected(fixture, '/sessions/create', { requestId: randomUUID() }, 401, 'unauthorized', {})
    await rejected(fixture, '/sessions/list', { offset: 0, limit: 10 }, 401, 'unauthorized', { token: randomBytes(32).toString('base64url') })
    await rejected(fixture, '/identity/me', {}, 401, 'unauthorized', { token: alice.account })
    await rejected(fixture, ACCOUNT_ROUTES.me, {}, 401, ACCOUNT_ERROR_CODES.unauthorized, { token: alice.agent })
    await rejected(fixture, ACCOUNT_ROUTES.me, {}, 403, 'invalid_origin', { token: alice.account, origin: null })
    await rejected(fixture, ACCOUNT_ROUTES.me, {}, 403, 'invalid_origin', { token: alice.account, origin: 'http://127.0.0.1:9' })
    await rejected(fixture, '/sessions/page', page, 404, 'session_not_found', { token: bob.agent })
    await rejected(fixture, '/native/sessions/rename', { sessionId: created, title: 'Other account title' },
      404, 'session_not_found', { token: bob.agent })
    await rejected(fixture, '/sessions/create', { requestId: randomUUID() }, 400, 'invalid_json', { token: alice.agent, rawBody: '{' })
    await rejected(fixture, '/sessions/create', { requestId: 'invalid' }, 400, 'invalid_request', { token: alice.agent })
    await rejected(fixture, '/sessions/list', { offset: -1, limit: 10 }, 400, 'invalid_request', { token: alice.agent })
    await rejected(fixture, '/sessions/page', { ...page, after: -2 }, 400, 'invalid_request', { token: alice.agent })
    await rejected(fixture, '/native/sessions/rename', { sessionId: created, title: '' }, 400, 'invalid_request', { token: alice.agent })
    await rejected(fixture, '/identity/settings/update', { requestId: randomUUID(), expectedRevision: 1,
      model: 'trial-model', maxTokens: 600, userId: bob.user.userId }, 400, 'invalid_request', { token: alice.agent })
    await rejected(fixture, '/native/preferences/write', { ns: 'ui-settings', mode: 'replace', value: { enabled: 'true' }, expectedRevision: 1 },
      400, 'invalid_request', { token: alice.agent })
    await rejected(fixture, ACCOUNT_ROUTES.update, { requestId: randomUUID(), userId: bob.user.userId,
      expectedRevision: 1, displayName: 'Invalid metadata', inventedField: true }, 400, 'invalid_request', { token: admin.account })
    const beforeLogout = await fixture.snapshot()
    expect(accepted(await fixture.http(ACCOUNT_ROUTES.logout, {}, { token: alice.account }))).toEqual({ ok: true })
    const afterLogout = await fixture.snapshot()
    expect(afterLogout.publicRows).toEqual(beforeLogout.publicRows)
    expect(afterLogout.counts).toEqual({ ...beforeLogout.counts, pe_credentials: (beforeLogout.counts.pe_credentials ?? 0) - 1 })
    await rejected(fixture, ACCOUNT_ROUTES.me, {}, 401, ACCOUNT_ERROR_CODES.unauthorized, { token: alice.account })
    expect(accepted(await fixture.http('/identity/me', {}, { token: alice.agent }))).toEqual({
      userId: alice.user.userId, username: alice.user.username, settings: { model: 'trial-model', maxTokens: 1000, revision: 1 },
    })
    const session = (await fixture.pool.query<{ user_id: string; event_count: number }>(
      'SELECT user_id,event_count FROM pe_sessions WHERE id=$1', [created])).rows[0]
    expect(session).toEqual({ user_id: alice.user.userId, event_count: 0 })
    expect(accepted(await fixture.http('/sessions/list', { offset: 0, limit: 10 }, { token: bob.agent }))).toEqual({ items: [], offset: 0, limit: 10 })
  }, context)
  settled(receipt)
})

function binaryJson(reply: SourceHttpBinaryReply): unknown {
  const value: unknown = JSON.parse(reply.bytes.toString('utf8'))
  return value
}

async function durableFiles(fixture: SourceHttpFixture) {
  const publicState = await fixture.snapshot()
  const storage = await fixture.storageSnapshot()
  const receipts = (await fixture.pool.query<{
    id: string
    user_id: string
    session_id: string
    storage_session_id: string
    request_id: string | null
    file: unknown
  }>(
    'SELECT id,user_id,session_id,storage_session_id,request_id,file FROM pe_native_file_receipts ORDER BY id')).rows
  return { publicState, storage, receipts }
}

async function rejectedBinary(fixture: SourceHttpFixture, path: string, bytes: Uint8Array | undefined,
  status: number, error: string, options: SourceHttpBinaryOptions): Promise<void> {
  const before = await durableFiles(fixture)
  const reply = await fixture.binaryHttp(path, bytes, options)
  expect(reply.status).toBe(status)
  expect(binaryJson(reply)).toEqual({ error })
  expect(reply.headers['content-disposition']).toBeUndefined()
  expect(await durableFiles(fixture)).toEqual(before)
}

test('source Profile downloads exact owned bytes and refuses missing, wrong-audience and foreign-owner credentials without mutation',
  { timeout: sourceHttpTestTimeout }, async (context) => {
    expect(context.task.timeout).toBe(sourceHttpTestTimeout)
    const receipt = await sourcePlatformHttpFixture(async (fixture) => {
      const { alice, bob } = fixture.actors
      const created = createdSessionId(accepted(await fixture.http('/sessions/create',
        createRequest.parse({ requestId: randomUUID() }), { token: alice.agent })))
      const name = 'owned-download.bin', bytes = Buffer.from([0x50, 0x00, 0xff, 0x7f, 0xc3, 0xa9, 0x0a])
      const sha256 = createHash('sha256').update(bytes).digest('hex')
      expect(accepted(await fixture.http('/files/session/put', { sessionId: created,
        requestId: randomUUID(), path: name, data: bytes.toString('base64') }, { token: alice.agent })))
        .toMatchObject({ path: name, size: bytes.length, revision: sha256 })
      const prepared = fileDownloadView.parse(accepted(await fixture.http('/files/download/prepare',
        { sessionId: created, paths: [name] }, { token: alice.agent })))
      expect(prepared).toMatchObject({ sessionId: created, fileName: name, fileCount: 1,
        contentType: 'application/octet-stream', sourceBytes: bytes.length, totalBytes: bytes.length })
      const path = prepared.downloadUrl.replace(FILE_DOWNLOAD_CONTENT_PATH, FILE_DOWNLOAD_PLATFORM_PATH)
      const before = await durableFiles(fixture)
      const downloaded = await fixture.binaryHttp(path, undefined, { method: 'GET', token: alice.agent })
      expect(downloaded.status).toBe(200)
      expect(downloaded.bytes).toEqual(bytes)
      expect(createHash('sha256').update(downloaded.bytes).digest('hex')).toBe(sha256)
      expect(downloaded.headers).toMatchObject({ 'content-type': 'application/octet-stream',
        'content-length': String(bytes.length), 'cache-control': 'no-store', 'x-content-type-options': 'nosniff',
        'content-disposition': "attachment; filename*=UTF-8''owned-download.bin" })
      expect(await durableFiles(fixture)).toEqual(before)
      await rejectedBinary(fixture, path, undefined, 401, 'unauthorized', { method: 'GET' })
      await rejectedBinary(fixture, path, undefined, 401, 'unauthorized', { method: 'GET', token: alice.account })
      await rejectedBinary(fixture, path, undefined, 404, 'session_not_found', { method: 'GET', token: bob.agent })
      const duplicate = new URL(path, fixture.url)
      duplicate.searchParams.delete('revision')
      duplicate.searchParams.append('paths', JSON.stringify([name]))
      const invalidJson = new URL(path, fixture.url)
      invalidJson.searchParams.set('paths', '{')
      const emptySelection = new URL(path, fixture.url)
      emptySelection.searchParams.set('paths', '[]')
      const excessive = new URL(path, fixture.url)
      excessive.searchParams.set('paths', 'x'.repeat(FILE_DOWNLOAD_MAX_URL_BYTES))
      for (const [invalidPath, status, error] of [
        [path + '&unexpected=1', 400, 'invalid_request'],
        [duplicate.pathname + duplicate.search, 400, 'invalid_request'],
        [invalidJson.pathname + invalidJson.search, 400, 'invalid_json'],
        [emptySelection.pathname + emptySelection.search, 400, 'invalid_request'],
        [excessive.pathname + excessive.search, 413, 'download_limit'],
      ] as const) {
        await rejectedBinary(fixture, invalidPath, undefined, status, error, { method: 'GET', token: alice.agent })
      }
      expect(await durableFiles(fixture)).toEqual(before)
    }, context)
    settled(receipt)
  })

test('source Profile persists octet upload bytes and an owned receipt while refusing foreign Sessions and invalid carriers without mutation',
  { timeout: sourceHttpTestTimeout }, async (context) => {
    expect(context.task.timeout).toBe(sourceHttpTestTimeout)
    const receipt = await sourcePlatformHttpFixture(async (fixture) => {
      const { alice, bob } = fixture.actors
      const created = createdSessionId(accepted(await fixture.http('/sessions/create',
        createRequest.parse({ requestId: randomUUID() }), { token: alice.agent })))
      const name = 'owned-upload.bin', bytes = Buffer.from([0x00, 0xff, 0xfe, 0x41, 0x0a, 0x80])
      const sha256 = createHash('sha256').update(bytes).digest('hex')
      const path = '/native/attachments/upload?' + new URLSearchParams({ sessionId: created, name }).toString()
      const before = await durableFiles(fixture)
      const reply = await fixture.binaryHttp(path, bytes, { method: 'POST', token: alice.agent })
      expect(reply.status).toBe(200)
      const uploaded = z.object({ receiptId: fileReceiptId, file: nativeFileAttachment }).strict().parse(binaryJson(reply))
      expect(uploaded.file).toEqual({ attachmentId: 'sha256:' + sha256, name, bytes: bytes.length })
      const expected = { id: uploaded.receiptId, user_id: alice.user.userId, session_id: created,
        storage_session_id: created, request_id: null, file: uploaded.file }
      const after = await durableFiles(fixture)
      expect(after.receipts).toEqual([...before.receipts, expected].sort((left, right) => left.id.localeCompare(right.id)))
      expect(after.publicState.publicRows).toEqual(before.publicState.publicRows)
      expect(after.publicState.counts).toEqual({ ...before.publicState.counts,
        pe_native_file_receipts: (before.publicState.counts.pe_native_file_receipts ?? 0) + 1 })
      const stored = storedFilePath(join(fixture.attachmentRoot, alice.user.userId, created), uploaded.file)
      expect(await readFile(stored)).toEqual(bytes)
      expect(createHash('sha256').update(await readFile(stored)).digest('hex')).toBe(sha256)
      await rejectedBinary(fixture, path, bytes, 404, 'session_not_found', { method: 'POST', token: bob.agent })
      await rejectedBinary(fixture, path, undefined, 405, 'method_not_allowed', { method: 'GET', token: alice.agent })
      await rejectedBinary(fixture, path, bytes, 415, 'invalid_content_type',
        { method: 'POST', token: alice.agent, contentType: 'application/json' })
      await rejectedBinary(fixture, path, bytes, 401, 'unauthorized', { method: 'POST' })
      await rejectedBinary(fixture, path, bytes, 401, 'unauthorized', { method: 'POST', token: alice.account })
      await rejectedBinary(fixture, '/native/attachments/upload?sessionId=invalid', bytes,
        400, 'invalid_request', { method: 'POST', token: alice.agent })
      await rejectedBinary(fixture, '/native/attachments/upload?' + new URLSearchParams({ sessionId: created,
        name: 'x'.repeat(4097) }).toString(), bytes, 400, 'invalid_request', { method: 'POST', token: alice.agent })
      expect(await durableFiles(fixture)).toEqual(after)
      expect(await readFile(stored)).toEqual(bytes)
    }, context)
    settled(receipt)
  })
