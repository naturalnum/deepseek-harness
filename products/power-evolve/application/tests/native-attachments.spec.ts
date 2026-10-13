/** Actual PostgreSQL receipts and immutable local file storage; no model or transport fixtures. */
import { createHash, randomUUID } from 'node:crypto'
import { chmod, mkdir, readFile, symlink, writeFile } from 'node:fs/promises'
import { join } from 'node:path'
import { expect, test } from 'vitest'
import { storedFilePath } from '@deepseek-ai/dsh-attachment-local'
import { Session } from '@deepseek-ai/dsh-session'
import { MessageId } from '@deepseek-ai/dsh-llm'
import { promptRequest, requestId } from '../src/contracts.ts'
import { nativeFileAttachment, nativePromptContent } from '../src/native-attachment-contracts.ts'
import { NativeAttachments } from '../src/platform/native-attachments.ts'
import { TaskStore } from '../src/platform/tasks.ts'
import { EventStore } from '../src/platform/events.ts'
import { NativeSessionCommands } from '../src/platform/native-session-commands.ts'
import { headerSchema } from '../src/session-records.ts'
import { cloudFixture } from './cloud-fixture.ts'

const limits = { maxEventBytes: 262144, leaseMs: 60000, maxPendingPerUser: 8, maxActivePerUser: 1 }
async function* bytes(text: string): AsyncGenerator<Uint8Array> {
  const data = Buffer.from(text)
  yield data.subarray(0, 2)
  yield data.subarray(2)
}

test('a durable upload binds its original ordered content once and survives service reconstruction', async () => {
  await cloudFixture(async (f) => {
    const tasks = new TaskStore(f.pool, limits)
    const session = await tasks.create(f.alice.user, requestId.parse(randomUUID()), f.alice.token)
    const config = { root: join(f.root, 'attachments'), maxFilesPerUser: 4096, maxFilesPerSession: 4, maxBytesPerUser: 1024 }
    const uploads = new NativeAttachments(f.pool, tasks, f.files, config); await uploads.init()
    const original = 'first line\n第二行\nthird line\n'
    const uploaded = await uploads.upload(f.alice.user, f.alice.token, session.sessionId, bytes(original),
      '../private\\report?.txt', new AbortController().signal)
    expect(uploaded.file).toEqual({ attachmentId: `sha256:${createHash('sha256').update(original).digest('hex')}`,
      name: 'report_.txt', bytes: Buffer.byteLength(original) })
    expect((await readFile(storedFilePath(join(config.root, f.alice.user.userId, session.sessionId), uploaded.file))).toString())
      .toBe(original)
    const request = requestId.parse(randomUUID())
    const content = nativePromptContent.parse([{ type: 'text', text: 'read this file' }, { type: 'file', receiptId: uploaded.receiptId }])
    expect(promptRequest.safeParse({ sessionId: session.sessionId, requestId: request, text: 'different text',
      nativeContent: content }).success).toBe(false)
    await expect(tasks.accept(f.alice.user, session.sessionId, request, 'different text', f.alice.token,
      { kind: 'cloud' }, content)).rejects.toMatchObject({ code: 'native_input_mismatch' })
    expect((await f.pool.query<{ request_id: string | null }>(
      'SELECT request_id FROM pe_native_file_receipts WHERE id=$1', [uploaded.receiptId])).rows[0]!.request_id).toBeNull()
    const accepted = await tasks.accept(f.alice.user, session.sessionId, request, 'read this file', f.alice.token, { kind: 'cloud' }, content)
    expect(await tasks.accept(f.alice.user, session.sessionId, request, 'read this file', f.alice.token, { kind: 'cloud' }, content)).toEqual(accepted)
    const grant = await tasks.claim(randomUUID()); if (!grant) throw new Error('Expected accepted operation')
    expect(grant.nativeContent).toEqual([{ type: 'text', text: 'read this file' }, { type: 'file', attachment: uploaded.file }])
    expect(grant.attachments).toEqual([uploaded.file])
    const resumed = new NativeAttachments(f.pool, tasks, f.files, config); await resumed.init()
    expect(await resumed.readText(grant.token, uploaded.file, 2, 1)).toEqual({ ...uploaded.file,
      offset: 2, text: '第二行', lines: 1, eof: false })
    expect(await resumed.readText(grant.token, uploaded.file, 3, 200)).toMatchObject({ text: 'third line', lines: 1, eof: true })
    const copied = await resumed.copy(grant.token, uploaded.file, 'original-copy-call', 'copy.txt')
    expect(await resumed.copy(grant.token, uploaded.file, 'original-copy-call', 'copy.txt')).toEqual(copied)
    await expect(resumed.copy(grant.token, uploaded.file, 'original-copy-call', 'changed.txt')).rejects.toMatchObject({ code: 'request_id_conflict' })
    expect(Buffer.from((await f.files.read(f.alice.user, 'copy.txt')).data, 'base64').toString()).toBe(original)
    await f.pool.query("UPDATE pe_operations SET error_code='cancel_requested' WHERE id=$1", [grant.operationId])
    await expect(resumed.copy(grant.token, uploaded.file, 'cancelled-copy', 'cancelled.txt')).rejects.toMatchObject({ code: 'operation_cancelled' })
    await expect(tasks.accept(f.alice.user, session.sessionId, requestId.parse(randomUUID()), 'read this file', f.alice.token,
      { kind: 'cloud' }, content)).rejects.toMatchObject({ code: 'attachment_not_staged' })
    await tasks.finish(grant.token, 'completed', null)
    await expect(resumed.readText(grant.token, uploaded.file, 1, 1)).rejects.toMatchObject({ code: 'lease_lost' })
  })
})

