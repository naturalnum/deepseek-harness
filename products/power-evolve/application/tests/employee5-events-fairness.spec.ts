/** Durable native event sequences, prompt identities and two-user PostgreSQL scheduling. */
import { randomUUID } from 'node:crypto'
import { join } from 'node:path'
import { Pool } from 'pg'
import { Session } from '@deepseek-ai/dsh-session'
import type {} from '@deepseek-ai/dsh-session-title'
import { MessageId } from '@deepseek-ai/dsh-llm'
import { expect, test } from 'vitest'
import { requestId, promptRequest } from '../src/contracts.ts'
import { MAX_INPUT_JSON_BYTES } from '../src/continuation-input.ts'
import { nativePromptContent } from '../src/native-attachment-contracts.ts'
import { TaskStore } from '../src/platform/tasks.ts'
import { EventStore } from '../src/platform/events.ts'
import { NativeAttachments } from '../src/platform/native-attachments.ts'
import { NativePreferences, nativeModelSelect } from '../src/platform/native-preferences.ts'
import { NativeSessionRead } from '../src/platform/native-session-read.ts'
import { headerSchema } from '../src/session-records.ts'
import { cloudFixture } from './cloud-fixture.ts'

const limits = { maxEventBytes: 524_288, maxHistoryBytes: 4_194_304, maxHistoryEvents: 100,
  leaseMs: 30_000, maxPendingPerUser: 8, maxActivePerUser: 1 }

async function* bytes(value: string): AsyncGenerator<Uint8Array> { yield Buffer.from(value) }

test('concurrent identical prompt retries admit one operation and reject changed text, receipts and order', () =>
  cloudFixture(async ({ pool, root, files, alice }) => {
    const tasks = new TaskStore(pool, limits)
    const session = await tasks.create(alice.user, requestId.parse(randomUUID()), alice.token)
    const uploads = new NativeAttachments(pool, tasks, files,
      { root: join(root, 'originals'), maxFilesPerSession: 4, maxFilesPerUser: 4096, maxBytesPerUser: 1024 })
    await uploads.init()
    const first = await uploads.upload(alice.user, alice.token, session.sessionId, bytes('original'), 'first.txt', new AbortController().signal)
    const second = await uploads.upload(alice.user, alice.token, session.sessionId, bytes('replacement'), 'second.txt', new AbortController().signal)
    const request = requestId.parse(randomUUID())
    const content = nativePromptContent.parse([{ type: 'text', text: 'first' }, { type: 'file', receiptId: first.receiptId },
      { type: 'text', text: 'second' }])
    const work = () => tasks.accept(alice.user, session.sessionId, request, 'first\nsecond', alice.token, { kind: 'cloud' }, content)
    const results = await Promise.all([work(), work()])
    expect(results[0]).toEqual(results[1])
    await expect(tasks.accept(alice.user, session.sessionId, request, 'changed', alice.token))
      .rejects.toMatchObject({ status: 409, code: 'request_id_conflict' })
    for (const changed of [
      nativePromptContent.parse([{ type: 'text', text: 'first' }, { type: 'file', receiptId: second.receiptId }, { type: 'text', text: 'second' }]),
      nativePromptContent.parse([{ type: 'file', receiptId: first.receiptId }, { type: 'text', text: 'first' }, { type: 'text', text: 'second' }]),
    ]) {
      await expect(tasks.accept(alice.user, session.sessionId, request, 'first\nsecond', alice.token, { kind: 'cloud' }, changed))
        .rejects.toMatchObject({ status: 409, code: 'request_id_conflict' })
    }
    expect((await pool.query('SELECT input,state FROM pe_operations')).rows).toEqual([{ input: 'first\nsecond', state: 'queued' }])
    expect((await pool.query('SELECT id,request_id FROM pe_native_file_receipts ORDER BY id')).rows)
      .toEqual([{ id: first.receiptId, request_id: request },
        { id: second.receiptId, request_id: null }].sort((a, b) => a.id.localeCompare(b.id)))
    expect((await pool.query('SELECT submitted,admitted FROM pe_native_prompt_inputs')).rows)
      .toEqual([{ submitted: content, admitted: [{ type: 'text', text: 'first' },
        { type: 'file', attachment: first.file }, { type: 'text', text: 'second' }] }])
  }))

