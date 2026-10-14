/** Built plane: actual PG native cohorts and credential-free gVisor Pods in a caller-owned namespace. */
import assert from 'node:assert/strict'
import { test } from 'node:test'
import { randomBytes, randomUUID } from 'node:crypto'
import { mkdir, readFile, writeFile } from 'node:fs/promises'
import { join } from 'node:path'
import { createServer } from 'node:http'
import { setTimeout as delay } from 'node:timers/promises'
import { createHash } from 'node:crypto'
import { Pool } from 'pg'
import { Context } from '@deepseek-ai/cordis'
import { Session } from '@deepseek-ai/dsh-session'
import { initializeDatabase, transaction } from '../lib/platform/database.js'
import { seedNewUser } from '../lib/platform/account-settings.js'
import { hashPassword, IdentityService } from '../lib/platform/identity.js'
import { FileService } from '../lib/platform/files.js'
import { TaskStore } from '../lib/platform/tasks.js'
import { NativeSessionWriter } from '../lib/platform/native-session-writer.js'
import { NativeExecutionFrames } from '../lib/platform/native-execution-frames.js'
import { NativeInputLedger } from '../lib/platform/native-input-ledger.js'
import { NativeExecutionAuthority } from '../lib/platform/native-execution-authority.js'
import { AccountService } from '../lib/platform/accounts.js'
import { revokeAccountExecutions } from '../lib/platform/account-execution-revocation.js'
import { EventStore } from '../lib/platform/events.js'
import { nativeInputAdmissionCommand, nativeInputClaimCommand, nativeInputStepCommand } from '../lib/native-input-ledger-contracts.js'
import { NativeExecutionAuthorityStore } from '../lib/platform/native-execution-authority-store.js'
import { verifyNativeExecutionConsumers } from '../lib/native-execution-consumers/native-consumers.mjs'
import { createNativeExecutionHttpBinding } from '../lib/native-execution/http-client.js'
import { readNativeRuntimePolicy } from '../lib/platform/native-runtime-policy.js'
import { installNativeExecutionPlatform } from '../lib/platform/native-execution-platform.js'

const input = process.env.PE_NATIVE_EXECUTION_PHYSICAL_INPUT
if (!input) throw new Error('PE_NATIVE_EXECUTION_PHYSICAL_INPUT must name owned physical inputs')
const config = JSON.parse(await readFile(input, 'utf8'))
const limits = { maxEventBytes: 524288, leaseMs: 600000, maxPendingPerUser: 8, maxActivePerUser: 4 }
const history = { maxHistoryEvents: 1000, maxHistoryBytes: 8388608 }