test('an exact-prefix fork retains only inherited file authority and reads the original storage object', async () => {
  await cloudFixture(async (f) => {
    const config = { ...limits, maxHistoryBytes: 67108864, maxHistoryEvents: 10000,
      searchDeadlineMs: 5000, searchMaxSessions: 256, searchMaxEvents: 100000, searchMaxBytes: 67108864,
      titleMaxBytes: 4096, searchResultLimit: 20, searchSnippetChars: 240 }
    const tasks = new TaskStore(f.pool, config), events = new EventStore(tasks, config)
    const commands = new NativeSessionCommands(f.pool, config)
    const source = await tasks.create(f.alice.user, requestId.parse(randomUUID()), f.alice.token)
    const uploads = new NativeAttachments(f.pool, tasks, f.files,
      { root: join(f.root, 'attachments'), maxFilesPerUser: 4096, maxFilesPerSession: 4, maxBytesPerUser: 1024 })
    await uploads.init()
    const first = await uploads.upload(f.alice.user, f.alice.token, source.sessionId, bytes('first inherited'), 'first.txt', new AbortController().signal)
    const second = await uploads.upload(f.alice.user, f.alice.token, source.sessionId, bytes('outside prefix'), 'later.txt', new AbortController().signal)
    const header = headerSchema.parse((await f.pool.query<{ header: unknown }>(
      'SELECT header FROM pe_sessions WHERE id=$1', [source.sessionId])).rows[0]!.header)
    const session = Session.create(header.id, undefined, header)
    for (const [index, uploaded] of [first, second].entries()) {
      const request = requestId.parse(randomUUID())
      await tasks.accept(f.alice.user, source.sessionId, request, '', f.alice.token, { kind: 'cloud' },
        nativePromptContent.parse([{ type: 'file', receiptId: uploaded.receiptId }]))
      const grant = await tasks.claim(randomUUID()); if (!grant) throw new Error('Expected file operation')
      session.append('turn/start', { turn: index + 1 })
      session.append('user/message', { id: MessageId(request), role: 'user', content: [{ type: 'file', attachment: uploaded.file }],
        source: { kind: 'user' } }, { surfaceOp: 'append' })
      session.append('turn/end', { turn: index + 1, reason: { kind: 'completed' } })
      await events.append(grant.token, session.snapshotEvents().slice(index * 3))
      await tasks.finish(grant.token, 'completed', null)
    }
    const child = await commands.fork(f.alice.user, f.alice.token, { sessionId: source.sessionId, atSeq: 2 }, requestId.parse(randomUUID()))
    await tasks.accept(f.alice.user, child.sessionId, requestId.parse(randomUUID()), 'read inherited file', f.alice.token)
    const grant = await tasks.claim(randomUUID()); if (!grant) throw new Error('Expected child operation')
    expect(grant.attachments).toEqual([first.file])
    expect(await uploads.readText(grant.token, first.file, 1, 1)).toMatchObject({ text: 'first inherited' })
    await expect(uploads.readText(grant.token, second.file, 1, 1)).rejects.toMatchObject({ code: 'attachment_not_found' })
    expect((await f.pool.query('SELECT storage_session_id FROM pe_native_file_receipts WHERE session_id=$1', [child.sessionId])).rows)
      .toEqual([{ storage_session_id: source.sessionId }])
  })
})

