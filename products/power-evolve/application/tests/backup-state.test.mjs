/** Backup state extraction uses local files and a controlled Client, without a database or trial. */
import assert from 'node:assert/strict'
import { createHash } from 'node:crypto'
import { chmod, mkdir, mkdtemp, readFile, rm, symlink, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import test from 'node:test'
import { inspectBackupState, inventoryBackupTree, requireIdleBackupState } from '../../scripts/backup-state.mjs'

function database({ schema = 28, connector = [], desktop = [], resolutions = [], active = {}, fail, closeFails = false } = {}) {
  let instance
  class Client {
    constructor(options) { this.options = options; this.queries = []; instance = this }
    async connect() { if (fail === 'connect') throw new Error(this.options.connectionString) }
    async query(request) {
      this.queries.push(request)
      if (fail === 'query') throw new Error(`private query detail: ${this.options.connectionString}`)
      const sql = request.text
      if (sql === 'SELECT version FROM pe_schema') return { rows: [{ version: schema }] }
      if (sql.includes(' AS operations')) {
        // Evaluate the two added state filters against fixture rows rather than supplying their counts.
        const count = (table, states) => {
          const predicate = sql.match(new RegExp(`${table} WHERE state IN \\(([^)]+)\\)`, 'u'))
          assert.ok(predicate, `Missing state filter for ${table}`)
          const selected = [...predicate[1].matchAll(/'([^']+)'/gu)].map(match => match[1])
          return states.filter(state => selected.includes(state)).length
        }
        return { rows: [{ operations: 0, executions: 0, stdio: 0, ssh: 0, sshactions: 0,
          connectorActions: count('pe_connector_actions', connector),
          desktopExecutions: count('pe_desktop_executions', desktop), ...active }] }
      }
      if (sql.includes(' AS quarantined')) return { rows: [{ records: '3', quarantined: '1' }] }
      if (sql.includes('FROM pe_skill_package_versions')) return { rows: [{
        user_id: '00000000-0000-4000-8000-000000000001', archive_digest: 'archive',
        manifest_digest: 'manifest', manifest: { format: 1 } }] }
      if (sql.includes('FROM pe_cloud_execution_resolutions ')) {
        const predicate = sql.match(/WHERE state IN \(([^)]+)\)/u)
        assert.ok(predicate)
        const states = [...predicate[1].matchAll(/'([^']+)'/gu)].map(match => match[1])
        return { rows: [{ n: active.cloudResolutions ?? resolutions.filter(state => states.includes(state)).length }] }
      }
      for (const [table, key] of [['pe_mcp_checks', 'mcpChecks'], ['pe_mcp_actions', 'mcpActions'],
        ['pe_workspace_binding_requests', 'workspaceRecoveries'], ['pe_storage_directory_requests', 'storageDirectories']]) {
        if (sql.includes(`FROM ${table} `)) return { rows: [{ n: active[key] ?? 0 }] }
      }
      if (sql.includes('FROM pe_mcp_remote_connections')) return { rows: [{ n: '4' }] }
      throw new Error('Unexpected backup query')
    }
    async end() {
      this.ended = true
      if (closeFails) throw new Error(this.options.connectionString)
    }
  }
  return { Client, instance: () => instance }
}
const privateUrl = 'postgresql://test:synthetic-private-value@invalid.example/backup'

test('file inventory keeps sorted bytes, modes and literal symlinks; failures omit private paths', async t => {
  const directory = await mkdtemp(join(tmpdir(), 'pe-backup-state-'))
  t.after(() => rm(directory, { recursive: true, force: true }))
  const source = join(directory, 'source')
  await mkdir(join(source, 'a'), { recursive: true, mode: 0o700 })
  const bytes = Buffer.from([0, 255, 10, 42])
  await writeFile(join(source, 'z.bin'), bytes)
  await chmod(join(source, 'z.bin'), 0o640)
  await writeFile(join(source, 'a', 'run'), '#!/bin/sh\n')
  await chmod(join(source, 'a', 'run'), 0o750)
  await writeFile(join(directory, 'outside'), 'Excluded from inventory')
  await symlink('../outside', join(source, 'b-link'))
  assert.deepEqual(await inventoryBackupTree(source), [
    { path: 'a/run', kind: 'file', size: 10,
      sha256: createHash('sha256').update('#!/bin/sh\n').digest('hex'), mode: 0o750 },
    { path: 'b-link', kind: 'symlink', target: '../outside' },
    { path: 'z.bin', kind: 'file', size: bytes.length,
      sha256: createHash('sha256').update(bytes).digest('hex'), mode: 0o640 },
  ])
  await assert.rejects(inventoryBackupTree(join(directory, 'private-missing-path')), error => {
    assert.equal(error.message, 'Cannot inspect backup POSIX inventory')
    assert.equal(error.cause, undefined)
    return true
  })
})

