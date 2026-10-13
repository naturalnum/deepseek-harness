/** Actual Host transport, owned HTTP carrier and PostgreSQL provider; no named Profile or Scheduler runs here. */
import { randomBytes, randomUUID } from 'node:crypto'
import { once } from 'node:events'
import { writeFile } from 'node:fs/promises'
import { createServer } from 'node:http'
import { join } from 'node:path'
import { Context } from '@deepseek-ai/cordis'
import { expect, test } from 'vitest'
import { requestId, type Grant } from '../src/contracts.ts'
import { bearer, readJson, sendFailure, sendJson } from '../src/http.ts'
import { HostNativeWriterClient } from '../src/host/native-writer-client.ts'
import RuntimeScope from '../src/host/scope.ts'
import { NativeSessionWriter } from '../src/platform/native-session-writer.ts'
import { routeNativeWriter } from '../src/platform/native-writer-routes.ts'
import { TaskStore } from '../src/platform/tasks.ts'
import type { NativeWriterLease, NativeWriterReleased } from '../src/native-writer-contracts.ts'
import { cloudFixture } from './cloud-fixture.ts'

type DatabaseFixture = Parameters<Parameters<typeof cloudFixture>[0]>[0]
const limits = { maxEventBytes: 524_288, leaseMs: 30_000, maxPendingPerUser: 8, maxActivePerUser: 1 }
const freshToken = () => randomBytes(32).toString('base64url')
interface RouteFixture {
  readonly db: DatabaseFixture
  readonly origin: string
  readonly runtime: RuntimeScope
  readonly client: HostNativeWriterClient
  readonly tasks: TaskStore
  readonly grant: Grant
  dropAcquireOnce: boolean
  rewrite: ((receipt: NativeWriterLease | NativeWriterReleased) => unknown) | undefined
}

async function routed(run: (fixture: RouteFixture) => Promise<void>): Promise<void> {
  await cloudFixture(async (db) => {
    const tasks = new TaskStore(db.pool, limits), writer = new NativeSessionWriter(tasks, { leaseMs: 20_000 })
    const context = new Context(), pending = new Set<Promise<void>>()
    let fixture: RouteFixture | undefined
    const server = createServer((request, response) => {
      const work = (async () => {
        try {
          const receipt = await routeNativeWriter(writer, request.url ?? '', bearer(request), await readJson(request, 4096))
          if (fixture?.dropAcquireOnce && request.url === '/runtime/native-writer/acquire') {
            fixture.dropAcquireOnce = false
            response.destroy()
            return
          }
          sendJson(response, fixture?.rewrite ? fixture.rewrite(receipt) : receipt)
        } catch (error: unknown) { sendFailure(response, error) }
      })()
      pending.add(work)
      void work.finally(() => { pending.delete(work) })
    })
    try {
      server.listen(0, '127.0.0.1')
      await once(server, 'listening')
      const address = server.address()
      if (!address || typeof address === 'string') throw new Error('Expected owned HTTP listener')
      const origin = `http://127.0.0.1:${address.port}`
      const workerFile = join(db.root, 'route-worker-token')
      await writeFile(workerFile, freshToken(), { mode: 0o600 })
      await context.plugin(RuntimeScope, { platformUrl: origin, workerTokenFile: workerFile,
        timeoutMs: 5000, maxResponseBytes: 65536 })
      let runtime: RuntimeScope | undefined
      await context.inject(['powerEvolveRuntime'], (ctx) => { runtime = ctx.powerEvolveRuntime })
      if (runtime === undefined) throw new Error('Host runtime service did not activate')
      const session = await tasks.create(db.alice.user, requestId.parse(randomUUID()), db.alice.token)
      await tasks.accept(db.alice.user, session.sessionId, requestId.parse(randomUUID()), 'route input', db.alice.token)
      const grant = await tasks.claim(runtime.workerId)
      if (!grant) throw new Error('Expected owned route operation')
      runtime.grants.set(grant.sessionId, grant)
      fixture = { db, origin, runtime, client: new HostNativeWriterClient(runtime), tasks, grant,
        dropAcquireOnce: false, rewrite: undefined }
      await run(fixture)
    } finally {
      await context.fiber.dispose()
      await Promise.all(pending)
      if (server.listening) {
        await new Promise<void>((resolve, reject) => {
          server.close((error) => { if (error) reject(error); else resolve() })
          server.closeIdleConnections()
        })
      }
    }
  })
}