test('foreign owners and other Sessions cannot upload, bind or read a receiving Session file', async () => {
  await cloudFixture(async (f) => {
    const tasks = new TaskStore(f.pool, limits)
    const first = await tasks.create(f.alice.user, requestId.parse(randomUUID()), f.alice.token)
    const second = await tasks.create(f.alice.user, requestId.parse(randomUUID()), f.alice.token)
    const uploads = new NativeAttachments(f.pool, tasks, f.files, { root: join(f.root, 'attachments'), maxFilesPerUser: 4096, maxFilesPerSession: 4, maxBytesPerUser: 1024 })
    await uploads.init()
    await expect(uploads.upload(f.bob.user, f.bob.token, first.sessionId, bytes('foreign'), 'x.txt', new AbortController().signal))
      .rejects.toMatchObject({ code: 'session_not_found' })
    const file = await uploads.upload(f.alice.user, f.alice.token, first.sessionId, bytes('private'), 'x.txt', new AbortController().signal)
    const content = nativePromptContent.parse([{ type: 'file', receiptId: file.receiptId }])
    await expect(tasks.accept(f.alice.user, second.sessionId, requestId.parse(randomUUID()), '', f.alice.token,
      { kind: 'cloud' }, content)).rejects.toMatchObject({ code: 'attachment_not_staged' })
    await expect(tasks.accept(f.bob.user, first.sessionId, requestId.parse(randomUUID()), '', f.bob.token,
      { kind: 'cloud' }, content)).rejects.toMatchObject({ code: 'session_not_found' })
    await tasks.accept(f.alice.user, second.sessionId, requestId.parse(randomUUID()), 'independent', f.alice.token)
    const grant = await tasks.claim(randomUUID()); if (!grant) throw new Error('Expected independent operation')
    await expect(uploads.readText(grant.token, file.file, 1, 1)).rejects.toMatchObject({ code: 'attachment_not_found' })
    expect((await f.pool.query('SELECT request_id FROM pe_native_file_receipts')).rows).toEqual([{ request_id: null }])
  })
})

