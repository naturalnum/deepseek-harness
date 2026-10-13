/** Owned HTTPS Kube protocol and genuine Linux STDIO driver; synthetic Kube identities do not qualify a Pod. */
import assert from 'node:assert/strict'
import { execFile } from 'node:child_process'
import { randomUUID } from 'node:crypto'
import { readFile, readdir, writeFile } from 'node:fs/promises'
import { createServer } from 'node:https'
import { join, resolve } from 'node:path'
import { promisify } from 'node:util'
import { z } from 'zod'
import type { Pool } from 'pg'
import { parseStdioStartV2 } from '@power-evolve/connector-runner/stdio-v2-dispatch'
import { StdioCloudRuntimeV2 } from '../../connector-runner/src/stdio-v2-runtime.ts'
import { stdioCloudDeploymentV2, stdioExecutorOwnerV2, type StdioLimitsV2 } from '@power-evolve/contracts/stdio-mcp'
import { KubernetesClient } from '../src/platform/kubernetes.ts'
import { SandboxManager } from '../src/platform/sandbox.ts'
import type { FileService } from '../src/platform/files.ts'

const execute = promisify(execFile)
const metadata = z.object({ name: z.string(), namespace: z.string(), labels: z.record(z.string(), z.string()),
  uid: z.string().optional(), resourceVersion: z.string().optional(), generation: z.number().optional(),
  finalizers: z.array(z.string()).optional(), ownerReferences: z.array(z.object({ uid: z.string() }).loose()).optional() }).loose()
const resource = z.object({ apiVersion: z.string(), kind: z.string(), metadata,
  spec: z.record(z.string(), z.unknown()).optional(), data: z.record(z.string(), z.string()).optional(),
  stringData: z.record(z.string(), z.string()).optional(), status: z.unknown().optional() }).loose()
type Resource = z.infer<typeof resource>

/** Observe actual UID1000 writers in this owned Linux PID namespace; a direct child exit is insufficient. */
async function uidQuiet(): Promise<boolean> {
  for (const pid of (await readdir('/proc')).filter(value => /^[0-9]+$/u.test(value))) {
    try {
      const status = await readFile(`/proc/${pid}/status`, 'utf8')
      if (/^Uid:\s+1000\s/mu.test(status) && !/^State:\s+Z/mu.test(status)) return false
    } catch (error) { if (!(error instanceof Error && 'code' in error && error.code === 'ENOENT')) throw error }
  }
  return true
}

/** Start only a disposable listener; all ready PG records remain current SandboxManager output.
 * @param f Owned ordinary-role PG and storage services.
 * @param tlsRoot Private fixture certificate directory.
 * @param limits Frozen current STDIO SDK budgets.
 * @param imageId Inspected Linux dependency image; reported Kube resources remain synthetic.
 * @param signal Actual case lifetime; no new request is admitted after cancellation.
 * @returns Current manager, actual HTTP observations and awaited listener/Runner disposal.
 */
