/** Real PG native image permissions from actual SDK acceptance, exact source prompts and owned fork prefixes. */
import { randomUUID } from 'node:crypto'
import { join } from 'node:path'
import type { ImageAttachmentRef } from '@deepseek-ai/dsh-attachment'
import { readImageFile } from '@deepseek-ai/dsh-attachment-local'
import { MessageId } from '@deepseek-ai/dsh-llm'
import { Session } from '@deepseek-ai/dsh-session'
import { expect, test } from 'vitest'
import { requestId } from '../src/contracts.ts'
import { admittedNativeContent } from '../src/native-attachment-contracts.ts'
import { nativeInputRecordDigest } from '../src/native-input-ledger-records.ts'
import { headerSchema } from '../src/session-records.ts'
import { seedNewUser } from '../src/platform/account-settings.ts'
import { CURRENT_SCHEMA_VERSION, transaction } from '../src/platform/database.ts'
import { EventStore } from '../src/platform/events.ts'
import { hashPassword } from '../src/platform/identity.ts'
import { LegacyMigrationImageReader } from '../src/platform/legacy-migration-v2-image-reader.ts'
import { readNativeBrowserImageResponse, readNativeImageResponse } from '../src/platform/native-image-route.ts'
import { NativeImageReader } from '../src/platform/native-images.ts'
import { NativeSessionCommands } from '../src/platform/native-session-commands.ts'
import { TaskStore } from '../src/platform/tasks.ts'
import { cloudFixture } from './cloud-fixture.ts'
import { retainedNativeFacts } from './native-retained-intent-fixture.ts'

type Fixture = Parameters<Parameters<typeof cloudFixture>[0]>[0]
const bounds = { maxEventBytes: 524_288, maxHistoryBytes: 8_388_608, maxHistoryEvents: 1000,
  leaseMs: 60_000, maxPendingPerUser: 8, maxActivePerUser: 2 }
const commandBounds = { ...bounds, titleMaxBytes: 256, searchDeadlineMs: 5000, searchMaxSessions: 64,
  searchMaxEvents: 1000, searchMaxBytes: 8_388_608, searchResultLimit: 20, searchSnippetChars: 100 }
const sdk = { maxImageBytes: 65_536, maxImagesPerMessage: 4, maxMessageImageBytes: 262_144,
  maxImagePixels: 4096, maxImageDimension: 64, normalizedImageMaxPixels: 4096,
  normalizedImageMaxDimension: 64, normalizedImageMaxBytes: 65_536, imageCompressionConcurrency: 1 }
const pngs = [
  'iVBORw0KGgoAAAANSUhEUgAAAAIAAAABCAIAAAB7QOjdAAAACXBIWXMAAAPoAAAD6AG1e1JrAAAAD0lEQVQImWPgYmLmYmIGAAB+AB9eAzL0AAAAAElFTkSuQmCC',
  'iVBORw0KGgoAAAANSUhEUgAAAAEAAAACCAIAAAAW4yFwAAAACXBIWXMAAAPoAAAD6AG1e1JrAAAAEElEQVQImWM4wcTMcIKJGQAH+gGbkyl0lgAAAABJRU5ErkJggg==',
]
const signal = () => new AbortController().signal

function first<T>(rows: readonly T[]): T {
  const row = rows[0]
  if (row === undefined) throw new Error('Actual native image fixture returned no row')
  return row
}

function png(index: number) {
  return { type: 'image' as const, mediaType: 'image/png' as const, data: first(pngs.slice(index)), name: `image-${index}.png` }
}

function image(content: ReturnType<typeof admittedNativeContent.parse>): ImageAttachmentRef {
  const part = content.find(item => item.type === 'image')
  if (!part || part.type !== 'image') throw new Error('Actual SDK intake returned no image')
  return part.attachment
}

