/** Actual Broker and relay consumers retain failed outside stop after the published handle has left live ownership. */
import { Context } from '@deepseek-ai/cordis'
import { SubprocessRuntime, type SubprocessHandle, type SubprocessTerminalHandle } from '@deepseek-ai/dsh-subprocess'
import { randomUUID } from 'node:crypto'
import { mkdtemp, rm, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { PassThrough } from 'node:stream'
import { Pool } from 'pg'
import { expect, test, vi } from 'vitest'
import { nativeExecutionWorld } from '../src/native-execution/types.ts'
import { storageBinding } from '../src/platform/cloud-storage-types.ts'
import { KubernetesClient } from '../src/platform/kubernetes.ts'
import { ManagedCloudStorage } from '../src/platform/managed-storage.ts'
import { NativeExecutionAuthorityStore } from '../src/platform/native-execution-authority-store.ts'
import { NativeExecutionBroker } from '../src/platform/native-execution-broker.ts'
import { NativeExecutionPods } from '../src/platform/native-execution-pods.ts'
import { SafePosix } from '../src/platform/safe-posix.ts'

class CompletedRelayTransport extends SubprocessRuntime {
  override resolveExecutable(command: string) { return Promise.resolve(command) }
  override terminalEnvironment() { return Promise.resolve({ platform: 'posix' as const, defaultShell: '/bin/bash' }) }
  override spawn(): SubprocessHandle {
    const stdout = new PassThrough(), stdin = new PassThrough()
    stdout.end([JSON.stringify({ kind: 'ready', pid: 123 }), JSON.stringify({ kind: 'exit', exitCode: 0, signal: null }), ''].join('\n'))
    return { stdout, stdin, stderr: undefined, control: undefined, collected: {}, done: Promise.resolve({ exitCode: 0, signal: null }),
      terminate: () => { stdin.destroy() }, waitForExit: async () => true }
  }
  override spawnTerminal(): Promise<SubprocessTerminalHandle> { throw new Error('The Broker owns terminal relay assembly') }
}

for (const terminal of [false, true]) test(`${terminal ? 'PTY' : 'process'} Broker disposal retains original failed stop after done rejection`, async () => {
  const root = await mkdtemp(join(tmpdir(), 'pe-broker-stop-')), ctx = new Context(), pool = new Pool({ max: 1 })
  try {
    const config = join(root, 'kubeconfig')
    await writeFile(config, JSON.stringify({ 'current-context': 'owned',
      contexts: [{ name: 'owned', context: { cluster: 'owned', user: 'owned' } }],
      clusters: [{ name: 'owned', cluster: { server: 'https://127.0.0.1:1', 'certificate-authority-data': 'dGVzdA==' } }],
      users: [{ name: 'owned', user: { token: 'fixture-token' } }] }), { mode: 0o600 })
    const kube = await KubernetesClient.fromFile(config)
    const world = nativeExecutionWorld.parse({ worldId: randomUUID(), userId: randomUUID(), sessionId: randomUUID(),
      agentId: randomUUID(), workspaceId: randomUUID(), operationId: randomUUID(), operationEpoch: 1,
      storageGeneration: 1, permissionGeneration: 1, mode: 'danger-full-access', workspaceRoot: '/workspace', homeRoot: '/home/agent' })
    const binding = storageBinding.parse({ workspaceId: world.workspaceId, spaceId: randomUUID(), rootKey: randomUUID(),
      rootRelativePath: '', generation: 1 })
    const storage = new ManagedCloudStorage(pool, new SafePosix(root))
    const authority = new NativeExecutionAuthorityStore(pool, { nativeWorldAuthorized: async () => { throw new Error('Unused PG boundary') } },
      storage, async () => ({ mode: world.mode, permissionGeneration: world.permissionGeneration }))
    vi.spyOn(authority, 'assert').mockResolvedValue(binding)
    const pods = new NativeExecutionPods(pool, kube, { namespace: 'owned', runtimeClassName: 'gvisor', image: 'unused',
      storageVolumeClaim: 'owned', storageVolumePrefix: 'storage', homeVolumePrefix: 'homes', homeLocalRoot: root,
      tmpVolumePrefix: 'tmp', tmpLocalRoot: root, cpu: '1', memory: '128Mi', pollMs: 1, readyTimeoutMs: 1000,
      stopTimeoutMs: 1000, maxPodSeconds: 60 })
    const range = { id: randomUUID(), name: 'owned-original-pod', uid: 'owned-original-uid', world }
    vi.spyOn(pods, 'create').mockResolvedValue(range)
    const original = new Error('Original outside stop is unconfirmed')
    const stop = vi.spyOn(pods, 'stop').mockRejectedValue(original)
    const outcome = vi.spyOn(pods, 'recordOutcome').mockResolvedValue(undefined)
    const broker = new NativeExecutionBroker(authority, pods, new CompletedRelayTransport(ctx), {
      kubectlExecutable: '/unused', kubeconfigPath: config, fsWorkerPath: '/unused', processWorkerPath: '/unused',
      maxRequestBytes: 4096, maxReplyBytes: 4096, maxProcessMs: 1000, authorityPollMs: 1000, transportGraceMs: 100 })
    const spec = { argv: ['fixture'], cwd: '/workspace', graceMs: 100 }
    const handle = terminal ? await broker.terminal('fixture-token', world, { ...spec, rows: 24, cols: 80, terminalType: 'xterm' })
      : broker.spawn('fixture-token', world, { ...spec, stdio: { stdin: 'ignore', stdout: 'pipe', stderr: 'pipe' } })
    await expect(handle.done).rejects.toBe(original)
    // The done callback already removed this handle; disposal must observe retained stop failure instead of finding an empty success.
    const disposed = await broker.dispose().then(() => undefined, (error: unknown) => error)
    expect(disposed).toBeInstanceOf(AggregateError)
    if (!(disposed instanceof AggregateError)) throw new Error('Broker discarded the original failure')
    expect(disposed.errors).toContain(original)
    expect(stop).toHaveBeenCalledTimes(1); expect(stop.mock.calls[0]?.[0]).toBe(range)
    expect(outcome).not.toHaveBeenCalled()
    await expect(broker.dispose()).rejects.toMatchObject({ errors: [original] })
    expect(stop).toHaveBeenCalledTimes(1)
  } finally { await ctx.fiber.dispose(); await pool.end(); await rm(root, { recursive: true, force: true }) }
})