test('accepted model snapshots survive a changed next-model intent and service reconstruction', () =>
  cloudFixture(async ({ pool, alice, bob }) => {
    const tasks = new TaskStore(pool, limits), preferences = new NativePreferences(pool, limits)
    const session = await tasks.create(alice.user, requestId.parse(randomUUID()), alice.token)
    await pool.query("INSERT INTO pe_user_models(user_id,model_id,label,max_tokens,enabled) VALUES($1,'next-model','Next',512,true)", [alice.user.userId])
    const request = requestId.parse(randomUUID())
    const accepted = await tasks.accept(alice.user, session.sessionId, request, 'frozen model', alice.token)
    await preferences.selectModel(alice.user, alice.token,
      nativeModelSelect.parse({ sessionId: session.sessionId, provider: 'power-evolve', model: 'next-model' }))
    expect(await new TaskStore(pool, limits).accept(alice.user, session.sessionId, request, 'frozen model', alice.token)).toEqual(accepted)
    await tasks.accept(alice.user, session.sessionId, requestId.parse(randomUUID()), 'next model', alice.token)
    expect((await pool.query('SELECT input,settings FROM pe_operations ORDER BY input')).rows).toEqual([
      { input: 'frozen model', settings: { model: 'trial-model', maxTokens: 1000, revision: 1 } },
      { input: 'next model', settings: { model: 'next-model', maxTokens: 512, revision: 1 } },
    ])
    await expect(tasks.accept(bob.user, session.sessionId, request, 'frozen model', bob.token)).rejects.toMatchObject({ status: 404 })
    expect(promptRequest.safeParse({ sessionId: session.sessionId, requestId: request, text: 'frozen model', model: 'next-model' }).success).toBe(false)
  }))

test('committed native events read back exactly after replay, rejected gaps and a reconstructed reader', () =>
  cloudFixture(async ({ pool, alice, bob }) => {
    const tasks = new TaskStore(pool, limits), events = new EventStore(tasks, limits)
    const created = await tasks.create(alice.user, requestId.parse(randomUUID()), alice.token)
    const request = requestId.parse(randomUUID())
    await tasks.accept(alice.user, created.sessionId, request, 'persist native input', alice.token)
    const grant = await tasks.claim(randomUUID())
    if (!grant) throw new Error('Expected native operation')
    const header = headerSchema.parse((await pool.query<{ header: unknown }>(
      'SELECT header FROM pe_sessions WHERE id=$1', [created.sessionId])).rows[0]?.header)
    const native = Session.create(header.id, undefined, header)
    native.append('turn/start', { turn: 1 })
    native.append('user/message', { id: MessageId(request), role: 'user', content: [{ type: 'text', text: 'persist native input' }],
      source: { kind: 'user' } }, { surfaceOp: 'append' })
    const prefix = native.snapshotEvents()
    expect(await events.append(grant.token, prefix)).toEqual({ eventCount: prefix.length })
    native.append('session/title', { title: 'persistent native title', messageSeqs: [], source: { kind: 'user' } })
    const suffix = native.snapshotEvents().slice(prefix.length)
    expect(await events.append(grant.token, native.snapshotEvents())).toEqual({ eventCount: native.snapshotEvents().length })
    const before = (await pool.query<{ event_count: number; event_bytes: string }>(
      'SELECT event_count,event_bytes FROM pe_sessions WHERE id=$1', [created.sessionId])).rows[0]
    if (!before) throw new Error('Expected committed Session watermark')
    expect(await events.append(grant.token, native.snapshotEvents())).toEqual({ eventCount: native.snapshotEvents().length })
    expect((await pool.query('SELECT event_count,event_bytes FROM pe_sessions WHERE id=$1', [created.sessionId])).rows[0]).toEqual(before)
    await expect(events.append(grant.token, [{ ...suffix[0], data: { title: 'conflicting title', messageSeqs: [], source: { kind: 'user' } } }]))
      .rejects.toMatchObject({ status: 409, code: 'event_conflict' })
    native.append('turn/end', { turn: 1, reason: { kind: 'completed' } })
    const end = native.snapshotEvents().at(-1)!
    await expect(events.append(grant.token, [end, { ...end, seq: end.seq + 2 }]))
      .rejects.toMatchObject({ status: 409, code: 'event_gap' })
    expect((await pool.query('SELECT event_count,event_bytes FROM pe_sessions WHERE id=$1', [created.sessionId])).rows[0]).toEqual(before)
    expect((await pool.query<{ count: number }>(
      'SELECT count(*)::integer AS count FROM pe_events WHERE session_id=$1', [created.sessionId])).rows[0]?.count).toBe(before.event_count)
    await events.append(grant.token, [end])
    await tasks.finish(grant.token, 'completed', null)
    const reader = new NativeSessionRead(pool), address = { kind: 'session' as const, sessionId: created.sessionId }
    const committed = native.snapshotEvents()
    const opening = await reader.snapshot(alice.user, { address })
    expect(opening.cursor).toBe(committed.length - 1)
    expect(opening.projections.asOfSeq).toBe(opening.cursor)
    expect(opening.projections.values.title).toBe('persistent native title')
    expect(opening.records).toEqual(committed.map(event => ({ type: 'event', event })))
    expect(await reader.after(alice.user, created.sessionId, -1, 2)).toEqual(committed.slice(0, 2))
    expect(await new NativeSessionRead(pool).after(alice.user, created.sessionId, 1)).toEqual(committed.slice(2))
    expect(await reader.after(alice.user, created.sessionId, opening.cursor)).toEqual([])
    expect(await reader.page(alice.user, { address, throughSeq: opening.cursor })).toEqual({ records: opening.records, hasMore: false })
    await expect(reader.after(bob.user, created.sessionId, -1)).rejects.toMatchObject({ status: 404, code: 'session_not_found' })
    await expect(reader.page(alice.user, { address, throughSeq: committed.length })).rejects.toMatchObject({ code: 'native_page_future_cursor' })
    expect((await pool.query('SELECT seq,event FROM pe_events WHERE session_id=$1 ORDER BY seq', [created.sessionId])).rows)
      .toEqual(committed.map(event => ({ seq: event.seq, event })))
  }))