async function prepare(f: Fixture, maxLedgerBytes = 65_536) {
  const schema = (await f.pool.query<{ family: string; version: number }>('SELECT family,version FROM pe_schema')).rows
  expect(schema).toEqual([{ family: 'cloud-native', version: CURRENT_SCHEMA_VERSION }])
  const username = `image-owner-${randomUUID()}`, password = randomUUID()
  await seedNewUser(f.pool, username, await hashPassword(password), { model: 'deepseek-flash', maxTokens: 1000, revision: 1 })
  const actor = await f.identities.login(username, password)
  const root = join(f.root, 'native-originals')
  const limits = { root, maxImageBytes: sdk.maxImageBytes, maxImagePixels: sdk.maxImagePixels, maxLedgerBytes }
  const tasks = new TaskStore(f.pool, { ...bounds, nativeImageAdmission: {
    storage: { root, maxFilesPerSession: 8, maxFilesPerUser: 16, maxBytesPerUser: 1_048_576 }, sdk, maxLedgerBytes,
  } })
  const created = await tasks.create(actor.user, requestId.parse(randomUUID()), actor.token)
  const ledger = async (sessionId = created.sessionId) => (await f.pool.query<{ value: unknown; revision: number }>(
    'SELECT value,revision FROM pe_native_preferences WHERE user_id=$1 AND namespace=$2',
    [actor.user.userId, `native-images:${sessionId}`])).rows
  const admitted = async (id: ReturnType<typeof requestId.parse>, sessionId = created.sessionId) => admittedNativeContent.parse(
    first((await f.pool.query<{ admitted: unknown }>(
      'SELECT admitted FROM pe_native_prompt_inputs WHERE session_id=$1 AND request_id=$2', [sessionId, id])).rows).admitted)
  return { tasks, actor, root, limits, created, ledger, admitted }
}

test('actual image accept saves only exact SDK bindings and reconstructed reads preserve mixed order and unchanged bytes', () => cloudFixture(async (f) => {
  const n = await prepare(f), id = requestId.parse(randomUUID())
  const content = [{ type: 'text' as const, text: 'first' }, png(0), { type: 'text' as const, text: 'middle' }, png(1),
    { type: 'text' as const, text: 'last' }]
  const text = 'first\nmiddle\nlast'
  const accepted = await n.tasks.accept(n.actor.user, n.created.sessionId, id, text, n.actor.token, { kind: 'cloud' }, content)
  const original = await n.admitted(id), before = await n.ledger()
  expect(original.map(part => part.type)).toEqual(['text', 'image', 'text', 'image', 'text'])
  expect(original.filter(part => part.type === 'text').map(part => part.text)).toEqual(['first', 'middle', 'last'])
  const refs = original.flatMap(part => part.type === 'image' ? [part.attachment] : [])
  expect(first(before).value).toEqual({ version: 1, userId: n.actor.user.userId, sessionId: n.created.sessionId,
    bindings: refs.map(ref => ({ image: ref, storageSessionId: n.created.sessionId, sourceRequestId: id,
      acceptedContentDigest: nativeInputRecordDigest(original) })) })
  expect(JSON.stringify(first(before).value)).not.toContain(png(0).data)
  expect(JSON.stringify(first(before).value)).not.toContain('verified-history-migration')
  expect(await n.tasks.accept(n.actor.user, n.created.sessionId, id, text, n.actor.token,
    { kind: 'cloud' }, content)).toEqual(accepted)
  expect(await n.ledger()).toEqual(before)
  await expect(n.tasks.accept(n.actor.user, n.created.sessionId, id, text, n.actor.token,
    { kind: 'cloud' }, [{ ...png(0), name: 'changed-name.png' }]))
    .rejects.toMatchObject({ status: 409, code: 'request_id_conflict' })
  expect(await n.ledger()).toEqual(before)
  const grant = await n.tasks.claim(randomUUID())
  if (!grant) throw new Error('Actual image-bearing operation was not claimed')
  const restored = await transaction(f.pool, client =>
    n.tasks.restoreGrantInTransaction(client, grant.operationId, grant.token, grant.epoch))
  expect(restored.nativeContent).toEqual(original)
  const reader = new NativeImageReader(f.pool, n.tasks, n.limits)
  for (const ref of refs) {
    const expected = await readImageFile(join(n.root, n.actor.user.userId, n.created.sessionId, 'attachments', 'v1'), ref)
    const stored = await reader.read(grant.token, ref, signal())
    expect(stored.ref).toEqual(ref)
    expect(Buffer.from(stored.data)).toEqual(Buffer.from(expected.data))
    const reconstructed = new NativeImageReader(f.pool, n.tasks, n.limits)
    expect(await readNativeImageResponse(reconstructed, grant.token, { image: ref }, signal()))
      .toEqual({ image: ref, data: Buffer.from(expected.data).toString('base64') })
  }
}))