test('receipt identity and part ordering participate in prompt retry conflicts', async () => {
  await cloudFixture(async (f) => {
    const tasks = new TaskStore(f.pool, limits)
    const session = await tasks.create(f.alice.user, requestId.parse(randomUUID()), f.alice.token)
    const uploads = new NativeAttachments(f.pool, tasks, f.files, { root: join(f.root, 'attachments'), maxFilesPerUser: 4096, maxFilesPerSession: 4, maxBytesPerUser: 1024 })
    await uploads.init()
    const first = await uploads.upload(f.alice.user, f.alice.token, session.sessionId, bytes('same bytes'), 'x.txt', new AbortController().signal)
    const second = await uploads.upload(f.alice.user, f.alice.token, session.sessionId, bytes('same bytes'), 'x.txt', new AbortController().signal)
    expect(first.file).toEqual(second.file); expect(first.receiptId).not.toBe(second.receiptId)
    const request = requestId.parse(randomUUID())
    const content = nativePromptContent.parse([{ type: 'text', text: 'text' }, { type: 'file', receiptId: first.receiptId }])
    await tasks.accept(f.alice.user, session.sessionId, request, 'text', f.alice.token, { kind: 'cloud' }, content)
    for (const changed of [[content[1], content[0]], [{ type: 'text', text: 'text' }, { type: 'file', receiptId: second.receiptId }]]) {
      await expect(tasks.accept(f.alice.user, session.sessionId, request, 'text', f.alice.token,
        { kind: 'cloud' }, nativePromptContent.parse(changed))).rejects.toMatchObject({ code: 'request_id_conflict' })
    }
    expect((await f.pool.query<{ count: number }>('SELECT count(*)::integer AS count FROM pe_operations')).rows[0]!.count).toBe(1)
    expect((await f.pool.query<{ request_id: string | null }>(
      'SELECT request_id FROM pe_native_file_receipts WHERE id=$1', [second.receiptId])).rows[0]!.request_id).toBeNull()
  })
})

test('byte and receipt limits reject intake without admitting partial prompt authority', async () => {
  await cloudFixture(async (f) => {
    const tasks = new TaskStore(f.pool, limits)
    const session = await tasks.create(f.alice.user, requestId.parse(randomUUID()), f.alice.token)
    const uploads = new NativeAttachments(f.pool, tasks, f.files, { root: join(f.root, 'attachments'), maxFilesPerUser: 4096, maxFilesPerSession: 1, maxBytesPerUser: 4 })
    await uploads.init()
    await expect(uploads.upload(f.alice.user, f.alice.token, session.sessionId, bytes('too long'), 'x', new AbortController().signal))
      .rejects.toMatchObject({ code: 'attachment_bytes_limit' })
    expect((await f.pool.query<{ count: number }>('SELECT count(*)::integer AS count FROM pe_native_file_receipts')).rows[0]!.count).toBe(0)
    await uploads.upload(f.alice.user, f.alice.token, session.sessionId, bytes('okay'), undefined, new AbortController().signal)
    await expect(uploads.upload(f.alice.user, f.alice.token, session.sessionId, bytes('x'), undefined, new AbortController().signal))
      .rejects.toMatchObject({ code: 'attachment_count_limit' })
    const cancelled = AbortSignal.abort(new Error('cancelled intake'))
    const other = await tasks.create(f.alice.user, requestId.parse(randomUUID()), f.alice.token)
    await expect(uploads.upload(f.alice.user, f.alice.token, other.sessionId, bytes(''), undefined, cancelled)).rejects.toThrow('cancelled intake')
  })
})

test('a changed original or binary file never becomes a successful text read', async () => {
  await cloudFixture(async (f) => {
    const tasks = new TaskStore(f.pool, limits)
    const session = await tasks.create(f.alice.user, requestId.parse(randomUUID()), f.alice.token)
    const config = { root: join(f.root, 'attachments'), maxFilesPerUser: 4096, maxFilesPerSession: 4, maxBytesPerUser: 1024 }
    const uploads = new NativeAttachments(f.pool, tasks, f.files, config); await uploads.init()
    const uploaded = await uploads.upload(f.alice.user, f.alice.token, session.sessionId, bytes('a\0b'), 'binary', new AbortController().signal)
    await tasks.accept(f.alice.user, session.sessionId, requestId.parse(randomUUID()), '', f.alice.token, { kind: 'cloud' },
      nativePromptContent.parse([{ type: 'file', receiptId: uploaded.receiptId }]))
    const grant = await tasks.claim(randomUUID()); if (!grant) throw new Error('Expected accepted file operation')
    await expect(uploads.readText(grant.token, uploaded.file, 1, 1)).rejects.toMatchObject({ code: 'file_not_text' })
    const path = storedFilePath(join(config.root, f.alice.user.userId, session.sessionId), uploaded.file)
    await chmod(path, 0o600); await writeFile(path, 'changed original')
    await expect(uploads.readText(grant.token, uploaded.file, 1, 1)).rejects.toMatchObject({ code: 'ATTACHMENT_CORRUPT' })
  })
})

