/** Real PostgreSQL image permissions and the production HTTP response consumed by the scoped SDK service. */
import { randomUUID } from 'node:crypto'
import { once } from 'node:events'
import { mkdir, readFile, lstat, writeFile } from 'node:fs/promises'
import { createServer } from 'node:http'
import { join } from 'node:path'
import { Context } from '@deepseek-ai/cordis'
import { createScope } from '@deepseek-ai/dsh-scope'
import { Session, SessionSeq } from '@deepseek-ai/dsh-session'
import { MessageId } from '@deepseek-ai/dsh-llm'
import AttachmentLocal from '@deepseek-ai/dsh-attachment-local'
import { expect, test } from 'vitest'
import { requestId } from '../src/contracts.ts'
import { bearer, readJson, sendFailure, sendJson } from '../src/http.ts'
import { resolveNativeImageOptions, type NativeImageConfiguration } from '../src/host/native-image-config.ts'
import RuntimeScope from '../src/host/scope.ts'
import { LegacyMigrationHostImages } from '../src/platform/legacy-migration-v2-host-images.ts'
import { LegacyMigrationImageReader } from '../src/platform/legacy-migration-v2-image-reader.ts'
import { readNativeImageResponse } from '../src/platform/native-image-route.ts'
import { TaskStore } from '../src/platform/tasks.ts'
import { EventStore } from '../src/platform/events.ts'
import { legacyMigrationImageLedger } from '../src/platform/legacy-migration-v2-media-contracts.ts'
import { cloudFixture } from './cloud-fixture.ts'

const imageConfig: NativeImageConfiguration = { readyFile: '/private/host/ready.json', legacyImageCacheRoot: '',
  legacyImageMaxBytes: 65536, legacyImageMaxPixels: 4096, legacyImageMaxDimension: 64,
  legacyImageMaxImagesPerMessage: 4, legacyImageMaxMessageBytes: 262144 }
const taskLimits = { maxEventBytes: 524288, leaseMs: 30000, maxPendingPerUser: 8, maxActivePerUser: 1 }

test('Host resolves an absolute derivative cache beside its private readiness file and preserves configured image limits', () => {
  expect(resolveNativeImageOptions(imageConfig)).toEqual({ cacheRoot: '/private/host/image-request-cache', imageLimits: {
    maxImageBytes: 65536, maxImagePixels: 4096, maxImageDimension: 64, maxImagesPerMessage: 4,
    maxMessageImageBytes: 262144, mediaTypes: ['image/png', 'image/jpeg', 'image/webp', 'image/gif'],
  } })
  expect(resolveNativeImageOptions({ ...imageConfig, legacyImageCacheRoot: '/private/other/cache' }).cacheRoot)
    .toBe('/private/other/cache')
})

test.each([{ readyFile: 'relative/ready.json' }, { legacyImageCacheRoot: 'relative/cache' }])(
  'Host refuses relative image cache configuration %j', (patch) => {
    expect(() => resolveNativeImageOptions({ ...imageConfig, ...patch })).toThrow('absolute private path')
  })