test('exact ref and Session boundaries refuse reads and corrupt native sources never fall back to migration permissions', () => cloudFixture(async (f) => {
  const n = await prepare(f), id = requestId.parse(randomUUID())
  await n.tasks.accept(n.actor.user, n.created.sessionId, id, 'original source', n.actor.token, { kind: 'cloud' },
    [{ type: 'text', text: 'original source' }, png(0)])
  const ref = image(await n.admitted(id)), grant = await n.tasks.claim(randomUUID())
  if (!grant) throw new Error('Actual image scope was not claimed')
  const reader = new NativeImageReader(f.pool, n.tasks, n.limits)
  await expect(reader.read(grant.token, { ...ref, width: ref.width + 1 }, signal()))
    .rejects.toMatchObject({ status: 404, code: 'native_image_not_found' })
  const other = await n.tasks.create(n.actor.user, requestId.parse(randomUUID()), n.actor.token)
  await n.tasks.accept(n.actor.user, other.sessionId, requestId.parse(randomUUID()), 'other Session', n.actor.token)
  const otherGrant = await n.tasks.claim(randomUUID())
  if (!otherGrant) throw new Error('Actual unrelated Session was not claimed')
  expect(otherGrant.sessionId).toBe(other.sessionId)
  await expect(reader.read(otherGrant.token, ref, signal())).rejects.toMatchObject({ status: 404, code: 'native_image_not_found' })
  let fallbacks = 0
  const legacy = new LegacyMigrationImageReader(f.pool, n.tasks, n.limits)
  const composed = new NativeImageReader(f.pool, n.tasks, n.limits, { read: async (bearer, imageRef, abort) => {
    fallbacks++; return legacy.read(bearer, imageRef, abort)
  } })
  await expect(composed.read(grant.token, { ...ref, name: 'unadmitted-name.png' }, signal()))
    .rejects.toMatchObject({ status: 404, code: 'legacy_image_not_found' })
  expect(fallbacks).toBe(1)
  await f.pool.query('UPDATE pe_native_prompt_inputs SET admitted=jsonb_set(admitted,\'{0,text}\',to_jsonb(\'changed full source\'::text)) WHERE session_id=$1 AND request_id=$2',
    [n.created.sessionId, id])
  await expect(composed.read(grant.token, ref, signal())).rejects.toMatchObject({ status: 503, code: 'native_image_origin_changed' })
  expect(fallbacks).toBe(1)
  await f.pool.query('UPDATE pe_native_preferences SET value=jsonb_build_object(\'oversized\',$3::text) WHERE user_id=$1 AND namespace=$2',
    [n.actor.user.userId, `native-images:${n.created.sessionId}`, 'x'.repeat(n.limits.maxLedgerBytes + 1)])
  await expect(composed.read(grant.token, ref, signal())).rejects.toMatchObject({ status: 413, code: 'native_image_ledger_limit' })
  expect(fallbacks).toBe(1)
}))

