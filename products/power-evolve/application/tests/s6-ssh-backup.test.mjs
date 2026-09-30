/** Real PG and CLI dump/restore; controlled kubectl and Runner, with no service startup. */
import assert from 'node:assert/strict'
import { execFile } from 'node:child_process'
import { createHash, randomBytes, randomUUID } from 'node:crypto'
import { mkdir, mkdtemp, readFile, rm, stat, writeFile } from 'node:fs/promises'
import { homedir } from 'node:os'
import { join } from 'node:path'
import { Readable } from 'node:stream'
import test from 'node:test'
import { fileURLToPath } from 'node:url'
import { promisify } from 'node:util'
import { Pool } from 'pg'
import { initializeDatabase } from '../lib/platform/database.js'
import { SshCallStore } from '../lib/platform/ssh-calls.js'
import { SshAuthenticationCheck } from '../lib/platform/ssh-check.js'
import { SshConnectionService } from '../lib/platform/ssh.js'
import { SshActionCipher, SshExecuteService } from '../lib/platform/ssh-execute.js'
import { TaskStore } from '../lib/platform/tasks.js'

const execute = promisify(execFile)
const root = fileURLToPath(new URL('../../../../', import.meta.url))
const script = join(root, 'products/power-evolve/scripts/backup-trial.mjs')
const stateTables = ['pe_ssh_connections', 'pe_ssh_configuration_versions', 'pe_ssh_credential_versions',
  'pe_ssh_calls', 'pe_ssh_execute_actions', 'pe_sessions', 'pe_events', 'pe_operations']

class Runner {
  posts = []
  cleaned = []
  async prepare(callId, destination) {
    return { callId, destination, podUid: randomUUID(), instanceId: randomUUID() }
  }
  digestFor(handle, request) {
    return createHash('sha256').update(JSON.stringify({ handle, request })).digest('hex')
  }
  async dispatchFirst(handle, request) {
    this.posts.push({ handle, request })
    if (request.kind === 'ssh.authenticate') return { state: 'uncertain', reason: 'dispatch_outcome_unknown' }
    return { state: 'known', status: { callId: handle.callId, instanceId: handle.instanceId,
      digest: this.digestFor(handle, request), state: 'failed', errorCode: 'ssh_timeout', effectMayHaveOccurred: true } }
  }
  async reconcile() { return { state: 'uncertain', reason: 'dispatched_call_missing' } }
  async cleanup(callId) { this.cleaned.push(callId) }
}