test('the production image route preserves original bytes through Host SDK derivation and fences obsolete operation scopes', () =>
  cloudFixture(async (db) => {
    const tasks = new TaskStore(db.pool, taskLimits)
    const events = new EventStore(tasks, { maxEventBytes: taskLimits.maxEventBytes, maxHistoryBytes: 8388608, maxHistoryEvents: 10000 })
    const session = await tasks.create(db.alice.user, requestId.parse(randomUUID()), db.alice.token)
    await tasks.accept(db.alice.user, session.sessionId, requestId.parse(randomUUID()), 'read original', db.alice.token)
    const root = join(db.root, 'originals'), home = join(root, db.alice.user.userId, session.sessionId)
    await mkdir(home, { recursive: true, mode: 0o700 })
    const ctx = new Context(), pending = new Set<Promise<void>>()
    const originalStore = new AttachmentLocal(ctx, { dshHome: home, maxImageBytes: 65536, maxImagePixels: 4_000_000,
      maxImageDimension: 8192, normalizedImageMaxBytes: 65536, normalizedImageMaxPixels: 4096, normalizedImageMaxDimension: 64 })
    const ref = await originalStore.saveImage({ data: await readFile(new URL('./fixtures/native-image-original.png', import.meta.url)),
      mediaType: 'image/png', name: 'original.png' })
    const original = await originalStore.readImage(ref)
    const reader = new LegacyMigrationImageReader(db.pool, tasks, { root, maxImageBytes: 65536,
      maxImagePixels: 4096, maxLedgerBytes: 262144 })
    const server = createServer((req, res) => {
      const work = (async () => {
        try { sendJson(res, await readNativeImageResponse(reader, bearer(req), await readJson(req, 4096),
          AbortSignal.timeout(5000))) }
        catch (error: unknown) { sendFailure(res, error) }
      })()
      pending.add(work)
      void work.finally(() => { pending.delete(work) })
    })
    // Separate provider root: the scoped Host service never sees the Platform original storage path.
    const host = new Context()
    try {
      server.listen(0, '127.0.0.1'); await once(server, 'listening')
      const address = server.address()
      if (!address || typeof address === 'string') throw new Error('Owned image listener missing')
      const worker = join(db.root, 'worker-token'); await writeFile(worker, randomUUID(), { mode: 0o600 })
      await host.plugin(RuntimeScope, { platformUrl: `http://127.0.0.1:${address.port}`, workerTokenFile: worker,
        timeoutMs: 5000, maxResponseBytes: 262144 })
      let runtime: RuntimeScope | undefined
      await host.inject(['powerEvolveRuntime'], (context) => { runtime = context.powerEvolveRuntime })
      if (!runtime) throw new Error('Owned Host runtime missing')
      const grant = await tasks.claim(runtime.workerId)
      if (!grant) throw new Error('Owned image grant missing')
      const log = Session.create(session.sessionId, undefined, { id: session.sessionId, version: 4, createdAt: 1, isSeeded: false })
      log.append('turn/start', { turn: 1 })
      log.append('user/message', { id: MessageId(grant.requestId), role: 'user', content: [{ type: 'image', attachment: ref }],
        source: { kind: 'user' } }, { surfaceOp: 'append' })
      log.append('turn/end', { turn: 1, reason: { kind: 'completed' } })
      await events.append(grant.token, log.snapshotEvents())
      const ledger = legacyMigrationImageLedger.parse({ version: 1, userId: grant.userId, sessionId: grant.sessionId, bindings: [{
        kind: 'image', authority: 'verified-history-migration', migrationId: randomUUID(), userId: grant.userId,
        sessionId: grant.sessionId, storageSessionId: grant.sessionId, sourceRootId: 'owned-original',
        sourceRowSha256s: ['a'.repeat(64)], image: ref, occurrences: [{ seq: SessionSeq(1), imageIndex: 0 }],
      }] })
      await db.pool.query('INSERT INTO pe_native_preferences(user_id,namespace,value,revision) VALUES($1,$2,$3,1)',
        [grant.userId, `legacy-migration-v2-images:${grant.sessionId}`, JSON.stringify(ledger)])
      runtime.grants.set(grant.sessionId, grant)
      const images = new LegacyMigrationHostImages(host, runtime, resolveNativeImageOptions({ ...imageConfig,
        readyFile: join(db.root, 'host-ready.json') }))
      const scope = createScope(host, {})
      images.bind(scope.ctx, grant)
      try {
        const transmitted = await scope.ctx.attachments.readImage(ref)
        expect(transmitted.ref).toEqual(original.ref)
        expect(Buffer.from(transmitted.data)).toEqual(Buffer.from(original.data))
        const derived = await scope.ctx.attachments.readImageRequest(ref, { width: 1, height: 1, maxBytes: 65536 })
        expect(derived.attachment).toEqual(ref)
        expect(derived.width).toBe(1)
        expect(derived.height).toBe(1)
        expect(ref.width).toBeGreaterThan(derived.width)
        expect((await lstat(join(db.root, 'image-request-cache'))).mode & 0o077).toBe(0)
        await expect(runtime.call('/runtime/attachments/image', grant.token, { image: ref, root: home }))
          .rejects.toMatchObject({ code: 'invalid_request' })
        await expect(runtime.call('/runtime/attachments/image', db.bob.token, { image: ref }))
          .rejects.toMatchObject({ code: 'lease_lost' })
        const stopped = new AbortController(); stopped.abort()
        await expect(readNativeImageResponse(reader, grant.token, { image: ref }, stopped.signal)).rejects.toThrow()
        await tasks.finish(grant.token, 'completed', null)
        await expect(readNativeImageResponse(reader, grant.token, { image: ref }, new AbortController().signal))
          .rejects.toMatchObject({ code: 'lease_lost' })
        runtime.grants.delete(grant.sessionId)
        await expect(scope.ctx.attachments.readImage(ref)).rejects.toMatchObject({ code: 'lease_lost' })
      } finally { runtime.grants.delete(grant.sessionId); await scope.dispose() }
    } finally {
      await host.fiber.dispose(); await ctx.fiber.dispose(); await Promise.all(pending)
      await new Promise<void>((resolve, reject) => {
        server.close((error) => { if (error) reject(error); else resolve() }); server.closeIdleConnections()
      })
    }
  }))
