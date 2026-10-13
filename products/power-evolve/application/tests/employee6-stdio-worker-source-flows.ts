/** Current Cloud STDIO producer workflows; PG authority and real Linux child facts are never preseeded. */
import assert from 'node:assert/strict'
import { createHash, randomBytes, randomUUID } from 'node:crypto'
import { readFile, readdir, writeFile } from 'node:fs/promises'
import { join } from 'node:path'
import { setTimeout as delay } from 'node:timers/promises'
import { pathToFileURL } from 'node:url'
import type { Pool, PoolClient } from 'pg'
import { z } from 'zod'
import { stdioCheckRequestV2, stdioDigestV2, stdioReceiptRequestV2, type StdioActionIdV2 } from '@power-evolve/contracts/stdio-mcp'
import { stdioOutcomeV2, stdioWorkerIdV2 } from '@power-evolve/contracts/stdio-runtime'
import { requestId } from '../src/contracts.ts'
import type { FileService } from '../src/platform/files.ts'
import type { IdentityService } from '../src/platform/identity.ts'
import { TaskStore } from '../src/platform/tasks.ts'
import { StdioOperationAdmissionV2 } from '../src/platform/stdio-v2-operation-admission.ts'
import { StdioCallContinuationV2 } from '../src/platform/stdio-v2-continuations.ts'
import { StdioCloudWorkerStoreV2 } from '../src/platform/stdio-v2-worker-store.ts'
import { loadStdioPlatformConfigV2 } from '../src/platform/stdio-v2-platform-config.ts'
import { createStdioCloudServicesV2, STDIO_PRODUCT_RESERVED_NAMES_V2 } from '../src/platform/stdio-v2-services.ts'
import { workerProtocol } from './employee6-stdio-worker-protocol.ts'

/** Exactly three business flows; timeout/cleanup controls are kept outside this list. */
export type WorkerFlow = 'unallocated-cancel-drain' | 'discover-call-once-and-reconcile' | 'lease-lost-cancel-original'
/** Ordinary-role PG services and original browser/approval identities created by current account producers. */
export interface WorkerFixture {
  pool: Pool
  root: string
  files: FileService
  owner: Awaited<ReturnType<IdentityService['login']>>
  approval: Awaited<ReturnType<IdentityService['login']>>
  observe: (value: {
    http: Array<{ method: string; path: string; status: number }>
    protocolErrors: unknown[]
    peerEvents: unknown[] | undefined
    nativeBindings: Array<{ pid: number; raw: string; rawHash: string }>
    peerObservation: {
      finalRead: 'not-available' | 'succeeded' | 'failed'
      readFailureObserved: boolean
      cacheAvailable: boolean
    }
  }) => void
}
const limits = { runtimeMs: 30_000, requestMs: 15_000, stdinGraceMs: 0, terminateGraceMs: 100, killGraceMs: 1000,
  maxInputBytes: 65_536, maxMessageBytes: 8192, maxProtocolBytes: 131_072, maxProtocolMessages: 100,
  maxJsonDepth: 32, maxJsonNodes: 5000, maxPages: 10, maxTools: 20, maxCatalogBytes: 16_384,
  maxToolBytes: 8192, maxResultBytes: 8192, maxStderrBytes: 1024 }
const receiptId = () => stdioReceiptRequestV2.shape.requestId.parse(randomUUID())
const peerEvent = z.object({ event: z.string(), pid: z.number().int().positive().optional(),
  uid: z.number().int().nonnegative().optional(), envKeys: z.array(z.string()).optional(), method: z.string().optional(),
  nativeCaptureDirectoryHash: z.string().regex(/^[a-f0-9]{64}$/u).optional() }).strict()
interface ActionRow {
  state: string
  lease_owner: string | null
  lease_epoch: string
  cancel_requested: boolean
  execution_id: string
}

