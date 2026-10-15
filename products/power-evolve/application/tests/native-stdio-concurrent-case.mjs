/** Built PG and native gVisor STDIO concurrency in an explicitly owned namespace and storage prefix. */
import assert from 'node:assert/strict'
import { test } from 'node:test'
import { randomBytes, randomUUID } from 'node:crypto'
import { mkdir, readFile, stat, writeFile } from 'node:fs/promises'
import { join } from 'node:path'
import { setTimeout as delay } from 'node:timers/promises'
import { Pool } from 'pg'
import { Context } from '@deepseek-ai/cordis'
import { Session } from '@deepseek-ai/dsh-session'
import { initializeDatabase } from '../lib/platform/database.js'
import { seedNewUser } from '../lib/platform/account-settings.js'
import { hashPassword, IdentityService } from '../lib/platform/identity.js'
import { FileService } from '../lib/platform/files.js'
import { TaskStore } from '../lib/platform/tasks.js'
import { NativeCloudCommands } from '../lib/platform/native-cloud-commands.js'
import { ExecutionService } from '../lib/platform/executions.js'
import { EventStore } from '../lib/platform/events.js'
import { NativeWorkspaceRead } from '../lib/platform/native-workspace-read.js'
import { StdioOperationAdmissionV2 } from '../lib/platform/stdio-v2-operation-admission.js'
import { createStdioCloudServicesV2 } from '../lib/platform/stdio-v2-services.js'
import { installNativeExecutionPlatform } from '../lib/platform/native-execution-platform.js'
import { readNativeRuntimePolicy } from '../lib/platform/native-runtime-policy.js'
import { kubernetesPodStopStatus } from '../lib/platform/pod-stop-status.js'

const input = process.env.PE_NATIVE_STDIO_PHYSICAL_INPUT
if (!input) throw new Error('PE_NATIVE_STDIO_PHYSICAL_INPUT must name the owned physical configuration')
const config = JSON.parse(await readFile(input, 'utf8'))
const limits = { runtimeMs: 90_000, requestMs: 80_000, stdinGraceMs: 100, terminateGraceMs: 1000, killGraceMs: 3000,
  maxInputBytes: 262144, maxMessageBytes: 32768, maxProtocolBytes: 262144, maxProtocolMessages: 100,
  maxJsonDepth: 64, maxJsonNodes: 10000, maxPages: 8, maxTools: 32, maxCatalogBytes: 65536,
  maxToolBytes: 16384, maxResultBytes: 32768, maxStderrBytes: 4096 }
const management = { maxNameBytes: 80, maxConnections: 16, pageItems: 16 }
const admission = { maxConnections: 16, maxTools: 32, maxSnapshotBytes: 1048576, maxDescriptionBytes: 4096 }
const history = { maxHistoryEvents: 1000, maxHistoryBytes: 8388608, maxEventBytes: 524288 }

const peer = `import { createInterface } from 'node:readline';
import { writeFile, access } from 'node:fs/promises';
import { setTimeout as delay } from 'node:timers/promises';
const id=process.argv[2];
const reply=(request,result)=>process.stdout.write(JSON.stringify({jsonrpc:'2.0',id:request.id,result})+'\\n');
for await(const line of createInterface({input:process.stdin})){
 const request=JSON.parse(line);if(request.id===undefined)continue;
 if(request.method==='initialize')reply(request,{protocolVersion:request.params.protocolVersion,
  capabilities:{tools:{}},serverInfo:{name:'owned-concurrent-peer',version:'1'}});
 else if(request.method==='tools/list'){
  await writeFile(id+'.started','started');
  for(;;){try{await access(id+'.release');break}catch{}await delay(100)}
  reply(request,{tools:[{name:'echo',inputSchema:{type:'object',properties:{text:{type:'string'}},additionalProperties:false}}]});
 }else if(request.method==='ping')reply(request,{});else throw new Error('Unexpected owned peer method');
}`


async function until(run, label, ms = 120000) {
  const deadline = Date.now() + ms
  for (;;) {
    const value = await run()
    if (value) return value
    assert.ok(Date.now() < deadline, label + ' did not become observable')
    await delay(100)
  }
}
const exists = path => stat(path).then(() => true, (error) => { if (error.code === 'ENOENT') return false; throw error })