test('published bytes after a receipt rollback consume the owner budget across Sessions', async () => {
  await cloudFixture(async (f) => {
    const tasks = new TaskStore(f.pool, limits)
    const first = await tasks.create(f.alice.user, requestId.parse(randomUUID()), f.alice.token)
    const other = await tasks.create(f.alice.user, requestId.parse(randomUUID()), f.alice.token)
    const root = join(f.root, 'attachments')
    const uploads = new NativeAttachments(f.pool, tasks, f.files,
      { root, maxFilesPerUser: 4, maxFilesPerSession: 4, maxBytesPerUser: 4 })
    await uploads.init()
    await f.pool.query(`CREATE FUNCTION reject_receipt() RETURNS trigger LANGUAGE plpgsql AS $$
      BEGIN RAISE EXCEPTION 'receipt persistence unavailable'; END $$;
      CREATE TRIGGER reject_receipt BEFORE INSERT ON pe_native_file_receipts
      FOR EACH ROW EXECUTE FUNCTION reject_receipt()`)
    await expect(uploads.upload(f.alice.user, f.alice.token, first.sessionId, bytes('full'), 'original.txt',
      new AbortController().signal)).rejects.toThrow('receipt persistence unavailable')
    expect((await f.pool.query<{ count: number }>('SELECT count(*)::integer AS count FROM pe_native_file_receipts')).rows[0]!.count).toBe(0)
    const original = { attachmentId: `sha256:${createHash('sha256').update('full').digest('hex')}`, name: 'original.txt', bytes: 4 }
    expect((await readFile(storedFilePath(join(root, f.alice.user.userId, first.sessionId),
      nativeFileAttachment.parse(original)))).toString()).toBe('full')
    await f.pool.query('DROP TRIGGER reject_receipt ON pe_native_file_receipts; DROP FUNCTION reject_receipt()')
    await expect(uploads.upload(f.alice.user, f.alice.token, other.sessionId, bytes('next'), 'next.txt',
      new AbortController().signal)).rejects.toMatchObject({ code: 'attachment_bytes_limit' })
    // Another owner's storage budget is independent of Alice's orphaned original.
    const bob = await tasks.create(f.bob.user, requestId.parse(randomUUID()), f.bob.token)
    await expect(uploads.upload(f.bob.user, f.bob.token, bob.sessionId, bytes('full'), 'bob.txt',
      new AbortController().signal)).resolves.toMatchObject({ file: { bytes: 4 } })
  })
})

test('a receipt rollback consumes Session and owner file slots even for empty files', async () => {
  await cloudFixture(async (f) => {
    const tasks = new TaskStore(f.pool, limits)
    const first = await tasks.create(f.alice.user, requestId.parse(randomUUID()), f.alice.token)
    const other = await tasks.create(f.alice.user, requestId.parse(randomUUID()), f.alice.token)
    const uploads = new NativeAttachments(f.pool, tasks, f.files,
      { root: join(f.root, 'attachments'), maxFilesPerUser: 1, maxFilesPerSession: 1, maxBytesPerUser: 4 })
    await uploads.init()
    await f.pool.query(`CREATE FUNCTION reject_receipt() RETURNS trigger LANGUAGE plpgsql AS $$
      BEGIN RAISE EXCEPTION 'receipt persistence unavailable'; END $$;
      CREATE TRIGGER reject_receipt BEFORE INSERT ON pe_native_file_receipts
      FOR EACH ROW EXECUTE FUNCTION reject_receipt()`)
    await expect(uploads.upload(f.alice.user, f.alice.token, first.sessionId, bytes(''), 'empty.txt',
      new AbortController().signal)).rejects.toThrow('receipt persistence unavailable')
    await f.pool.query('DROP TRIGGER reject_receipt ON pe_native_file_receipts; DROP FUNCTION reject_receipt()')
    await expect(uploads.upload(f.alice.user, f.alice.token, first.sessionId, bytes(''), 'another.txt',
      new AbortController().signal)).rejects.toMatchObject({ code: 'attachment_count_limit' })
    await expect(uploads.upload(f.alice.user, f.alice.token, other.sessionId, bytes(''), 'another.txt',
      new AbortController().signal)).rejects.toMatchObject({ code: 'attachment_storage_limit' })
    expect((await f.pool.query<{ count: number }>('SELECT count(*)::integer AS count FROM pe_native_file_receipts')).rows[0]!.count).toBe(0)
  })
})