test('native JSON events retain NUL, escaped controls and Unicode in PostgreSQL and cold reads', () =>
  cloudFixture(async ({ pool, alice }) => {
    const tasks = new TaskStore(pool, limits), events = new EventStore(tasks, limits)
    const created = await tasks.create(alice.user, requestId.parse(randomUUID()), alice.token)
    await tasks.accept(alice.user, created.sessionId, requestId.parse(randomUUID()), 'native output preservation', alice.token)
    const grant = await tasks.claim(randomUUID())
    if (!grant) throw new Error('Expected native operation')
    const header = headerSchema.parse((await pool.query<{ header: unknown }>(
      'SELECT header FROM pe_sessions WHERE id=$1', [created.sessionId])).rows[0]?.header)
    const native = Session.create(header.id, undefined, header)
    native.append('turn/start', { turn: 1 })
    const output = 'start:\0:literal\\u0000:\u0001:表😀:end'
    native.append('step/start', { turn: 1, step: 1 })
    native.append('assistant/message', { turn: 1, step: 1,
      message: { id: MessageId(randomUUID()), role: 'assistant', content: [{ type: 'text', text: output }],
        source: { kind: 'model', provider: 'power-evolve', model: 'trial-model' } },
      stream: [
        { type: 'chunk', time: 1, chunk: { type: 'block-start', index: 0, blockType: 'text' } },
        { type: 'text-chunks', time0: 1, index: 0, dt: [], texts: [output] },
        { type: 'chunk', time: 2, chunk: { type: 'block-end', index: 0, block: { type: 'text', text: output } } },
        { type: 'chunk', time: 2, chunk: { type: 'finish', reason: { kind: 'stop' } } },
      ],
    }, { surfaceOp: 'append' })
    native.append('step/end', { turn: 1, step: 1 })
    native.append('turn/end', { turn: 1, reason: { kind: 'completed' } })
    await events.append(grant.token, native.snapshotEvents())
    await tasks.finish(grant.token, 'completed', null)
    expect(await new NativeSessionRead(pool).after(alice.user, created.sessionId, -1)).toEqual(native.snapshotEvents())
    expect((await pool.query<{ event: unknown }>('SELECT event FROM pe_events WHERE session_id=$1 ORDER BY seq', [created.sessionId])).rows.map(row => row.event))
      .toEqual(native.snapshotEvents())
  }))