test('Host writer transport acquires, retries, renews after operation settlement and releases the exact tombstone', () =>
  routed(async (f) => {
    const token = freshToken(), owned = await f.client.acquire(f.grant, token)
    expect(await f.client.acquire(f.grant, token)).toEqual(owned)
    expect(owned.identity).toMatchObject({ sessionId: f.grant.sessionId, workerId: f.runtime.workerId, token, epoch: 1 })
    const before = (await f.db.pool.query('SELECT grant_digest,lease_epoch,lease_until FROM pe_sessions')).rows
    expect(await f.client.renew(owned.identity)).toMatchObject({ sessionId: f.grant.sessionId, epoch: 1 })
    expect((await f.db.pool.query('SELECT grant_digest,lease_epoch,lease_until FROM pe_sessions')).rows).toEqual(before)
    await f.tasks.finish(f.grant.token, 'completed', null)
    f.runtime.grants.delete(f.grant.sessionId)
    expect(await f.client.renew(owned.identity)).toMatchObject({ epoch: 1 })
    const released = await f.client.release(owned.identity)
    expect(await f.client.release(owned.identity)).toEqual(released)
    expect(released).toEqual({ sessionId: f.grant.sessionId, workerId: f.runtime.workerId, epoch: 1, released: true })
    expect((await f.db.pool.query('SELECT epoch,expires_at FROM pe_native_writers')).rows).toEqual([{ epoch: '1', expires_at: null }])
    await expect(f.client.renew(owned.identity)).rejects.toMatchObject({ code: 'native_writer_lost' })
  }))

test('a committed acquisition whose HTTP response is lost retries the retained token without a second writer epoch', () =>
  routed(async (f) => {
    const token = freshToken()
    f.dropAcquireOnce = true
    await expect(f.client.acquire(f.grant, token)).rejects.toThrow()
    const committed = (await f.db.pool.query('SELECT epoch,token_digest,expires_at FROM pe_native_writers')).rows
    expect(committed).toHaveLength(1)
    expect((await f.client.acquire(f.grant, token)).identity.epoch).toBe(1)
    expect((await f.db.pool.query('SELECT epoch,token_digest,expires_at FROM pe_native_writers')).rows).toEqual(committed)
  }))

test('stale Host operation objects and expired independent writer identities cannot affect a successor', () => routed(async (f) => {
  const old = await f.client.acquire(f.grant, freshToken())
  await f.tasks.accept(f.db.alice.user, f.grant.sessionId, requestId.parse(randomUUID()), 'successor input', f.db.alice.token)
  await f.tasks.finish(f.grant.token, 'completed', null)
  await f.db.pool.query("UPDATE pe_native_writers SET expires_at=clock_timestamp()-interval '1 second' WHERE session_id=$1",
    [f.grant.sessionId])
  const next = await f.tasks.claim(f.runtime.workerId)
  if (!next) throw new Error('Expected expired writer to permit successor claim')
  f.runtime.grants.set(next.sessionId, next)
  const current = await f.client.acquire(next, freshToken())
  expect(current.identity.epoch).toBe(old.identity.epoch + 1)
  await expect(f.client.acquire(f.grant, old.identity.token)).rejects.toMatchObject({ code: 'lease_lost' })
  await expect(f.client.renew(old.identity)).rejects.toMatchObject({ code: 'native_writer_lost' })
  await expect(f.client.release(old.identity)).rejects.toMatchObject({ code: 'native_writer_lost' })
  expect(await f.client.renew(current.identity)).toMatchObject({ epoch: current.identity.epoch })
}))

test('writer HTTP maintenance rejects another owner, a second body token, malformed JSON and unknown paths', () => routed(async (f) => {
  const owned = await f.client.acquire(f.grant, freshToken())
  const { token, ...input } = owned.identity
  for (const body of [{ ...input, userId: f.db.bob.user.userId }, { ...input, token }, { sessionId: input.sessionId }]) {
    await expect(f.runtime.call('/runtime/native-writer/renew', token, body)).rejects.toMatchObject({ code: 'invalid_request' })
  }
  await expect(f.runtime.call('/runtime/native-writer/renew', freshToken(), input)).rejects.toMatchObject({ code: 'native_writer_lost' })
  await expect(f.runtime.call('/runtime/native-writer/acquire', f.db.bob.token,
    { sessionId: input.sessionId, workerId: input.workerId, token: freshToken() })).rejects.toMatchObject({ code: 'lease_lost' })
  await expect(f.runtime.call('/runtime/native-writer/unknown', token, input)).rejects.toMatchObject({ code: 'not_found' })
  const response = await fetch(f.origin + '/runtime/native-writer/renew', { method: 'POST',
    headers: { authorization: `Bearer ${token}` }, body: '{' })
  expect(response.status).toBe(400)
  expect(await response.json()).toEqual({ error: 'invalid_json' })
}))

for (const changed of ['session', 'worker', 'epoch'] as const) {
  test(`Host maintenance rejects a valid receipt carrying a different ${changed} identity`, () => routed(async (f) => {
    const owned = await f.client.acquire(f.grant, freshToken())
    // Mutate only the actual wire response; the production PostgreSQL provider still authorizes the original identity.
    f.rewrite = receipt => ({ ...receipt, ...(changed === 'session' ? { sessionId: randomUUID() }
      : changed === 'worker' ? { workerId: randomUUID() } : { epoch: receipt.epoch + 1 }) })
    await expect(f.client.renew(owned.identity)).rejects.toMatchObject({ code: 'native_writer_receipt' })
    f.rewrite = undefined
    expect(await f.client.renew(owned.identity)).toMatchObject({ epoch: owned.identity.epoch })
  }))
}
