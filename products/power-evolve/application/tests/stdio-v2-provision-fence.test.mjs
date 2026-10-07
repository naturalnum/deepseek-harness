/** Original-action resource fences with recording PG/Kubernetes substitutes; no real cluster or program. */
import assert from 'node:assert/strict'
import test from 'node:test'
import { randomUUID } from 'node:crypto'
import { SandboxManager } from '../lib/platform/sandbox.js'

function fixture() {
  const userId = randomUUID(), sessionId = randomUUID(), workspaceId = randomUUID(), events = [], requests = []
  const account = { userId, username: 'synthetic', displayName: 'Synthetic', role: 'USER', enabled: true, revision: 1,
    credentialVersion: 1, passwordChangeRequired: false, deletedAt: null }
  const client = {
    on() {}, removeListener() {}, release() { events.push('release') },
    async query(text) {
      events.push(text)
      if (['BEGIN', 'COMMIT', 'ROLLBACK'].includes(text)) return { rows: [], rowCount: 0 }
      if (text.includes('FROM pe_users WHERE id=ANY')) return { rows: [account], rowCount: 1 }
      throw new Error(`Unexpected resource SQL: ${text}`)
    },
  }
  const pool = {
    async connect() { return client },
    async query(text) {
      if (text.includes('FROM pe_sessions s JOIN pe_workspaces')) return { rows: [{ workspace_id: workspaceId }], rowCount: 1 }
      throw new Error(`Unexpected outer SQL: ${text}`)
    },
  }
  const kube = {
    resourcePath: (_namespace, resource, name = '') => `/${resource}/${name}`,
    async call(method, path) { requests.push({ method, path }); if (method === 'GET') throw Object.assign(new Error('unused GET'), { status: 404 }) },
  }
  const config = { namespace: 'unused', image: 'unused', localRoot: '/unused', nodeRoot: '/unused', readyTimeoutMs: 100,
    fileScan: { maxEntries: 10, maxHashBytes: 1024, timeoutMs: 100, maxSnapshotBytes: 1024, maxFiles: 10 } }
  const files = { async workspaceForId() {}, async bindingForId() { throw new Error('Resource fence must precede binding reads') } }
  const manager = new SandboxManager(kube, files, pool, 'synthetic', config)
  const slot = { user_id: userId, session_id: sessionId, workspace_id: workspaceId, state: 'reserved', generation: '1' }
  return { manager, userId, sessionId, workspaceId, client, events, requests, files, slot }
}

test('cancellation after the outer lease check rejects acquire before any reservation or resource POST', async () => {
  const f = fixture(); let cancelled = false, checks = 0
  f.files.workspaceForId = async () => { cancelled = true }
  await assert.rejects(f.manager.ensureReady(f.sessionId, f.userId, async () => { checks++ }, async (client, mode) => {
    assert.equal(client, f.client); assert.equal(mode, 'acquire'); assert(cancelled)
    assert.match(f.events.at(-1), /FROM pe_users.*FOR NO KEY UPDATE/u)
    throw new Error('original action cancelled')
  }), /original action cancelled/u)
  assert.equal(checks, 1); assert.deepEqual(f.requests, [])
  assert(f.events.includes('ROLLBACK')); assert(!f.events.includes('COMMIT'))
  assert(f.events.every(value => !value.startsWith('UPDATE') && !value.startsWith('INSERT')))
})

test('an expired original generation cannot issue a previously selected Kubernetes mutation', async () => {
  const f = fixture()
  await assert.rejects(f.manager.provisionMutation(f.slot, null, async (client, mode) => {
    assert.equal(client, f.client); assert.equal(mode, 'mutation'); throw new Error('original lease expired')
  }, () => f.manager.kube.call('POST', '/sandboxes/')), /original lease expired/u)
  assert.deepEqual(f.requests, []); assert(f.events.includes('ROLLBACK'))
})

test('expiry after an issued mutation rolls back PG without silently issuing another resource create', async () => {
  const f = fixture(); let checks = 0
  f.manager.reserved = async () => null
  await assert.rejects(f.manager.provisionMutation(f.slot, null, async (client, mode) => {
    assert.equal(client, f.client); assert.equal(mode, 'mutation')
    if (++checks === 2) throw new Error('lease expired during request')
  }, () => f.manager.kube.call('POST', '/sandboxes/')), /lease expired during request/u)
  assert.deepEqual(f.requests, [{ method: 'POST', path: '/sandboxes/' }])
  assert(f.events.includes('ROLLBACK')); assert(!f.events.includes('COMMIT'))
})

test('late creation UID persistence is refused on the same resource client before any identity write', async () => {
  const f = fixture(); let outer = 0
  await assert.rejects(f.manager.retainCreatingPod(f.slot, randomUUID(), async () => { outer++ }, async (client, mode) => {
    assert.equal(client, f.client); assert.equal(mode, 'record'); throw new Error('action already closed')
  }), /action already closed/u)
  assert.equal(outer, 1); assert(f.events.includes('ROLLBACK'))
  assert(f.events.every(value => !value.startsWith('UPDATE'))); assert.deepEqual(f.requests, [])
})
