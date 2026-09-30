/** Real PG migrations and CLI dump/restore on an existing server; no model or remote tool is started. */
import test from 'node:test'
import assert from 'node:assert/strict'
import { randomBytes, randomUUID } from 'node:crypto'
import { execFile, spawnSync } from 'node:child_process'
import { promisify } from 'node:util'
import { mkdtemp, mkdir, readFile, writeFile, rm, stat, chmod, symlink, readdir, cp } from 'node:fs/promises'
import { homedir } from 'node:os'
import { join } from 'node:path'
import { fileURLToPath } from 'node:url'
import { Pool, Client } from 'pg'
import { initializeDatabase, transaction } from '../lib/platform/database.js'
import * as migrations from '../lib/platform/schema.js'
import { McpConnectionService } from '../lib/platform/mcp-connections.js'
import { seedV21Session, seedV22Mcp } from './legacy-mcp-backup-fixture.mjs'
import { McpCredentialCipher } from '../lib/platform/mcp-credentials.js'
import { McpActionFixtureStore as McpActionStore } from './task-credential-fixture.mjs'
import { selectMcpOperationTools } from '../lib/platform/mcp-admission.js'
import { TaskFixtureStore as TaskStore } from './task-credential-fixture.mjs'
import { loadMcpPlatformConfig } from '../lib/platform/mcp-platform-config.js'
import { requireSeparateBackupPaths, runningBackupTargets, dumpBackupDatabase,
  backupDatabaseIdentity, requireEmptyBackupDatabase } from '../../scripts/backup-support.mjs'

const execute = promisify(execFile)
const root = fileURLToPath(new URL('../../../../', import.meta.url))
const script = join(root, 'products/power-evolve/scripts/backup-trial.mjs')
const management = { maxConnections: 8, maxPendingTickets: 8, maxActiveChecks: 8,
  maxDrafts: 8, maxDraftsPerHour: 16, maxTools: 8, maxCatalogBytes: 65536, maxToolBytes: 16384,
  ticketLifetimeMs: 300000, checkLifetimeMs: 60000, draftLifetimeMs: 120000, retentionMs: 3600000, checkLeaseMs: 30000 }
const admission = { maxTools: 8, maxSnapshotBytes: 131072, maxToolBytes: 16384, maxDescriptionBytes: 4096 }
const actions = { maxArgumentBytes: 8192, maxResultBytes: 32768, maxCallsPerChain: 8,
  maxPendingPerUser: 8, chainLifetimeMs: 300000, approvalLifetimeMs: 300000, leaseMs: 30000, listLimit: 50 }
const transport = { timeoutMs: 10000, idleTimeoutMs: 5000, maxRequestBytes: 65536,
  maxResponseBytes: 65536, maxTotalResponseBytes: 262144, maxResponseHeaderBytes: 16384,
  maxRequests: 32, maxHeaderBytes: 8192, maxHeaders: 16, maxPages: 4, maxTools: 8, maxCatalogBytes: 65536 }
const taskLimits = { maxEventBytes: 524288, leaseMs: 30000, maxPendingPerUser: 16,
  maxActivePerUser: 2, remoteMcpAdmission: admission }

async function legacyRows(pool) {
  return {
    users: (await pool.query('SELECT id,username,settings FROM pe_users ORDER BY id')).rows,
    sessions: (await pool.query('SELECT id,user_id,workspace_id,header,event_count,event_bytes FROM pe_sessions ORDER BY id')).rows,
    events: (await pool.query('SELECT * FROM pe_events ORDER BY session_id,seq')).rows,
    connections: (await pool.query('SELECT * FROM pe_mcp_connections ORDER BY id')).rows,
    operations: (await pool.query('SELECT id,session_id,input,state,mcp_selection,source FROM pe_operations ORDER BY id')).rows,
  }
}

async function restoreTargetObjects(pool) {
  return (await pool.query(`SELECT
    (SELECT coalesce(jsonb_agg(to_jsonb(c) ORDER BY c.oid),'[]') FROM pg_class c WHERE c.oid>=16384) AS relations,
    (SELECT coalesce(jsonb_agg(to_jsonb(t) ORDER BY t.oid),'[]') FROM pg_type t WHERE t.oid>=16384) AS types,
    (SELECT coalesce(jsonb_agg(to_jsonb(l) ORDER BY l.oid),'[]') FROM pg_largeobject_metadata l) AS large_objects,
    (SELECT coalesce(jsonb_agg(jsonb_build_object('oid',loid,'page',pageno,'data',encode(data,'hex')) ORDER BY loid,pageno),'[]')
      FROM pg_largeobject) AS large_object_bytes`)).rows[0]
}