/** Wait for a real producer observation under the actual test lifetime and a separate bounded condition budget. */
async function until<T>(read: () => Promise<T>, accepted: (value: T) => boolean, signal: AbortSignal, ms = 15_000): Promise<T> {
  const deadline = Date.now() + ms
  for (;;) {
    signal.throwIfAborted()
    const value = await read()
    if (accepted(value)) return value
    assert(Date.now() < deadline, 'Owned producer condition must settle within its declared budget')
    await delay(25, undefined, { signal })
  }
}

/** Run a current producer workflow; the caller closes its ordinary-role pool only after this drains.
 * @param job Selected cancellation, original reconciliation or lease-loss workflow.
 * @param f Fresh ordinary-role PG and account/storage producers.
 * @param tlsRoot Private owned HTTPS certificate directory.
 * @param imageId Inspected Linux dependency image.
 * @param signal Actual test cancellation, shared with worker polling and bounded conditions.
 * @returns Actual PG, HTTP and UID1000 child observations after the workflow settles.
 */
export async function runWorkerFlow(job: WorkerFlow, f: WorkerFixture, tlsRoot: string, imageId: string, signal: AbortSignal) {
  const lifetime = new AbortController(), combined = AbortSignal.any([signal, lifetime.signal])
  const p = await workerProtocol(f, tlsRoot, limits, imageId, combined)
  const admission = { maxConnections: 4, maxTools: 20, maxSnapshotBytes: 262_144, maxDescriptionBytes: 1024 }
  const workerOptions = { pollMs: 25, renewMs: 50, leaseMs: job === 'lease-lost-cancel-original' ? 1000 : 30_000,
    maxActive: 2, maxCandidates: 8 }
  const settings = { approvalKeyFile: join(f.root, 'approval-key-private'), limits,
    management: { maxNameBytes: 80, pageItems: 8, maxConnections: 4 }, admission, cloudDeployment: p.pin,
    maxReplyBytes: 262_144, maxPendingPerUser: 8, maxCallsPerChain: 8, chainLifetimeMs: 300_000,
    approvalLifetimeMs: 120_000, worker: workerOptions, transport: { requestTimeoutMs: 10_000, maxTrackedActions: 8 } }
  let running: Promise<void> | undefined, current: ReturnType<typeof createStdioCloudServicesV2> | undefined
  let replacement: ReturnType<typeof createStdioCloudServicesV2> | undefined
  let blocker: PoolClient | undefined
  let observedPeerEvents: z.infer<typeof peerEvent>[] | undefined
  let peerTracePath: string | undefined, readFailureObserved = false
  let finalPeerRead: 'not-available' | 'succeeded' | 'failed' = 'not-available'
  const nativeBindings: Array<{ pid: number; raw: string; rawHash: string }> = []
  const readPeerEvents = async () => {
    try {
      assert(peerTracePath, 'Owned peer trace has not been created')
      const rows = (await readFile(peerTracePath, 'utf8')).split('\n').filter(Boolean)
        .map(line => peerEvent.parse(JSON.parse(line)))
      observedPeerEvents = rows
      return rows
    } catch (error) {
      readFailureObserved = true
      throw error
    }
  }
  const operations = new Set<Promise<unknown>>()
  const track = <T>(operation: Promise<T>) => {
    operations.add(operation); void operation.then(() => operations.delete(operation), () => operations.delete(operation))
    return operation
  }
  try {
    await writeFile(settings.approvalKeyFile, randomBytes(32).toString('hex'), { flag: 'wx', mode: 0o600 })
    const configFile = join(f.root, 'platform-config-private.json')
    await writeFile(configFile, JSON.stringify(settings), { flag: 'wx', mode: 0o600 })
    const config = await loadStdioPlatformConfigV2(configFile); assert(config)
    const selection = new StdioOperationAdmissionV2(f.files, { limits, admission, maxReplyBytes: settings.maxReplyBytes,
      cloudDeployment: p.pin })
    const tasks = new TaskStore(f.pool, { maxEventBytes: 524_288, leaseMs: 60_000, maxPendingPerUser: 8, maxActivePerUser: 1,
      stdioV2Admission: { selection, reservedNames: STDIO_PRODUCT_RESERVED_NAMES_V2 } })
    const workerId = stdioWorkerIdV2.parse(randomUUID())
    const services = createStdioCloudServicesV2(f.pool, tasks, selection, f.files, p.manager, config, workerId)
    current = services
    const continuation = new StdioCallContinuationV2({ limits, admission, maxReplyBytes: settings.maxReplyBytes })
    const store = new StdioCloudWorkerStoreV2(f.pool, { limits, ...workerOptions, continuation })
    const session = await tasks.create(f.owner.user, requestId.parse(randomUUID()), f.owner.token)
    const peer = await readFile(new URL('./fixtures/employee6-stdio-worker-mcp.mjs', import.meta.url))
    await f.files.put(f.owner.user, randomUUID(), 'worker-peer.mjs', peer.toString('base64'))
    await f.files.put(f.owner.user, randomUUID(), 'worker-trace.jsonl', '')
    const workspace = await f.files.workspaceForUser(f.owner.user.userId)
    peerTracePath = join(workspace.path, 'worker-trace.jsonl')
    const connection = await current.connections.create(f.owner.token, { requestId: receiptId(), configuration: {
      name: 'Owned current-worker MCP', invocation: { program: process.execPath,
        argv: ['worker-peer.mjs', job === 'lease-lost-cancel-original' ? 'hold' : 'complete', join(workspace.path, 'worker-trace.jsonl')], cwd: '.' } } })
    const accepted = await current.discovery.check(f.owner.token, stdioCheckRequestV2.parse({ requestId: receiptId(),
      connectionId: connection.connectionId, expectedRevision: 1, sessionId: session.sessionId, target: { kind: 'cloud' } }))
    const actionRow = async (id: string) => (await f.pool.query<ActionRow>(
      'SELECT state,lease_owner,lease_epoch,cancel_requested,execution_id FROM pe_stdio_v2_actions WHERE id=$1', [id])).rows[0]
    const claim = async (id: string, owner = workerId) => {
      const lease = await store.claimNext(owner); assert(lease); assert.equal(lease.actionId, id); return lease
    }
    const prepareApprove = async (id: StdioActionIdV2) => {
      assert.equal(await services.worker.step(await claim(id), combined), 'pending')
      const prepared = (await f.pool.query<{ fingerprint: string }>('SELECT fingerprint FROM pe_stdio_v2_preparations WHERE action_id=$1', [id])).rows[0]
      assert(prepared)
      await services.authorization.decide(f.approval.token, { actionId: id,
        fingerprint: stdioDigestV2.parse(prepared.fingerprint), decision: 'once' })
    }
    const finalize = async (id: string, worker = services.worker, owner = workerId) => {
      await until(async () => {
        const row = await actionRow(id); assert(row)
        if (row.state === 'succeeded' || row.state === 'cancelled') return row
        await worker.step(await claim(id, owner), combined)
        return actionRow(id)
      }, row => row?.state === 'succeeded' || row?.state === 'cancelled', combined)
    }
    if (job === 'unallocated-cancel-drain') {
      await current.actions.cancel(f.owner.token, { actionId: accepted.actionId })
      running = track(current.worker.run(combined))
      await until(() => actionRow(accepted.actionId), row => row?.state === 'cancelled' && row.lease_owner === null, combined)
      lifetime.abort(); await running; await current.worker.stop()
      const closure = (await f.pool.query<{ receipt: { resource: { kind: string } } }>('SELECT receipt FROM pe_stdio_v2_no_start_closures WHERE action_id=$1', [accepted.actionId])).rows[0]
      assert.equal(closure?.receipt.resource.kind, 'unallocated'); assert.equal(p.trace.length, 0)
      for (const name of ['pe_mount_slots', 'pe_sandbox_instances', 'pe_stdio_v2_preparations', 'pe_stdio_v2_start_permits',
        'pe_stdio_v2_dispatches', 'pe_stdio_v2_results', 'pe_stdio_v2_catalogs']) {
        assert.equal((await f.pool.query<{ n: number }>(`SELECT count(*)::integer AS n FROM ${name}`)).rows[0]?.n, 0)
      }
    } else if (job === 'discover-call-once-and-reconcile') {
      await prepareApprove(accepted.actionId)
      assert.equal(await current.worker.step(await claim(accepted.actionId), combined), 'observed')
      p.loseNextGet()
      assert.equal(await current.worker.step(await claim(accepted.actionId), combined), 'deferred')
      const uncertain = await actionRow(accepted.actionId); assert.equal(uncertain?.state, 'blocked')
      const execution = (await f.pool.query<{ state: string }>('SELECT state FROM pe_cloud_executions WHERE id=$1',
        [accepted.executionRef.executionId])).rows[0]; assert.equal(execution?.state, 'uncertain')
      await finalize(accepted.actionId)
      await current.connections.toggle(f.owner.token, { requestId: receiptId(), connectionId: connection.connectionId,
        expectedRevision: 1, enabled: true })
      await tasks.accept(f.owner.user, session.sessionId, requestId.parse(randomUUID()), 'Use owned current-worker MCP', f.owner.token)
      const grant = await tasks.claim(randomUUID()); assert(grant)
      const tool = grant.stdioV2Connections[0]?.tools[0]; assert(tool)
      const call = await current.calls.propose(grant.token, { callKey: 'owned-call-1', toolName: tool.model.name,
        arguments: { message: 'original\0😀' } })
      await prepareApprove(call.actionId)
      assert.equal(await current.worker.step(await claim(call.actionId), combined), 'observed')
      await finalize(call.actionId)
      const produced = (await f.pool.query<{ result: unknown }>('SELECT result FROM pe_stdio_v2_results WHERE action_id=$1',
        [call.actionId])).rows[0]; assert(produced)
      const outcome = stdioOutcomeV2(limits, settings.maxReplyBytes).parse(produced.result)
      assert(outcome.state === 'completed' && outcome.phase === 'call')
      assert.deepEqual(outcome.result.content, [{ type: 'text', text: 'original\0😀' }])
      assert.equal(outcome.facts.childExitObserved, true); assert.equal(outcome.facts.childCloseObserved, true)
      assert.equal(outcome.facts.cleanupConfirmed, true); assert(outcome.facts.childPid && outcome.facts.childPid > 0)
      const counts = (await f.pool.query<{ n: number }>('SELECT count(*)::integer AS n FROM pe_stdio_v2_catalogs')).rows[0]
      assert.equal(counts?.n, 1)
      assert.equal(p.trace.filter(row => row.method === 'POST' && row.path.endsWith('/stdio/v2/executions')).length, 2)
      assert.equal(p.trace.filter(row => row.method === 'GET' && row.status === 404 && row.path.includes('/stdio/v2/executions/')).length, 1)
    } else {
      await prepareApprove(accepted.actionId)
      const originalLease = await claim(accepted.actionId), reached = p.holdNextStart()
      const original = track(current.worker.step(originalLease, combined))
      await Promise.race([reached, original.then(() => { throw new Error('Worker ended before the controlled start barrier') })])
      await until(readPeerEvents, rows => rows.some(row => row.event === 'spawn')
        && rows.some(row => row.method === 'tools/list'), combined)
      blocker = await f.pool.connect(); await blocker.query('BEGIN')
      await blocker.query('SELECT id FROM pe_stdio_v2_actions WHERE id=$1 FOR UPDATE', [accepted.actionId])
      await until(async () => (await f.pool.query<{ expired: boolean }>('SELECT lease_until<=clock_timestamp() AS expired FROM pe_stdio_v2_actions WHERE id=$1', [accepted.actionId])).rows[0]?.expired ?? false,
        value => value, combined, 5000)
      await blocker.query('COMMIT'); blocker.release(); blocker = undefined
      const nextId = stdioWorkerIdV2.parse(randomUUID()), nextLease = await claim(accepted.actionId, nextId)
      assert(nextLease.leaseEpoch > originalLease.leaseEpoch)
      p.releaseHeldStart(); assert.equal(await original, 'lease-lost')
      replacement = createStdioCloudServicesV2(f.pool, tasks, selection, f.files, p.manager, config, nextId)
      await current.actions.cancel(f.owner.token, { actionId: accepted.actionId })
      await replacement.worker.step(nextLease, combined)
      await finalize(accepted.actionId, replacement.worker, nextId)
      assert.equal((await actionRow(accepted.actionId))?.state, 'cancelled')
      assert.equal(p.trace.filter(row => row.method === 'POST' && row.path.endsWith('/stdio/v2/executions')).length, 1)
      assert(p.trace.some(row => row.method === 'POST' && row.path.endsWith('/cancel')))
    }
    assert.deepEqual(p.errors, []); assert(await p.uidQuiet())
    const traces = await readPeerEvents()
    const spawned = traces.filter(row => row.event === 'spawn')
    assert.equal(spawned.length, job === 'unallocated-cancel-drain' ? 0 : job === 'discover-call-once-and-reconcile' ? 2 : 1)
    if (spawned.length) {
      const inputPath = process.env.PE_CLOUD_COVERAGE_INPUT; assert(inputPath)
      const context = z.object({ version: z.literal(1), executionDirectory: z.string(),
        parentInputHash: z.string().regex(/^[a-f0-9]{64}$/u) }).parse(JSON.parse(await readFile(inputPath, 'utf8')))
      const rawDirectory = join(context.executionDirectory, 'raw')
      assert.equal(process.env.NODE_V8_COVERAGE, rawDirectory)
      const expectedHash = createHash('sha256').update(rawDirectory).digest('hex')
      const expectedProgram = pathToFileURL(join(workspace.path, 'worker-peer.mjs')).href
      const files = await readdir(rawDirectory)
      for (const row of spawned) {
        assert.equal(row.uid, 1000); assert(row.pid); assert(row.envKeys)
        // Only this known native instrumentation key is separated; every business and unrelated key remains checked.
        assert.deepEqual(row.envKeys.filter(key => key !== 'NODE_V8_COVERAGE'), ['HOME', 'LANG', 'PATH'])
        assert.deepEqual(row.envKeys, ['HOME', 'LANG', 'NODE_V8_COVERAGE', 'PATH'])
        assert.equal(row.nativeCaptureDirectoryHash, expectedHash)
        let bound = false
        for (const name of files.filter(name => new RegExp(`^coverage-${row.pid}-[0-9]+-[0-9]+\\.json$`, 'u').test(name))) {
          const bytes = await readFile(join(rawDirectory, name))
          const raw = z.object({ result: z.array(z.object({ url: z.string() })) }).parse(JSON.parse(bytes.toString('utf8')))
          if (raw.result.some(script => script.url === expectedProgram)) {
            bound = true
            nativeBindings.push({ pid: row.pid, raw: name, rawHash: createHash('sha256').update(bytes).digest('hex') })
          }
        }
        assert(bound, 'Actual peer PID must have its original program in this owned native raw namespace')
      }
    }
    return { job, finalAction: await actionRow(accepted.actionId), http: p.trace, peerEvents: traces,
      pgProducerRecordsOnly: true, realUid1000Children: traces.filter(row => row.event === 'spawn').map(row => row.pid),
      physicalPodQualified: false, currentSourceWorkerQualified: true, independentUidQuiet: true, nativeBindings }
  } finally {
    lifetime.abort(); p.releaseHeldStart()
    if (blocker) { try { await blocker.query('ROLLBACK') } finally { blocker.release() } }
    await Promise.allSettled(operations)
    try { await Promise.all([current?.worker.stop(), replacement?.worker.stop()]) }
    finally {
      try { await p.close() }
      finally {
        // This observation is independent of the original body/drain failure and precedes the caller's storage removal.
        if (peerTracePath) {
          try { await readPeerEvents(); finalPeerRead = 'succeeded' }
          catch (_finalObservationReadFailure) { finalPeerRead = 'failed' }
        }
        f.observe({ http: p.trace, protocolErrors: p.errors, peerEvents: observedPeerEvents, nativeBindings,
          peerObservation: { finalRead: finalPeerRead, readFailureObserved, cacheAvailable: observedPeerEvents !== undefined } })
      }
    }
  }
}