for (const [label, output, budget, truncated] of [
  ['office guide', 'office guide '.repeat(4000), 524_288, false],
  ['escaped Unicode', 'begin:' + '\u0001表😀\\"'.repeat(40_000) + ':end', 8192, true],
] as const) {
  test(`Alice's ${label} continuation and Bob's task are independently claimable by two PostgreSQL workers`, () =>
    cloudFixture(async ({ pool, alice, bob }) => {
      const config = { ...limits, maxEventBytes: budget }, tasks = new TaskStore(pool, config)
      const a = await tasks.create(alice.user, requestId.parse(randomUUID()), alice.token)
      const rootRequest = requestId.parse(randomUUID())
      await tasks.accept(alice.user, a.sessionId, rootRequest, 'original execution input', alice.token)
      const original = await tasks.claim(randomUUID())
      if (!original) throw new Error('Expected original operation')
      await tasks.finish(original.token, 'completed', null)
      const executionId = randomUUID(), continuation = requestId.parse(randomUUID())
      // Only the settled Runner record is fixture data; claim, budgets, attempt fencing and PG are real.
      await pool.query(`INSERT INTO pe_cloud_executions(id,user_id,session_id,operation_id,call_id,
        command,cwd,request_digest,state,result,continuation_request_id)
        VALUES($1,$2,$3,$4,'employee5-result','fixture','','fixture-digest','succeeded',$5,$6)`,
      [executionId, alice.user.userId, a.sessionId, original.operationId, { stdout: output, exitCode: 0 }, continuation])
      await pool.query(`INSERT INTO pe_operations(id,session_id,request_id,input,settings,skill_selection,
        source,source_execution_id,state)
        SELECT $1,session_id,$2,$3,settings,skill_selection,'sandbox_result',$4,'queued' FROM pe_operations WHERE id=$5`,
      [randomUUID(), continuation, output, executionId, original.operationId])
      const b = await tasks.create(bob.user, requestId.parse(randomUUID()), bob.token)
      const bobRequest = requestId.parse(randomUUID())
      await tasks.accept(bob.user, b.sessionId, bobRequest, 'Bob independent input', bob.token)
      const workers = [new Pool({ connectionString: pool.options.connectionString, max: 1 }),
        new Pool({ connectionString: pool.options.connectionString, max: 1 })]
      try {
        const results = await Promise.all(workers.map(worker => new TaskStore(worker, config).claim(randomUUID())))
        const aliceGrant = results.find(value => value?.userId === alice.user.userId)
        const bobGrant = results.find(value => value?.userId === bob.user.userId)
        if (!aliceGrant || !bobGrant) throw new Error('Both users must be claimable independently')
        expect(aliceGrant).toMatchObject({ sessionId: a.sessionId, requestId: continuation, source: 'sandbox_result', sourceExecutionId: executionId, nativeContent: null })
        expect(bobGrant).toMatchObject({ sessionId: b.sessionId, requestId: bobRequest, text: 'Bob independent input', source: 'user', sourceExecutionId: null })
        expect(Buffer.byteLength(JSON.stringify(aliceGrant.text))).toBeLessThanOrEqual(Math.min(MAX_INPUT_JSON_BYTES, budget / 2))
        expect(Buffer.from(aliceGrant.text).toString('utf8')).toBe(aliceGrant.text)
        if (truncated) {
          expect(aliceGrant.text).toContain('Internal result truncated.')
          expect(aliceGrant.text).toContain('begin:')
          expect(aliceGrant.text.endsWith(':end')).toBe(true)
        } else expect(aliceGrant.text).toBe(output)
        expect(await tasks.claim(randomUUID())).toBeNull()
        await Promise.all([tasks.finish(aliceGrant.token, 'completed', null), tasks.finish(bobGrant.token, 'completed', null)])
        expect((await pool.query('SELECT input,state,attempts FROM pe_operations WHERE request_id=$1', [continuation])).rows)
          .toEqual([{ input: output, state: 'completed', attempts: 1 }])
        expect((await pool.query<{ result: unknown }>('SELECT result FROM pe_cloud_executions WHERE id=$1', [executionId])).rows[0]?.result)
          .toEqual({ stdout: output, exitCode: 0 })
        expect((await pool.query<{ count: number }>(
          'SELECT count(*)::integer AS count FROM pe_operations WHERE source_execution_id=$1', [executionId])).rows[0]?.count).toBe(1)
        expect((await pool.query<{ count: number }>('SELECT count(*)::integer AS count FROM pe_attempts')).rows[0]?.count).toBe(3)
      } finally { await Promise.all(workers.map(worker => worker.end())) }
    }))
}
