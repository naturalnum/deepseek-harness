/** Real PG independent service grants and physical-path locks; no Kubernetes resources are created. */
import { randomBytes, randomUUID } from 'node:crypto'
import { expect, test } from 'vitest'
import { stdioCheckRequestV2 } from '@power-evolve/contracts/stdio-mcp'
import { stdioWorkerIdV2 } from '@power-evolve/contracts/stdio-runtime'
import { requestId } from '../src/contracts.ts'
import { nativeExecutionServiceWorld } from '../src/native-execution/types.ts'
import { NativeExecutionServiceAuthority, nativeExecutionServiceOwner } from '../src/platform/native-execution-service-authority.ts'
import { mutateNativeExecutionPath } from '../src/platform/native-execution-mutations.ts'
import { stdioWorkflow, workflowRequest } from './employee1-stdio-workflow-fixture.ts'

const timeout = (ms: number) => AbortSignal.timeout(ms)

async function waitForLock(pool: Parameters<typeof mutateNativeExecutionPath>[0], signal: AbortSignal): Promise<void> {
  while (!signal.aborted) {
    const result = await pool.query<{ waiting: boolean }>("SELECT EXISTS(SELECT 1 FROM pg_locks WHERE locktype='advisory' AND NOT granted AND database=(SELECT oid FROM pg_database WHERE datname=current_database())) AS waiting")
    if (result.rows[0]?.waiting) return
    await new Promise<void>(resolve => setImmediate(resolve))
  }
  throw new Error('Original advisory lock waiter was not observed')
}

test('two same-account Sessions obtain independent native service worlds without a user mount slot', async () => {
  await stdioWorkflow(async (f) => {
    const second = await f.tasks.create(f.owner.user, requestId.parse(randomUUID()), f.owner.token)
    const secondAction = await f.admission.check(f.owner.token, stdioCheckRequestV2.parse({ requestId: workflowRequest(),
      connectionId: f.connection.connectionId, expectedRevision: 1, sessionId: second.sessionId, target: { kind: 'cloud' } }))
    const firstLease = await f.claim(), nextLease = await f.store.claimNext(stdioWorkerIdV2.parse(randomUUID()))
    if (!nextLease) throw new Error('A second same-account action must claim independently')
    await Promise.all([f.store.beginPreparation(firstLease), f.store.beginPreparation(nextLease)])
    const authority = new NativeExecutionServiceAuthority(f.pool, f.files.storage, f.store.nativeServiceLease, randomBytes(32))
    const issue = async (lease: typeof firstLease) => {
      const snapshot = await f.store.snapshot(lease)
      return authority.issue(nativeExecutionServiceOwner.parse({ userId: f.owner.user.userId, kind: 'stdio-action',
        id: lease.actionId, epoch: 1, workerId: snapshot.executionRef.executionId }))
    }
    const [a, b] = await Promise.all([issue(firstLease), issue(nextLease)])
    expect(a.world.worldId).not.toBe(b.world.worldId)
    expect(a.world.serviceId).not.toBe(b.world.serviceId)
    expect(new Set([firstLease.actionId, nextLease.actionId])).toEqual(new Set([f.discovery.actionId, secondAction.actionId]))
    expect((await f.pool.query('SELECT * FROM pe_mount_slots')).rowCount).toBe(0)
    expect((await f.pool.query('SELECT * FROM pe_sandbox_instances')).rowCount).toBe(0)
    expect(await authority.assert(a.token, a.world, 'storage-read')).toEqual(a.binding)
    await expect(authority.assert(a.token, b.world, 'storage-read')).rejects.toThrow('native_service_authority_lost')
    await expect(authority.assert(a.token, a.world)).rejects.toThrow('stdio_v2_native_start_not_authorized')
    const again = await issue(firstLease)
    expect(again).toEqual(a)
    await authority.revoke(a.token, a.world)
    await expect(authority.assert(a.token, a.world, 'storage-read')).rejects.toThrow('native_service_authority_lost')
    expect(await authority.assert(b.token, b.world, 'storage-read')).toEqual(b.binding)
    await authority.assertOwnership(a.token, a.world)
    await expect(f.pool.query('UPDATE pe_native_execution_services SET authority_epoch=authority_epoch+1 WHERE id=$1',
      [b.world.serviceId])).rejects.toThrow('immutable')
    await f.store.release(firstLease)
    await f.store.release(nextLease)
    await expect(authority.assert(b.token, b.world, 'storage-read')).rejects.toThrow()
  })
})

test('native guarded edits serialize physical aliases and allow unrelated paths to overlap', async () => {
  await stdioWorkflow(async (f) => {
    const snapshot = await f.store.snapshot(await f.claim())
    const binding = await f.files.bindingForId(f.owner.user.userId, snapshot.task.scopeBinding.workspaceId)
    const world = nativeExecutionServiceWorld.parse({ worldId: randomUUID(), userId: f.owner.user.userId,
      sessionId: snapshot.task.sessionId, workspaceId: binding.workspaceId, storageGeneration: binding.generation,
      permissionGeneration: 1, mode: 'workspace-write', workspaceRoot: '/workspace', homeRoot: '/home/agent',
      serviceId: randomUUID(), serviceEpoch: 1, authorityKind: 'stdio-action' })
    const entered = Promise.withResolvers<null>(), release = Promise.withResolvers<null>(), independent = Promise.withResolvers<null>()
    const first = mutateNativeExecutionPath(f.pool, world, binding, '/workspace/shared/file.txt', async () => {
      entered.resolve(null); await release.promise; return 'first'
    })
    let secondEntered = false
    let second: Promise<string> | undefined
    try {
      await entered.promise
      const nested = { ...binding, rootRelativePath: 'shared' }
      second = mutateNativeExecutionPath(f.pool, world, nested, '/workspace/file.txt', async () => { secondEntered = true; return 'second' })
      await waitForLock(f.pool, timeout(10_000))
      await mutateNativeExecutionPath(f.pool, world, binding, '/workspace/other.txt', async () => { independent.resolve(null); return 'parallel' })
      await independent.promise
      expect(secondEntered).toBe(false)
    } finally { release.resolve(null); await Promise.all([first, second]) }
    expect(secondEntered).toBe(true)
    await expect(mutateNativeExecutionPath(f.pool, world, binding, '/workspace/a/../file.txt', async () => null))
      .rejects.toThrow('native_fs_path_not_canonical')
    await expect(mutateNativeExecutionPath(f.pool, world, binding, '/etc/passwd', async () => null))
      .rejects.toThrow('native_fs_path_outside_world')
  })
})