test('actual fork prefix inherits only its exact images and preserves the original prompt and storage identities', () => cloudFixture(async (f) => {
  const n = await prepare(f), events = new EventStore(n.tasks, bounds), commands = new NativeSessionCommands(f.pool, commandBounds)
  const header = headerSchema.parse(first((await f.pool.query<{ header: unknown }>(
    'SELECT header FROM pe_sessions WHERE id=$1', [n.created.sessionId])).rows).header)
  const native = Session.create(header.id, undefined, header), ids = [requestId.parse(randomUUID()), requestId.parse(randomUUID())]
  const refs: ImageAttachmentRef[] = []
  let firstEnd = 0
  for (const [index, id] of ids.entries()) {
    await n.tasks.accept(n.actor.user, n.created.sessionId, id, `turn ${index + 1}`, n.actor.token, { kind: 'cloud' },
      [{ type: 'text', text: `turn ${index + 1}` }, png(index)])
    const content = await n.admitted(id), grant = await n.tasks.claim(randomUUID())
    if (!grant) throw new Error('Actual parent image turn was not claimed')
    refs.push(image(content))
    const begin = native.snapshotEvents().length
    native.append('turn/start', { turn: index + 1 })
    native.append('user/message', { id: MessageId(id), role: 'user', source: { kind: 'user' }, content }, { surfaceOp: 'append' })
    const end = native.append('turn/end', { turn: index + 1, reason: { kind: 'completed' } })
    await events.append(grant.token, native.snapshotEvents().slice(begin))
    await n.tasks.finish(grant.token, 'completed', null)
    if (index === 0) firstEnd = end.seq
  }
  const child = await commands.fork(n.actor.user, n.actor.token,
    { sessionId: n.created.sessionId, atSeq: firstEnd }, requestId.parse(randomUUID()))
  const ref = first(refs), later = first(refs.slice(1))
  expect(first(await n.ledger(child.sessionId)).value).toEqual({ version: 1, userId: n.actor.user.userId, sessionId: child.sessionId,
    bindings: [{ image: ref, storageSessionId: n.created.sessionId, sourceRequestId: first(ids),
      acceptedContentDigest: nativeInputRecordDigest(await n.admitted(first(ids))) }] })
  await n.tasks.accept(n.actor.user, child.sessionId, requestId.parse(randomUUID()), 'read inherited image', n.actor.token)
  const grant = await n.tasks.claim(randomUUID())
  if (!grant) throw new Error('Actual inherited-image child was not claimed')
  expect(grant.sessionId).toBe(child.sessionId)
  const reader = new NativeImageReader(f.pool, n.tasks, n.limits)
  const expected = await readImageFile(join(n.root, n.actor.user.userId, n.created.sessionId, 'attachments', 'v1'), ref)
  expect(Buffer.from((await reader.read(grant.token, ref, signal())).data)).toEqual(Buffer.from(expected.data))
  await expect(reader.read(grant.token, later, signal())).rejects.toMatchObject({ status: 404, code: 'native_image_not_found' })
  await f.pool.query('UPDATE pe_native_preferences SET value=jsonb_set(value,\'{bindings,0,storageSessionId}\',to_jsonb($3::text)) WHERE user_id=$1 AND namespace=$2',
    [n.actor.user.userId, `native-images:${child.sessionId}`, child.sessionId])
  await expect(reader.read(grant.token, ref, signal())).rejects.toMatchObject({ status: 503, code: 'native_image_origin_missing' })
}))