test('external backup preserves V21 history, V22 MCP versions, V23 outcomes and private operator files',
  { timeout: 90000, skip: process.platform === 'win32' && 'Trial backup requires POSIX permissions and signals' }, async t => {
    const sourceUrlFile = join(process.env.PE_PRIVATE_DIR
      ?? join(homedir(), '.config/power-evolve/shared-host-s6-mcp-dev'), 'database-url')
    const databaseUrl = (await readFile(sourceUrlFile, 'utf8')).trim()
    const directory = await mkdtemp(join(homedir(), '.config/power-evolve/s6-mcp-backup-'))
    const suffix = randomBytes(6).toString('hex')
    const names = ['source', 'seed22', 'target'].map(name => `s6backup-${suffix}-${name}`)
    const databases = ['source', 'seed22', 'target'].map(name => `pe_mcp_backup_${suffix}_${name}`)
    const urls = [], pools = [], acquired = []
    const privatePaths = names.map(name => join(directory, name))
    const admin = new Pool({ connectionString: databaseUrl, max: 1 })
    t.after(async () => {
      for (const pool of pools) await pool.end()
      for (const database of acquired) await admin.query(`DROP DATABASE "${database}"`)
      await admin.end()
      await rm(directory, { recursive: true, force: true })
      for (const name of names) await rm(join(root, '.artifacts/power-evolve', name), { recursive: true, force: true })
    })
    for (const [index, database] of databases.entries()) {
      await admin.query(`CREATE DATABASE "${database}"`); acquired.push(database)
      const url = new URL(databaseUrl); url.pathname = `/${database}`
      urls.push(url.href); pools.push(new Pool({ connectionString: url.href, max: 2 }))
      await mkdir(privatePaths[index], { mode: 0o700 })
      await writeFile(join(privatePaths[index], 'database-url'), url.href, { mode: 0o600 })
    }
    const [source, seed22, target] = pools
    const privateSource = privatePaths[0]
    const storage = { format: 1, sharedRoot: privateSource, workspaceRoot: join(privateSource, 'workspaces'),
      artifactRoot: join(privateSource, 'artifacts'), skillLibraryRoot: join(privateSource, 'skill-library') }
    for (const path of [storage.workspaceRoot, storage.artifactRoot, join(privateSource, 'homes'),
      join(storage.skillLibraryRoot, 'skill-packages')]) await mkdir(path, { recursive: true, mode: 0o700 })
    await writeFile(join(privateSource, 'storage-layout.json'), JSON.stringify(storage), { mode: 0o600 })
    const marker = Buffer.from('original Workspace\0表😀')
    await writeFile(join(storage.workspaceRoot, 'marker'), marker, { mode: 0o640 })
    for (const [name, value] of Object.entries({ 'users.json': '[]', 'worker-token': 'fixture-worker',
      'connector-key': 'fixture-connector', 'model-key': 'fixture-model', 'model.env': 'DEEPSEEK_API_KEY=fixture-model\n' })) {
      await writeFile(join(privateSource, name), value, { mode: 0o600 })
    }
    const key = randomBytes(32).toString('base64url')
    const keyPath = join(privateSource, 'original-key'), caPath = join(privateSource, 'original-ca.pem')
    await writeFile(keyPath, key, { mode: 0o600 })
    const certificate = spawnSync('openssl', ['req', '-x509', '-newkey', 'rsa:2048', '-nodes',
      '-keyout', join(directory, 'tls-key'), '-out', caPath, '-days', '1', '-subj', '/CN=mcp-backup-fixture'],
    { encoding: 'utf8' })
    assert.equal(certificate.status, 0, 'OpenSSL must produce the synthetic CA fixture')
    await chmod(caPath, 0o600)
    const config = { credentialKeyFile: keyPath, pollMs: 100, renewMs: 1000, cleanupMs: 1000, cleanupBatchSize: 8,
      management, admission, actions, transport,
      internalExceptions: [{ origin: 'https://fixture.example.test', addresses: ['127.0.0.1'], caFile: caPath }] }
    const configPath = join(privateSource, 'original-config.json')
    await writeFile(configPath, JSON.stringify(config), { mode: 0o600 })
    const env = { ...process.env, PE_TRIAL_DATABASE: 'external', PE_BACKUP_KEEP_STOPPED: '1' }
    const cli = async (command, index, bundle, overrides = {}) => {
      const result = await execute(process.execPath, [script, command], { cwd: root,
        env: { ...env, PE_TRIAL_NAME: names[index], PE_PRIVATE_DIR: privatePaths[index],
          PE_BACKUP_BUNDLE: bundle, ...overrides }, maxBuffer: 2 * 1024 * 1024 })
      assert.equal((result.stdout + result.stderr).includes(databaseUrl), false, 'No database URL reaches diagnostics')
      assert.equal((result.stdout + result.stderr).includes(key), false, 'No sealing key reaches diagnostics')
      return result
    }
    const refused = async (command, index, bundle, pattern, overrides = {}) => {
      await assert.rejects(cli(command, index, bundle, overrides), error => {
        assert.match(error.stderr, pattern)
        assert.equal(error.stderr.includes(databaseUrl), false)
        assert.equal(error.stderr.includes(key), false)
        return true
      })
    }
    await source.query(migrations.schema); await source.query('INSERT INTO pe_schema(version) VALUES(1)')
    for (let version = 2; version <= 21; version++) await source.query(migrations[`schemaV${version}`])
    const owner = { userId: randomUUID(), username: 'alice' }
    await source.query("INSERT INTO pe_users(id,username,password_hash,settings) VALUES($1,$2,'fixture',$3)",
      [owner.userId, owner.username, { model: 'fixture', maxTokens: 64, revision: 1 }])
    await source.query("INSERT INTO pe_user_models(user_id,model_id,label,max_tokens,enabled) VALUES($1,'fixture','fixture',64,true)", [owner.userId])
    const { sessionId } = await seedV21Session(source, owner)
    const fixedId = randomUUID(), oldOperation = randomUUID()
    await source.query('INSERT INTO pe_mcp_connections(id,user_id,install_request_id,name) VALUES($1,$2,$3,$4)',
      [fixedId, owner.userId, randomUUID(), 'legacy whoami'])
    await source.query(`INSERT INTO pe_operations(id,session_id,request_id,input,settings,state,mcp_selection)
      VALUES($1,$2,$3,'original task',$4,'completed',$5)`,
    [oldOperation, sessionId, randomUUID(), { model: 'fixture', maxTokens: 64, revision: 1 }, JSON.stringify([{ connectionId: fixedId, revision: 1 }])])
    const event = { seq: 0, time: 1, type: 'session/end-seed', data: {} }
    await source.query('INSERT INTO pe_events(session_id,seq,event) VALUES($1,0,$2)', [sessionId, JSON.stringify(event)])
    await source.query('UPDATE pe_sessions SET event_count=1,event_bytes=$2 WHERE id=$1',
      [sessionId, Buffer.byteLength(JSON.stringify(event))])
    const old = await legacyRows(source), preBundle = join(directory, 'pre-v22')
    await t.test('a real pre-upgrade dump restores V21; existing Session and fixed whoami survive current migrations', async () => {
      await cli('create', 0, preBundle, { PE_REMOTE_MCP_CONFIG_FILE: configPath, PE_BACKUP_KEEP_STOPPED: '' })
      assert.deepEqual(await runningBackupTargets(join(root, '.artifacts/power-evolve', names[0], 'trial')), [])
      assert.equal((await readdir(privatePaths[0])).includes('profiles'), false)
      const manifest = JSON.parse(await readFile(join(preBundle, 'manifest.json'), 'utf8'))
      assert.equal(manifest.schema, 21)
      assert(manifest.files.every(file => file.kind !== 'file' || Number.isInteger(file.mode)))
      await cli('restore', 1, preBundle)
      assert.equal((await seed22.query('SELECT version FROM pe_schema')).rows[0].version, 21)
      assert.deepEqual(await legacyRows(seed22), old)
      await initializeDatabase(source); await initializeDatabase(source)
      assert.equal((await source.query('SELECT version FROM pe_schema')).rows[0].version, 25)
      assert.deepEqual(await legacyRows(source), old)
      assert.deepEqual((await source.query('SELECT remote_mcp_selection FROM pe_operations')).rows[0].remote_mcp_selection, [])
      assert.deepEqual(await readFile(join(privatePaths[1], 'workspaces/marker')), marker)
      assert.equal((await stat(join(privatePaths[1], 'workspaces/marker'))).mode & 0o777, 0o640)
      const evidence = JSON.parse(await readFile(join(privatePaths[1], 'restore-evidence.json'), 'utf8'))
      assert.equal(evidence.keptStopped, true); assert.equal(evidence.readyAt, null); assert.equal(evidence.rtoToHealthMs, null)
    })
    await seed22.query(migrations.schemaV22)
    const source22ConfigPath = join(privatePaths[1], 'remote-mcp/configuration.json')
    const secret = 'fixture-bearer-credential'
    const raw = { name: 'lookup', description: 'Opaque descriptor\0表😀', inputSchema: { type: 'object',
      properties: { text: { type: 'string' } }, required: ['text'] }, extension: { original: '\0' } }
    const found = await seedV22Mcp(seed22, owner, sessionId, key, secret, [raw])
    const selection = await transaction(seed22, client => selectMcpOperationTools(client, owner.userId, admission))
    const operation22 = randomUUID()
    await seed22.query(`INSERT INTO pe_operations(id,session_id,request_id,input,settings,state,remote_mcp_selection)
      VALUES($1,$2,$3,'MCP admission fixture',$4,'completed',$5)`,
    [operation22, sessionId, randomUUID(), { model: 'fixture', maxTokens: 64, revision: 1 }, JSON.stringify(selection)])
    const versionTables = ['pe_mcp_configuration_versions', 'pe_mcp_credential_versions', 'pe_mcp_catalog_versions']
    const versions22 = await Promise.all(versionTables.map(async table => (await seed22.query(`SELECT * FROM ${table}`)).rows))
    await t.test('V22 immutable MCP bytes and the accepted selection survive V23 and repeated initialization', async () => {
      await initializeDatabase(seed22); await initializeDatabase(seed22)
      assert.equal((await seed22.query('SELECT version FROM pe_schema')).rows[0].version, 25)
      for (const [index, table] of versionTables.entries()) assert.deepEqual((await seed22.query(`SELECT * FROM ${table}`)).rows, versions22[index])
      assert.deepEqual((await seed22.query('SELECT remote_mcp_selection FROM pe_operations WHERE id=$1', [operation22])).rows[0].remote_mcp_selection, selection)
      assert.deepEqual((await seed22.query('SELECT event FROM pe_events WHERE session_id=$1', [sessionId])).rows[0].event, event)
    })
    const service = new McpConnectionService(seed22, key, { ...management, assertEndpoint: async () => {} })
    const connection = { connectionId: found.connectionId, revision: 1, configurationRevision: 1, credentialRevision: 1 }
    const tasks = new TaskStore(seed22, taskLimits), actionStore = new McpActionStore(tasks, key, actions)
    const propose = grant => actionStore.propose(grant.token, { callKey: randomUUID(), toolName: selection[0].model.name,
      arguments: { text: 'argument\0表😀' } })
    await tasks.accept(owner, sessionId, randomUUID(), 'Synthetic terminal outcome storage')
    let grant = await tasks.claim(randomUUID())
    const succeeded = await propose(grant)
    await actionStore.decide(owner, succeeded.actionId, succeeded.fingerprint, 'persistent')
    const actionLease = await actionStore.claim(randomUUID())
    const catalog = await service.getCatalog(owner, found.catalogId)
    assert.equal(await actionStore.authorizeDispatch(actionLease, catalog.catalogDigest), true)
    const result = { content: [{ type: 'text', text: 'result\0表😀' }], extension: { original: '\0retained' } }
    // The result is an explicit storage fixture; a dispatch permit here is never sent to a remote endpoint.
    await actionStore.finish(actionLease, { result })
    const permissionId = (await seed22.query('SELECT permission_id FROM pe_mcp_actions WHERE id=$1', [succeeded.actionId])).rows[0].permission_id
    await actionStore.revoke(owner, permissionId)
    await tasks.finish(grant.token, 'completed', null)
    grant = await tasks.claim(randomUUID())
    const pending = await propose(grant)
    assert.equal(pending.state, 'pending'); await tasks.finish(grant.token, 'completed', null)
    await tasks.accept(owner, sessionId, randomUUID(), 'Synthetic uncertain storage')
    grant = await tasks.claim(randomUUID())
    const uncertain = await propose(grant)
    await actionStore.decide(owner, uncertain.actionId, uncertain.fingerprint, 'once')
    const uncertainLease = await actionStore.claim(randomUUID())
    assert.equal(await actionStore.authorizeDispatch(uncertainLease, catalog.catalogDigest), true)
    await actionStore.finish(uncertainLease, { errorCode: 'mcp_timeout' })
    await tasks.finish(grant.token, 'completed', null)
    grant = await tasks.claim(randomUUID()); await tasks.finish(grant.token, 'completed', null)
    const postBundle = join(directory, 'v23'), pinned = { connectionId: connection.connectionId,
      revision: connection.revision, configurationRevision: connection.configurationRevision,
      credentialRevision: connection.credentialRevision, catalogId: found.catalogId }
    const stateTables = [...versionTables, 'pe_mcp_actions', 'pe_mcp_permissions', 'pe_mcp_action_chains', 'pe_operations', 'pe_events']
    const before = await Promise.all(stateTables.map(async table => (await seed22.query(`SELECT * FROM ${table} ORDER BY 1`)).rows))
    await t.test('active discovery and dispatch refuse backup; pending review and terminal uncertainty are preserved', async () => {
      for (const state of ['queued', 'running']) {
        await seed22.query('UPDATE pe_mcp_checks SET state=$1 WHERE id=$2', [state, found.checkId])
        await refused('create', 1, join(directory, `blocked-check-${state}`), /no active operations.*MCP discovery\/dispatch/u,
          { PE_REMOTE_MCP_CONFIG_FILE: source22ConfigPath })
      }
      await seed22.query("UPDATE pe_mcp_checks SET state='succeeded' WHERE id=$1", [found.checkId])
      for (const state of ['approved', 'preparing', 'dispatch-intent']) {
        await seed22.query('UPDATE pe_mcp_actions SET state=$1 WHERE id=$2', [state, succeeded.actionId])
        await refused('create', 1, join(directory, `blocked-action-${state}`), /no active operations.*MCP discovery\/dispatch/u,
          { PE_REMOTE_MCP_CONFIG_FILE: source22ConfigPath })
      }
      await seed22.query("UPDATE pe_mcp_actions SET state='succeeded' WHERE id=$1", [succeeded.actionId])
      await refused('create', 1, join(directory, 'missing-key'), /Existing MCP history requires explicit/u,
        { PE_REMOTE_MCP_CONFIG_FILE: '' })
      await cli('create', 1, postBundle, { PE_REMOTE_MCP_CONFIG_FILE: source22ConfigPath })
      await cli('restore', 2, postBundle)
      const restoredKey = (await readFile(join(privatePaths[2], 'remote-mcp/credential-key'), 'utf8')).trim()
      assert.equal(restoredKey, key)
      const restoredConfig = await loadMcpPlatformConfig(join(privatePaths[2], 'remote-mcp/configuration.json'))
      assert.equal(restoredConfig.settings.credentialKeyFile, join(privatePaths[2], 'remote-mcp/credential-key'))
      assert.equal(restoredConfig.settings.internalExceptions[0].caFile, join(privatePaths[2], 'remote-mcp/ca-0.pem'))
      assert.deepEqual(restoredConfig.settings.internalExceptions.map(({ caFile, ...exception }) => exception),
        config.internalExceptions.map(({ caFile, ...exception }) => exception))
      assert.deepEqual(await readFile(join(privatePaths[2], 'remote-mcp/ca-0.pem')), await readFile(caPath))
      for (const file of ['configuration.json', 'credential-key', 'ca-0.pem']) {
        assert.equal((await stat(join(privatePaths[2], 'remote-mcp', file))).mode & 0o777, 0o600)
      }
      assert.equal((await stat(join(privatePaths[2], 'remote-mcp'))).mode & 0o777, 0o700)
      for (const [index, table] of stateTables.entries()) assert.deepEqual((await target.query(`SELECT * FROM ${table} ORDER BY 1`)).rows, before[index])
      const restoredService = new McpConnectionService(target, restoredKey, { ...management, assertEndpoint: async () => {} })
      assert.deepEqual((await transaction(target, client => restoredService.runtimeSnapshot(client, owner, pinned))).headers,
        { Authorization: `Bearer ${secret}` })
      const restoredActions = new McpActionStore(new TaskStore(target, taskLimits), restoredKey, actions)
      assert.deepEqual((await restoredActions.status(owner, succeeded.actionId)).result, result)
      assert.equal((await restoredActions.status(owner, pending.actionId)).state, 'pending')
      assert.equal((await restoredActions.status(owner, uncertain.actionId)).state, 'uncertain')
      assert.equal(await restoredActions.claim(randomUUID()), null, 'Restore never claims pending review or terminal uncertainty')
      const sealed = before[1][0].sealed
      assert.equal(sealed.includes(Buffer.from(secret)), false)
      assert.deepEqual(new McpCredentialCipher(restoredKey).open({ kind: 'connection', userId: owner.userId,
        resourceId: connection.connectionId, configurationRevision: 1, credentialRevision: 1 }, sealed),
      { formatVersion: 1, bearerToken: secret })
      assert.equal((await readdir(privatePaths[2])).some(name => name.includes('profile')), false)
      assert.deepEqual(await runningBackupTargets(join(root, '.artifacts/power-evolve', names[2], 'trial')), [])
    })
    await t.test('same source DB, occupied target, path aliases and bundle tampering fail before target copies', async () => {
      const originalUrl = await readFile(join(privatePaths[2], 'database-url'))
      const freshPrivate = join(directory, 'negative-target')
      await mkdir(freshPrivate, { mode: 0o700 })
      await writeFile(join(freshPrivate, 'database-url'), urls[1], { mode: 0o600 })
      await refused('restore', 2, postBundle, /Restore database overlaps the source/u, { PE_PRIVATE_DIR: freshPrivate })
      assert.deepEqual(await readdir(freshPrivate), ['database-url'])
      await writeFile(join(freshPrivate, 'database-url'), originalUrl, { mode: 0o600 })
      await refused('restore', 2, postBundle, /Restore database is not empty/u, { PE_PRIVATE_DIR: freshPrivate })
      assert.deepEqual(await readdir(freshPrivate), ['database-url'])
      const alias = join(directory, 'alias'); await symlink(privatePaths[1], alias)
      await assert.rejects(requireSeparateBackupPaths([join(alias, 'nested')], [privatePaths[1]]), /overlap/u)
      const changed = join(postBundle, 'config/remote-mcp/credential-key')
      const keyBytes = await readFile(changed)
      await writeFile(changed, randomBytes(32).toString('base64url'))
      await refused('restore', 2, postBundle, /Backup integrity check failed before restore/u, { PE_PRIVATE_DIR: freshPrivate })
      await writeFile(changed, keyBytes)
      await chmod(changed, 0o644)
      await refused('restore', 2, postBundle, /Backup integrity check failed before restore/u, { PE_PRIVATE_DIR: freshPrivate })
      await chmod(changed, 0o600)
      assert.deepEqual(await readdir(freshPrivate), ['database-url'])
      assert.notDeepEqual(await backupDatabaseIdentity(Client, urls[0]), await backupDatabaseIdentity(Client, urls[1]))
    })
    await t.test('legacy format 1 and 2 inventories remain readable with an explicit source identity', async () => {
      for (const format of [1, 2]) {
        const bundle = join(directory, `legacy-${format}`), privateDir = join(directory, `legacy-target-${format}`)
        await cp(preBundle, bundle, { recursive: true })
        await rm(join(bundle, 'config/remote-mcp'), { recursive: true })
        const manifest = JSON.parse(await readFile(join(bundle, 'manifest.json'), 'utf8'))
        delete manifest.sourceDatabase; delete manifest.sourcePrivateRoot; delete manifest.remoteMcp
        if (format === 1) delete manifest.storage
        manifest.format = format
        manifest.files = manifest.files.filter(file => !file.path.startsWith('config/remote-mcp/'))
          .map(({ mode, ...file }) => file)
        await writeFile(join(bundle, 'manifest.json'), JSON.stringify(manifest), { mode: 0o600 })
        await target.query('DROP SCHEMA public CASCADE'); await target.query('CREATE SCHEMA public')
        await mkdir(privateDir, { mode: 0o700 })
        await writeFile(join(privateDir, 'database-url'), urls[2], { mode: 0o600 })
        await cli('restore', 2, bundle, { PE_PRIVATE_DIR: privateDir,
          PE_BACKUP_SOURCE_DATABASE_URL_FILE: join(privatePaths[0], 'database-url') })
        assert.equal((await target.query('SELECT version FROM pe_schema')).rows[0].version, 21)
        assert.deepEqual(await legacyRows(target), old)
      }
    })
    await target.query('DROP SCHEMA public CASCADE'); await target.query('CREATE SCHEMA public')
    await t.test('PostgreSQL URI-like literal database names are rejected by the real CLI before any target copies or restore', async () => {
      for (const prefix of ['postgres', 'postgresql']) {
        const literalName = `${prefix}:///${databases[2]}`
        await admin.query(`CREATE DATABASE "${literalName}"`); acquired.push(literalName)
        const url = new URL(databaseUrl); url.pathname = `/${literalName}`
        const literal = new Pool({ connectionString: url.href, max: 1 }); pools.push(literal)
        assert.equal((await literal.query('SELECT current_database() AS name')).rows[0].name, literalName)
        const privateDir = join(directory, `uri-target-${prefix}`)
        await mkdir(privateDir, { mode: 0o700 })
        const literalBefore = await restoreTargetObjects(literal), expandedBefore = await restoreTargetObjects(target)
        for (const pathname of [`/${literalName}`, `/${encodeURIComponent(literalName)}`]) {
          url.pathname = pathname
          await writeFile(join(privateDir, 'database-url'), url.href, { mode: 0o600 })
          await refused('restore', 2, preBundle, /Invalid backup PostgreSQL database name/u, { PE_PRIVATE_DIR: privateDir })
          assert.deepEqual(await readdir(privateDir), ['database-url'])
          assert.equal(await readFile(join(privateDir, 'database-url'), 'utf8'), url.href)
          assert.deepEqual(await restoreTargetObjects(literal), literalBefore)
          assert.deepEqual(await restoreTargetObjects(target), expandedBefore)
        }
      }
    })
    const objectCases = [
      { name: 'large-object', create: async () => (await target.query("SELECT lo_from_bytea(0,decode('000102ff','hex')) AS oid")).rows[0].oid,
        inspect: 'SELECT oid,encode(lo_get(oid),\'hex\') AS bytes FROM pg_largeobject_metadata ORDER BY oid',
        drop: oid => target.query('SELECT lo_unlink($1)', [oid]) },
      { name: 'collation', create: "CREATE COLLATION backup_occupied_collation (provider=libc,locale='C')",
        inspect: "SELECT * FROM pg_collation WHERE collname='backup_occupied_collation'", drop: 'DROP COLLATION backup_occupied_collation' },
      { name: 'type', create: "CREATE TYPE backup_occupied_type AS ENUM ('occupied')",
        inspect: "SELECT * FROM pg_type WHERE typname='backup_occupied_type'", drop: 'DROP TYPE backup_occupied_type' },
      { name: 'language', create: 'CREATE LANGUAGE backup_occupied_language HANDLER pg_catalog.plpgsql_call_handler',
        inspect: "SELECT * FROM pg_language WHERE lanname='backup_occupied_language'", drop: 'DROP LANGUAGE backup_occupied_language' },
      { name: 'access-method', create: 'CREATE ACCESS METHOD backup_occupied_am TYPE INDEX HANDLER pg_catalog.bthandler',
        inspect: "SELECT * FROM pg_am WHERE amname='backup_occupied_am'", drop: 'DROP ACCESS METHOD backup_occupied_am' },
      { name: 'foreign-data-wrapper', create: 'CREATE FOREIGN DATA WRAPPER backup_occupied_fdw',
        inspect: "SELECT * FROM pg_foreign_data_wrapper WHERE fdwname='backup_occupied_fdw'", drop: 'DROP FOREIGN DATA WRAPPER backup_occupied_fdw' },
      { name: 'foreign-server', create: ['CREATE FOREIGN DATA WRAPPER backup_occupied_fdw',
        'CREATE SERVER backup_occupied_server FOREIGN DATA WRAPPER backup_occupied_fdw'],
        inspect: "SELECT * FROM pg_foreign_server WHERE srvname='backup_occupied_server'",
        drop: ['DROP SERVER backup_occupied_server', 'DROP FOREIGN DATA WRAPPER backup_occupied_fdw'] },
      { name: 'user-mapping', create: ['CREATE FOREIGN DATA WRAPPER backup_occupied_fdw',
        'CREATE SERVER backup_occupied_server FOREIGN DATA WRAPPER backup_occupied_fdw',
        'CREATE USER MAPPING FOR CURRENT_USER SERVER backup_occupied_server'], inspect: 'SELECT * FROM pg_user_mapping',
        drop: ['DROP USER MAPPING FOR CURRENT_USER SERVER backup_occupied_server', 'DROP SERVER backup_occupied_server',
          'DROP FOREIGN DATA WRAPPER backup_occupied_fdw'] },
      { name: 'publication', create: 'CREATE PUBLICATION backup_occupied_publication',
        inspect: "SELECT * FROM pg_publication WHERE pubname='backup_occupied_publication'", drop: 'DROP PUBLICATION backup_occupied_publication' },
      { name: 'disabled-subscription', create: "CREATE SUBSCRIPTION backup_occupied_subscription CONNECTION 'host=127.0.0.1 port=1 dbname=unused' PUBLICATION unused WITH (connect=false,enabled=false,create_slot=false,slot_name=NONE)",
        inspect: "SELECT oid,subdbid,subname,subenabled,subslotname FROM pg_subscription WHERE subname='backup_occupied_subscription'",
        drop: 'DROP SUBSCRIPTION backup_occupied_subscription' },
      { name: 'event-trigger', create: [
        'CREATE FUNCTION pg_catalog.backup_occupied_event() RETURNS event_trigger LANGUAGE plpgsql AS $$BEGIN END$$',
        "CREATE EVENT TRIGGER backup_occupied_trigger ON ddl_command_end WHEN TAG IN ('CREATE TABLE') EXECUTE FUNCTION pg_catalog.backup_occupied_event()"],
        inspect: "SELECT * FROM pg_event_trigger WHERE evtname='backup_occupied_trigger'",
        drop: ['DROP EVENT TRIGGER backup_occupied_trigger', 'DROP FUNCTION pg_catalog.backup_occupied_event()'] },
      { name: 'default-privileges', create: 'ALTER DEFAULT PRIVILEGES GRANT SELECT ON TABLES TO PUBLIC',
        inspect: 'SELECT * FROM pg_default_acl', drop: 'ALTER DEFAULT PRIVILEGES REVOKE SELECT ON TABLES FROM PUBLIC' },
      { name: 'cast', create: 'CREATE CAST (json AS integer) WITH INOUT',
        inspect: "SELECT * FROM pg_cast WHERE castsource='json'::regtype AND casttarget='integer'::regtype", drop: 'DROP CAST (json AS integer)' },
      { name: 'operator', create: 'CREATE OPERATOR public.=== (FUNCTION=pg_catalog.int4eq,LEFTARG=integer,RIGHTARG=integer)',
        inspect: "SELECT * FROM pg_operator WHERE oprname='==='", drop: 'DROP OPERATOR public.=== (integer,integer)' },
      { name: 'operator-family', create: 'CREATE OPERATOR FAMILY backup_occupied_family USING btree',
        inspect: "SELECT * FROM pg_opfamily WHERE opfname='backup_occupied_family'", drop: 'DROP OPERATOR FAMILY backup_occupied_family USING btree' },
      { name: 'text-search', create: 'CREATE TEXT SEARCH CONFIGURATION backup_occupied_search (COPY=pg_catalog.simple)',
        inspect: "SELECT * FROM pg_ts_config WHERE cfgname='backup_occupied_search'", drop: 'DROP TEXT SEARCH CONFIGURATION backup_occupied_search' },
      { name: 'database-setting', create: `ALTER DATABASE "${databases[2]}" SET statement_timeout='5s'`,
        inspect: 'SELECT * FROM pg_db_role_setting WHERE setdatabase=(SELECT oid FROM pg_database WHERE datname=current_database())',
        drop: `ALTER DATABASE "${databases[2]}" RESET statement_timeout` },
    ]
    const objectCommand = async value => {
      if (typeof value === 'function') return value()
      for (const sql of Array.isArray(value) ? value : [value]) await target.query(sql)
    }
    for (const fixture of objectCases) await t.test(`the real CLI refuses a target containing ${fixture.name} before copying and retains its object`, async () => {
      await requireEmptyBackupDatabase(Client, urls[2])
      const handle = await objectCommand(fixture.create)
      try {
        const objectBefore = (await target.query(fixture.inspect)).rows
        assert(objectBefore.length > 0, `${fixture.name} fixture must exist before CLI restore`)
        const allBefore = await restoreTargetObjects(target)
        const privateDir = join(directory, `occupied-${fixture.name}`)
        await mkdir(privateDir, { mode: 0o700 })
        await writeFile(join(privateDir, 'database-url'), urls[2], { mode: 0o600 })
        await refused('restore', 2, preBundle, /Restore database is not empty/u, { PE_PRIVATE_DIR: privateDir })
        assert.deepEqual(await readdir(privateDir), ['database-url'])
        assert.equal(await readFile(join(privateDir, 'database-url'), 'utf8'), urls[2])
        assert.deepEqual((await target.query(fixture.inspect)).rows, objectBefore)
        assert.deepEqual(await restoreTargetObjects(target), allBefore)
      } finally {
        if (typeof fixture.drop === 'function') await fixture.drop(handle)
        else await objectCommand(fixture.drop)
      }
      await requireEmptyBackupDatabase(Client, urls[2])
    })
  })

