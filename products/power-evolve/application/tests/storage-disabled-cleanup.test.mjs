/** Real PG account/recovery composition with a deterministic Kubernetes stop fixture. */
import assert from 'node:assert/strict'
import { randomUUID } from 'node:crypto'
import { join } from 'node:path'
import test from 'node:test'
import { FileService } from '../lib/platform/files.js'
import { SandboxManager } from '../lib/platform/sandbox.js'
import { KubernetesError } from '../lib/platform/kubernetes.js'
import { transaction } from '../lib/platform/database.js'
import { lockAccountAuthorities } from '../lib/platform/account-authority.js'
import { revokeAccountExecutions } from '../lib/platform/account-execution-revocation.js'
import { createSandboxFixture } from './sandbox-binding-fixture.mjs'

test('disabled account cleanup stops a blocked recovery writer without changing its binding', { timeout: 30000 }, async t => {
  for (const stopProof of [true, false]) await t.test(stopProof ? 'exact stop evidence' : 'stop remains unconfirmed', async t => {
    const f = await createSandboxFixture(t)
    const userId = await f.createUser(), { sessionId, workspaceId } = await f.createSession(userId)
    const ready = await f.manager.ensureReady(sessionId, userId, async () => {})
    const otherId = await f.createUser(), other = await f.createSession(otherId)
    const otherReady = await f.manager.ensureReady(other.sessionId, otherId, async () => {})
    const files = new FileService(f.pool, join(f.localRoot, 'workspaces'))
    await files.init()
    const manager = new SandboxManager(f.kube, files, f.pool, 'test-key', f.managerOptions)
    const requestId = randomUUID()
    const target = { kind: 'pod', mountGeneration: ready.generation, sessionId,
      podUid: ready.podUid, runnerInstanceId: ready.runnerInstanceId }
    // Seed a durable accepted request; HTTP credential admission has its own regression.
    await transaction(f.pool, async client => {
      await lockAccountAuthorities(client, [userId], 'update')
      await client.query(`INSERT INTO pe_workspace_binding_requests(user_id,request_id,workspace_id,
        space_id,root_relative_path,expected_generation,state,stop_target)
        VALUES($1,$2,$3,$4,$5,1,'accepted',$6::jsonb)`,
      [userId, requestId, workspaceId, ready.binding.spaceId, ready.binding.rootRelativePath, JSON.stringify(target)])
      await client.query("UPDATE pe_workspaces SET binding_state='recovering',recovery_request_id=$2 WHERE id=$1", [workspaceId, requestId])
    })
    const call = f.kube.call.bind(f.kube)
    let unavailable = true
    f.kube.call = async (method, path, body) => {
      if (unavailable && method === 'DELETE' && path.endsWith(`/sandboxes/${ready.name}`)) {
        throw new KubernetesError(503, 'Synthetic Kubernetes outage before DELETE')
      }
      return call(method, path, body)
    }
    const poll = () => files.bindings.poll((claim, lease) => manager.stopForRecovery(claim, lease),
      new AbortController().signal, { ownerId: randomUUID(), leaseMs: 5000 })
    assert.equal(await poll(), true)
    const request = () => f.pool.query('SELECT state,stop_target,stop_proof FROM pe_workspace_binding_requests WHERE request_id=$1', [requestId]).then(r => r.rows[0])
    assert.equal((await request()).state, 'blocked')
    assert.equal(f.kube.resource('pods', ready.name).metadata.uid, ready.podUid)
    await transaction(f.pool, async client => {
      await lockAccountAuthorities(client, [userId], 'update')
      await client.query('UPDATE pe_users SET enabled=false,credential_version=credential_version+1 WHERE id=$1', [userId])
      await revokeAccountExecutions(client, userId)
    })
    unavailable = false
    f.kube.supplyStopProof = stopProof
    const mutations = f.kube.mutations.length
    assert.equal(await poll(), false)
    if (stopProof) await manager.recycleIdle(3600000)
    else await assert.rejects(manager.recycleIdle(3600000), { code: 'mount_stop_unconfirmed' })
    const slot = (await f.pool.query('SELECT * FROM pe_mount_slots WHERE user_id=$1', [userId])).rows[0]
    const instance = (await f.pool.query('SELECT * FROM pe_sandbox_instances WHERE session_id=$1', [sessionId])).rows[0]
    const workspace = (await f.pool.query('SELECT binding_state,binding_generation,recovery_request_id FROM pe_workspaces WHERE id=$1', [workspaceId])).rows[0]
    assert.deepEqual(workspace, { binding_state: 'blocked', binding_generation: '1', recovery_request_id: requestId })
    assert.deepEqual(await request(), { state: 'blocked', stop_target: target, stop_proof: null })
    assert.equal(slot.state, stopProof ? 'free' : 'stopping')
    assert.equal(instance.state, stopProof ? 'deleted' : 'deleting')
    if (stopProof) {
      assert.equal(f.kube.resource('pods', ready.name), undefined)
      assert.equal(slot.stop_pod_uid, ready.podUid)
      assert.equal(slot.stop_evidence.status, 'KUBELET_STOPPED')
      assert.equal(slot.stop_evidence.runnerInstanceId, ready.runnerInstanceId)
      assert.deepEqual(slot.stop_evidence.bindingSnapshot, ready.binding)
      assert.deepEqual(instance.stop_evidence, slot.stop_evidence)
    } else {
      assert.equal(f.kube.resource('pods', ready.name).metadata.uid, ready.podUid)
      assert.equal(slot.stop_evidence, null)
    }
    const cleanup = f.kube.mutations.slice(mutations)
    assert(cleanup.length > 0)
    assert(cleanup.every(item => item.name === ready.name && item.method !== 'POST'))
    assert.equal(f.kube.resource('pods', otherReady.name).metadata.uid, otherReady.podUid)
  })
})