test('actual acceptance rolls back its operation and original prompt when the native image ledger budget is exhausted', () => cloudFixture(async (f) => {
  const n = await prepare(f, 1)
  await expect(n.tasks.accept(n.actor.user, n.created.sessionId, requestId.parse(randomUUID()), 'bounded PNG', n.actor.token,
    { kind: 'cloud' }, [{ type: 'text', text: 'bounded PNG' }, png(0)]))
    .rejects.toMatchObject({ status: 413, code: 'native_image_content_limit' })
  expect((await f.pool.query('SELECT id FROM pe_operations WHERE session_id=$1', [n.created.sessionId])).rows).toEqual([])
  expect((await f.pool.query('SELECT request_id FROM pe_native_prompt_inputs WHERE session_id=$1', [n.created.sessionId])).rows).toEqual([])
  expect(await n.ledger()).toEqual([])
}))

test('cold browser previews require owned canonical images and keep exact fork prefixes without creating operation grants', () =>
  cloudFixture(async (f) => {
    const n = await prepare(f), events = new EventStore(n.tasks, bounds)
    const legacy = new LegacyMigrationImageReader(f.pool, n.tasks, n.limits)
    const reader = () => new NativeImageReader(f.pool, n.tasks, n.limits, legacy, bounds)
    const header = headerSchema.parse(first((await f.pool.query<{ header: unknown }>(
      'SELECT header FROM pe_sessions WHERE id=$1', [n.created.sessionId])).rows).header)
    const native = Session.create(header.id, undefined, header)
    const refs: ImageAttachmentRef[] = [], ids = [requestId.parse(randomUUID()), requestId.parse(randomUUID())]
    let firstEnd = 0
    for (const [index, id] of ids.entries()) {
      const originals = index === 0 ? [png(index), { ...png(index), name: 'same-pixels-different-name.png' }]
        : [png(index), { ...png(0), name: 'parent-only-later-name.png' }]
      await n.tasks.accept(n.actor.user, n.created.sessionId, id, `preview ${index + 1}`, n.actor.token,
        { kind: 'cloud' }, [{ type: 'text', text: `preview ${index + 1}` }, ...originals])
      const content = await n.admitted(id), ref = image(content)
      if (index === 0) {
        const images = content.flatMap(part => part.type === 'image' ? [part.attachment] : [])
        expect(images).toHaveLength(2)
        expect(images.map(item => item.attachmentId)).toEqual([ref.attachmentId, ref.attachmentId])
        expect(images.map(item => item.name)).toEqual(['image-0.png', 'same-pixels-different-name.png'])
      }
      refs.push(ref)
      await expect(reader().readBrowser(n.actor.token, n.created.sessionId, ref.attachmentId, signal()))
        .rejects.toMatchObject({ status: 404, code: 'native_image_not_referenced' })
      const grant = await n.tasks.claim(randomUUID())
      if (!grant) throw new Error('Actual canonical preview turn was not claimed')
      const begin = native.snapshotEvents().length
      if (index === 0) native.append('session/end-seed', {})
      native.append('turn/start', { turn: index + 1 })
      native.append('agent/inbox/spliced', { target: 'next-step', start: 0,
        inserted: [{ id: MessageId(id), role: 'user', source: { kind: 'user' }, content }] })
      if (index === 0) {
        for (let title = 0; title < 9; title++) {
          native.append('session/title', { title: `Owned image history ${title}`, messageSeqs: [], source: { kind: 'user' } })
        }
      }
      const end = native.append('turn/end', { turn: index + 1, reason: { kind: 'completed' } })
      await events.append(grant.token, native.snapshotEvents().slice(begin))
      await n.tasks.finish(grant.token, 'completed', null)
      if (index === 0) firstEnd = end.seq
      expect(end.seq).toBe(index === 0 ? 12 : 15)
      const expected = await readImageFile(join(n.root, n.actor.user.userId, n.created.sessionId, 'attachments', 'v1'), ref)
      expect(await readNativeBrowserImageResponse(reader(), n.actor.token,
        { sessionId: n.created.sessionId, attachmentId: ref.attachmentId }, signal()))
        .toEqual({ attachment: ref, data: Buffer.from(expected.data).toString('base64') })
      await expect(reader().readBrowser(grant.token, n.created.sessionId, ref.attachmentId, signal()))
        .rejects.toMatchObject({ status: 401, code: 'account_unauthorized' })
    }
    const types = (await f.pool.query<{ type: string }>(
      "SELECT event->>'type' AS type FROM pe_events WHERE session_id=$1 ORDER BY seq", [n.created.sessionId])).rows
    expect(types.map(row => row.type)).not.toContain('user/message')
    expect(types.filter(row => row.type === 'agent/inbox/spliced')).toHaveLength(2)
    expect(types).toHaveLength(16)
    const ref = first(refs), later = first(refs.slice(1))
    const commands = new NativeSessionCommands(f.pool, commandBounds)
    const child = await commands.fork(n.actor.user, n.actor.token,
      { sessionId: n.created.sessionId, atSeq: firstEnd }, requestId.parse(randomUUID()))
    const inherited = await n.admitted(first(ids))
    expect(first(await n.ledger(child.sessionId)).value).toEqual({ version: 1, userId: n.actor.user.userId,
      sessionId: child.sessionId, bindings: inherited.flatMap(part => part.type === 'image' ? [{ image: part.attachment,
        storageSessionId: n.created.sessionId, sourceRequestId: first(ids),
        acceptedContentDigest: nativeInputRecordDigest(inherited) }] : []) })
    const before = (await f.pool.query('SELECT * FROM pe_operations ORDER BY id')).rows
    expect((await f.pool.query('SELECT id FROM pe_operations WHERE session_id=$1', [child.sessionId])).rows).toEqual([])
    const expected = await readImageFile(join(n.root, n.actor.user.userId, n.created.sessionId, 'attachments', 'v1'), ref)
    const reconstructed = reader()
    expect(await readNativeBrowserImageResponse(reconstructed, n.actor.token,
      { sessionId: child.sessionId, attachmentId: ref.attachmentId }, signal()))
      .toEqual({ attachment: ref, data: Buffer.from(expected.data).toString('base64') })
    await expect(reconstructed.readBrowser(n.actor.token, child.sessionId, later.attachmentId, signal()))
      .rejects.toMatchObject({ status: 404, code: 'native_image_not_referenced' })
    await expect(reconstructed.readBrowser(f.bob.token, child.sessionId, ref.attachmentId, signal()))
      .rejects.toMatchObject({ status: 404, code: 'session_not_found' })
    await expect(new NativeImageReader(f.pool, n.tasks, n.limits, legacy, { ...bounds, maxHistoryEvents: 1 })
      .readBrowser(n.actor.token, child.sessionId, ref.attachmentId, signal()))
      .rejects.toMatchObject({ status: 413, code: 'native_image_history_limit' })
    await expect(new NativeImageReader(f.pool, n.tasks, n.limits, legacy, { ...bounds, maxHistoryBytes: 1 })
      .readBrowser(n.actor.token, child.sessionId, ref.attachmentId, signal()))
      .rejects.toMatchObject({ status: 413, code: 'native_image_history_limit' })
    const stopped = new AbortController(); stopped.abort()
    await expect(reconstructed.readBrowser(n.actor.token, child.sessionId, ref.attachmentId, stopped.signal)).rejects.toThrow()
    expect((await f.pool.query('SELECT * FROM pe_operations ORDER BY id')).rows).toEqual(before)
    expect((await f.pool.query('SELECT id FROM pe_operations WHERE session_id=$1', [child.sessionId])).rows).toEqual([])
    await f.pool.query(`UPDATE pe_native_prompt_inputs SET admitted=jsonb_set(admitted,'{0,text}',to_jsonb('changed origin'::text))
      WHERE session_id=$1 AND request_id=$2`, [n.created.sessionId, first(ids)])
    await expect(reconstructed.readBrowser(n.actor.token, child.sessionId, ref.attachmentId, signal()))
      .rejects.toMatchObject({ status: 503, code: 'native_image_origin_changed' })
  }))