test('public attachment roots and relative configuration fail before intake', async () => {
  await cloudFixture(async (f) => {
    const tasks = new TaskStore(f.pool, limits)
    expect(() => new NativeAttachments(f.pool, tasks, f.files, { root: 'relative', maxFilesPerUser: 4096, maxFilesPerSession: 4, maxBytesPerUser: 1024 })).toThrow('absolute')
    const root = join(f.root, 'public'); await mkdir(root); await chmod(root, 0o755)
    await expect(new NativeAttachments(f.pool, tasks, f.files, { root, maxFilesPerUser: 4096, maxFilesPerSession: 4, maxBytesPerUser: 1024 }).init()).rejects.toThrow('private')
    await expect(NativeAttachments.validateRoot(join(f.root, 'attachments'), [join(f.root, 'workspaces')])).resolves.toBeUndefined()
    await expect(NativeAttachments.validateRoot(join(f.root, 'workspaces', 'originals'), [join(f.root, 'workspaces')])).rejects.toThrow('overlaps')
    await expect(NativeAttachments.validateRoot(f.root, [join(f.root, 'workspaces')])).rejects.toThrow('overlaps')
    await mkdir(join(f.root, 'workspaces'), { recursive: true })
    const alias = join(f.root, 'alias'); await symlink(join(f.root, 'workspaces'), alias)
    await expect(NativeAttachments.validateRoot(join(alias, 'originals'), [join(f.root, 'workspaces')])).rejects.toThrow('overlaps')
    await expect(NativeAttachments.validateRoot('relative', [f.root])).rejects.toThrow('absolute')
    await expect(NativeAttachments.validateRoot(join(f.root, 'attachments'), ['relative'])).rejects.toThrow('absolute')
  })
})

test('a lost PostgreSQL connection closes intake before a stalled source produces another chunk', async () => {
  await cloudFixture(async (f) => {
    const tasks = new TaskStore(f.pool, limits)
    const session = await tasks.create(f.alice.user, requestId.parse(randomUUID()), f.alice.token)
    const uploads = new NativeAttachments(f.pool, tasks, f.files,
      { root: join(f.root, 'attachments'), maxFilesPerUser: 4, maxFilesPerSession: 4, maxBytesPerUser: 1024 })
    await uploads.init()
    const entered = Promise.withResolvers<undefined>(), release = Promise.withResolvers<undefined>()
    let delivered = false
    const stalled = async function* () {
      entered.resolve(undefined); await release.promise; delivered = true; yield Buffer.from('late original')
    }
    const result = uploads.upload(f.alice.user, f.alice.token, session.sessionId, stalled(), 'late.txt',
      new AbortController().signal).then(() => ({ accepted: true, error: undefined }),
      (error: unknown) => ({ accepted: false, error }))
    try {
      await entered.promise
      const active = await f.pool.query<{ pid: number }>(`SELECT pid FROM pg_stat_activity
        WHERE datname=current_database() AND state='idle in transaction'
          AND query LIKE 'SELECT file,storage_session_id FROM pe_native_file_receipts%'`)
      expect(active.rows).toHaveLength(1)
      expect((await f.pool.query<{ stopped: boolean }>('SELECT pg_terminate_backend($1) AS stopped',
        [active.rows[0]!.pid])).rows[0]?.stopped).toBe(true)
      const outcome = await result
      expect(outcome.accepted).toBe(false)
      expect(outcome.error).toMatchObject({ code: 'database_unavailable' })
      expect(delivered).toBe(false)
      expect((await f.pool.query<{ count: number }>('SELECT count(*)::integer AS count FROM pe_native_file_receipts')).rows[0]!.count).toBe(0)
    } finally { release.resolve(undefined); await result }
  })
})