export async function workerProtocol(f: { pool: Pool; root: string; files: FileService }, tlsRoot: string,
  limits: StdioLimitsV2, imageId: string, signal: AbortSignal) {
  assert.equal(process.platform, 'linux'); assert.equal(process.getuid?.(), 0)
  const architecture = process.arch === 'x64' ? 'amd64' : process.arch
  assert(architecture === 'amd64' || architecture === 'arm64')
  const namespace = `pe-e6-stdio-${randomUUID().slice(0, 8)}`, bearer = randomUUID()
  const resources = new Map<string, Resource>(), identities = new Map<string, string>()
  const runtimes = new Map<string, StdioCloudRuntimeV2>(), pending = new Set<Promise<void>>()
  const trace: Array<{ method: string; path: string; status: number }> = []
  const errors: Array<{ name: string; publicCode: string | undefined; fixtureLocation: string | undefined }> = []
  let version = 0, missingNext = false, holdStart: Promise<void> | undefined
  let startSeen: (() => void) | undefined, releaseStart: (() => void) | undefined
  const pin = stdioCloudDeploymentV2.parse({ kind: 'cloud', deploymentId: randomUUID(), protocolVersion: 2,
    platform: { os: 'linux', architecture },
    imageReference: `fixture.invalid/current-stdio@${imageId}`, configImageId: imageId,
    runtimeImageIds: [`containerd://${imageId}`] })
  const maxReplyBytes = 262_144
  const runtimeFor = async (name: string, body: unknown) => {
    const packet = parseStdioStartV2(body, limits), { userId, sessionId } = packet.dispatch.task
    const instance = identities.get(name); assert(instance)
    let runtime = runtimes.get(name)
    if (!runtime) {
      const session = (await f.pool.query<{ workspace_id: string }>('SELECT workspace_id FROM pe_sessions WHERE id=$1 AND user_id=$2',
        [sessionId, userId])).rows[0]; assert(session)
      const workspace = await f.files.workspaceForId(userId, session.workspace_id)
      const env = { HOME: join(f.root, 'homes', userId), PATH: '/usr/local/bin:/usr/bin:/bin', LANG: 'C.UTF-8' }
      runtime = new StdioCloudRuntimeV2({ limits, maxReplyBytes,
        executorOwner: stdioExecutorOwnerV2.options[0].parse({ kind: 'cloud', runnerInstanceId: instance }),
        environment: { workspaceRoot: workspace.path, env, identity: { kind: 'unix', uid: 1000, gid: 1000 } },
        authorizeCwd: async (cwd, abort) => {
          try {
            await execute(process.execPath, ['-e', 'require("node:fs").accessSync(process.argv[1],require("node:fs").constants.X_OK)',
              resolve(workspace.path, cwd)], { uid: 1000, gid: 1000, env, signal: abort, timeout: 2000 })
            return true
          } catch (error) { if (abort.aborted) throw error; return false }
        }, cleanup: uidQuiet })
      runtimes.set(name, runtime)
    }
    return runtime
  }
  const server = createServer({ key: await readFile(join(tlsRoot, 'key.pem')), cert: await readFile(join(tlsRoot, 'cert.pem')) },
    (request, response) => {
      const operation = (async () => {
        assert(!signal.aborted); assert.equal(request.headers.authorization, `Bearer ${bearer}`)
        const chunks: Buffer[] = []; let bytes = 0
        for await (const part of request) {
          const chunk: unknown = part
          assert(Buffer.isBuffer(chunk)); bytes += chunk.length; assert(bytes <= 262_144); chunks.push(chunk)
        }
        const body: unknown = chunks.length ? JSON.parse(Buffer.concat(chunks).toString('utf8')) : undefined
        const path = request.url ?? '', parts = path.split('/'), method = request.method ?? ''
        let status = 200, value: unknown
        if (path === '/api/v1/nodes/owned-stdio-node' && method === 'GET') {
          value = { metadata: { name: 'owned-stdio-node' }, status: { nodeInfo: { operatingSystem: 'linux', architecture } } }
        } else {
          const index = parts.indexOf('namespaces') + 1; assert.equal(parts[index], namespace)
          const kind = parts[index + 1], name = decodeURIComponent(parts[index + 2] ?? ''); assert(kind)
          const key = `${kind}/${name}`, existing = resources.get(key)
          if (kind === 'services' && name.startsWith('http:') && parts[index + 3] === 'proxy') {
            const original = name.slice(5, -5), secret = resources.get(`secrets/${original}`); assert(secret?.data?.token)
            assert.equal(request.headers['x-power-evolve-runner-token'], Buffer.from(secret.data.token, 'base64').toString('utf8'))
            const endpoint = '/' + parts.slice(index + 4).join('/')
            if (endpoint === '/health') value = { ready: true, instanceId: identities.get(original) }
            else if (endpoint === '/stdio/v2/executions' && method === 'POST') {
              const runtime = await runtimeFor(original, body); value = await runtime.start(body)
              startSeen?.(); if (holdStart) await holdStart
            } else {
              const runtime = runtimes.get(original); assert(runtime)
              const executionId = decodeURIComponent(parts[index + 7] ?? '')
              if (method === 'GET' && missingNext) { missingNext = false; status = 404; value = { code: 'owned_missing_delivery' } }
              else if (method === 'GET') { value = runtime.get(executionId); if (!value) { status = 404; value = { code: 'owned_missing' } } }
              else if (method === 'POST' && endpoint.endsWith('/cancel')) value = runtime.cancel(executionId)
              else throw new Error('Owned Runner route mismatch')
            }
          } else if (method === 'GET') {
            if (!existing) { status = 404; value = { message: 'Owned protocol resource absent' } } else value = existing
          } else if (method === 'POST') {
            assert.equal(name, ''); assert(['sandboxes', 'services', 'secrets'].includes(kind))
            const posted = resource.parse(body), resourceName = posted.metadata.name
            assert(!resources.has(`${kind}/${resourceName}`))
            const created: Resource = { ...posted, metadata: {
              ...posted.metadata, uid: randomUUID(), resourceVersion: String(++version), generation: 1,
            } }
            if (kind === 'secrets') {
              created.data = Object.fromEntries(Object.entries(created.stringData ?? {}).map(([field, text]) => [field, Buffer.from(text).toString('base64')]))
              delete created.stringData
            } else if (kind === 'sandboxes') {
              const template = z.object({ spec: z.record(z.string(), z.unknown()) }).parse(created.spec?.podTemplate)
              created.status = { conditions: [{ type: 'Ready', status: 'True' }] }
              resources.set(`pods/${resourceName}`, { apiVersion: 'v1', kind: 'Pod',
                metadata: { name: resourceName, namespace, labels: structuredClone(created.metadata.labels), uid: randomUUID(),
                  resourceVersion: String(++version), generation: 1, finalizers: [], ownerReferences: [{ uid: created.metadata.uid ?? '' }] },
                spec: { ...structuredClone(template.spec), nodeName: 'owned-stdio-node' },
                status: { phase: 'Running', containerStatuses: [{ name: 'runner', ready: true, restartCount: 0,
                  state: { running: {} }, containerID: `containerd://owned-protocol-${randomUUID()}`, imageID: pin.runtimeImageIds[0] }] } })
              identities.set(resourceName, randomUUID())
            }
            resources.set(`${kind}/${resourceName}`, created); status = 201; value = created
          } else if (method === 'PATCH') {
            assert.equal(kind, 'pods'); assert(existing)
            const patch = z.object({ metadata: z.object({ uid: z.string(), resourceVersion: z.string(),
              finalizers: z.array(z.string()) }) }).parse(body)
            assert.equal(patch.metadata.uid, existing.metadata.uid)
            assert.equal(patch.metadata.resourceVersion, existing.metadata.resourceVersion)
            existing.metadata.finalizers = patch.metadata.finalizers
            existing.metadata.resourceVersion = String(++version); value = existing
          } else throw new Error('Unexpected owned Kubernetes method')
        }
        trace.push({ method, path, status }); response.writeHead(status, { 'content-type': 'application/json' }); response.end(JSON.stringify(value))
      })().catch((error: unknown) => {
        errors.push({ name: error instanceof Error ? error.name : 'NonError',
          publicCode: error instanceof Error && /^stdio_v2_[a-z0-9_]+$/u.test(error.message) ? error.message : undefined,
          fixtureLocation: error instanceof Error ? error.stack?.match(/employee6-stdio-worker-protocol\.ts:\d+:\d+/u)?.[0] : undefined })
        if (!response.headersSent) response.writeHead(500, { 'content-type': 'application/json' })
        response.end('{"message":"Owned protocol operation failed"}')
      })
      pending.add(operation); void operation.then(() => pending.delete(operation))
    })
  const close = async () => {
    releaseStart?.(); holdStart = undefined
    await Promise.all([...runtimes.values()].map(runtime => runtime.close()))
    await Promise.allSettled(pending)
    if (server.listening) await new Promise<void>((done, reject) => {
      server.close((error) => { if (error) reject(error); else done() }); server.closeAllConnections()
    })
    assert(await uidQuiet(), 'Actual UID1000 writers must be quiescent before disposal')
  }
  let returned = false
  try {
    await new Promise<void>((done, reject) => { server.once('error', reject); server.listen(0, '127.0.0.1', done) })
    const address = server.address(); assert(address && typeof address === 'object')
    const kubeconfig = join(f.root, 'owned-stdio-kubeconfig-private.json')
    await writeFile(kubeconfig, JSON.stringify({ 'current-context': 'owned-stdio',
      clusters: [{ name: 'owned-stdio', cluster: { server: `https://127.0.0.1:${address.port}`,
        'certificate-authority-data': Buffer.from(await readFile(join(tlsRoot, 'cert.pem'))).toString('base64') } }],
      contexts: [{ name: 'owned-stdio', context: { cluster: 'owned-stdio', user: 'owned-stdio' } }],
      users: [{ name: 'owned-stdio', user: { token: bearer } }] }), { flag: 'wx', mode: 0o600 })
    const manager = new SandboxManager(await KubernetesClient.fromFile(kubeconfig), f.files, f.pool, randomUUID(), {
      namespace, image: pin.imageReference, localRoot: f.root, nodeRoot: '', volumeClaimName: 'owned-stdio-claim',
      readyTimeoutMs: 5000, maxExecutions: 8, stdioV2: { limits, maxReplyBytes } })
    returned = true
    return { manager, pin, trace, errors, close, uidQuiet,
      loseNextGet: () => { missingNext = true },
      holdNextStart: () => {
        holdStart = new Promise<void>((done) => { releaseStart = done })
        return new Promise<void>((done) => { startSeen = done })
      },
      releaseHeldStart: () => { releaseStart?.(); holdStart = undefined; startSeen = undefined },
      runtimeViews: () => [...runtimes.values()] }
  } finally { if (!returned) await close() }
}
