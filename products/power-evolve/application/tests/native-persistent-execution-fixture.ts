/** Real PTY worker and production admission over owned PG/TLS observations; this fixture does not prove kernel isolation. */
import { Context } from '@deepseek-ai/cordis'
import { SubprocessRuntime, type SubprocessHandle, type SubprocessSpawnSpec, type SubprocessTerminalHandle } from '@deepseek-ai/dsh-subprocess'
import { spawn, execFile, execFileSync } from 'node:child_process'
import { once } from 'node:events'
import { readFile, writeFile, mkdir } from 'node:fs/promises'
import { createServer } from 'node:https'
import { join } from 'node:path'
import { promisify } from 'node:util'
import type { Duplex } from 'node:stream'
import { randomUUID } from 'node:crypto'
import { z } from 'zod'
import { expect } from 'vitest'
import { KubernetesClient } from '../src/platform/kubernetes.ts'
import { NativeExecutionAuthorityStore } from '../src/platform/native-execution-authority-store.ts'
import { NativeExecutionBroker } from '../src/platform/native-execution-broker.ts'
import { NativeExecutionPods } from '../src/platform/native-execution-pods.ts'
import { NativeExecutionRoutes } from '../src/platform/native-execution-routes.ts'
import { readNativeRuntimePolicy } from '../src/platform/native-runtime-policy.ts'
import { SafePosix } from '../src/platform/safe-posix.ts'
import type { TaskStore } from '../src/platform/tasks.ts'
import type { cloudFixture } from './cloud-fixture.ts'

type Fixture = Parameters<Parameters<typeof cloudFixture>[0]>[0]
const metadata = z.object({ name: z.string(), uid: z.string().optional(), resourceVersion: z.string().optional(),
  labels: z.record(z.string(), z.string()), finalizers: z.array(z.string()) }).loose()
const podSchema = z.object({ metadata,
  spec: z.object({ containers: z.array(z.object({ name: z.string(), image: z.string() }).loose()) }).loose(),
  status: z.unknown().optional() }).loose()
type Pod = z.infer<typeof podSchema>

/** Transport executes the unchanged Python relay and real Bash in an owned directory, instead of pretending kubectl creates a sandbox. */
class OwnedWorkerTransport extends SubprocessRuntime {
  private readonly live = new Map<ReturnType<typeof spawn>, { name: string; owner: string; done: Promise<unknown> }>()
  constructor(ctx: Context, private readonly root: string, private readonly image: string) {
    super(ctx)
    ctx.effect(() => async () => {
      await Promise.all([...this.live].map(async ([child, identity]) => {
        await this.stop(identity); await identity.done; child.kill('SIGKILL')
      }))
    })
  }
  private async stop(identity: { name: string; owner: string }): Promise<void> {
    const run = promisify(execFile)
    const inspected = await run('docker', ['inspect', identity.name]).catch(() => undefined)
    if (!inspected) return
    const record = z.array(z.object({ Id: z.string(), Config: z.object({ Labels: z.record(z.string(), z.string()) }) }))
      .parse(JSON.parse(inspected.stdout))[0]
    if (!record || record.Config.Labels['pe.s3.persistent.owner'] !== identity.owner) throw new Error('Owned worker identity changed')
    await run('docker', ['kill', record.Id]).catch(() => undefined)
  }
  override resolveExecutable(command: string): Promise<string> { return Promise.resolve(command) }
  override terminalEnvironment() { return Promise.resolve({ platform: 'posix' as const, defaultShell: '/bin/bash' }) }
  override spawnTerminal(): Promise<SubprocessTerminalHandle> { throw new Error('Production Broker owns the terminal worker') }
  override spawn(spec: SubprocessSpawnSpec): SubprocessHandle {
    const raw = spec.argv.at(-1)
    if (typeof raw !== 'string') throw new Error('Missing original worker request')
    const input = z.object({ cwd: z.string(), argv: z.array(z.string()) }).loose().parse(JSON.parse(raw))
    const name = 'pe-s3-persistent-' + randomUUID(), owner = randomUUID()
    const child = spawn('docker', ['run', '--rm', '-i', '--name', name, '--label', 'pe.s3.persistent.owner=' + owner,
      '--network', 'none', '--read-only', '--user', '1000:1000', '--cap-drop', 'ALL', '--security-opt', 'no-new-privileges',
      '--mount', 'type=bind,src=' + this.root + ',dst=/workspace,readonly', '--entrypoint', '/usr/bin/python3', this.image,
      '-I', '-B', '/opt/power-evolve/sandbox-payload/native-execution-worker/native-process-worker.py',
      JSON.stringify({ ...input, cwd: '/workspace' })], { stdio: ['pipe', 'pipe', 'pipe'] })
    const done = new Promise<{ exitCode: number | null; signal: NodeJS.Signals | null }>((resolve, reject) => {
      child.once('error', reject); child.once('close', (exitCode, signal) => { this.live.delete(child); resolve({ exitCode, signal }) })
    })
    const identity = { name, owner, done }; this.live.set(child, identity)
    void done.catch(() => undefined)
    child.stderr.on('data', (data: Buffer) => { process.stderr.write(data) })
    const handle: SubprocessHandle = { stdin: child.stdin, stdout: child.stdout, stderr: child.stderr, control: undefined,
      collected: {}, done, terminate: () => { void this.stop(identity) }, waitForExit: async () => { await done; return true } }
    return handle
  }
}