async function prepare(pool, identity, modes, files, account) {
  const tasks = new TaskStore(pool, limits), request = randomUUID()
  const created = await tasks.create(account.user, randomUUID(), account.token)
  await tasks.accept(account.user, created.sessionId, request, 'Native execution physical case', account.token)
  const workerId = randomUUID(), grant = await tasks.claim(workerId)
  assert(grant)
  const writers = new NativeSessionWriter(tasks, { leaseMs: 300000 })
  const acquire = { sessionId: created.sessionId, workerId, token: randomBytes(32).toString('base64url') }
  const leased = await writers.acquire(grant.token, acquire), writer = { ...acquire, epoch: leased.epoch }
  const authority = { writer, operationToken: grant.token }
  const events = new EventStore(tasks, { maxEventBytes: limits.maxEventBytes, ...history })
  const frames = new NativeExecutionFrames(tasks, writers, { ...history, maxFrameBytes: 2097152, maxCohortInputs: 128 })
  const ledger = new NativeInputLedger(tasks, writers, events, { ...history, maxEventBytes: limits.maxEventBytes,
    maxAcceptedAuditBytes: 2097152, maxRevisionBytes: 262144, maxCohortInputs: 128, maxCommandBytes: 4194304 },
  (client, value) => frames.verifyInTransaction(client, value))
  const header = (await pool.query('SELECT header FROM pe_sessions WHERE id=$1', [created.sessionId])).rows[0].header
  const session = Session.create(header.id, undefined, header)
  const content = (await pool.query('SELECT admitted FROM pe_native_prompt_inputs WHERE session_id=$1 AND request_id=$2', [created.sessionId, request])).rows[0].admitted
  const origin = randomUUID(), message = { id: randomUUID(), role: 'user', source: { kind: 'user', rpcId: request }, content }
  const admission = session.append('agent/inbox/spliced', { target: 'next-turn', start: 0, inserted: [message] })
  await ledger.admit(account.token, { authority, expectedEventCount: 0, events: [admission], command: nativeInputAdmissionCommand.parse({
    rpcNonce: randomUUID(), sessionId: created.sessionId, originInputId: origin, originOperationId: grant.operationId,
    messageId: message.id, target: 'next-turn' }) })
  const frame = await transaction(pool, client => frames.prepareInTransaction(client, authority, origin))
  const consumed = [session.append('turn/start', { turn: 1 }), session.append('agent/inbox/spliced', { target: 'next-turn', start: 0, removedCount: 1, inserted: [] })]
  const claim = nativeInputClaimCommand.parse({ rpcNonce: randomUUID(), cohortId: randomUUID(), boundaryKind: 'initial-turn-step',
    frame: { sessionId: grant.sessionId, operationId: grant.operationId, operationEpoch: grant.epoch,
      writerEpoch: writer.epoch, frozenSnapshotDigest: frame.frozenSnapshotDigest } })
  await ledger.claim({ command: claim, authority, expectedEventCount: 1, events: consumed })
  const step = session.append('step/start', { turn: 1, step: 1 })
  await transaction(pool, async client => { const current = await tasks.authorized(client, grant.token); await events.appendInTransaction(client, current, [step]);
    await ledger.bindStepInTransaction(client, nativeInputStepCommand.parse({ cohortId: claim.cohortId, frame: claim.frame, stepStartSeq: step.seq }), authority) })
  const nativeAuthority = new NativeExecutionAuthority((client, current, token) => frames.readExecutionInTransaction(client, current, token), { ...history, maxCohortInputs: 128, maxFactBytes: 2097152 })
  const executionTasks = new TaskStore(pool, limits, (client, current, token) => nativeAuthority.assertExecutionInTransaction(client, current, token))
  await events.append(grant.token, [session.append('sandbox/mode', { mode: 'workspace-write' })])
  const taskAuthority = { nativeWorldAuthorized: (client, token, purpose) => purpose === 'storage-read' ? executionTasks.authorized(client, token) : executionTasks.executionAuthorized(client, token) }
  const store = new NativeExecutionAuthorityStore(pool, taskAuthority, files.storage, readNativeRuntimePolicy)
  const issued = await store.open(grant.token, grant.sessionId)
  await mkdir(join(config.homeRoot, issued.world.userId), { recursive: true, mode: 0o755 })
  return { store, grant, issued, tasks, session, identity, events, taskAuthority }
}

