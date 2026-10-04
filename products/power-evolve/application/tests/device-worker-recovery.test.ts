/** Public Worker recovery uses real private files, native flock and loopback HTTP; Docker and Platform are replacements. */
import assert from 'node:assert/strict'
import { fork } from 'node:child_process'
import test, { type TestContext } from 'node:test'
import { createHash, randomUUID } from 'node:crypto'
import { createServer, type IncomingMessage, type ServerResponse } from 'node:http'
import { mkdir, mkdtemp, readFile, realpath, rename, rm, stat, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { fileURLToPath } from 'node:url'
import { setTimeout as delay } from 'node:timers/promises'
import { z } from 'zod'
import { deviceJob, deviceClaim, deviceClaimRequest, deviceContainerRegistration, deviceFinishRequest,
  deviceClaimClosureRequest, deviceClaimClosureReceipt, type DeviceClaimClosureReceipt } from '@power-evolve/contracts/device-execution'
import { DesktopWorker } from '../src/device/worker.ts'
import { DeviceWriterCoordinator, deviceWriterOwner, DEVICE_WRITER_SLOT_FILENAME } from '../src/device/writer-coordinator.ts'
import { DockerCommandError, OwnedDeviceContainer, OWNED_DEVICE_CONTAINER_LABELS, ownedContainerOwner, ownedContainerReceipt,
  type DockerClient, type DockerCommandResult, type OwnedContainerObservation, type OwnedContainerReceipt } from '../src/device/owned-container.ts'
import { SealedDeviceCreations, sealedCreation } from '../src/device/sealed-creations.ts'
import { deviceDrainReport, type DeviceDrainReport } from '@power-evolve/contracts/device-lifecycle'

const workerTestOptions = { timeout: 10000, skip: !['darwin', 'linux'].includes(process.platform) }
const IMAGE = 'sha256:' + 'a'.repeat(64), CONTAINER = 'b'.repeat(64)
const options = { pollMs: 10, contactGraceMs: 2000, commandPollMs: 10, platformRequestTimeoutMs: 300 }
const containerOptions = { commandTimeoutMs: 100, stopTimeoutMs: 100, stopGraceSeconds: 1 }
const stopped = { Running: false, ExitCode: 0, Status: 'exited',
  StartedAt: '2026-10-04T00:00:00Z', FinishedAt: '2026-10-04T00:00:01Z' } satisfies OwnedContainerObservation
const created: OwnedContainerObservation = { ...stopped, Status: 'created', StartedAt: '0001-01-01T00:00:00Z', FinishedAt: '0001-01-01T00:00:00Z' }
const resultUnknown = { state: 'uncertain' as const, exitCode: null, stdout: '', stderr: '',
  stdoutTruncated: false, stderrTruncated: false, timedOut: false }
const journalView = z.array(z.object({ id: z.uuid(), container: z.string(), stage: z.string(), startedAt: z.number(),
  owner: ownedContainerOwner.optional(), imageId: z.string().optional(), receipt: ownedContainerReceipt.optional(),
  queuedJob: deviceJob.optional(),
  claimed: deviceClaim.optional(), processId: z.uuid().optional(), dispatchId: z.uuid().optional(), stopRequestId: z.uuid().optional(),
  claimClosureRequestId: deviceClaimClosureRequest.shape.requestId.optional(), claimClosureReceipt: deviceClaimClosureReceipt.optional(),
  stopObservation: z.object({ Running: z.literal(false), receipt: ownedContainerReceipt }).passthrough().optional(),
  result: z.object({ state: z.string() }).passthrough().optional() }).passthrough())
type JournalRow = z.infer<typeof journalView>[number]
function gate() { let release!: () => void; const promise = new Promise<void>(resolve => { release = resolve }); return { promise, release } }
async function until(condition: () => boolean | Promise<boolean>, label: string): Promise<void> {
  const deadline = Date.now() + 2500
  while (!await condition()) { if (Date.now() >= deadline) throw new Error('Timed out: ' + label); await delay(10) }
}
async function journal(root: string) { return journalView.parse(JSON.parse(await readFile(join(root, 'journal.json'), 'utf8'))) }
async function absent(path: string): Promise<boolean> {
  try { await stat(path); return false }
  catch (error) { if ((error as NodeJS.ErrnoException).code === 'ENOENT') return true; throw error }
}
async function bounded<T>(promise: Promise<T>): Promise<T> {
  let timer: ReturnType<typeof setTimeout> | undefined
  const deadline = new Promise<never>((_, reject) => { timer = setTimeout(() => reject(new Error('child fixture deadline')), 3000) })
  try { return await Promise.race([promise, deadline]) } finally { clearTimeout(timer) }
}
function notice(worker: DesktopWorker): string { return z.object({ notice: z.string() }).parse(worker.status()).notice }
function failJournalWhile(worker: DesktopWorker, refused: () => Promise<boolean>): void {
  // Instance-local fixture injection preserves all successful real FS saves; no production hook exists.
  const method: unknown = Reflect.get(worker, 'saveJournal')
  assert.equal(typeof method, 'function')
  const original = method as (this: DesktopWorker) => Promise<void>
  Object.defineProperty(worker, 'saveJournal', { value: async () => {
    if (await refused()) throw new Error('fixture_journal_write_failed')
    await original.call(worker)
  } })
}
async function writerSlot(root: string) {
  return z.object({ slot: z.object({ owner: deviceWriterOwner, receipt: ownedContainerReceipt.nullable(), stop: z.unknown() })
    .nullable() }).parse(JSON.parse(await readFile(join(root, DEVICE_WRITER_SLOT_FILENAME), 'utf8'))).slot
}
function ownerLabels(receipt: OwnedContainerReceipt): Record<string, string> {
  return { [OWNED_DEVICE_CONTAINER_LABELS.schema]: '1', [OWNED_DEVICE_CONTAINER_LABELS.imageId]: receipt.imageId,
    ...Object.fromEntries(Object.entries(receipt.owner).map(([key, value]) => [OWNED_DEVICE_CONTAINER_LABELS[key as keyof typeof receipt.owner], value])) }
}

class DockerReplacement implements DockerClient {
  readonly calls: string[][] = []
  present = false
  name = ''
  labels: Record<string, string> = {}
  state: OwnedContainerObservation = { ...created }
  lostCreate = false
  keepRunning = false
  failStop = false
  lostRemove = false
  stopGate: ReturnType<typeof gate> | undefined
  onCreate: (() => Promise<void>) | undefined
  onStart: (() => Promise<void>) | undefined
  onRemove: (() => Promise<void>) | undefined
  count(command: string): number { return this.calls.filter(args => args[0] === command).length }
  seed(entry: JournalRow, state = created): void {
    assert(entry.owner)
    const receipt = entry.receipt ?? ownedContainerReceipt.parse({ containerId: CONTAINER, imageId: IMAGE, owner: entry.owner })
    this.present = true; this.name = entry.container; this.labels = ownerLabels(receipt); this.state = { ...state }
  }
  async run(args: readonly string[], timeoutMs: number): Promise<DockerCommandResult> {
    assert(timeoutMs > 0 && timeoutMs <= 100); this.calls.push([...args])
    switch (args[0]) {
      case 'image': return { stdout: JSON.stringify(IMAGE), stderr: '' }
      case 'create': {
        await this.onCreate?.(); this.present = true; this.state = { ...created }
        this.name = args[args.indexOf('--name') + 1]!
        this.labels = {}
        for (let index = 0; index < args.length; index++) if (args[index] === '--label') {
          const text = args[++index]!, separator = text.indexOf('='); this.labels[text.slice(0, separator)] = text.slice(separator + 1)
        }
        if (this.lostCreate) throw new DockerCommandError('docker_command_failed')
        return { stdout: CONTAINER + '\n', stderr: '' }
      }
      case 'container': {
        assert.equal(args[1], 'inspect')
        if (!this.present || ![CONTAINER, this.name].includes(args.at(-1)!)) throw new DockerCommandError('docker_not_found')
        return { stdout: JSON.stringify({ Id: CONTAINER, Image: IMAGE, Labels: this.labels, State: this.state }), stderr: '' }
      }
      case 'start': {
        assert.equal(args[1], CONTAINER); await this.onStart?.()
        this.state = this.keepRunning ? { ...stopped, Running: true, Status: 'running', FinishedAt: created.FinishedAt } : { ...stopped }
        return { stdout: CONTAINER, stderr: '' }
      }
      case 'stop': {
        assert.equal(args.at(-1), CONTAINER); await this.stopGate?.promise
        if (this.failStop) throw new DockerCommandError('docker_command_failed')
        this.state = { ...stopped }; return { stdout: CONTAINER, stderr: '' }
      }
      case 'logs': assert.equal(args[1], CONTAINER); return { stdout: 'fixture-answer\n', stderr: '' }
      case 'rm': {
        assert.deepEqual(args, ['rm', CONTAINER]); assert.equal(this.state.Running, false); await this.onRemove?.(); this.present = false
        if (this.lostRemove) { this.lostRemove = false; throw new DockerCommandError('docker_command_failed') }
        return { stdout: CONTAINER, stderr: '' }
      }
      default: throw new Error('Unexpected replacement Docker operation')
    }
  }
}

type Job = z.infer<typeof deviceJob>
async function fixture(t: TestContext, shared?: { coordinationRoot: string; directory: string }) {
  const base = await mkdtemp(join(await realpath(tmpdir()), 'pe-worker-recovery-'))
  const privateRoot = join(base, 'private'), directory = shared?.directory ?? join(base, 'project')
  const workerOptions = { ...options, coordinationRoot: shared?.coordinationRoot ?? join(base, 'writers'),
    pythonExecutable: '/usr/bin/python3', fileOperationTimeoutMs: 1000 }
  await mkdir(directory, { mode: 0o700, recursive: true })
  const deviceId = randomUUID(), directoryId = randomUUID(), docker = new DockerReplacement()
  const requests: { path: string; body: Record<string, unknown> }[] = [], finishes: Record<string, unknown>[] = []
  const allowed = [directoryId], workers: DesktopWorker[] = []
  const closeChildren: (() => Promise<void>)[] = []
  const claims = new Map<string, z.infer<typeof deviceClaim>>()
  const registrations = new Map<string, string>(), finished = new Map<string, string>()
  const closedClaims = new Map<string, DeviceClaimClosureReceipt>(), closures: DeviceClaimClosureReceipt[] = []
  const resolvedUnknown = new Set<string>()
  let jobs: Job[] = [], finishAck: 'valid' | 'wrong-id' | 'running' | 'wrong-dispatch' | 'wrong-request' | 'no-stop' | 'lost' = 'valid'
  let registerAck: 'valid' | 'lost' | 'wrong-dispatch' | 'wrong-receipt' | 'no-start' = 'valid'
  let claimAck: 'valid' | 'lost' = 'valid'
  let registeredAck: 'valid' | 'lost' | 'permit' | 'refused' = 'valid'
  let closureFailure: { status: number; body: string } | undefined
  let closureAck: 'valid' | 'lost' | 'wrong-device' | 'wrong-instance' | 'wrong-id' | 'wrong-process'
    | 'wrong-directory' | 'wrong-digest' | 'wrong-request' | 'wrong-dispatch' | 'not-sealed' = 'valid'
  let onClosure: (() => Promise<void>) | undefined
  let closureGate: ReturnType<typeof gate> | undefined, closureEntered: ReturnType<typeof gate> | undefined
  let claimGate: ReturnType<typeof gate> | undefined, claimEntered: ReturnType<typeof gate> | undefined
  let onClaim: (() => Promise<void>) | undefined
  let directoryGate: ReturnType<typeof gate> | undefined
  let directoryEntered: ReturnType<typeof gate> | undefined
  let directoryIssued = false
  let transferGate: ReturnType<typeof gate> | undefined
  const cloudBytes = Buffer.from('explicit cloud transfer\n')
  async function route(req: IncomingMessage, res: ServerResponse) {
    const buffers: Buffer[] = []; let length = 0
    for await (const chunk of req) { const bytes = Buffer.from(chunk); length += bytes.length; assert(length <= 65536); buffers.push(bytes) }
    const body = z.record(z.string(), z.unknown()).parse(JSON.parse(Buffer.concat(buffers).toString('utf8')))
    const path = req.url ?? ''; requests.push({ path, body })
    let reply: object
    switch (path) {
      case '/fixture/docker': {
        const input = z.object({ args: z.array(z.string()).max(100), timeoutMs: z.number().int().positive().max(100) }).strict().parse(body)
        try { reply = await docker.run(input.args, input.timeoutMs) }
        catch (error) { if (!(error instanceof DockerCommandError)) throw error; reply = { error: error.code } }
        break
      }
      case '/devices/enroll': reply = { deviceId, token: 'synthetic-device-test-token-00000000000000' }; break
      case '/devices/agent/directory': {
        directoryEntered?.release(); await directoryGate?.promise
        const id = directoryIssued ? randomUUID() : directoryId
        directoryIssued = true
        if (!allowed.includes(id)) allowed.push(id)
        reply = { directoryId: id }; break
      }
      case '/devices/agent/jobs': reply = { jobs, directories: [...allowed] }; break
      case '/devices/agent/files/read': {
        await transferGate?.promise
        reply = { data: cloudBytes.toString('base64'), revision: createHash('sha256').update(cloudBytes).digest('hex') }; break
      }
      case '/devices/agent/files/put': {
        const input = z.object({ path: z.string(), data: z.string() }).passthrough().parse(body)
        reply = { path: input.path, revision: createHash('sha256').update(Buffer.from(input.data, 'base64')).digest('hex') }; break
      }
      case '/devices/agent/claim': {
        const input = deviceClaimRequest.parse(body)
        const job = jobs.find(item => item.executionId === body.executionId); assert(job)
        const { state, cancelRequested, ...claimed } = job; void state; void cancelRequested
        const original = claims.get(input.executionId) ?? deviceClaim.parse({ ...claimed,
          dispatchId: randomUUID(), processId: input.processId })
        assert.equal(original.processId, input.processId)
        claims.set(input.executionId, original)
        jobs = jobs.map(item => item.executionId === input.executionId ? { ...item, state: 'running' } : item)
        await onClaim?.(); claimEntered?.release(); await claimGate?.promise
        if (claimAck === 'lost') { claimAck = 'valid'; res.destroy(); return }
        reply = original; break
      }
      case '/devices/agent/claim/close': {
        const input = deviceClaimClosureRequest.parse(body)
        if (closureFailure) { res.writeHead(closureFailure.status, { 'content-type': 'application/json' }).end(closureFailure.body); return }
        if (registrations.has(input.executionId)) { res.writeHead(409, { 'content-type': 'application/json' }).end(JSON.stringify({ error: 'device_claim_start_unconfirmed' })); return }
        const original = claims.get(input.executionId), prior = closedClaims.get(input.requestId)
        if (original) {
          assert.equal(original.processId, input.processId); assert.equal(original.directoryId, input.directoryId)
          assert.equal(original.digest, input.digest)
        }
        const accepted = prior ?? deviceClaimClosureReceipt.parse({ ...input, deviceId, dispatchId: original?.dispatchId ?? null,
          kind: 'unstarted_claim_closed', state: 'cancelled', startNeverAuthorized: true, continuationQueued: true })
        if (prior) for (const key of Object.keys(input) as (keyof typeof input)[]) assert.equal(prior[key], input[key])
        closedClaims.set(input.requestId, accepted); closures.push(accepted)
        jobs = jobs.filter(job => job.executionId !== input.executionId)
        await onClosure?.(); closureEntered?.release(); await closureGate?.promise
        if (closureAck === 'lost') { res.destroy(); return }
        reply = { ...accepted,
          ...(closureAck === 'wrong-device' ? { deviceId: randomUUID() } : {}),
          ...(closureAck === 'wrong-instance' ? { instanceId: randomUUID() } : {}),
          ...(closureAck === 'wrong-id' ? { executionId: randomUUID() } : {}),
          ...(closureAck === 'wrong-process' ? { processId: randomUUID() } : {}),
          ...(closureAck === 'wrong-directory' ? { directoryId: randomUUID() } : {}),
          ...(closureAck === 'wrong-digest' ? { digest: 'e'.repeat(64) } : {}),
          ...(closureAck === 'wrong-request' ? { requestId: randomUUID() } : {}),
          ...(closureAck === 'wrong-dispatch' ? { dispatchId: randomUUID() } : {}),
          ...(closureAck === 'not-sealed' ? { startNeverAuthorized: false } : {}) }; break
      }
      case '/devices/agent/register': {
        const input = deviceContainerRegistration.parse(body), original = claims.get(input.executionId); assert(original)
        assert.equal(input.processId, original.processId); assert.equal(input.dispatchId, original.dispatchId)
        assert.equal(input.receipt.owner.requestDigest, original.digest)
        const prior = registrations.get(input.executionId), text = JSON.stringify(input)
        if (prior) assert.equal(prior, text)
        registrations.set(input.executionId, text)
        if (registerAck === 'lost') { registerAck = 'valid'; res.destroy(); return }
        reply = { executionId: input.executionId,
          dispatchId: registerAck === 'wrong-dispatch' ? randomUUID() : input.dispatchId,
          receipt: registerAck === 'wrong-receipt' ? { ...input.receipt, containerId: 'd'.repeat(64) } : input.receipt,
          canStart: !prior && registerAck !== 'no-start' }; break
      }
      case '/devices/agent/registered': {
        const input = deviceContainerRegistration.parse(body), prior = registrations.get(input.executionId)
        if (!prior || registeredAck === 'refused') { res.writeHead(409, { 'content-type': 'application/json' }).end(JSON.stringify({ error: 'device_container_unregistered' })); return }
        assert.equal(prior, JSON.stringify(input))
        if (registeredAck === 'lost') { res.destroy(); return }
        reply = { executionId: input.executionId, dispatchId: registerAck === 'wrong-dispatch' ? randomUUID() : input.dispatchId,
          receipt: registerAck === 'wrong-receipt' ? { ...input.receipt, containerId: 'd'.repeat(64) } : input.receipt,
          canStart: registeredAck === 'permit' }; break
      }
      case '/devices/agent/finish': {
        const input = deviceFinishRequest.parse(body), original = claims.get(input.executionId); assert(original)
        assert.equal(input.processId, original.processId); assert.equal(input.dispatchId, original.dispatchId)
        assert.equal(JSON.stringify(input.observation.receipt), JSON.stringify(JSON.parse(registrations.get(input.executionId)!).receipt))
        const prior = finished.get(input.requestId), text = JSON.stringify(input)
        if (prior) assert.equal(prior, text)
        finished.set(input.requestId, text)
        finishes.push(body); jobs = jobs.filter(job => job.executionId !== body.executionId)
        if (finishAck === 'lost') { res.destroy(); return }
        reply = { executionId: finishAck === 'wrong-id' ? randomUUID() : body.executionId,
          dispatchId: finishAck === 'wrong-dispatch' ? randomUUID() : body.dispatchId,
          requestId: finishAck === 'wrong-request' ? randomUUID() : body.requestId,
          stopConfirmed: finishAck !== 'no-stop',
          state: finishAck === 'running' ? 'running' : resolvedUnknown.has(input.executionId) ? 'closed_unknown'
            : z.object({ state: z.string() }).parse(body.result).state }; break
      }
      default: res.writeHead(404).end(); return
    }
    res.writeHead(200, { 'content-type': 'application/json' }).end(JSON.stringify(reply))
  }
  const server = createServer((req, res) => { void route(req, res).catch(() => { res.writeHead(500).end(JSON.stringify({ error: 'fixture_failure' })) }) })
  await new Promise<void>(resolve => server.listen(0, '127.0.0.1', resolve))
  const address = server.address(); assert(address && typeof address === 'object')
  const url = 'http://127.0.0.1:' + address.port
  const makeWorker = () => {
    const worker = new DesktopWorker(url, privateRoot, 'synthetic-fixture:tag', workerOptions, new OwnedDeviceContainer(containerOptions, docker))
    workers.push(worker); return worker
  }
  t.after(async () => {
    directoryGate?.release(); claimGate?.release(); closureGate?.release(); docker.stopGate?.release(); transferGate?.release()
    await Promise.all(closeChildren.map(close => close()))
    await Promise.all(workers.map(worker => worker.close()))
    server.closeAllConnections(); await new Promise<void>(resolve => server.close(() => resolve()))
    await rm(base, { recursive: true, force: true })
  })
  const worker = makeWorker(); await worker.init()
  await worker.pair('synthetic-pairing-code-000000', 'Synthetic test device'); await worker.authorize(directory)
  async function seed(stage: 'claimed' | 'created' | 'finished', withReceipt: boolean, withStopped = false,
    seedOptions: { registered?: boolean; captured?: boolean } = {}): Promise<JournalRow> {
    await worker.close()
    const device = z.object({ instanceId: z.uuid() }).parse(JSON.parse(await readFile(join(privateRoot, 'device.json'), 'utf8')))
    const source = job(), id = source.executionId
    const { state, cancelRequested, ...command } = source; void state; void cancelRequested
    const claimed = deviceClaim.parse({ ...command, processId: randomUUID(), dispatchId: randomUUID() })
    claims.set(id, claimed)
    const owner = ownedContainerOwner.parse({ deviceId, enrollmentId: device.instanceId,
      executionId: id, creationId: claimed.dispatchId, requestDigest: claimed.digest })
    const receipt = ownedContainerReceipt.parse({ containerId: CONTAINER, imageId: IMAGE, owner })
    const row = { id, container: 'pe-local-' + id.replaceAll('-', ''), owner, claimed,
      processId: claimed.processId, dispatchId: claimed.dispatchId, imageId: IMAGE, stage, startedAt: Date.now(),
      ...(withReceipt ? { receipt } : {}), ...(withStopped ? { stopObservation: { receipt, ...stopped } } : {}),
      ...(withStopped ? { stopRequestId: randomUUID() } : {}),
      ...(stage === 'finished' ? { result: resultUnknown } : {}) }
    if (seedOptions.registered ?? withReceipt) registrations.set(id, JSON.stringify({ instanceId: device.instanceId,
      executionId: id, processId: claimed.processId, dispatchId: claimed.dispatchId, receipt }))
    const lease = await new DeviceWriterCoordinator(workerOptions.coordinationRoot).command(deviceWriterOwner.parse({ kind: 'command',
      deviceId, enrollmentId: device.instanceId, executionId: id, processId: claimed.processId,
      directoryId: claimed.directoryId, requestDigest: claimed.digest }))
    if (seedOptions.captured) await lease.capture(receipt)
    await lease.release()
    await writeFile(join(privateRoot, 'journal.json'), JSON.stringify([row]), { mode: 0o600 })
    return row
  }
  function job(): Job {
    const command = 'printf synthetic-device-test', cwd = '', timeoutMs = 2000
    return deviceJob.parse({ executionId: randomUUID(), directoryId, command, cwd, timeoutMs, state: 'queued', cancelRequested: false,
      digest: createHash('sha256').update(JSON.stringify({ command, cwd, timeoutMs, deviceId, directoryId })).digest('hex') })
  }
  async function seedClaiming(committed = false): Promise<JournalRow> {
    await worker.close()
    const device = z.object({ instanceId: z.uuid() }).parse(JSON.parse(await readFile(join(privateRoot, 'device.json'), 'utf8')))
    const queuedJob = job(), processId = randomUUID()
    const row = { id: queuedJob.executionId, container: 'pe-local-' + queuedJob.executionId.replaceAll('-', ''),
      stage: 'claiming', processId, queuedJob, startedAt: Date.now() }
    const lease = await new DeviceWriterCoordinator(workerOptions.coordinationRoot).command(deviceWriterOwner.parse({ kind: 'command',
      deviceId, enrollmentId: device.instanceId, executionId: row.id, processId,
      directoryId: queuedJob.directoryId, requestDigest: queuedJob.digest }))
    await lease.release()
    await writeFile(join(privateRoot, 'journal.json'), JSON.stringify([row]), { mode: 0o600 })
    if (committed) {
      const { state, cancelRequested, ...command } = queuedJob; void state; void cancelRequested
      claims.set(row.id, deviceClaim.parse({ ...command, processId, dispatchId: randomUUID() }))
    }
    jobs = [{ ...queuedJob, state: committed ? 'running' : 'queued' }]
    return row
  }
  async function makeChild() {
    // Plain Node protocol fixture consumes this checkout's compiled Worker, without Cordis or a paths loader.
    const path = join(base, 'worker-recovery-' + randomUUID() + '.fixture.mjs')
    await writeFile(path, `
import { DesktopWorker } from ${JSON.stringify(new URL('../lib/device/worker.js', import.meta.url).href)};
import { OwnedDeviceContainer, DockerCommandError } from ${JSON.stringify(new URL('../lib/device/owned-container.js', import.meta.url).href)};
const [url, privateRoot, options, containerOptions] = process.argv.slice(2);
const docker = { async run(args, timeoutMs) {
  const response = await fetch(new URL('/fixture/docker', url), { method: 'POST',
    headers: { 'content-type': 'application/json' }, body: JSON.stringify({ args, timeoutMs }),
    signal: AbortSignal.timeout(300) });
  if (!response.ok) throw new Error('fixture_transport_failed');
  const result = await response.json();
  if (result.error) throw new DockerCommandError(result.error);
  return result;
} };
const worker = new DesktopWorker(url, privateRoot, 'synthetic-fixture:tag', JSON.parse(options),
  new OwnedDeviceContainer(JSON.parse(containerOptions), docker));
await worker.init();
process.on('message', async message => {
  if (message === 'start') worker.start();
  if (message === 'status') process.send({ event: 'status', notice: worker.status().notice });
  if (message === 'close') { await worker.close(); process.disconnect(); }
});
process.send({ event: 'ready' });
`, { mode: 0o600, flag: 'wx' })
    const child = fork(path, [url, privateRoot, JSON.stringify(workerOptions), JSON.stringify(containerOptions)],
      { cwd: fileURLToPath(new URL('../../../../', import.meta.url)), execArgv: [], env: {}, stdio: ['ignore', 'pipe', 'pipe', 'ipc'] })
    let stderr = '', stdout = ''
    child.stderr?.on('data', bytes => { stderr = (stderr + String(bytes)).slice(0, 4096) })
    child.stdout?.on('data', bytes => { stdout = (stdout + String(bytes)).slice(0, 4096) })
    const closed = new Promise<{ code: number | null; signal: NodeJS.Signals | null }>((resolve, reject) => {
      child.once('error', reject); child.once('close', (code, signal) => resolve({ code, signal }))
    })
    void closed.catch(() => {}) // The same promise is awaited by owned teardown.
    const ready = new Promise<unknown>((resolve, reject) => {
      child.once('message', resolve); child.once('error', reject)
      child.once('close', () => reject(new Error('child closed before readiness: ' + stderr)))
    })
    closeChildren.push(async () => {
      if (child.connected) child.send('close')
      try { await bounded(closed) }
      catch (error) { child.kill('SIGKILL'); await bounded(closed); throw error }
    })
    assert.deepEqual(await bounded(ready), { event: 'ready' })
    return { start: () => child.send('start'), async notice() {
      const status = new Promise<unknown>(resolve => child.once('message', resolve))
      child.send('status')
      return z.object({ event: z.literal('status'), notice: z.string() }).parse(await bounded(status)).notice
    }, async close() {
      child.send('close'); assert.deepEqual(await bounded(closed), { code: 0, signal: null }); assert.equal(stdout, ''); assert.equal(stderr, '')
    } }
  }
  return { base, privateRoot, directory, coordinationRoot: workerOptions.coordinationRoot,
    docker, worker, makeWorker, seed, seedClaiming, job, requests, finishes, closures,
    makeChild,
    async resolveUnknown() {
      await until(() => finishes.length > 0, 'reported unknown outcome')
      const rows = await journal(privateRoot); assert.equal(rows.length, 1)
      assert.equal(rows[0]!.result?.state, 'uncertain'); assert(rows[0]!.stopObservation)
      resolvedUnknown.add(rows[0]!.id)
      await until(async () => (await journal(privateRoot)).length === 0, 'cleanup after synthetic trusted closure')
    },
    advertise(value: Job[]) { jobs = value }, ack(value: typeof finishAck) { finishAck = value },
    registrationAck(value: typeof registerAck) { registerAck = value },
    registeredAck(value: typeof registeredAck) { registeredAck = value },
    closureFailure(value: typeof closureFailure) { closureFailure = value },
    claimAck(value: typeof claimAck) { claimAck = value },
    closureAck(value: typeof closureAck) { closureAck = value },
    observeClaim(action: () => Promise<void>) { onClaim = action },
    observeClosure(action: () => Promise<void>) { onClosure = action },
    holdClaim() { claimGate = gate(); claimEntered = gate(); return { entered: claimEntered.promise, release: claimGate.release } },
    holdClosure() { closureGate = gate(); closureEntered = gate(); return { entered: closureEntered.promise, release: closureGate.release } },
    holdDirectory() { directoryGate = gate(); directoryEntered = gate(); return { entered: directoryEntered.promise, release: directoryGate.release } },
    holdTransfer() { transferGate = gate(); return { release: transferGate.release } } }
}

test('fresh public execution saves owner before create and receipt/start intent before start, with native lock exclusion', workerTestOptions, async t => {
  const f = await fixture(t), job = f.job()
  f.docker.onCreate = async () => { const [row] = await journal(f.privateRoot); assert.equal(row?.id, job.executionId); assert.equal(row.stage, 'claimed'); assert(row.owner?.creationId); assert.equal(row.receipt, undefined) }
  f.docker.onStart = async () => { const [row] = await journal(f.privateRoot); assert.equal(row?.receipt?.containerId, CONTAINER); assert.equal(row.receipt.imageId, IMAGE); assert.equal(row.stage, 'started')
    assert.equal(row.owner?.creationId, row.dispatchId); assert.equal(row.claimed?.processId, row.processId)
    assert.equal(f.requests.filter(item => item.path === '/devices/agent/register').length, 1) }
  f.advertise([job]); f.worker.start()
  await until(async () => f.finishes.length === 1 && (await journal(f.privateRoot)).length === 0, 'fresh execution completion')
  assert.equal(z.object({ state: z.string() }).parse(f.finishes[0]!.result).state, 'succeeded')
  assert.equal(f.docker.count('create'), 1); assert.equal(f.docker.count('start'), 1); assert.equal(f.docker.count('rm'), 1)
  assert.equal((await stat(f.privateRoot)).mode & 0o777, 0o700)
  for (const path of ['device.json', 'journal.json', 'device-process.lock']) assert.equal((await stat(join(f.privateRoot, path))).mode & 0o777, 0o600)
  const competing = f.makeWorker(); await assert.rejects(competing.init(), { code: 'device_process_already_owned' })
  await f.worker.close(); const next = f.makeWorker(); await next.init(); await next.close()
})

test('lost create acknowledgement is adopted once; cold create-to-journal recovery never creates or starts', workerTestOptions, async t => {
  const fresh = await fixture(t); fresh.docker.lostCreate = true; fresh.advertise([fresh.job()]); fresh.worker.start()
  await until(async () => fresh.finishes.length === 1 && (await journal(fresh.privateRoot)).length === 0, 'lost acknowledgement completion')
  assert.equal(fresh.docker.count('create'), 1); assert.equal(fresh.docker.count('start'), 1)
  assert.equal(fresh.docker.calls.filter(args => args[0] === 'container' && args.at(-1) === fresh.docker.name).length, 1)
  await fresh.worker.close()
  const cold = await fixture(t), row = await cold.seed('claimed', false)
  cold.docker.seed(row); const recovering = cold.makeWorker(); await recovering.init(); recovering.start()
  await until(async () => (await journal(cold.privateRoot)).length === 0, 'unregistered creation sealed and removed')
  assert.equal(cold.closures.length, 1); assert.equal(cold.finishes.length, 0)
  assert.equal(cold.requests.filter(item => ['/devices/agent/register', '/devices/agent/registered'].includes(item.path)).length, 0)
  assert.equal(cold.docker.count('create'), 0); assert.equal(cold.docker.count('start'), 0); assert.equal(cold.docker.count('rm'), 1)
})

test('foreign same-name or missing exact identity retains journal and blocks new admission', workerTestOptions, async t => {
  for (const kind of ['foreign', 'missing']) {
    const f = await fixture(t), row = await f.seed('created', kind === 'missing')
    if (kind === 'foreign') { f.docker.seed(row); f.docker.labels[OWNED_DEVICE_CONTAINER_LABELS.creationId] = randomUUID() }
    f.advertise([f.job()]); const recovering = f.makeWorker(); await recovering.init(); recovering.start()
    await until(() => notice(recovering).includes(kind === 'foreign' ? 'container_identity_mismatch' : 'device_stop_observation_missing'), 'identity refusal')
    const rows = await journal(f.privateRoot); assert.equal(rows.length, 1); assert.equal(rows[0]!.id, row.id)
    assert.equal(f.finishes.length, 0); assert.equal(f.requests.filter(item => item.path === '/devices/agent/claim').length, 0)
    for (const command of ['create', 'start', 'stop', 'rm']) assert.equal(f.docker.count(command), 0)
    await recovering.close()
  }
})

test('failed stop closes boundedly, releases flock, and the next worker recovers before admitting another job', workerTestOptions, async t => {
  const f = await fixture(t); f.docker.keepRunning = true; f.docker.failStop = true
  f.advertise([f.job()]); f.worker.start(); await until(() => f.docker.count('start') === 1, 'running container')
  const started = Date.now(); await f.worker.close(); assert(Date.now() - started < 1500)
  let rows = await journal(f.privateRoot); assert.equal(rows.length, 1); assert.equal(rows[0]!.stopObservation, undefined)
  assert.equal(f.docker.state.Running, true); assert.equal(f.finishes.length, 0)
  f.advertise([f.job()]); const next = f.makeWorker(); await next.init(); next.start()
  await until(() => notice(next) === 'device_stop_observation_missing', 'next worker recovery first')
  assert.equal(f.requests.filter(item => item.path === '/devices/agent/claim').length, 1)
  assert.equal(f.docker.count('create'), 1); assert.equal(f.docker.count('start'), 1)
  f.advertise([]); f.docker.failStop = false
  await f.resolveUnknown()
  rows = await journal(f.privateRoot); assert.equal(rows.length, 0)
  assert.equal(z.object({ state: z.string() }).parse(f.finishes[0]!.result).state, 'uncertain')
  await next.close(); const successor = f.makeWorker(); await successor.init(); await successor.close()
})

test('a saved stop observation cannot finish a container that is running again before a new exact stop', workerTestOptions, async t => {
  const f = await fixture(t), row = await f.seed('finished', true, true)
  f.docker.seed(row, { ...stopped, Running: true, Status: 'running' }); f.docker.stopGate = gate()
  const next = f.makeWorker(); await next.init(); next.start()
  await until(() => f.docker.count('stop') === 1, 'restarted container stop request')
  assert.equal(f.finishes.length, 0); assert.equal((await journal(f.privateRoot))[0]!.stopObservation, undefined)
  f.docker.stopGate.release()
  await f.resolveUnknown()
  assert.equal(z.object({ state: z.string() }).parse(f.finishes[0]!.result).state, 'uncertain')
  assert.equal(f.docker.count('start'), 0); assert.equal(f.docker.count('create'), 0)
})

test('wrong execution identity or nonterminal finish acknowledgement preserves journal and prohibits removal/admission', workerTestOptions, async t => {
  for (const ack of ['wrong-id', 'running', 'wrong-dispatch', 'wrong-request', 'no-stop'] as const) {
    const f = await fixture(t), row = await f.seed('finished', true, true)
    f.docker.seed(row, stopped); f.ack(ack); f.advertise([f.job()])
    const next = f.makeWorker(); await next.init(); next.start()
    await until(() => f.finishes.length > 0 && notice(next) !== '', 'invalid finish acknowledgement')
    const rows = await journal(f.privateRoot); assert.equal(rows.length, 1); assert.equal(rows[0]!.id, row.id); assert(rows[0]!.stopObservation)
    assert.equal(f.docker.count('rm'), 0); assert.equal(f.requests.filter(item => item.path === '/devices/agent/claim').length, 0)
    await next.close()
  }
})

test('close closes local admission and waits for an in-flight public authorize before releasing its flock', workerTestOptions, async t => {
  const f = await fixture(t), extra = join(f.base, 'extra-project'); await mkdir(extra, { mode: 0o700 })
  f.worker.start(); const held = f.holdDirectory(), authorizing = f.worker.authorize(extra)
  await held.entered
  let closed = false; const closing = f.worker.close().then(() => { closed = true })
  await delay(30); assert.equal(closed, false)
  const competing = f.makeWorker(); await assert.rejects(competing.init(), { code: 'device_process_already_owned' })
  await assert.rejects(f.worker.authorize(f.directory), /device_closed/u)
  held.release(); await authorizing; await closing
  const next = f.makeWorker(); await next.init()
  const status = z.object({ directories: z.array(z.object({ path: z.string() })) }).parse(next.status())
  assert(status.directories.some(item => item.path === extra)); await next.close()
  assert.equal(f.docker.calls.length, 0)
})

test('lost registration acknowledgement and duplicate registration never authorize start', workerTestOptions, async t => {
  for (const ack of ['lost', 'no-start'] as const) {
    const f = await fixture(t); f.registrationAck(ack); f.advertise([f.job()]); f.worker.start()
    await f.resolveUnknown()
    assert.equal(f.docker.count('create'), 1); assert.equal(f.docker.count('start'), 0); assert.equal(f.docker.count('rm'), 1)
    assert.equal(z.object({ state: z.string() }).parse(f.finishes[0]!.result).state, 'uncertain')
    const registrations = f.requests.filter(item => item.path === '/devices/agent/register')
    assert.equal(registrations.length, 1)
    if (ack === 'lost') assert(f.requests.some(item => item.path === '/devices/agent/registered'))
    for (const registration of registrations) assert.deepEqual(registration.body, registrations[0]!.body)
    assert.equal(f.requests.filter(item => item.path === '/devices/agent/claim').length, 1)
  }
})

test('mismatched registration dispatch or exact receipt retains evidence and prevents start and cleanup', workerTestOptions, async t => {
  for (const ack of ['wrong-dispatch', 'wrong-receipt'] as const) {
    const f = await fixture(t); f.registrationAck(ack); f.advertise([f.job()]); f.worker.start()
    await until(async () => notice(f.worker) === 'device_registration_identity_mismatch'
      && !!(await journal(f.privateRoot))[0]?.stopObservation, 'invalid registration stopped locally')
    const [row] = await journal(f.privateRoot); assert(row?.receipt); assert.equal(row.owner?.creationId, row.dispatchId)
    assert.equal(f.docker.count('start'), 0); assert.equal(f.docker.count('rm'), 0); assert.equal(f.finishes.length, 0)
    assert.equal(f.requests.filter(item => item.path === '/devices/agent/claim').length, 1)
    f.registrationAck('valid')
    await f.resolveUnknown()
    assert.equal(f.docker.count('start'), 0); assert.equal(f.docker.count('create'), 1)
    assert.equal(z.object({ state: z.string() }).parse(f.finishes[0]!.result).state, 'uncertain')
  }
})

test('cold registration refusal still stops the exact writer but retains journal without a finish acknowledgement', workerTestOptions, async t => {
  const f = await fixture(t), row = await f.seed('created', true)
  f.docker.seed(row, { ...stopped, Running: true, Status: 'running' }); f.registrationAck('wrong-dispatch')
  const next = f.makeWorker(); await next.init(); next.start()
  await until(async () => notice(next) === 'device_registration_identity_mismatch'
    && !!(await journal(f.privateRoot))[0]?.stopObservation, 'refused registration local stop')
  assert.equal(f.docker.state.Running, false); assert.equal(f.docker.count('stop'), 1)
  for (const command of ['create', 'start', 'rm']) assert.equal(f.docker.count(command), 0)
  assert.equal(f.finishes.length, 0)
})

test('legacy journals lacking original process or dispatch remain review evidence without invented identities', workerTestOptions, async t => {
  for (const missing of ['claimed', 'processId', 'dispatchId'] as const) {
    const f = await fixture(t), row = await f.seed('finished', true, true)
    // Old released entries have no claim-generation fields; do not manufacture them from current runtime state.
    const { claimed, processId, dispatchId, ...legacy } = row; void claimed; void processId; void dispatchId
    const partial = { ...legacy, ...(missing !== 'processId' ? { processId: row.processId } : {}),
      ...(missing !== 'dispatchId' ? { dispatchId: row.dispatchId } : {}) }
    await writeFile(join(f.privateRoot, 'journal.json'), JSON.stringify([partial]), { mode: 0o600 })
    f.docker.seed(row, stopped); f.advertise([f.job()])
    const next = f.makeWorker(); await next.init(); next.start()
    await until(() => notice(next) === 'device_legacy_journal_requires_review', 'legacy review requirement')
    assert.equal((await journal(f.privateRoot)).length, 1); assert.equal(f.docker.calls.length, 0)
    for (const path of ['/devices/agent/claim', '/devices/agent/register', '/devices/agent/finish']) {
      assert.equal(f.requests.filter(item => item.path === path).length, 0)
    }
    await next.close()
  }
})

test('a real replacement process recovers a lost finish acknowledgement with the original process and stop request identities', workerTestOptions, async t => {
  const f = await fixture(t); f.ack('lost'); f.advertise([f.job()]); f.worker.start()
  await until(async () => f.finishes.length > 0 && !!(await journal(f.privateRoot))[0]?.stopRequestId, 'durable lost finish intent')
  await f.worker.close()
  const [row] = await journal(f.privateRoot); assert(row?.processId); assert(row.stopRequestId); assert(row.dispatchId)
  const originalClaim = f.requests.find(item => item.path === '/devices/agent/claim'); assert(originalClaim)
  assert.equal(row.processId, originalClaim.body.processId)
  f.ack('valid')
  const child = await f.makeChild()
  const competing = f.makeWorker(); await assert.rejects(competing.init(), { code: 'device_process_already_owned' })
  child.start()
  await until(async () => (await journal(f.privateRoot)).length === 0, 'cross-process finish recovery')
  await child.close()
  const registrations = f.requests.filter(item => ['/devices/agent/register', '/devices/agent/registered'].includes(item.path))
  assert(registrations.length >= 2)
  for (const registration of registrations) {
    assert.equal(registration.body.processId, row.processId); assert.equal(registration.body.dispatchId, row.dispatchId)
  }
  assert(f.finishes.length >= 2)
  for (const finish of f.finishes) {
    assert.equal(finish.processId, row.processId); assert.equal(finish.dispatchId, row.dispatchId); assert.equal(finish.requestId, row.stopRequestId)
    assert.deepEqual(finish.observation, row.stopObservation); assert.deepEqual(finish.result, row.result)
  }
  assert.equal(f.requests.filter(item => item.path === '/devices/agent/claim').length, 1)
  assert.equal(f.docker.count('create'), 1); assert.equal(f.docker.count('start'), 1); assert.equal(f.docker.count('rm'), 1)
  const next = f.makeWorker(); await next.init(); await next.close()
})

test('claim commit with lost HTTP acknowledgement retries the durable intent in the same process and starts exactly once', workerTestOptions, async t => {
  const f = await fixture(t), job = f.job()
  const observations: { row: JournalRow | undefined; creates: number; starts: number }[] = []
  f.claimAck('lost')
  f.observeClaim(async () => {
    let row: JournalRow | undefined
    try { [row] = await journal(f.privateRoot) }
    catch (error) { if ((error as NodeJS.ErrnoException).code !== 'ENOENT') throw error }
    observations.push({ row, creates: f.docker.count('create'), starts: f.docker.count('start') })
  })
  f.advertise([job]); f.worker.start()
  await until(async () => f.finishes.length === 1 && (await journal(f.privateRoot)).length === 0, 'same-generation claim recovery')
  const claims = f.requests.filter(item => item.path === '/devices/agent/claim'); assert.equal(claims.length, 2)
  assert.deepEqual(claims[0]!.body, claims[1]!.body)
  assert.equal(claims[0]!.body.executionId, job.executionId)
  assert.equal(observations.length, 2)
  for (const { row, creates, starts } of observations) {
    assert(row); assert.equal(row.stage, 'claiming'); assert.equal(row.processId, claims[0]!.body.processId)
    assert.deepEqual(row.queuedJob, job); assert.equal(row.owner, undefined); assert.equal(row.dispatchId, undefined)
    assert.equal(creates, 0); assert.equal(starts, 0)
  }
  assert.equal(f.docker.count('create'), 1); assert.equal(f.docker.count('start'), 1); assert.equal(f.docker.count('rm'), 1)
  assert.equal(z.object({ state: z.string() }).parse(f.finishes[0]!.result).state, 'succeeded')
})

test('a cold OS process closes a committed lost-claim intent without reclaiming, creating, or inventing stop facts', workerTestOptions, async t => {
  const f = await fixture(t), job = f.job(), held = f.holdClaim()
  f.claimAck('lost'); f.advertise([job]); f.worker.start()
  await held.entered
  const [intent] = await journal(f.privateRoot); assert(intent?.processId); assert.equal(intent.stage, 'claiming')
  const closing = f.worker.close(); held.release(); await closing
  const claims = f.requests.filter(item => item.path === '/devices/agent/claim'); assert.equal(claims.length, 1)
  f.observeClosure(async () => {
    const [row] = await journal(f.privateRoot)
    assert(row); assert.equal(row.processId, intent.processId); assert(row.claimClosureRequestId)
    assert.deepEqual(row.queuedJob, intent.queuedJob)
    await assert.rejects(new DeviceWriterCoordinator(f.coordinationRoot).transfer(async () => {}), { code: 'device_process_already_owned' })
  })
  const child = await f.makeChild(); child.start()
  await until(async () => (await journal(f.privateRoot)).length === 0, 'cold committed claim retired')
  await child.close()
  assert.deepEqual(intent.queuedJob, job); assert.equal(intent.dispatchId, undefined); assert.equal(intent.owner, undefined)
  assert.equal(f.closures.length, 1); assert(f.closures[0]!.dispatchId)
  assert.equal(f.closures[0]!.processId, intent.processId); assert.equal(f.closures[0]!.digest, job.digest)
  assert.equal(await writerSlot(f.coordinationRoot), null)
  assert.equal(f.requests.filter(item => item.path === '/devices/agent/claim').length, 1)
  for (const path of ['/devices/agent/register', '/devices/agent/finish']) assert.equal(f.requests.filter(item => item.path === path).length, 0)
  assert.equal(f.docker.calls.length, 0)
})

test('a cold unsubmitted claim closes with nullable dispatch and preserves its original process and inputs', workerTestOptions, async t => {
  const f = await fixture(t), intent = await f.seedClaiming()
  const cold = f.makeWorker(); await cold.init(); cold.start()
  await until(async () => (await journal(f.privateRoot)).length === 0, 'unsubmitted claim closure')
  await cold.close()
  assert.equal(f.closures.length, 1); assert.equal(f.closures[0]!.dispatchId, null)
  assert.equal(f.closures[0]!.processId, intent.processId); assert.equal(f.closures[0]!.digest, intent.queuedJob!.digest)
  assert.equal(f.requests.filter(item => item.path === '/devices/agent/claim').length, 0)
  assert.equal(f.finishes.length, 0); assert.equal(f.docker.calls.length, 0)
  assert.equal(await writerSlot(f.coordinationRoot), null)
})

test('lost closure ACK across another OS process reuses its synced ID and exact inputs without a new claim', workerTestOptions, async t => {
  const f = await fixture(t), intent = await f.seedClaiming(true)
  f.closureAck('lost')
  const cold = f.makeWorker(); await cold.init(); cold.start()
  await until(() => f.closures.length > 0 && notice(cold) !== '', 'lost closure acknowledgement')
  await cold.close()
  const [saved] = await journal(f.privateRoot); assert(saved?.claimClosureRequestId); assert.equal(saved.claimClosureReceipt, undefined)
  assert.equal(saved.processId, intent.processId); assert.deepEqual(saved.queuedJob, intent.queuedJob)
  assert.equal((await writerSlot(f.coordinationRoot))?.owner.processId, intent.processId)
  f.closureAck('valid')
  const child = await f.makeChild(); child.start()
  await until(async () => (await journal(f.privateRoot)).length === 0, 'retry sealed claim')
  await child.close()
  const calls = f.requests.filter(item => item.path === '/devices/agent/claim/close')
  assert(calls.length >= 2)
  for (const call of calls) assert.deepEqual(call.body, calls[0]!.body)
  assert.equal(calls[0]!.body.requestId, saved.claimClosureRequestId)
  assert.equal(new Set(f.closures.map(receipt => receipt.requestId)).size, 1)
  assert.equal(f.requests.filter(item => item.path === '/devices/agent/claim').length, 0)
  assert.equal(f.docker.calls.length, 0); assert.equal(f.finishes.length, 0)
})

test('wrong closure identities or absent no-start authority preserve both journal and global intent', workerTestOptions, async t => {
  for (const ack of ['wrong-device', 'wrong-instance', 'wrong-id', 'wrong-process', 'wrong-directory',
    'wrong-digest', 'wrong-request', 'not-sealed'] as const) await t.test(ack, async t => {
    const f = await fixture(t), intent = await f.seedClaiming(true)
    f.closureAck(ack)
    const cold = f.makeWorker(); await cold.init(); cold.start()
    await until(() => f.closures.length > 0 && notice(cold) !== '', 'closure refusal')
    await cold.close()
    const [saved] = await journal(f.privateRoot)
    assert(saved); assert.equal(saved.processId, intent.processId); assert(saved.claimClosureRequestId)
    assert.equal(saved.claimClosureReceipt, undefined)
    const slot = await writerSlot(f.coordinationRoot); assert(slot); assert.equal(slot.owner.processId, intent.processId)
    assert.equal(slot.receipt, null); assert.equal(slot.stop, null)
    assert.equal(f.docker.calls.length, 0); assert.equal(f.finishes.length, 0)
  })
})

test('failed closure receipt persistence cannot be bypassed by the in-memory receipt on a later poll', workerTestOptions, async t => {
  const f = await fixture(t), intent = await f.seedClaiming(true)
  const cold = f.makeWorker(); await cold.init()
  let fail = true
  failJournalWhile(cold, async () => fail && f.closures.length > 0)
  cold.start()
  await until(() => notice(cold) === 'fixture_journal_write_failed', 'closure receipt save failure')
  const [saved] = await journal(f.privateRoot); assert(saved?.claimClosureRequestId); assert.equal(saved.claimClosureReceipt, undefined)
  assert.equal((await writerSlot(f.coordinationRoot))?.owner.processId, intent.processId)
  await assert.rejects(new DeviceWriterCoordinator(f.coordinationRoot).transfer(async () => {}), { code: 'device_process_already_owned' })
  // Resume the same process: its cached ACK must still be synced before retirement.
  fail = false
  await until(async () => (await journal(f.privateRoot)).length === 0, 'receipt synced before clearing')
  await cold.close()
  assert.equal(f.closures.length, 1); assert.equal(await writerSlot(f.coordinationRoot), null)
  assert.equal(f.docker.calls.length, 0)
})

test('a synced closure receipt survives interruption before slot retirement and a new process does not query or reclaim again', workerTestOptions, async t => {
  const f = await fixture(t), intent = await f.seedClaiming(true)
  const cold = f.makeWorker(); await cold.init()
  // Stop exactly before the real retirement operation; successful journal saves still use actual FS.
  const coordinator: unknown = Reflect.get(cold, 'coordination')
  assert(coordinator instanceof DeviceWriterCoordinator)
  Object.defineProperty(coordinator, 'retireClaim', { value: async () => { throw new Error('fixture_before_retirement') } })
  cold.start()
  await until(() => notice(cold) === 'fixture_before_retirement', 'durable receipt before retirement')
  await cold.close()
  const [saved] = await journal(f.privateRoot); assert(saved?.claimClosureReceipt)
  assert.equal((await writerSlot(f.coordinationRoot))?.owner.processId, intent.processId)
  const child = await f.makeChild(); child.start()
  await until(async () => (await journal(f.privateRoot)).length === 0, 'receipt-only retirement in next process')
  await child.close()
  assert.equal(f.closures.length, 1); assert.equal(await writerSlot(f.coordinationRoot), null)
  assert.equal(f.requests.filter(item => item.path === '/devices/agent/claim').length, 0)
  assert.equal(f.docker.calls.length, 0); assert.equal(f.finishes.length, 0)
})

test('slot retirement followed by failed journal removal recovers from a durable receipt without rebuilding or clearing a new writer', workerTestOptions, async t => {
  const f = await fixture(t), intent = await f.seedClaiming(true)
  const cold = f.makeWorker(); await cold.init()
  failJournalWhile(cold, async () => {
    const rows = await journal(f.privateRoot)
    return rows.some(row => row.claimClosureReceipt !== undefined) && await writerSlot(f.coordinationRoot) === null
  })
  cold.start()
  await until(() => notice(cold) === 'fixture_journal_write_failed', 'journal removal failure after slot retirement')
  await cold.close()
  const [saved] = await journal(f.privateRoot); assert(saved?.claimClosureReceipt)
  assert.equal(saved.processId, intent.processId); assert.equal(await writerSlot(f.coordinationRoot), null)
  const coordinator = new DeviceWriterCoordinator(f.coordinationRoot), newer = deviceWriterOwner.parse({ kind: 'command',
    deviceId: randomUUID(), enrollmentId: randomUUID(), executionId: randomUUID(), processId: randomUUID(),
    directoryId: randomUUID(), requestDigest: 'c'.repeat(64) })
  const lease = await coordinator.command(newer); await lease.release()
  const before = await readFile(join(f.coordinationRoot, DEVICE_WRITER_SLOT_FILENAME))
  const child = await f.makeChild(); child.start()
  await until(async () => (await journal(f.privateRoot)).length === 0, 'retired receipt-only recovery')
  await child.close()
  assert.deepEqual(await readFile(join(f.coordinationRoot, DEVICE_WRITER_SLOT_FILENAME)), before)
  assert.equal((await writerSlot(f.coordinationRoot))?.owner.executionId, newer.executionId)
  assert.equal(f.closures.length, 1); assert.equal(f.docker.calls.length, 0)
})

test('a missing creation is sealed without pretending it stopped and retains a late-cleanup tombstone', workerTestOptions, async t => {
  const f = await fixture(t), original = await f.seed('claimed', false)
  const child = await f.makeChild(); child.start()
  await until(async () => (await journal(f.privateRoot)).length === 0, 'missing creation sealed')
  await child.close()
  const record = sealedCreation.parse(JSON.parse(await readFile(join(f.privateRoot, 'sealed-creations', original.id + '.json'), 'utf8')))
  assert.equal(record.closure.dispatchId, original.dispatchId); assert.equal(record.receipt, undefined)
  assert.equal(record.observation, undefined); assert.equal(record.removalConfirmed, false)
  assert.equal(f.closures.length, 1); assert.equal(f.docker.count('create'), 0); assert.equal(f.docker.count('start'), 0)
})

test('cold creation closure survives lost ACK and post-retirement journal failure without recreating a reservation', workerTestOptions, async t => {
  for (const failure of ['lost-ack', 'journal-removal'] as const) await t.test(failure, async t => {
    const f = await fixture(t), original = await f.seed('claimed', false)
    const cold = f.makeWorker(); await cold.init()
    if (failure === 'lost-ack') f.closureAck('lost')
    else failJournalWhile(cold, async () => (await journal(f.privateRoot)).some(row => !!row.claimClosureReceipt)
      && await writerSlot(f.coordinationRoot) === null)
    cold.start()
    await until(() => f.closures.length > 0 && notice(cold) !== '', 'creation closure recovery checkpoint')
    await cold.close()
    const [saved] = await journal(f.privateRoot); assert(saved?.claimClosureRequestId)
    assert.equal(saved.dispatchId, original.dispatchId); assert.equal(saved.processId, original.processId)
    if (failure === 'journal-removal') {
      assert(saved.claimClosureReceipt); assert.equal(await writerSlot(f.coordinationRoot), null)
      const newer = deviceWriterOwner.parse({ kind: 'command', deviceId: randomUUID(), enrollmentId: randomUUID(),
        executionId: randomUUID(), processId: randomUUID(), directoryId: randomUUID(), requestDigest: 'd'.repeat(64) })
      const lease = await new DeviceWriterCoordinator(f.coordinationRoot).command(newer); await lease.release()
    }
    const slotBefore = await readFile(join(f.coordinationRoot, DEVICE_WRITER_SLOT_FILENAME))
    f.closureAck('valid')
    const child = await f.makeChild(); child.start()
    await until(async () => (await journal(f.privateRoot)).length === 0, 'same creation receipt-only recovery')
    await child.close()
    const calls = f.requests.filter(item => item.path === '/devices/agent/claim/close')
    for (const call of calls) assert.deepEqual(call.body, calls[0]!.body)
    assert.equal(new Set(f.closures.map(receipt => receipt.requestId)).size, 1)
    if (failure === 'journal-removal') assert.deepEqual(await readFile(join(f.coordinationRoot, DEVICE_WRITER_SLOT_FILENAME)), slotBefore)
    else assert.equal(await writerSlot(f.coordinationRoot), null)
    assert.equal(f.docker.count('create'), 0); assert.equal(f.docker.count('start'), 0); assert.equal(f.finishes.length, 0)
    const record = sealedCreation.parse(JSON.parse(await readFile(join(f.privateRoot, 'sealed-creations', original.id + '.json'), 'utf8')))
    assert.equal(record.closure.requestId, saved.claimClosureRequestId)
  })
})

test('claimed without a synced image closes before any Docker operation and admits new work', workerTestOptions, async t => {
  const f = await fixture(t), original = await f.seed('claimed', false)
  const { imageId, ...withoutImage } = original; void imageId
  await writeFile(join(f.privateRoot, 'journal.json'), JSON.stringify([withoutImage]), { mode: 0o600 })
  const next = f.makeWorker(); await next.init(); next.start()
  await until(async () => (await journal(f.privateRoot)).length === 0, 'pre-create claim sealed')
  assert.equal(f.docker.calls.length, 0); assert.equal(f.finishes.length, 0)
  await until(() => absent(join(f.privateRoot, 'sealed-creations', original.id + '.json')), 'pre-create tombstone retired')
  assert.equal(f.closures[0]?.dispatchId, original.dispatchId); assert.equal((await writerSlot(f.coordinationRoot)), null)
  f.advertise([f.job()])
  await until(() => f.finishes.length === 1, 'new command after pre-create closure')
  assert.equal(f.docker.count('create'), 1); assert.equal(f.docker.count('start'), 1)
})

test('late owned creation cleanup proceeds during a new active claim without changing its writer slot', workerTestOptions, async t => {
  const f = await fixture(t), original = await f.seed('claimed', false)
  const next = f.makeWorker(); await next.init(); next.start()
  await until(async () => (await journal(f.privateRoot)).length === 0, 'missing create sealed')
  const held = f.holdClaim(), newer = f.job(); f.advertise([newer]); await held.entered
  const [pending] = await journal(f.privateRoot); assert.equal(pending?.stage, 'claiming'); assert.equal(pending.id, newer.executionId)
  const before = await readFile(join(f.coordinationRoot, DEVICE_WRITER_SLOT_FILENAME))
  f.docker.seed(original)
  await until(() => f.docker.count('rm') === 1, 'late unstarted creation removed')
  assert.deepEqual(await readFile(join(f.coordinationRoot, DEVICE_WRITER_SLOT_FILENAME)), before)
  assert.equal((await writerSlot(f.coordinationRoot))?.owner.executionId, newer.executionId)
  assert.equal(f.docker.count('create'), 0); assert.equal(f.docker.count('start'), 0); assert.equal(f.docker.count('stop'), 0)
  assert.equal(f.requests.filter(item => ['/devices/agent/register', '/devices/agent/registered', '/devices/agent/finish'].includes(item.path)).length, 0)
  const closing = next.close(); held.release(); await closing
})

test('local captured creation with no Platform registration is removed durably before retiring its slot, including lost rm ACK', workerTestOptions, async t => {
  const f = await fixture(t), original = await f.seed('created', true, false, { registered: false, captured: true })
  f.docker.seed(original); f.docker.lostRemove = true
  f.docker.onRemove = async () => {
    const record = sealedCreation.parse(JSON.parse(await readFile(join(f.privateRoot, 'sealed-creations', original.id + '.json'), 'utf8')))
    assert(record.observation); assert.equal(record.removalConfirmed, false)
    assert.equal((await writerSlot(f.coordinationRoot))?.receipt?.containerId, CONTAINER)
  }
  const next = f.makeWorker(); await next.init(); next.start()
  await until(async () => (await journal(f.privateRoot)).length === 0, 'captured unregistered creation sealed')
  await until(() => absent(join(f.privateRoot, 'sealed-creations', original.id + '.json')), 'completed cleanup tombstone retired')
  assert.equal(await writerSlot(f.coordinationRoot), null)
  assert.equal(f.finishes.length, 0); assert.equal(f.docker.count('rm'), 1); assert.equal(f.docker.count('start'), 0)
})

test('only the exact Platform no-start refusal permits a read-only registered query', workerTestOptions, async t => {
  for (const failure of [{ status: 409, body: '{"error":"device_claim_identity_changed"}' },
    { status: 503, body: '{"error":"device_claim_start_unconfirmed"}' },
    { status: 409, body: '{"code":"device_claim_start_unconfirmed"}' }, { status: 409, body: 'invalid JSON' }]) await t.test(failure.body, async t => {
    const f = await fixture(t), original = await f.seed('created', true)
    f.docker.seed(original); f.closureFailure(failure)
    const next = f.makeWorker(); await next.init(); next.start()
    await until(() => notice(next) === `platform_${failure.status}`, 'closure refusal retained')
    assert.equal(f.requests.filter(item => ['/devices/agent/register', '/devices/agent/registered', '/devices/agent/finish'].includes(item.path)).length, 0)
    assert.equal(f.docker.count('rm'), 0); assert.equal((await journal(f.privateRoot)).length, 1)
  })
})

test('failed or impermissible registered replies cannot grant cold start or suppress exact local stop', workerTestOptions, async t => {
  for (const ack of ['refused', 'lost', 'permit'] as const) await t.test(ack, async t => {
    const f = await fixture(t), original = await f.seed('created', true)
    f.docker.seed(original, { ...stopped, Running: true, Status: 'running' }); f.registeredAck(ack)
    const next = f.makeWorker(); await next.init(); next.start()
    await until(async () => f.docker.count('stop') === 1 && !!(await journal(f.privateRoot))[0]?.stopObservation, 'query refusal exact stop')
    assert.equal(f.finishes.length, 0); assert.equal(f.docker.count('rm'), 0); assert.equal(f.docker.count('start'), 0)
    assert.equal(f.requests.filter(item => item.path === '/devices/agent/register').length, 0)
    if (ack === 'permit') await until(() => notice(next) === 'device_recovery_start_permission', 'invalid query permission refused')
    await next.close()
  })
})

test('a failed sealed-creation sync retains the original journal and captured slot before any removal', workerTestOptions, async t => {
  const f = await fixture(t), original = await f.seed('created', true, false, { registered: false, captured: true })
  f.docker.seed(original)
  const next = f.makeWorker(); await next.init()
  const store: unknown = Reflect.get(next, 'sealed'); assert(store && typeof store === 'object')
  const preserve: unknown = Reflect.get(store, 'preserve'); assert.equal(typeof preserve, 'function')
  let fail = true
  Object.defineProperty(store, 'preserve', { value: async function (input: unknown) {
    if (fail) throw new Error('fixture_sealed_sync_failed')
    return (preserve as (this: object, input: unknown) => Promise<unknown>).call(store, input)
  } })
  next.start(); await until(() => notice(next) === 'fixture_sealed_sync_failed', 'sealed sync failure')
  assert((await journal(f.privateRoot))[0]?.claimClosureReceipt)
  assert.equal((await writerSlot(f.coordinationRoot))?.receipt?.containerId, CONTAINER); assert.equal(f.docker.count('rm'), 0)
  fail = false
  await until(async () => (await journal(f.privateRoot)).length === 0, 'sealed sync retry retirement')
  assert.equal(f.closures.length, 1); assert.equal(f.docker.count('rm'), 1)
})

test('rename success followed by repeated directory sync failure cannot retire the original creation', workerTestOptions, async t => {
  const f = await fixture(t), original = await f.seed('claimed', false)
  const next = f.makeWorker(); await next.init()
  const store: unknown = Reflect.get(next, 'sealed'); assert(store instanceof SealedDeviceCreations)
  const owned: unknown = Reflect.get(store, 'owned'); assert.equal(typeof owned, 'function')
  await (owned as (this: SealedDeviceCreations) => Promise<void>).call(store)
  const handle: unknown = Reflect.get(store, 'handle'); assert(handle && typeof handle === 'object')
  const sync: unknown = Reflect.get(handle, 'sync'); assert.equal(typeof sync, 'function')
  let fail = true, attempts = 0
  Object.defineProperty(handle, 'sync', { value: async () => {
    attempts++
    if (fail) throw new Error('fixture_directory_sync_failed')
    await (sync as (this: object) => Promise<void>).call(handle)
  } })
  const slotBefore = await readFile(join(f.coordinationRoot, DEVICE_WRITER_SLOT_FILENAME))
  next.start()
  await until(async () => attempts >= 2 || (await journal(f.privateRoot)).length === 0, 'same-process directory sync retry')
  const [saved] = await journal(f.privateRoot); assert(saved?.claimClosureReceipt)
  assert.equal(saved.id, original.id); assert(attempts >= 2)
  const path = join(f.privateRoot, 'sealed-creations', original.id + '.json')
  assert.equal(sealedCreation.parse(JSON.parse(await readFile(path, 'utf8'))).closure.executionId, original.id)
  assert.deepEqual(await readFile(join(f.coordinationRoot, DEVICE_WRITER_SLOT_FILENAME)), slotBefore)
  assert.equal(f.docker.calls.length, 0); assert.equal(f.closures.length, 1)
  fail = false
  await until(async () => (await journal(f.privateRoot)).length === 0, 'successful sync permits retirement')
  assert.equal(await writerSlot(f.coordinationRoot), null); assert.equal(f.closures.length, 1)
  assert.equal(sealedCreation.parse(JSON.parse(await readFile(path, 'utf8'))).removalConfirmed, false)
})

test('close during a successful claim acknowledgement preserves its intent and suppresses creation', workerTestOptions, async t => {
  const f = await fixture(t), job = f.job(), held = f.holdClaim()
  f.advertise([job]); f.worker.start(); await held.entered
  const [intent] = await journal(f.privateRoot); assert.equal(intent?.stage, 'claiming')
  const closing = f.worker.close(); held.release(); await closing
  const [row] = await journal(f.privateRoot); assert(row?.claimed); assert.equal(row.processId, intent.processId)
  assert.equal(row.stage, 'claimed'); assert.deepEqual(row.queuedJob, job)
  assert.equal(f.docker.count('create'), 0); assert.equal(f.docker.count('start'), 0)
  assert.equal(f.requests.filter(item => item.path === '/devices/agent/register').length, 0)
})

test('a different Device cannot claim an overlapping directory before the prior writer is stopped and settled', workerTestOptions, async t => {
  const first = await fixture(t)
  first.docker.keepRunning = true
  first.advertise([first.job()]); first.worker.start()
  await until(() => first.docker.state.Running, 'first writer running')
  const second = await fixture(t, { coordinationRoot: first.coordinationRoot, directory: join(first.directory, 'nested') })
  second.advertise([second.job()]); second.worker.start()
  await until(() => notice(second.worker) === 'device_process_already_owned', 'shared writer exclusion')
  assert.equal(second.requests.filter(item => item.path === '/devices/agent/claim').length, 0)
  assert.equal(second.docker.count('create'), 0)
  await second.worker.close()
  const restarted = second.makeWorker(); await restarted.init(); restarted.start()
  await first.worker.close()
  await until(async () => (await journal(first.privateRoot)).length === 0, 'first stopped and settled')
  await until(async () => second.finishes.length === 1 && (await journal(second.privateRoot)).length === 0, 'waiting Device restored')
  assert.equal(second.requests.filter(item => item.path === '/devices/agent/claim').length, 1)
  assert.equal(second.docker.count('create'), 1); assert.equal(second.docker.count('start'), 1)
})

test('a stopped unknown command retains shared admission across restart until trusted closure', workerTestOptions, async t => {
  const first = await fixture(t)
  first.registrationAck('no-start'); first.advertise([first.job()]); first.worker.start()
  await until(() => first.finishes.length > 0 && notice(first.worker) === 'device_unknown_result_requires_approval', 'unknown stopped writer')
  assert.equal(first.docker.count('rm'), 1)
  const second = await fixture(t, { coordinationRoot: first.coordinationRoot, directory: first.directory })
  second.advertise([second.job()]); second.worker.start()
  await until(() => notice(second.worker) === 'device_process_already_owned', 'live unknown reservation')
  await first.worker.close()
  await until(() => notice(second.worker) === 'device_writer_busy', 'durable unknown reservation')
  assert.equal(second.requests.filter(item => item.path === '/devices/agent/claim').length, 0)
  const recovering = first.makeWorker(); await recovering.init(); recovering.start()
  await first.resolveUnknown()
  await until(async () => second.finishes.length === 1 && (await journal(second.privateRoot)).length === 0, 'admission after closure')
  assert.equal(first.docker.count('create'), 1); assert.equal(first.docker.count('start'), 0)
  const reports = first.finishes
  for (const report of reports) assert.deepEqual(report, reports[0])
  assert.equal(second.docker.count('start'), 1)
})

test('local transfer holds shared admission across Devices and refuses a repeated create without overwriting', workerTestOptions, async t => {
  const first = await fixture(t)
  const second = await fixture(t, { coordinationRoot: first.coordinationRoot, directory: first.directory })
  const status = z.object({ directories: z.array(z.object({ directoryId: z.uuid() })) }).parse(first.worker.status())
  const directoryId = status.directories[0]!.directoryId
  const held = first.holdTransfer()
  const incoming = first.worker.importFile(directoryId, 'cloud.txt', 'received.txt')
  await until(() => first.requests.some(item => item.path === '/devices/agent/files/read'), 'admitted transfer')
  const secondId = z.object({ directories: z.array(z.object({ directoryId: z.uuid() })) }).parse(second.worker.status()).directories[0]!.directoryId
  await assert.rejects(second.worker.exportFile(secondId, 'received.txt', 'exported.txt', randomUUID()), { code: 'device_process_already_owned' })
  assert.equal(second.requests.filter(item => item.path === '/devices/agent/files/put').length, 0)
  held.release(); await incoming
  assert.equal(await readFile(join(first.directory, 'received.txt'), 'utf8'), 'explicit cloud transfer\n')
  await assert.rejects(first.worker.importFile(directoryId, 'cloud.txt', 'received.txt'), { code: 'file_exists' })
  await second.worker.exportFile(secondId, 'received.txt', 'exported.txt', randomUUID())
  assert.equal(await readFile(join(first.directory, 'received.txt'), 'utf8'), 'explicit cloud transfer\n')
  assert.equal(first.docker.calls.length + second.docker.calls.length, 0)
})

test('legacy directory access requires explicit local reauthorization and excludes protected runtime directories', workerTestOptions, async t => {
  const f = await fixture(t)
  const statePath = join(f.privateRoot, 'device.json')
  await f.worker.close()
  const state = z.object({ directories: z.array(z.object({ id: z.uuid() }).passthrough()) }).passthrough().parse(JSON.parse(await readFile(statePath, 'utf8')))
  const directoryId = state.directories[0]!.id
  delete state.directories[0]!.identity
  await writeFile(statePath, JSON.stringify(state), { mode: 0o600 })
  const next = f.makeWorker(); await next.init()
  await assert.rejects(next.importFile(directoryId, 'cloud.txt', 'legacy.txt'), /directory_requires_local_reauthorization/u)
  const allowed = z.object({ directoryId: z.uuid() }).parse(await next.authorize(f.directory))
  assert.equal(allowed.directoryId, directoryId)
  await next.importFile(directoryId, 'cloud.txt', 'legacy.txt')
  for (const selected of [f.privateRoot, f.coordinationRoot, f.base]) {
    await assert.rejects(next.authorize(selected), /directory_not_allowed/u)
  }
  assert.equal(await readFile(join(f.directory, 'legacy.txt'), 'utf8'), 'explicit cloud transfer\n')
  assert.equal(f.docker.calls.length, 0)
})

test('a replacement physical directory cannot use the old grant and explicit selection issues a new grant', workerTestOptions, async t => {
  const f = await fixture(t)
  const status = z.object({ directories: z.array(z.object({ directoryId: z.uuid() })) }).parse(f.worker.status())
  const originalId = status.directories[0]!.directoryId
  await rename(f.directory, join(f.base, 'original-project'))
  await mkdir(f.directory, { mode: 0o700 })
  await writeFile(join(f.directory, 'new.txt'), 'replacement bytes')
  await assert.rejects(f.worker.exportFile(originalId, 'new.txt', 'exported.txt', randomUUID()), { code: 'directory_identity_changed' })
  await assert.rejects(f.worker.importFile(originalId, 'cloud.txt', 'received.txt'), /directory_changed/u)
  assert.equal(f.requests.filter(item => item.path === '/devices/agent/files/put' || item.path === '/devices/agent/files/read').length, 0)
  const renewed = z.object({ directoryId: z.uuid() }).parse(await f.worker.authorize(f.directory))
  assert.notEqual(renewed.directoryId, originalId)
  await f.worker.importFile(renewed.directoryId, 'cloud.txt', 'received.txt')
  assert.equal(await readFile(join(f.directory, 'new.txt'), 'utf8'), 'replacement bytes')
  assert.equal(f.docker.calls.length, 0)
})

async function quiesceWorker(worker: DesktopWorker): Promise<DeviceDrainReport> {
  const method: unknown = Reflect.get(worker, 'quiesce')
  assert.equal(typeof method, 'function', 'the owned Device exposes quiescence separately from process exit')
  return deviceDrainReport.parse(await (method as (this: DesktopWorker) => Promise<DeviceDrainReport>).call(worker))
}

test('parent lifecycle quiescence retains durable stop facts after finish ACK loss', workerTestOptions, async t => {
  const f = await fixture(t), job = f.job()
  f.docker.keepRunning = true; f.ack('lost'); f.advertise([job]); f.worker.start()
  await until(() => f.docker.count('start') === 1, 'owned command started')
  const report = await quiesceWorker(f.worker)
  assert.equal(report.entries.length, 1)
  assert.equal(report.entries[0]!.state, 'stopConfirmed')
  assert.equal(report.entries[0]!.executionId, job.executionId)
  assert.equal(f.docker.count('stop'), 1)
  assert.equal(f.docker.count('rm'), 0)
  assert.equal((await journal(f.privateRoot)).length, 1)
  assert(await writerSlot(f.coordinationRoot))
  await assert.rejects(f.worker.authorize(f.directory), /device_closed/u)
})

test('parent lifecycle collector never confirms an in-memory-only stop observation', workerTestOptions, async t => {
  const f = await fixture(t), row = await f.seed('created', true)
  const next = f.makeWorker(); await next.init()
  const bytes = await readFile(join(f.privateRoot, 'journal.json'), 'utf8')
  const entries: unknown = Reflect.get(next, 'journal')
  assert(entries instanceof Map)
  const memory = entries.get(row.id) as JournalRow
  memory.stopObservation = { receipt: row.receipt!, ...stopped }
  const report = await quiesceWorker(next)
  assert.deepEqual(report.entries, [{ executionId: row.id, state: 'unconfirmed' }])
  assert.equal(await readFile(join(f.privateRoot, 'journal.json'), 'utf8'), bytes)
  assert.equal(f.docker.calls.length, 0)
})