test('Workspace copy refuses a grant that expires during the physical writer lock wait', async () => {
  await cloudFixture(async (f) => {
    const tasks = new TaskStore(f.pool, { ...limits, leaseMs: 2000 })
    const session = await tasks.create(f.alice.user, requestId.parse(randomUUID()), f.alice.token)
    const uploads = new NativeAttachments(f.pool, tasks, f.files,
      { root: join(f.root, 'attachments'), maxFilesPerUser: 4, maxFilesPerSession: 4, maxBytesPerUser: 1024 })
    await uploads.init()
    const uploaded = await uploads.upload(f.alice.user, f.alice.token, session.sessionId, bytes('lease original'),
      'original.txt', new AbortController().signal)
    await tasks.accept(f.alice.user, session.sessionId, requestId.parse(randomUUID()), '', f.alice.token, { kind: 'cloud' },
      nativePromptContent.parse([{ type: 'file', receiptId: uploaded.receiptId }]))
    await f.pool.query("INSERT INTO pe_mount_slots(user_id,state) VALUES($1,'free')", [f.alice.user.userId])
    const workspace = (await f.pool.query<{ workspace_id: string }>('SELECT workspace_id FROM pe_sessions WHERE id=$1',
      [session.sessionId])).rows[0]!.workspace_id
    const grant = await tasks.claim(randomUUID()); if (!grant) throw new Error('Expected accepted file grant')
    const blocker = await f.pool.connect()
    let copying: Promise<unknown> | undefined
    try {
      await blocker.query('BEGIN')
      const pid = (await blocker.query<{ pid: number }>('SELECT pg_backend_pid() AS pid')).rows[0]!.pid
      await blocker.query('SELECT user_id FROM pe_mount_slots WHERE user_id=$1 FOR UPDATE', [f.alice.user.userId])
      copying = uploads.copy(grant.token, uploaded.file, 'expired-copy', 'expired.txt').then(
        value => ({ accepted: true, value }), (error: unknown) => ({ accepted: false, error }))
      await expect.poll(async () => (await f.pool.query<{ count: number }>(`SELECT count(*)::integer AS count
        FROM pg_stat_activity WHERE datname=current_database() AND $1=ANY(pg_blocking_pids(pid))
          AND query LIKE 'SELECT state FROM pe_mount_slots%'`, [pid])).rows[0]?.count,
      { timeout: 10_000, interval: 10 }).toBe(1)
      await expect.poll(async () => (await f.pool.query<{ expired: boolean }>(
        'SELECT lease_until<=clock_timestamp() AS expired FROM pe_sessions WHERE id=$1', [session.sessionId])).rows[0]?.expired,
      { timeout: 10_000, interval: 10 }).toBe(true)
      await blocker.query('COMMIT')
      expect(await copying).toMatchObject({ accepted: false, error: { code: 'lease_lost' } })
      await expect(f.files.readInWorkspace(f.alice.user, workspace, 'expired.txt'))
        .rejects.toMatchObject({ code: 'file_not_found' })
      expect((await f.pool.query<{ count: number }>('SELECT count(*)::integer AS count FROM pe_file_uploads')).rows[0]!.count).toBe(0)
    } finally { await blocker.query('ROLLBACK'); blocker.release(); if (copying) await copying }
  })
})