test('local libpq receives credentials in its environment and a failed tool cannot print them', async t => {
  const directory = await mkdtemp(join(homedir(), '.config/power-evolve/s6-mcp-backup-tools-'))
  t.after(() => rm(directory, { recursive: true, force: true }))
  const output = join(directory, 'observed.json'), password = 'fixture-secret-password'
  const executable = join(directory, 'pg_dump')
  await writeFile(executable, '#!/usr/bin/env node\n' +
    `import { writeFileSync } from 'node:fs';\nwriteFileSync(${JSON.stringify(output)}, JSON.stringify({args:process.argv.slice(2),database:process.env.PGDATABASE,password:process.env.PGPASSWORD}));\n` +
    'process.stderr.write(process.env.PGPASSWORD);process.exit(1);\n', { mode: 0o700 })
  await writeFile(join(directory, 'package.json'), '{"type":"module"}', { mode: 0o600 })
  assert.throws(() => dumpBackupDatabase(join(directory, 'failed.dump'), `postgresql://fixture:${password}@localhost/unique_db`,
    { PE_BACKUP_PG_BIN_DIR: directory }), error => {
    assert.equal(error.message, 'Backup PostgreSQL pg_dump failed'); return true
  })
  const observed = JSON.parse(await readFile(output, 'utf8'))
  assert.equal(observed.password, password); assert.equal(observed.database, 'unique_db')
  assert(observed.args.every(value => !value.includes(password) && !value.includes('postgresql://')))
  assert.throws(() => dumpBackupDatabase(join(directory, 'invalid.dump'), `invalid-${password}`,
    { PE_BACKUP_PG_BIN_DIR: directory }), error => { assert.equal(error.message.includes(password), false); return true })
  class InvalidClient { constructor() { throw new Error(password) } }
  await assert.rejects(backupDatabaseIdentity(InvalidClient, password), { message: 'Cannot verify backup PostgreSQL identity' })
  await assert.rejects(requireEmptyBackupDatabase(InvalidClient, password), { message: 'Cannot verify empty restore PostgreSQL database' })
})