test('backup refuses dispatchable Connector and active desktop states from the real schema', async () => {
  const schema = await readFile(new URL('../src/platform/schema.ts', import.meta.url), 'utf8')
  for (const [table, fixture, activeStates] of [
    ['pe_connector_actions', 'connector', ['approved', 'dispatching', 'uncertain']],
    ['pe_desktop_executions', 'desktop', ['queued', 'running', 'cancelling', 'uncertain']],
  ]) {
    const values = schema.match(new RegExp(`CREATE TABLE ${table} \\([\\s\\S]*?state text NOT NULL CHECK \\(state IN \\(([^)]+)\\)\\)`, 'u'))
    assert.ok(values)
    const states = [...values[1].matchAll(/'([^']+)'/gu)].map(match => match[1])
    for (const state of states) {
      const mock = database({ [fixture]: [state] })
      const status = await inspectBackupState(mock.Client, privateUrl)
      if (activeStates.includes(state)) {
        assert.throws(() => requireIdleBackupState(status), /no active operations.*MCP discovery\/dispatch/u)
        if (fixture === 'connector') assert.throws(() => requireIdleBackupState(status), /settle or reconcile/u)
      } else assert.doesNotThrow(() => requireIdleBackupState(status))
      assert.equal(mock.instance().ended, true)
    }
  }
})

test('backup retains historical schema gates, package metadata and existing active-work refusal', async () => {
  for (const schema of [18, 21, 22, 23, 26, 27, 28]) {
    const mock = database({ schema })
    const status = await inspectBackupState(mock.Client, privateUrl)
    assert.equal(status.schema, schema)
    assert.equal(status.sshRecords, 3)
    assert.equal(status.sshQuarantined, 1)
    assert.equal(status.mcpRecords, schema >= 22 ? 4 : 0)
    assert.deepEqual(status.packages[0].manifest, { format: 1 })
    assert.equal(Object.hasOwn(status.active, 'mcpChecks'), schema >= 22)
    assert.equal(Object.hasOwn(status.active, 'mcpActions'), schema >= 23)
    assert.equal(Object.hasOwn(status.active, 'workspaceRecoveries'), schema >= 27)
    assert.equal(Object.hasOwn(status.active, 'storageDirectories'), schema >= 27)
    assert.equal(Object.hasOwn(status.active, 'cloudResolutions'), schema >= 28)
    assert.doesNotThrow(() => requireIdleBackupState(status))
  }
  for (const key of ['operations', 'executions', 'stdio', 'ssh', 'sshactions',
    'mcpChecks', 'mcpActions', 'workspaceRecoveries', 'storageDirectories', 'cloudResolutions']) {
    const mock = database({ active: { [key]: 1 } })
    const status = await inspectBackupState(mock.Client, privateUrl)
    assert.throws(() => requireIdleBackupState(status), /no active operations/u)
  }
})

test('V28 backup excludes pending cleanup while retaining blocked and completed reconciliation records', async () => {
  for (const state of ['accepted', 'stopping', 'completed', 'blocked']) {
    const mock = database({ resolutions: [state] })
    const status = await inspectBackupState(mock.Client, privateUrl)
    if (['accepted', 'stopping'].includes(state)) assert.throws(() => requireIdleBackupState(status), /no active operations/u)
    else assert.doesNotThrow(() => requireIdleBackupState(status))
  }
})

test('state inspection bounds every query and closes failures without exposing connection diagnostics', async () => {
  const mock = database({ closeFails: true })
  const status = await inspectBackupState(mock.Client, privateUrl)
  assert.doesNotThrow(() => requireIdleBackupState(status))
  const client = mock.instance()
  assert.ok(client.options.connectionTimeoutMillis > 0 && client.options.connectionTimeoutMillis <= 10000)
  assert.ok(client.options.statement_timeout > 0 && client.options.statement_timeout < client.options.query_timeout)
  assert.match(client.options.options, /default_transaction_read_only=on/u)
  assert.ok(client.queries.every(query => query.query_timeout > 0 && query.query_timeout <= 10000))
  assert.equal(client.ended, true)
  for (const fail of ['connect', 'query']) {
    const failed = database({ fail, closeFails: true })
    await assert.rejects(inspectBackupState(failed.Client, privateUrl), error => {
      assert.equal(error.message, 'Cannot inspect backup PostgreSQL state')
      assert.equal(error.cause, undefined)
      assert.ok(!error.stack.includes(privateUrl))
      return true
    })
    assert.equal(failed.instance().ended, true)
  }
})