test('same-account STDIO Pods overlap, retain shared project bytes and cancel only their original UID', { timeout: 300000 }, async () => {
  const connection = new URL((await readFile(config.databaseUrlFile, 'utf8')).trim())
  const admin = new Pool({ connectionString: connection.href, max: 1 })
  const database = 'pe_native_stdio_' + randomUUID().replaceAll('-', '')
  await admin.query('CREATE DATABASE "' + database + '"')
  connection.pathname = '/' + database
  const pool = new Pool({ connectionString: connection.href, max: 16 })
  const ctx = new Context(), stop = new AbortController(), evidence = { database, namespace: config.pods.namespace, checks: [] }
  let physical, services, commands, running, safe = false
  try {
    await initializeDatabase(pool)
    const password = randomUUID()
    await seedNewUser(pool, 'native-stdio-owner', await hashPassword(password), { model: 'trial-model', maxTokens: 1000, revision: 1 })
    const identities = new IdentityService(pool, 600000), account = await identities.login('native-stdio-owner', password)
    const approval = await identities.login('native-stdio-owner', password, 'approval')
    const files = new FileService(pool, config.storageRoot, { uid: 1000, gid: 1000 }); await files.init()
    const selection = new StdioOperationAdmissionV2(files, { limits, admission, maxReplyBytes: 1048576,
      cloudDeployment: config.deployment })
    const tasks = new TaskStore(pool, { maxEventBytes: history.maxEventBytes, leaseMs: 120000,
      maxPendingPerUser: 16, maxActivePerUser: 4, executionEnabled: true, stdioV2Admission: { selection, reservedNames: [] } })
    physical = await installNativeExecutionPlatform(ctx, pool, tasks, files.storage, readNativeRuntimePolicy, config.nativeConfigFile)
    const forbidden = () => { throw new Error('Native execution reached the legacy user mount slot') }
    const legacy = { ensureReady: forbidden, cancelCreation: forbidden, observeReady: forbidden,
      captureStdioV2: forbidden, runnerBounded: forbidden, recycleIdle: async () => {} }
    services = createStdioCloudServicesV2(pool, tasks, selection, files,
      legacy,
      { approvalKey: randomBytes(32), settings: { limits, management, admission, cloudDeployment: config.deployment,
        maxReplyBytes: 1048576, maxPendingPerUser: 16, maxCallsPerChain: 8, chainLifetimeMs: 300000, approvalLifetimeMs: 180000,
        worker: { pollMs: 100, renewMs: 1000, leaseMs: 20000, maxActive: 3, maxCandidates: 32 },
        transport: { requestTimeoutMs: 10000, maxTrackedActions: 64 } } }, randomUUID(), physical)
    const workspaces = new NativeWorkspaceRead(pool, files, 16, 128)
    const project = await workspaces.create(account.user, randomUUID(), 'Parallel project', account.token)
    const another = await workspaces.create(account.user, randomUUID(), 'Independent project', account.token)
    const events = new EventStore(tasks, history)
    const create = async (id, workspaceId) => {
      const session = await tasks.create(account.user, randomUUID(), account.token, workspaceId)
      await tasks.accept(account.user, session.sessionId, randomUUID(), 'Configure native sandbox policy', account.token)
      const worker = randomUUID(), grant = await until(() => tasks.claim(worker), 'original Session grant')
      assert.equal(grant.sessionId, session.sessionId)
      const header = (await pool.query('SELECT header FROM pe_sessions WHERE id=$1', [session.sessionId])).rows[0].header
      const native = Session.create(header.id, undefined, header)
      await events.append(grant.token, [native.append('sandbox/mode', { mode: 'workspace-write' })])
      await tasks.finish(grant.token, 'completed', null)
      const path = (await files.workspaceForId(account.user.userId, workspaceId)).path
      await writeFile(join(path, '.owned-native-stdio-peer.mjs'), peer, { mode: 0o644 })
      const connection = await services.connections.create(account.token, { requestId: randomUUID(), configuration: {
        name: id, invocation: { program: 'node', argv: ['/workspace/.owned-native-stdio-peer.mjs', id], cwd: '.' } } })
      const action = await services.discovery.check(account.token, { requestId: randomUUID(), connectionId: connection.connectionId,
        expectedRevision: 1, sessionId: session.sessionId, target: { kind: 'cloud' } })
      return { id, sessionId: session.sessionId, actionId: action.actionId, path }
    }
    running = services.worker.run(stop.signal)
    const state = async action => (await pool.query('SELECT state FROM pe_stdio_v2_actions WHERE id=$1', [action.actionId])).rows[0].state
    const approve = async (action) => {
      const row = await until(async () => (await pool.query('SELECT fingerprint FROM pe_stdio_v2_preparations WHERE action_id=$1',
        [action.actionId])).rows[0], 'original preparation')
      await services.authorization.decide(approval.token, { actionId: action.actionId, fingerprint: row.fingerprint, decision: 'once' })
    }
    const active = async action => (await pool.query(`SELECT p.pod_name,p.pod_uid,p.state,p.stop_evidence,p.first_stop_cause
      FROM pe_native_stdio_executions n JOIN pe_native_execution_processes p ON p.id=n.process_id WHERE n.action_id=$1`,
    [action.actionId])).rows[0]
    const pair = async (sameProject, cancel) => {
      const first = await create('a-' + randomUUID(), project.workspaceId)
      const second = await create('b-' + randomUUID(), sameProject ? project.workspaceId : another.workspaceId)
      await Promise.all([approve(first), approve(second)])
      await Promise.all([first, second].map(action => until(() => exists(join(action.path, action.id + '.started')), 'both programs running')))
      const [a, b] = await Promise.all([active(first), active(second)])
      assert.equal(a.state, 'running'); assert.equal(b.state, 'running'); assert.notEqual(a.pod_uid, b.pod_uid)
      assert.equal((await pool.query('SELECT * FROM pe_mount_slots')).rowCount, 0)
      assert.equal((await pool.query('SELECT * FROM pe_sandbox_instances')).rowCount, 0)
      if (cancel) {
        await services.actions.cancel(account.token, { actionId: first.actionId })
        await until(async () => (await active(first)).state === 'stopped', 'cancelled exact Pod stopped')
        const sibling = await active(second)
        assert.equal(sibling.state, 'running'); assert.equal(sibling.pod_uid, b.pod_uid)
      } else {
        await writeFile(join(first.path, first.id + '.release'), 'release', { mode: 0o644 })
        await until(async () => await state(first) === 'succeeded', 'first complete result')
        const sibling = await active(second)
        assert.equal(sibling.state, 'running'); assert.equal(sibling.pod_uid, b.pod_uid)
      }
      await writeFile(join(second.path, second.id + '.release'), 'release', { mode: 0o644 })
      await until(async () => await state(second) === 'succeeded', 'second complete result')
      if (cancel) {
        await until(async () => ['cancelled', 'blocked'].includes(await state(first)), 'cancelled result or retained uncertainty')
        const count = (await pool.query('SELECT count(*)::integer AS count FROM pe_native_execution_processes WHERE id IN (SELECT process_id FROM pe_native_stdio_executions WHERE action_id=$1)',
          [first.actionId])).rows[0].count
        assert.equal(count, 1)
      }
      evidence.checks.push({ sameProject, cancel, first: await active(first), second: await active(second) })
    }
    await pair(true, false)
    await pair(false, true)
    const shutdown = await create('shutdown-' + randomUUID(), project.workspaceId)
    await approve(shutdown)
    await until(() => exists(join(shutdown.path, shutdown.id + '.started')), 'original shutdown process running')
    commands = new ExecutionService(tasks, legacy, 2, 100, 60000, 90000, 20000,
      new NativeCloudCommands(pool, physical, randomBytes(32), 90000, 20000))
    const cloudCommand = async () => {
      const session = await tasks.create(account.user, randomUUID(), account.token, project.workspaceId)
      await tasks.accept(account.user, session.sessionId, randomUUID(), 'Concurrent native cloud command', account.token)
      const worker = randomUUID(), grant = await until(() => tasks.claim(worker), 'original Session grant')
      assert.equal(grant.sessionId, session.sessionId)
      const header = (await pool.query('SELECT header FROM pe_sessions WHERE id=$1', [session.sessionId])).rows[0].header
      const native = Session.create(header.id, undefined, header), id = randomUUID()
      await events.append(grant.token, [native.append('sandbox/mode', { mode: 'workspace-write' })])
      const script = "const fs=require('fs');fs.writeFileSync('" + id + ".started','started');const t=setInterval(()=>{if(fs.existsSync('"
        + id + ".release')){clearInterval(t);process.stdout.write('original-command-'+'" + id + "')}},100)"
      const command = 'node -e ' + JSON.stringify('eval(Buffer.from("' + Buffer.from(script).toString('base64') + '","base64").toString())')
      const receipt = await commands.propose(grant.token, randomUUID(), command, '')
      await tasks.finish(grant.token, 'completed', null)
      return { id, executionId: receipt.executionId, path: (await files.workspaceForId(account.user.userId, project.workspaceId)).path }
    }
    const a = await cloudCommand(), b = await cloudCommand()
    commands.start()
    await Promise.all([a, b].map(action => until(() => exists(join(action.path, action.id + '.started')), 'both cloud commands running')))
    const process = async action => (await pool.query('SELECT id,pod_uid,state,stop_evidence FROM pe_native_execution_processes WHERE id=$1',
      [action.executionId])).rows[0]
    const originals = await Promise.all([process(a), process(b)])
    assert.notEqual(originals[0].pod_uid, originals[1].pod_uid)
    await writeFile(join(a.path, a.id + '.release'), 'release')
    await until(async () => (await pool.query('SELECT state FROM pe_cloud_executions WHERE id=$1', [a.executionId])).rows[0].state === 'succeeded',
      'first cloud command complete')
    assert.equal((await process(b)).state, 'running'); assert.equal((await process(b)).pod_uid, originals[1].pod_uid)
    // Inject only a lost command observation; the independent approval must stop the original running UID without replay.
    await pool.query("UPDATE pe_cloud_executions SET state='uncertain' WHERE id=$1", [b.executionId])
    const inspection = await commands.inspectResolution(account.user, b.executionId)
    assert.equal(inspection.canStop, true); assert.ok(inspection.fingerprint)
    const resolution = { requestId: randomUUID(), executionId: b.executionId, target: 'cloud',
      fingerprint: inspection.fingerprint, note: 'Owned original UID reconciliation' }
    await commands.resolveUncertain(account.user, resolution, approval.token)
    await until(async () => (await process(b)).state === 'stopped', 'approved cloud command exact stopped')
    await until(async () => (await commands.resolutionStatus(account.user, resolution.requestId)).receipt?.state === 'completed',
      'independently approved original reconciliation')
    assert.equal((await pool.query('SELECT state FROM pe_cloud_executions WHERE id=$1', [b.executionId])).rows[0].state, 'closed_unknown')
    evidence.cloudResolution = await commands.resolutionStatus(account.user, resolution.requestId)
    assert.equal((await pool.query('SELECT * FROM pe_mount_slots')).rowCount, 0)
    assert.equal((await pool.query('SELECT * FROM pe_sandbox_instances')).rowCount, 0)
    evidence.cloudCommands = await Promise.all([process(a), process(b)])
    assert.equal((await active(shutdown)).state, 'running', 'The original SDK range must still be active before shutdown')
    const closingAt = Date.now()
    await services.close(); await running
    evidence.shutdownMs = Date.now() - closingAt
    assert.ok(evidence.shutdownMs < 45000, 'Shutdown did not interrupt and join the original active range')
    assert.equal((await active(shutdown)).state, 'stopped')
    const nodes = await physical.pods.recover(100)
    assert.deepEqual(nodes, [])
    evidence.nativeServiceCount = (await pool.query('SELECT count(*)::integer AS count FROM pe_native_execution_services')).rows[0].count
    evidence.mountSlots = (await pool.query('SELECT count(*)::integer AS count FROM pe_mount_slots')).rows[0].count
    evidence.status = 'passed'
  } finally {
    stop.abort()
    const results = await Promise.allSettled([services?.close(), running, commands?.close()])
    const cleanup = await Promise.allSettled([physical?.close(), ctx.fiber.dispose()])
    evidence.cleanupErrors = [...results, ...cleanup].filter(item => item.status === 'rejected').map(item => String(item.reason))
    try {
      evidence.originals = (await pool.query('SELECT id,world_id,pod_name,pod_uid,state,stop_evidence FROM pe_native_execution_processes')).rows
      safe = evidence.cleanupErrors.length === 0 && evidence.originals.every(row => row.state === 'stopped'
        && row.stop_evidence?.resourceReleased === true && row.stop_evidence.podUid === row.pod_uid
        && row.stop_evidence.worldId === row.world_id && row.stop_evidence.processId === row.id
        && kubernetesPodStopStatus(row.stop_evidence.observation) === row.stop_evidence.status)
      evidence.quiescent = safe
      await mkdir(config.evidenceRoot, { recursive: true, mode: 0o700 })
      await writeFile(join(config.evidenceRoot, 'native-stdio-evidence.json'), JSON.stringify(evidence, null, 2) + '\n', { mode: 0o600 })
    } finally {
      await pool.end()
      if (safe) await admin.query('DROP DATABASE "' + database + '"')
      await admin.end()
    }
    assert.equal(safe, true, 'Uncertain native resources require retained-database reconciliation')
  }
})