/** Assemble actual PG admission and provider consumers with a bounded TLS Kubernetes observation peer.
 * Pod observations are synthetic, while subprocess/PTY data is produced by the real maintained worker.
 */
export async function persistentExecutionFixture(f: Fixture, tasks: TaskStore, expectedStopFailure = false) {
  const key = join(f.root, 'persistent-tls-key'), cert = join(f.root, 'persistent-tls-cert'), token = join(f.root, 'persistent-tls-token')
  execFileSync('openssl', ['req', '-x509', '-newkey', 'rsa:2048', '-nodes', '-subj', '/CN=localhost',
    '-addext', 'subjectAltName=IP:127.0.0.1', '-days', '1', '-keyout', key, '-out', cert], { stdio: 'ignore', timeout: 10000 })
  await writeFile(token, 'owned-persistent-tls', { mode: 0o600 })
  const observed = new Map<string, Pod>(), sockets = new Set<Duplex>(), errors: unknown[] = []
  const stopEntered = Promise.withResolvers<undefined>(), stopRelease = Promise.withResolvers<undefined>()
  let heldStop = false, denyStop = false
  const server = createServer({ key: await readFile(key), cert: await readFile(cert) })
  server.on('connection', (socket) => { sockets.add(socket); socket.once('close', () => { sockets.delete(socket) }) })
  server.on('request', (request, response) => {
    void (async () => {
      expect(request.headers.authorization).toBe('Bearer owned-persistent-tls')
      const name = request.url?.split('/').at(-1)
      if (request.method === 'POST') {
        const chunks: Buffer[] = []; for await (const chunk of request) chunks.push(Buffer.from(chunk as Uint8Array))
        const pod = podSchema.parse(JSON.parse(Buffer.concat(chunks).toString()))
        pod.metadata.uid = randomUUID(); pod.metadata.resourceVersion = '1'; pod.metadata.generation = 1
        pod.spec.nodeName = 'owned-observation'
        pod.status = { phase: 'Running', containerStatuses: [{ name: 'payload', ready: true }] }
        observed.set(pod.metadata.name, pod); response.end(JSON.stringify(pod)); return
      }
      const pod = name ? observed.get(name) : undefined
      if (!pod) { response.statusCode = 404; response.end('{"reason":"NotFound"}'); return }
      if (request.method === 'DELETE') {
        const kind = (await f.pool.query<{ kind: string }>('SELECT kind FROM pe_native_execution_processes WHERE pod_name=$1', [name])).rows[0]?.kind
        if (kind === 'terminal' && !heldStop) { heldStop = true; stopEntered.resolve(undefined); await stopRelease.promise }
        if (denyStop) { response.statusCode = 503; response.end('{"reason":"OwnedStopDenied"}'); return }
        const id = 'containerd://' + 'b'.repeat(64), now = new Date().toISOString()
        pod.metadata.deletionTimestamp = now
        pod.status = { phase: 'Failed', conditions: [{ type: 'PodReadyToStartContainers', status: 'False', observedGeneration: 1 }],
          containerStatuses: [{ name: 'payload', ready: false, started: false, restartCount: 0, lastState: {}, containerID: id,
            state: { terminated: { containerID: id, exitCode: 143, startedAt: now, finishedAt: now } } }] }
      } else if (request.method === 'PATCH') {
        const chunks: Buffer[] = []; for await (const chunk of request) chunks.push(Buffer.from(chunk as Uint8Array))
        const update = z.object({ metadata: z.object({ uid: z.string(), resourceVersion: z.string(), finalizers: z.array(z.string()) }) })
          .parse(JSON.parse(Buffer.concat(chunks).toString()))
        expect(update.metadata.uid).toBe(pod.metadata.uid); expect(update.metadata.resourceVersion).toBe(pod.metadata.resourceVersion)
        pod.metadata.finalizers = update.metadata.finalizers
        pod.metadata.resourceVersion = String(Number(pod.metadata.resourceVersion) + 1)
      } else expect(request.method).toBe('GET')
      response.end(JSON.stringify(pod))
    })().catch((error: unknown) => { errors.push(error); response.statusCode = 500; response.end('{}') })
  })
  server.listen(0, '127.0.0.1'); await once(server, 'listening')
  const address = server.address(); if (!address || typeof address === 'string') throw new Error('Missing owned TLS listener')
  const kube = await KubernetesClient.fromServiceAccount(`https://127.0.0.1:${address.port}`, cert, token)
  const authority = new NativeExecutionAuthorityStore(f.pool, tasks, f.files.storage, readNativeRuntimePolicy)
  const pods = new NativeExecutionPods(f.pool, kube, { namespace: 'owned-persistent', runtimeClassName: 'gvisor',
    image: 'owned@sha256:' + 'a'.repeat(64), storageVolumeClaim: 'owned', storageVolumePrefix: 'storage',
    homeVolumePrefix: 'homes', homeLocalRoot: f.root, tmpVolumePrefix: 'tmp', tmpLocalRoot: f.root,
    cpu: '1', memory: '128Mi', pollMs: 5, readyTimeoutMs: 1000, stopTimeoutMs: 1000, maxPodSeconds: 60 })
  // This observation test runs as the test caller, so its directory provisioners keep caller ownership.
  // Production admission, process identity, original generation checks and TLS cleanup remain unchanged.
  for (const field of ['homes', 'temporary']) {
    const provider: unknown = Reflect.get(pods, field)
    if (!(provider instanceof SafePosix)) throw new Error('Missing original directory provisioner')
    Reflect.set(provider, 'owner', undefined)
  }
  const imageTag = process.env.PE_TEST_CLOUD_IMAGE
  if (!imageTag || !/^pe-employee4-cloud:[a-f0-9-]{36}$/u.test(imageTag)) throw new Error('Owned Linux source image is required')
  const inspectedImage = execFileSync('docker', ['image', 'inspect', imageTag], { encoding: 'utf8', timeout: 10000 })
  const image = z.object({ Id: z.string().regex(/^sha256:[a-f0-9]{64}$/u), Os: z.literal('linux'), Architecture: z.literal('arm64'),
    Config: z.object({ Labels: z.record(z.string(), z.string()) }) }).array().length(1).parse(JSON.parse(inspectedImage))[0]
  if (!image || image.Config.Labels['org.power-evolve.employee4'] !== imageTag.slice('pe-employee4-cloud:'.length)) {
    throw new Error('Linux source image belongs to another fixture')
  }
  const workerImage = image.Id
  const guest = join(f.root, 'owned-guest'); await mkdir(guest, { mode: 0o755 })
  const owner = new Context(), transport = new OwnedWorkerTransport(owner, guest, workerImage)
  const broker = new NativeExecutionBroker(authority, pods, transport, { kubectlExecutable: '/owned-observation', kubeconfigPath: token,
    fsWorkerPath: '/unused', processWorkerPath: '/unchanged-native-worker', maxRequestBytes: 1048576, maxReplyBytes: 1048576,
    maxProcessMs: 30000, authorityPollMs: 20, transportGraceMs: 100 })
  const routes = new NativeExecutionRoutes(broker, { maxLiveHandles: 8, maxOutputBytes: 1048576 })
  return { authority, pods, broker, routes, observed, stopEntered: stopEntered.promise,
    releaseStop: () => { stopRelease.resolve(undefined) }, rejectStop: () => { denyStop = true },
    async close() {
      stopRelease.resolve(undefined)
      try {
        if (expectedStopFailure) {
          denyStop = false
          await pods.recover(8)
          await expect(routes.dispose()).rejects.toBeInstanceOf(AggregateError)
          await expect(broker.dispose()).rejects.toBeInstanceOf(AggregateError)
          await owner.fiber.dispose()
        } else { await routes.dispose(); await broker.dispose(); await owner.fiber.dispose() }
      }
      finally {
        const closed = new Promise<void>((resolve, reject) => { server.close((error) => { if (error) reject(error); else resolve() }) })
        for (const socket of sockets) socket.destroy()
        await closed
      }
      if (errors.length) throw new AggregateError(errors, 'Owned TLS peer failed')
    } }
}