test('SSH quarantine backs up only after durable action, operation and Pod checks; restore preserves history without dispatch',
  { timeout: 90000, skip: process.platform === 'win32' && 'Trial backup requires POSIX permissions' }, async t => {
    const databaseUrl = (await readFile(join(process.env.PE_PRIVATE_DIR
      ?? join(homedir(), '.config/power-evolve/shared-host-native-s5'), 'database-url'), 'utf8')).trim()
    const directory = await mkdtemp(join(homedir(), '.config/power-evolve/s6-ssh-backup-'))
    const suffix = randomBytes(6).toString('hex')
    const trials = ['source', 'target'].map(name => `sshbackup-${suffix}-${name}`)
    const databases = ['source', 'target'].map(name => `pe_ssh_backup_${suffix}_${name}`)
    const privatePaths = trials.map(name => join(directory, name))
    const admin = new Pool({ connectionString: databaseUrl, max: 1 }), pools = [], created = []
    t.after(async () => {
      try {
        for (const pool of pools) await pool.end()
        for (const database of created) await admin.query(`DROP DATABASE "${database}"`)
      } finally {
        await admin.end()
        await rm(directory, { recursive: true, force: true })
        for (const trial of trials) await rm(join(root, '.artifacts/power-evolve', trial), { recursive: true, force: true })
      }
    })
    for (const [index, database] of databases.entries()) {
      await admin.query(`CREATE DATABASE "${database}"`); created.push(database)
      const url = new URL(databaseUrl); url.pathname = `/${database}`
      pools.push(new Pool({ connectionString: url.href, max: 4 }))
      await mkdir(privatePaths[index], { mode: 0o700 })
      await writeFile(join(privatePaths[index], 'database-url'), url.href, { mode: 0o600 })
    }
    const [source, target] = pools, [privateSource, privateTarget] = privatePaths
    await initializeDatabase(source)
    const storage = { format: 1, sharedRoot: privateSource, workspaceRoot: join(privateSource, 'workspaces'),
      artifactRoot: join(privateSource, 'artifacts'), skillLibraryRoot: join(privateSource, 'skill-library') }
    for (const path of [storage.workspaceRoot, storage.artifactRoot, join(privateSource, 'homes'),
      join(storage.skillLibraryRoot, 'skill-packages')]) await mkdir(path, { recursive: true, mode: 0o700 })
    await writeFile(join(privateSource, 'storage-layout.json'), JSON.stringify(storage), { mode: 0o600 })
    const key = randomBytes(32).toString('base64url')
    for (const [name, value] of Object.entries({ 'users.json': '[]', 'worker-token': 'fixture-worker',
      'connector-key': 'fixture-connector', 'model-key': 'fixture-model', 'model.env': 'DEEPSEEK_API_KEY=fixture-model\n',
      'ssh-credential-key': key })) await writeFile(join(privateSource, name), value, { mode: 0o600 })
    const ssh = { namespace: 'pe-connector-backup-test', kubeconfigFile: join(directory, 'synthetic-kubeconfig') }
    const sshPath = join(privateSource, 'ssh.json')
    await writeFile(sshPath, JSON.stringify(ssh), { mode: 0o600 })
    const bin = join(directory, 'bin'), control = join(directory, 'kube-control.json'), log = join(directory, 'kube-calls.jsonl')
    await mkdir(bin, { mode: 0o700 })
    await writeFile(join(bin, 'kubectl'), `#!${process.execPath}
import { appendFileSync, readFileSync } from 'node:fs'
appendFileSync(process.env.PE_BACKUP_TEST_LOG,JSON.stringify(process.argv.slice(2))+'\\n')
const mode=JSON.parse(readFileSync(process.env.PE_BACKUP_TEST_CONTROL,'utf8'))
if(mode.exit) process.exit(mode.exit)
process.stdout.write(JSON.stringify({items:mode.items ?? []}))
`, { mode: 0o700 })
    const configureKube = mode => writeFile(control, JSON.stringify(mode), { mode: 0o600 })
    await configureKube({ items: [] })
    const cli = async (command, index, bundle, overrides = {}) => execute(process.execPath, [script, command], {
      cwd: root, maxBuffer: 2 * 1024 * 1024, env: { ...process.env, PE_TRIAL_DATABASE: 'external',
        PE_BACKUP_KEEP_STOPPED: '1', PE_TRIAL_NAME: trials[index], PE_PRIVATE_DIR: privatePaths[index],
        PE_BACKUP_BUNDLE: bundle, PE_KUBE_CONTEXT: 'backup-test', PE_REMOTE_MCP_CONFIG_FILE: '',
        PATH: `${bin}:${process.env.PATH}`, PE_BACKUP_TEST_CONTROL: control, PE_BACKUP_TEST_LOG: log, ...overrides } })
    let blocked = 0
    const refuse = async (pattern, overrides = {}) => {
      const bundle = join(directory, `blocked-${++blocked}`)
      await assert.rejects(cli('create', 0, bundle, overrides), error => {
        assert.match(error.stderr, pattern)
        for (const secret of [databaseUrl, key, 'alice-private-password']) assert.equal(error.stderr.includes(secret), false)
        return true
      })
      await assert.rejects(stat(bundle), { code: 'ENOENT' })
    }
    const alice = { userId: randomUUID(), username: 'alice' }
    await source.query("INSERT INTO pe_users(id,username,password_hash,settings) VALUES($1,'alice','fixture',$2)",
      [alice.userId, { model: 'fixture', maxTokens: 64, revision: 1 }])
    await source.query("INSERT INTO pe_user_models(user_id,model_id,label,max_tokens,enabled) VALUES($1,'fixture','fixture',64,true)", [alice.userId])
    const connections = new SshConnectionService(source, key, 'fixture.example.test:2222')
    const password = Buffer.from('alice-private-password')
    const ticket = await connections.issueTicket(alice, { requestId: randomUUID(), displayName: 'Alice target',
      host: 'fixture.example.test', port: 2222, username: 'qa-alice', hostKeySha256: `SHA256:${'A'.repeat(43)}`,
      credentialKind: 'password', sizeBytes: password.length, enabled: true }, 'http://127.0.0.1:19221')
    const connection = (await connections.upload(ticket.ticket, Readable.from([password]))).item
    const limits = { maxEventBytes: 524288, leaseMs: 60000, maxPendingPerUser: 8, maxActivePerUser: 1, sshEnabled: true }
    const tasks = new TaskStore(source, limits), calls = new SshCallStore(source), runner = new Runner(), owner = randomUUID()
    const service = new SshExecuteService(tasks, calls, connections, runner, key, owner, 60000, 100, async () => '192.0.2.42')
    const { sessionId } = await tasks.create(alice, randomUUID())
    await tasks.accept(alice, sessionId, randomUUID(), 'Reviewed command fixture')
    const grant = await tasks.claim(randomUUID())
    const command = "printf 'effect may have happened'"
    const action = await service.propose(grant.token, 'backup-command', connection.connectionId, 1, 1, command)
    await tasks.finish(grant.token, 'completed', null)
    await service.decide(alice, action.actionId, action.fingerprint, true)
    await service.pump(await calls.claim(owner, 60000, 'ssh.execute'))
    await source.query("UPDATE pe_ssh_calls SET lease_until=now()-interval '1 second' WHERE id=$1", [action.actionId])
    await service.pump(await calls.claim(owner, 60000, 'ssh.execute'))
    const continuation = await tasks.claim(randomUUID())
    assert.equal(continuation.sourceSshExecuteActionId, action.actionId)
    assert.match(continuation.text, /远端执行结果不明，不得自动重试/u)
    await tasks.finish(continuation.token, 'completed', null)
    const authOptions = { ownerId: randomUUID(), requestKey: key, leaseMs: 60000, pollMs: 100, resolveHost: async () => '192.0.2.42' }
    const auth = new SshAuthenticationCheck(calls, connections, runner, authOptions)
    const authentication = await auth.submit(alice, { requestId: randomUUID(), connectionId: connection.connectionId, connectionRevision: 1 })
    await auth.pump()
    await source.query("UPDATE pe_ssh_calls SET created_at=now()-interval '6 minutes',lease_until=now()-interval '1 second' WHERE id=$1", [authentication.callId])
    await auth.pump()
    assert.equal(runner.posts.length, 2)
    assert.deepEqual((await source.query('SELECT state,cleanup_complete FROM pe_ssh_calls ORDER BY id')).rows,
      [{ state: 'uncertain', cleanup_complete: true }, { state: 'uncertain', cleanup_complete: true }])

    await t.test('unfinished cleanup and nonterminal or missing execute actions refuse backup', async () => {
      for (const callId of [authentication.callId, action.actionId]) {
        await source.query('UPDATE pe_ssh_calls SET cleanup_complete=false WHERE id=$1', [callId])
        await refuse(/no active operations/u)
        await source.query('UPDATE pe_ssh_calls SET cleanup_complete=true WHERE id=$1', [callId])
      }
      for (const state of ['approved', 'pending', 'succeeded']) {
        await source.query('UPDATE pe_ssh_execute_actions SET state=$1 WHERE id=$2', [state, action.actionId])
        await refuse(/no active operations/u)
      }
      await source.query("UPDATE pe_ssh_execute_actions SET state='approved' WHERE id=$1", [action.actionId])
      await source.query("UPDATE pe_ssh_calls SET state='succeeded' WHERE id=$1", [action.actionId])
      await refuse(/no active operations/u)
      await source.query("UPDATE pe_ssh_calls SET state='uncertain' WHERE id=$1", [action.actionId])
      await source.query("UPDATE pe_ssh_execute_actions SET state='uncertain' WHERE id=$1", [action.actionId])
      const original = (await calls.get(alice, action.actionId)).request_digest
      await source.query('UPDATE pe_ssh_calls SET request_digest=$1 WHERE id=$2', ['0'.repeat(64), action.actionId])
      await refuse(/no active operations/u)
      await source.query('UPDATE pe_ssh_calls SET request_digest=$1 WHERE id=$2', [original, action.actionId])
      // A mismatched action ID is indistinguishable from a missing corresponding action to preflight.
      await source.query('UPDATE pe_ssh_calls SET id=$1 WHERE id=$2', [randomUUID(), action.actionId])
      await refuse(/no active operations/u)
      await source.query("UPDATE pe_ssh_calls SET id=$1 WHERE kind='ssh.execute'", [action.actionId])
      for (const state of ['accepted', 'preparing', 'ready', 'dispatch-intent', 'running']) {
        await source.query('UPDATE pe_ssh_calls SET state=$1 WHERE id=$2', [state, action.actionId])
        await refuse(/no active operations/u)
      }
      await source.query("UPDATE pe_ssh_calls SET state='uncertain' WHERE id=$1", [action.actionId])
    })
    await t.test('queued and running result continuations still block backup', async () => {
      for (const state of ['queued', 'running']) {
        await source.query('UPDATE pe_operations SET state=$1 WHERE id=$2', [state, continuation.operationId])
        await refuse(/no active operations/u)
      }
      await source.query("UPDATE pe_operations SET state='completed' WHERE id=$1", [continuation.operationId])
    })
    await t.test('cleanup flags do not bypass configuration, context, Pod absence or credential-key evidence', async () => {
      await refuse(/PE_KUBE_CONTEXT/u, { PE_KUBE_CONTEXT: '' })
      for (const pod of [{ metadata: { name: 'pe-cr-active' } },
        { metadata: { name: 'pe-cr-canary-check', deletionTimestamp: '2026-10-01T00:00:00Z' } }]) {
        await configureKube({ items: [pod] }); await refuse(/Connector Runner Pods remain active/u)
      }
      await configureKube({ exit: 1 }); await refuse(/kubectl.*failed/u)
      await configureKube({ items: [] })
      await rm(sshPath); await refuse(/Quarantined SSH calls require/u)
      await writeFile(sshPath, JSON.stringify(ssh), { mode: 0o600 })
      await rm(join(privateSource, 'ssh-credential-key')); await refuse(/Existing SSH history requires its credential key/u)
      await writeFile(join(privateSource, 'ssh-credential-key'), key, { mode: 0o600 })
    })
    const before = await Promise.all(stateTables.map(async table => (await source.query(`SELECT * FROM ${table} ORDER BY 1`)).rows))
    const bundle = join(directory, 'quarantined-backup')
    await cli('create', 0, bundle)
    const kubeCalls = (await readFile(log, 'utf8')).trim().split('\n').map(line => JSON.parse(line))
    assert(kubeCalls.length > 0)
    for (const args of kubeCalls) assert.deepEqual(args, ['--kubeconfig', ssh.kubeconfigFile,
      '--context', 'backup-test', '-n', ssh.namespace, 'get', 'pods', '-o', 'json'])
    await cli('restore', 1, bundle)
    for (const [index, table] of stateTables.entries()) assert.deepEqual((await target.query(`SELECT * FROM ${table} ORDER BY 1`)).rows, before[index])
    const restoredKey = (await readFile(join(privateTarget, 'ssh-credential-key'), 'utf8')).trim()
    assert.equal(restoredKey, key)
    assert.equal((await stat(join(privateTarget, 'ssh-credential-key'))).mode & 0o777, 0o600)
    const restoredConnections = new SshConnectionService(target, restoredKey, 'fixture.example.test:2222')
    assert.deepEqual((await restoredConnections.credentialForCall(alice, connection.connectionId, 1)).credential,
      { kind: 'password', password: password.toString() })
    const restoredAction = (await target.query('SELECT * FROM pe_ssh_execute_actions WHERE id=$1', [action.actionId])).rows[0]
    assert.equal(new SshActionCipher(restoredKey).open(restoredAction, 'command', restoredAction.command_sealed), command)
    const restoredCalls = new SshCallStore(target)
    for (const kind of ['ssh.execute', 'ssh.authenticate']) assert.equal(await restoredCalls.claim(randomUUID(), 60000, kind), null)
    const restoredTasks = new TaskStore(target, limits)
    assert.equal(await restoredTasks.claim(randomUUID()), null)
    const forbiddenRunner = new Proxy({}, { get: () => () => { assert.fail('Restored quarantine must never access a Runner') } })
    const restoredAuth = new SshAuthenticationCheck(restoredCalls, restoredConnections, forbiddenRunner, authOptions)
    assert.equal(await restoredAuth.pump(), false)
    const restoredService = new SshExecuteService(restoredTasks, restoredCalls, restoredConnections,
      forbiddenRunner, restoredKey, randomUUID(), 60000, 100)
    await restoredService.reconcileTerminals()
    assert.equal((await restoredService.status(alice, action.actionId)).state, 'uncertain')
    for (const [index, table] of stateTables.entries()) assert.deepEqual((await target.query(`SELECT * FROM ${table} ORDER BY 1`)).rows, before[index])
    assert.equal((await target.query("SELECT count(*)::integer AS n FROM pe_operations WHERE source='ssh_execute_result'")).rows[0].n, 1)
    assert.equal(JSON.parse(await readFile(join(privateTarget, 'restore-evidence.json'), 'utf8')).keptStopped, true)
  })
