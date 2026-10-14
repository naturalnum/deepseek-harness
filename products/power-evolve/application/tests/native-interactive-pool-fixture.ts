/** Real Pool admission reads actual consumer availability over its verified TLS Kubernetes transport. */
import { randomUUID } from 'node:crypto'
import { execFileSync } from 'node:child_process'
import { once } from 'node:events'
import { createServer } from 'node:https'
import { readFile, realpath, writeFile } from 'node:fs/promises'
import { join } from 'node:path'
import { Pool } from 'pg'
import { z } from 'zod'
import { accountUserId } from '../src/account-contracts.ts'
import { PlatformError } from '../src/contracts.ts'
import { readJson, sendFailure, sendJson } from '../src/http.ts'
import { KubernetesClient } from '../src/platform/kubernetes.ts'
import { NativeRuntimeAuthority } from '../src/platform/native-runtime-authority.ts'
import { NativeRuntimePool, type NativeRuntimePoolConfig } from '../src/platform/native-runtime-pool.ts'

/** Build an owned controller observation plane around the unchanged production Pool.
 * @param database Owned case PostgreSQL pool.
 * @param root Owned case scratch directory.
 * @param user Exact browser-authenticated account.
 * @param available Actual NativeRuntimeSessions availability, never an invented outcome.
 * @returns Original Pool, credential, observations and joined cleanup.
 */
export async function interactivePool(database: Pool, root: string, user: string, available: () => boolean) {
  const key = join(root, 'interactive-kube-key'), certificate = join(root, 'interactive-kube-ca'), tokenFile = join(root, 'interactive-kube-token')
  execFileSync('openssl', ['req', '-x509', '-newkey', 'rsa:2048', '-nodes', '-subj', '/CN=localhost',
    '-addext', 'subjectAltName=IP:127.0.0.1', '-days', '1', '-keyout', key, '-out', certificate], { stdio: 'ignore', timeout: 10000 })
  await writeFile(tokenFile, 'owned-interactive-kube-token', { mode: 0o600 })
  const resources = new Map<string, Record<string, unknown>>(), calls: Array<{ method: string; path: string }> = []
  const pending = new Set<Promise<void>>(), authority = new NativeRuntimeAuthority(database)
  const server = createServer({ key: await readFile(key), cert: await readFile(certificate) }, (request, response) => {
    const work = (async () => {
      try {
        if (request.headers.authorization !== 'Bearer owned-interactive-kube-token') throw new PlatformError(403, 'owned_kube_auth_required')
        const path = request.url ?? '', method = request.method ?? ''
        calls.push({ method, path })
        if (path.includes('/proxy/')) {
          const actor = await authority.authenticate(String(request.headers['x-power-evolve-runner-token']))
          if (actor.userId !== user || !path.includes('pe-runtime-' + actor.runtimeId + ':')) throw new PlatformError(403, 'owned_runtime_mismatch')
          sendJson(response, { ready: available(), runtimeUserId: actor.userId,
            runtimeId: actor.runtimeId, generation: actor.generation }); return
        }
        if (method === 'POST') {
          const value = z.object({ metadata: z.object({ name: z.string() }).loose(),
            stringData: z.record(z.string(), z.string()).optional(), spec: z.record(z.string(), z.unknown()).optional() }).loose()
            .parse(await readJson(request, 1048576))
          const entry: Record<string, unknown> = { ...value,
            metadata: { ...value.metadata, uid: randomUUID(), generation: 1, resourceVersion: '1' } }
          if (value.stringData) entry['data'] = Object.fromEntries(Object.entries(value.stringData).map(([name, text]) => [name, Buffer.from(text).toString('base64')]))
          if (path.endsWith('/pods')) { entry['spec'] = { ...value.spec, nodeName: 'owned-node' }; entry['status'] = { phase: 'Running' } }
          resources.set(path + '/' + value.metadata.name, entry); sendJson(response, entry); return
        }
        const current = resources.get(path)
        if (!current) throw new PlatformError(404, 'owned_resource_missing')
        if (method === 'GET') { sendJson(response, current); return }
        if (method === 'DELETE') {
          if (!path.includes('/pods/')) { resources.delete(path); sendJson(response, {}); return }
          const metadata = z.record(z.string(), z.unknown()).parse(current['metadata'])
          current['metadata'] = { ...metadata, deletionTimestamp: '2026-10-14T00:00:02Z' }
          const stopped = (name: string, id: string) => ({ name, ready: false, restartCount: 0, containerID: id, lastState: {},
            state: { terminated: { exitCode: 0, containerID: id, startedAt: '2026-10-14T00:00:00Z', finishedAt: '2026-10-14T00:00:01Z' } } })
          current['status'] = { phase: 'Succeeded', conditions: [{ type: 'PodReadyToStartContainers', status: 'False', observedGeneration: 1 }],
            initContainerStatuses: [stopped('prepare-private', 'containerd://' + 'a'.repeat(64))],
            containerStatuses: [stopped('native-runtime', 'containerd://' + 'b'.repeat(64))] }
          sendJson(response, current); return
        }
        if (method === 'PATCH') {
          const patch = z.object({ metadata: z.record(z.string(), z.unknown()) }).parse(await readJson(request, 1048576))
          current['metadata'] = { ...z.record(z.string(), z.unknown()).parse(current['metadata']), ...patch.metadata }
          sendJson(response, current); resources.delete(path); return
        }
        throw new PlatformError(405, 'owned_kube_method')
      } catch (error) { sendFailure(response, error) }
    })()
    pending.add(work); void work.finally(() => { pending.delete(work) })
  })
  server.listen(0, '127.0.0.1'); await once(server, 'listening')
  const address = server.address(); if (!address || typeof address === 'string') throw new Error('Missing owned Pool listener')
  const kube = await KubernetesClient.fromServiceAccount(`https://127.0.0.1:${address.port}`, certificate, tokenFile)
  const locks = new Pool({ ...database.options, max: 2 })
  const config: NativeRuntimePoolConfig = { kubeconfigFile: tokenFile, namespace: 'owned', image: 'fixture@sha256:' + 'a'.repeat(64),
    runtimeClass: 'gvisor', volumeClaimName: 'owned', storageSubPath: 'homes', localStateRoot: join(await realpath(root), 'homes'),
    deployment: { mode: 'local-http', privateDir: '/unused', dshHome: '/unused', hostOrigin: 'http://host.example',
      platformOrigin: 'http://platform.example', platformInternalUrl: 'http://platform', rows: { 'native-runtime': {} } },
    credentialLifetimeMs: 60000, readyTimeoutMs: 1000, requestTimeoutMs: 1000, stopTimeoutMs: 1000, reconcileMs: 1000,
    maxResponseBytes: 1048576, maxRuntimeSeconds: 60, maxAccounts: 10, lockConnections: 2,
    resources: { requests: { cpu: '1', memory: '256Mi' }, limits: { cpu: '1', memory: '256Mi' } } }
  const pool = new NativeRuntimePool(database, locks, kube, config)
  const original = await pool.ensure(accountUserId.parse(user))
  const secret = [...resources].find(([path]) => path.includes('/secrets/'))?.[1]
  const data = z.object({ data: z.object({ 'runtime-token': z.string() }) }).parse(secret)
  const token = Buffer.from(data.data['runtime-token'], 'base64').toString()
  return { pool, original, token, calls, close: async () => {
    try { await pool.close() } finally {
      await locks.end(); server.closeAllConnections()
      await new Promise<void>((resolve, reject) => server.close((error) => { if (error) reject(error); else resolve() }))
      await Promise.allSettled(pending)
    }
  } }
}