test('browser preview preserves ownership errors and maps SDK metadata corruption without changing native facts', () => cloudFixture(async (f) => {
  const n = await prepare(f), id = requestId.parse(randomUUID()), events = new EventStore(n.tasks, bounds)
  await n.tasks.accept(n.actor.user, n.created.sessionId, id, 'preview original', n.actor.token, { kind: 'cloud' },
    [{ type: 'text', text: 'preview original' }, png(0)])
  const content = await n.admitted(id), ref = image(content), grant = await n.tasks.claim(randomUUID())
  if (!grant) throw new Error('Expected the actual browser preview grant')
  const header = headerSchema.parse(first((await f.pool.query<{ header: unknown }>(
    'SELECT header FROM pe_sessions WHERE id=$1', [n.created.sessionId])).rows).header)
  const native = Session.create(header.id, undefined, header)
  native.append('turn/start', { turn: 1 })
  const message = { id: MessageId(id), role: 'user' as const, source: { kind: 'user' as const }, content }
  const inserted = native.append('agent/inbox/spliced', { target: 'next-step', start: 0, inserted: [message] })
  native.append('turn/end', { turn: 1, reason: { kind: 'completed' } })
  await events.append(grant.token, native.snapshotEvents())
  await n.tasks.finish(grant.token, 'completed', null)
  const reader = new NativeImageReader(f.pool, n.tasks, n.limits, undefined, bounds)
  const request = { sessionId: n.created.sessionId, attachmentId: ref.attachmentId }
  const original = await readImageFile(join(n.root, n.actor.user.userId, n.created.sessionId, 'attachments', 'v1'), ref)
  expect(await readNativeBrowserImageResponse(reader, n.actor.token, request, signal()))
    .toEqual({ attachment: ref, data: Buffer.from(original.data).toString('base64') })
  const owned = await retainedNativeFacts(f.pool)
  await expect(readNativeBrowserImageResponse(reader, f.bob.token, request, signal()))
    .rejects.toMatchObject({ status: 404, code: 'session_not_found' })
  expect(await retainedNativeFacts(f.pool)).toEqual(owned)
  const corrupt = { ...ref, width: ref.width + 1 }
  const damaged = content.map(part => part.type === 'image' ? { ...part, attachment: corrupt } : part)
  await transaction(f.pool, async (client) => {
    await client.query('UPDATE pe_native_prompt_inputs SET admitted=$3 WHERE session_id=$1 AND request_id=$2',
      [n.created.sessionId, id, JSON.stringify(damaged)])
    await client.query('UPDATE pe_native_preferences SET value=$3 WHERE user_id=$1 AND namespace=$2',
      [n.actor.user.userId, `native-images:${n.created.sessionId}`, { version: 1, userId: n.actor.user.userId,
        sessionId: n.created.sessionId, bindings: [{ image: corrupt, storageSessionId: n.created.sessionId,
          sourceRequestId: id, acceptedContentDigest: nativeInputRecordDigest(damaged) }] }])
    await client.query('UPDATE pe_events SET event=$3::json WHERE session_id=$1 AND seq=$2',
      [n.created.sessionId, inserted.seq, JSON.stringify({ ...inserted, data: { ...inserted.data,
        inserted: [{ ...message, content: damaged }] } })])
  })
  const before = await retainedNativeFacts(f.pool), prompt = await n.admitted(id)
  await expect(readNativeBrowserImageResponse(reader, n.actor.token, request, signal()))
    .rejects.toMatchObject({ status: 400, code: 'ATTACHMENT_CORRUPT' })
  expect(await retainedNativeFacts(f.pool)).toEqual(before)
  expect(await n.admitted(id)).toEqual(prompt)
  expect(await readImageFile(join(n.root, n.actor.user.userId, n.created.sessionId, 'attachments', 'v1'), ref)).toEqual(original)
}))