test('native Fs, Bash and physical permissions share one generation and exact stop evidence', { timeout: 300000 }, async () => {
  const admin = new Pool({ connectionString: (await readFile(config.databaseUrlFile, 'utf8')).trim() })
  const name = 'pe_native_exec_' + randomUUID().replaceAll('-', '')
  await admin.query('CREATE DATABASE "' + name + '"')
  const connection = new URL((await readFile(config.databaseUrlFile, 'utf8')).trim()); connection.pathname = '/' + name
  const pool = new Pool({ connectionString: connection.href })
  const ctx = new Context(), runtimeContexts = [], nativeBindings = [], modes = new Map()
  let broker, server
  try {
    await initializeDatabase(pool)
    const password = randomUUID(), hash = await hashPassword(password)
    for (const user of ['alice', 'bob']) await seedNewUser(pool, user, hash, { model: 'trial-model', maxTokens: 1000, revision: 1 })
    const identity = new IdentityService(pool, 600000), alice = await identity.login('alice', password), bob = await identity.login('bob', password)
    const files = new FileService(pool, config.storageRoot, { uid: 1000, gid: 1000 }); await files.init()
    const a = await prepare(pool, identity, modes, files, alice), b = await prepare(pool, identity, modes, files, bob)
    const assembled = await installNativeExecutionPlatform(ctx, pool, a.taskAuthority, files.storage, readNativeRuntimePolicy, config.nativeConfigFile)
    const { pods, routes } = assembled; broker = assembled.broker
    // Exercise the Runtime's real serialized HTTP request/reply path in this owned controller.
    // The production Webserver carrier has its own admission/body/teardown acceptance tests.
    server = createServer((request, response) => {
      void (async () => {
        const chunks = []
        for await (const chunk of request) chunks.push(chunk)
        try {
          const value = await routes.route(request.url, request.headers.authorization.slice(7), JSON.parse(Buffer.concat(chunks)))
          response.setHeader('content-type', 'application/json'); response.end(JSON.stringify(value))
        } catch (error) {
          response.statusCode = error.status ?? 500
          response.end(JSON.stringify({ code: error.code ?? 'native_physical_dispatch_failed', message: error.message }))
        }
      })().catch(() => { response.destroy() })
    })
    await new Promise(resolve => server.listen(0, '127.0.0.1', resolve))
    const origin = 'http://127.0.0.1:' + server.address().port
    const transport = async (path, bearer, body) => {
      const response = await fetch(origin + path, { method: 'POST', headers: { authorization: 'Bearer ' + bearer,
        'content-type': 'application/json' }, body: JSON.stringify(body) })
      const value = await response.json()
      if (!response.ok) throw Object.assign(new Error(value.message), { code: value.code })
      return value
    }
    const native = (issued, token) => {
      const owner = new Context(); runtimeContexts.push(owner)
      const binding = createNativeExecutionHttpBinding(owner, issued.world, token, transport, { pollMs: 50, maxOutputBytes: 1048576 })
      nativeBindings.push(binding); return binding
    }
    assert.equal((await a.store.open(a.grant.token, a.grant.sessionId)).world.worldId, a.issued.world.worldId)
    const waitFile = async (issued, path) => {
      const deadline = Date.now() + 30000, filename = join(config.storageRoot, issued.binding.rootKey, issued.binding.rootRelativePath, path)
      while (Date.now() < deadline) {
        try { return await readFile(filename, 'utf8') } catch (error) { if (error.code !== 'ENOENT') throw error }
        await delay(100)
      }
      throw new Error('Physical payload did not enter its command before deadline')
    }
    const n = native(a.issued, a.grant.token)
    const directCtx = new Context(); runtimeContexts.push(directCtx)
    const direct = broker.binding(directCtx, a.grant.token, a.issued.world)
    let firstFile
    try { firstFile = await direct.filesystem.resolve('/workspace/native-proof.txt') }
    catch (error) { await writeFile(config.evidenceFile + '.failure', JSON.stringify({ error: error.message, cause: error.cause?.message }) + '\n', { mode: 0o600 }); throw error }
    assert.equal(direct.filesystem.processPath(firstFile), '/workspace/native-proof.txt')
    const file = await n.filesystem.resolve('/workspace/native-proof.txt')
    await n.filesystem.writeText(file, 'native Fs wrote this\n')
    const run = async (binding, script, signal) => {
      const confined = await binding.sandbox.confine(['/bin/bash', '-c', script], { mode: binding.world.mode, workspaceRoot: '/workspace' })
      const handle = binding.subprocess.spawn({ argv: confined.argv, cwd: '/workspace', graceMs: 1000, signal,
        stdio: { stdin: 'ignore', stdout: { maxBytes: 65536 }, stderr: { maxBytes: 65536 } } })
      const outcome = await handle.done; assert.equal(await handle.waitForExit(), true)
      return { outcome, stdout: handle.collected.stdout.readFrom(0), stderr: handle.collected.stderr.readFrom(0) }
    }
    const read = await run(n, 'cat native-proof.txt; printf bash >> native-proof.txt')
    assert.equal(read.outcome.exitCode, 0); assert.match(read.stdout.text, /native Fs wrote this/)
    assert.match(await n.filesystem.readText(file), /bash$/)
    await n.filesystem.writeText(await n.filesystem.resolve('/tmp/native-shared.txt'), 'same session temporary data')
    assert.match((await run(n, 'cat /tmp/native-shared.txt')).stdout.text, /same session temporary data/)
    const observed = await n.filesystem.stat(file)
    assert(observed?.version)
    const edited = await n.filesystem.editText(file, { oldString: 'bash', newString: 'guarded', replaceAll: false }, { version: observed.version })
    assert(edited.version)
    await assert.rejects(n.filesystem.editText(file, { oldString: 'guarded', newString: 'stale', replaceAll: false }, { version: observed.version }), error => error.code === 'FS_STALE_VERSION')
    assert.match(await n.filesystem.readText(file), /guarded$/)
    const largeWrite = await n.filesystem.resolve('/workspace/large-write.txt'), text = 'UTF8-中文🌍\n'.repeat(40000)
    await n.filesystem.writeText(largeWrite, text)
    assert.equal(await n.filesystem.readText(largeWrite), text)
    const large = await n.filesystem.resolve('/workspace/large-stream.txt')
    assert.equal((await run(n, "python3 -c \"open('large-stream.txt','w').write('中文🌍\\n'*400000)\"")).outcome.exitCode, 0)
    await assert.rejects(n.filesystem.readText(large), error => error.code === 'FS_TOO_LARGE')
    const streamHash = createHash('sha256'); let streamed = 0, streamChunks = 0
    for await (const chunk of await n.filesystem.streamText(large)) { streamHash.update(chunk); streamed += Buffer.byteLength(chunk); streamChunks++ }
    const wanted = '中文🌍\n'.repeat(400000)
    assert.equal(streamed, Buffer.byteLength(wanted)); assert.ok(streamChunks > 1)
    assert.equal(streamHash.digest('hex'), createHash('sha256').update(wanted).digest('hex'))
    // An eagerly allocated reader must close even when JS has not started its generator.
    const unopened = (await n.filesystem.streamText(large))[Symbol.asyncIterator]()
    await unopened.return(); await unopened.return()
    const unopenedDirect = (await direct.filesystem.streamText(await direct.filesystem.resolve('/workspace/large-stream.txt')))[Symbol.asyncIterator]()
    await unopenedDirect.return()
    const held = Promise.withResolvers(), admitted = Promise.withResolvers(), heldOwner = new Context()
    runtimeContexts.push(heldOwner)
    const heldBinding = createNativeExecutionHttpBinding(heldOwner, a.issued.world, a.grant.token, async (path, bearer, body) => {
      if (path === '/runtime/native-world/fs/stream/start') { admitted.resolve(); await held.promise }
      return await transport(path, bearer, body)
    }, { pollMs: 50, maxOutputBytes: 1048576 })
    nativeBindings.push(heldBinding)
    const pendingRead = heldBinding.filesystem.streamText(large)
    void pendingRead.catch(() => {})
    await admitted.promise
    let closed = false
    const closingRead = heldBinding.close().then(() => { closed = true })
    await delay(100); assert.equal(closed, false, 'Cleanup cannot finish before the original held start settles')
    held.resolve(); await closingRead
    await assert.rejects(pendingRead, error => error.code === 'FS_ABORTED')
    assert.equal(heldBinding.close(), heldBinding.close())
    const partial = (await n.filesystem.streamText(large))[Symbol.asyncIterator]()
    assert.equal((await partial.next()).done, false); await partial.return()
    const abortedRead = new AbortController(), reading = (await n.filesystem.streamText(large, abortedRead.signal))[Symbol.asyncIterator]()
    assert.equal((await reading.next()).done, false); abortedRead.abort()
    await assert.rejects(reading.next(), error => error.code === 'FS_ABORTED')
    const header = (await pool.query('SELECT header FROM pe_sessions WHERE id=$1', [a.grant.sessionId])).rows[0].header
    const consumers = await verifyNativeExecutionConsumers({ world: a.issued.world, token: a.grant.token, header, transport })
    const home = await run(n, 'echo forbidden > /home/agent/blocked')
    assert.notEqual(home.outcome.exitCode, 0); assert.match(home.stderr.text, /Read-only file system|Permission denied/)
    const escape = await run(n, 'test ! -r /input/kubeconfig.yaml && test ! -r /input/database-url && test ! -d /s2-volume; id -u; env')
    assert.equal(escape.outcome.exitCode, 0); assert.match(escape.stdout.text, /^1000\n/)
    assert.doesNotMatch(escape.stdout.text, /KUBECONFIG|POSTGRES_PASSWORD|workerToken|model.key/)
    const sameUid = n.subprocess.spawn({ argv: ['/usr/bin/python3', '-I', '-B', '-c',
      "import os,errno; p=os.getppid(); failures=[]\nfor tail in ['fd/1','environ','mem']:\n try:\n  fd=os.open('/proc/%d/%s'%(p,tail),os.O_RDONLY); os.close(fd); failures.append(tail)\n except OSError as e:\n  assert e.errno in [errno.EACCES,errno.EPERM],(tail,e.errno)\nprint('outer-fds-denied'); os._exit(23 if not failures else 99)"], cwd: '/workspace', graceMs: 1000,
      stdio: { stdin: 'ignore', stdout: { maxBytes: 65536 }, stderr: { maxBytes: 65536 } } })
    assert.equal((await sameUid.done).exitCode, 23)
    const pipeEvidence = []
    for (const channel of ['stdout', 'control']) {
      const controller = new AbortController(), marker = 'paused-' + channel + '.txt'
      const handle = n.subprocess.spawn({ argv: ['/usr/bin/python3', '-I', '-B', '-c',
        "import os,time; open('" + marker + "','w').write('entered'); os.write(" + (channel === 'stdout' ? 1 : 7) + ",b'x'*8388608); time.sleep(30)"],
      cwd: '/workspace', signal: controller.signal, graceMs: 1000,
      stdio: { stdin: 'ignore', stdout: 'pipe', stderr: 'pipe', ...(channel === 'control' ? { control: 'pipe' } : {}) } })
      void handle.done.catch(() => {})
      assert.equal(await waitFile(a.issued, marker), 'entered')
      await delay(500)
      const source = channel === 'stdout' ? handle.stdout : handle.control
      assert.ok(source.readableLength <= 1048576 + 8192, 'Runtime raw pipe must retain a bounded credit window')
      const began = Date.now(); controller.abort()
      assert.equal((await handle.done).signal, 'SIGTERM')
      assert.equal(await handle.waitForExit(), true)
      assert.ok(Date.now() - began < 20000, 'Paused raw pipe must not prevent the original Pod DELETE/stop/join')
      pipeEvidence.push({ channel, stopped: true, bounded: true })
    }
    // A same-UID payload can stop its guest proxy. External control must still reach
    // Kubernetes DELETE and join exact whole-Pod evidence when negotiation cannot reply.
    const stoppedProxySignal = new AbortController(), proxyIssued = await a.store.open(a.grant.token, a.grant.sessionId)
    const stoppedProxy = n.subprocess.spawn({ argv: ['/usr/bin/python3', '-I', '-B', '-c',
      "import os,signal,time; open('stopped-proxy.txt','w').write('entered'); os.kill(os.getppid(),signal.SIGSTOP); time.sleep(30)"],
    cwd: '/workspace', signal: stoppedProxySignal.signal, graceMs: 1000,
    stdio: { stdin: 'ignore', stdout: 'pipe', stderr: 'pipe' } })
    void stoppedProxy.done.catch(() => {})
    assert.equal(await waitFile(proxyIssued, 'stopped-proxy.txt'), 'entered')
    const proxyStopBegan = Date.now(); stoppedProxySignal.abort()
    assert.equal((await stoppedProxy.done).signal, 'SIGTERM')
    assert.ok(Date.now() - proxyStopBegan < 20000)
    await assert.rejects(b.store.assert(b.grant.token, a.issued.world))
    const other = native(b.issued, b.grant.token)
    await assert.rejects(other.filesystem.readText(file), /another world|another execution world/)
    await a.events.append(a.grant.token, [a.session.append('sandbox/mode', { mode: 'read-only' })])
    await assert.rejects(a.store.assert(a.grant.token, a.issued.world), error => error.code === 'native_world_generation_changed')
    const readonly = await a.store.open(a.grant.token, a.grant.sessionId), ro = native(readonly, a.grant.token)
    const blocked = await run(ro, 'echo no > /workspace/no; echo no > /tmp/no')
    assert.notEqual(blocked.outcome.exitCode, 0); assert.match(blocked.stderr.text, /Read-only file system/)
    await assert.rejects(ro.filesystem.writeText(await ro.filesystem.resolve('/workspace/no'), 'no'), error => error.code === 'FS_SANDBOX_DENIED')
    await a.events.append(a.grant.token, [a.session.append('sandbox/mode', { mode: 'workspace-write' })])
    const live = native(await a.store.open(a.grant.token, a.grant.sessionId), a.grant.token)
    const current = await a.store.open(a.grant.token, a.grant.sessionId)
    const controller = new AbortController(), cancelled = run(live, 'printf entered > running-cancel.txt; sleep 30; echo wrong > after-cancel', controller.signal)
    assert.equal(await waitFile(current, 'running-cancel.txt'), 'entered'); controller.abort()
    assert.equal((await cancelled).outcome.signal, 'SIGTERM')
    const changed = run(live, 'printf entered > running-generation.txt; sleep 30; echo wrong > after-generation')
    void changed.catch(() => {})
    assert.equal(await waitFile(current, 'running-generation.txt'), 'entered')
    await a.events.append(a.grant.token, [a.session.append('sandbox/mode', { mode: 'read-only' })])
    await assert.rejects(changed)
    const newWorld = await a.store.open(a.grant.token, a.grant.sessionId)
    assert.notEqual(newWorld.world.worldId, current.world.worldId)
    await a.events.append(a.grant.token, [a.session.append('sandbox/mode', { mode: 'workspace-write' })])
    const revoking = await a.store.open(a.grant.token, a.grant.sessionId), original = native(revoking, a.grant.token)
    const revoked = run(original, 'printf entered > running-revoke.txt; sleep 30; echo wrong > after-revoke')
    void revoked.catch(() => {})
    assert.equal(await waitFile(revoking, 'running-revoke.txt'), 'entered')
    await pool.query("UPDATE pe_users SET role='ADMIN' WHERE id=$1", [bob.user.userId])
    const accounts = new AccountService(pool, identity, { platformOrigin: 'http://127.0.0.1:1', workspaceRoot: config.storageRoot,
      management: { maxUsers: 10, models: [{ id: 'trial-model', label: 'Trial', maxTokens: 1000 }], initialSettings: { model: 'trial-model', maxTokens: 1000 } },
      revokeExecutions: revokeAccountExecutions })
    const administrator = await accounts.login('bob', password)
    await accounts.update(administrator.token, { userId: alice.user.userId, requestId: randomUUID(), expectedRevision: 1, enabled: false })
    await assert.rejects(revoked)
    await assert.rejects(original.filesystem.readText(file))
    const bobFile = await other.filesystem.resolve('/workspace/bob-owned.txt'); await other.filesystem.writeText(bobFile, 'bob survives alice revoke')
    assert.equal(await other.filesystem.readText(bobFile), 'bob survives alice revoke')
    await original.close()
    const evidence = (await pool.query("SELECT state,pod_uid,first_stop_cause,stop_evidence FROM pe_native_execution_processes WHERE state='stopped'")).rows
    assert.ok(evidence.length >= 8); assert.ok(evidence.every(row => row.pod_uid === row.stop_evidence.podUid && row.stop_evidence.status === 'KUBELET_STOPPED'))
    const stale = await b.store.open(b.grant.token, b.grant.sessionId)
    await pool.query('UPDATE pe_workspaces SET binding_generation=binding_generation+1 WHERE id=$1', [stale.world.workspaceId])
    await assert.rejects(b.store.assert(b.grant.token, stale.world), error => error.code === 'native_world_generation_changed')
    await routes.dispose()
    assert.deepEqual(await pods.recover(100), [])
    await writeFile(config.evidenceFile, JSON.stringify({ database: name, passed: true, consumers, pipeEvidence, stream: { streamed, streamChunks }, evidence }, null, 2) + '\n', { mode: 0o600 })
  } finally {
    for (const binding of nativeBindings) await binding.close()
    if (broker) await broker.dispose()
    if (server) { server.closeAllConnections(); await new Promise(resolve => server.close(resolve)) }
    for (const runtime of runtimeContexts) await runtime.fiber.dispose()
    await ctx.fiber.dispose(); await pool.end(); await admin.query('DROP DATABASE "' + name + '"'); await admin.end()
  }
})
