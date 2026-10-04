/** Public Worker recovery uses real private files, native flock and loopback HTTP; Docker and Platform are replacements. */
import assert from 'node:assert/strict'
import { fork } from 'node:child_process'
import test, { type TestContext } from 'node:test'
import { createHash, randomUUID } from 'node:crypto'
import { createServer, type IncomingMessage, type ServerResponse } from 'node:http'
import { mkdir, mkdtemp, readFile, realpath, rm, stat, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { fileURLToPath } from 'node:url'
import { setTimeout as delay } from 'node:timers/promises'
import { z } from 'zod'
import { deviceJob, deviceClaim, deviceClaimRequest, deviceContainerRegistration, deviceFinishRequest } from '@power-evolve/contracts/device-execution'
import { DesktopWorker } from '../src/device/worker.ts'
import { DockerCommandError, OwnedDeviceContainer, OWNED_DEVICE_CONTAINER_LABELS, ownedContainerOwner, ownedContainerReceipt,
  type DockerClient, type DockerCommandResult, type OwnedContainerObservation, type OwnedContainerReceipt } from '../src/device/owned-container.ts'

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
  stopObservation: z.object({ Running: z.literal(false), receipt: ownedContainerReceipt }).passthrough().optional(),
  result: z.object({ state: z.string() }).passthrough().optional() }).passthrough())
type JournalRow = z.infer<typeof journalView>[number]
function gate() { let release!: () => void; const promise = new Promise<void>(resolve => { release = resolve }); return { promise, release } }
async function until(condition: () => boolean | Promise<boolean>, label: string): Promise<void> {
  const deadline = Date.now() + 2500
  while (!await condition()) { if (Date.now() >= deadline) throw new Error('Timed out: ' + label); await delay(10) }
}
async function journal(root: string) { return journalView.parse(JSON.parse(await readFile(join(root, 'journal.json'), 'utf8'))) }
async function bounded<T>(promise: Promise<T>): Promise<T> {
  let timer: ReturnType<typeof setTimeout> | undefined
  const deadline = new Promise<never>((_, reject) => { timer = setTimeout(() => reject(new Error('child fixture deadline')), 3000) })
  try { return await Promise.race([promise, deadline]) } finally { clearTimeout(timer) }
}
function notice(worker: DesktopWorker): string { return z.object({ notice: z.string() }).parse(worker.status()).notice }
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
  stopGate: ReturnType<typeof gate> | undefined
  onCreate: (() => Promise<void>) | undefined
  onStart: (() => Promise<void>) | undefined
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
      case 'rm': assert.deepEqual(args, ['rm', CONTAINER]); assert.equal(this.state.Running, false); this.present = false; return { stdout: CONTAINER, stderr: '' }
      default: throw new Error('Unexpected replacement Docker operation')
    }
  }
}

type Job = z.infer<typeof deviceJob>
async function fixture(t: TestContext) {
  const base = await mkdtemp(join(await realpath(tmpdir()), 'pe-worker-recovery-'))
  const privateRoot = join(base, 'private'), directory = join(base, 'project')
  await mkdir(directory, { mode: 0o700 })
  const deviceId = randomUUID(), directoryId = randomUUID(), docker = new DockerReplacement()
  const requests: { path: string; body: Record<string, unknown> }[] = [], finishes: Record<string, unknown>[] = []
  const allowed = [directoryId], workers: DesktopWorker[] = []
  const closeChildren: (() => Promise<void>)[] = []
  const claims = new Map<string, z.infer<typeof deviceClaim>>()
  const registrations = new Map<string, string>(), finished = new Map<string, string>()
  let jobs: Job[] = [], finishAck: 'valid' | 'wrong-id' | 'running' | 'wrong-dispatch' | 'wrong-request' | 'no-stop' | 'lost' = 'valid'
  let registerAck: 'valid' | 'lost' | 'wrong-dispatch' | 'wrong-receipt' | 'no-start' = 'valid'
  let claimAck: 'valid' | 'lost' = 'valid'
  let claimGate: ReturnType<typeof gate> | undefined, claimEntered: ReturnType<typeof gate> | undefined
  let onClaim: (() => Promise<void>) | undefined
  let directoryGate: ReturnType<typeof gate> | undefined
  let directoryEntered: ReturnType<typeof gate> | undefined
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
        const id = allowed.length === 1 && workers.length === 1 && !directoryGate ? directoryId : randomUUID()
        if (!allowed.includes(id)) allowed.push(id)
        reply = { directoryId: id }; break
      }
      case '/devices/agent/jobs': reply = { jobs, directories: [...allowed] }; break
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
          state: finishAck === 'running' ? 'running' : z.object({ state: z.string() }).parse(body.result).state }; break
      }
      default: res.writeHead(404).end(); return
    }
    res.writeHead(200, { 'content-type': 'application/json' }).end(JSON.stringify(reply))
  }
  const server = createServer((req, res) => { void route(req, res).catch(() => { res.writeHead(500).end('{}') }) })
  await new Promise<void>(resolve => server.listen(0, '127.0.0.1', resolve))
  const address = server.address(); assert(address && typeof address === 'object')
  const url = 'http://127.0.0.1:' + address.port
  const makeWorker = () => {
    const worker = new DesktopWorker(url, privateRoot, 'synthetic-fixture:tag', options, new OwnedDeviceContainer(containerOptions, docker))
    workers.push(worker); return worker
  }
  t.after(async () => {
    directoryGate?.release(); claimGate?.release(); docker.stopGate?.release()
    await Promise.all(closeChildren.map(close => close()))
    await Promise.all(workers.map(worker => worker.close()))
    server.closeAllConnections(); await new Promise<void>(resolve => server.close(() => resolve()))
    await rm(base, { recursive: true, force: true })
  })
  const worker = makeWorker(); await worker.init()
  await worker.pair('synthetic-pairing-code-000000', 'Synthetic test device'); await worker.authorize(directory)
  async function seed(stage: 'claimed' | 'created' | 'finished', withReceipt: boolean, withStopped = false): Promise<JournalRow> {
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
    await writeFile(join(privateRoot, 'journal.json'), JSON.stringify([row]), { mode: 0o600 })
    return row
  }
  function job(): Job {
    const command = 'printf synthetic-device-test', cwd = '', timeoutMs = 2000
    return deviceJob.parse({ executionId: randomUUID(), directoryId, command, cwd, timeoutMs, state: 'queued', cancelRequested: false,
      digest: createHash('sha256').update(JSON.stringify({ command, cwd, timeoutMs, deviceId, directoryId })).digest('hex') })
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
    const child = fork(path, [url, privateRoot, JSON.stringify(options), JSON.stringify(containerOptions)],
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
  return { base, privateRoot, directory, docker, worker, makeWorker, seed, job, requests, finishes,
    makeChild,
    advertise(value: Job[]) { jobs = value }, ack(value: typeof finishAck) { finishAck = value },
    registrationAck(value: typeof registerAck) { registerAck = value },
    claimAck(value: typeof claimAck) { claimAck = value },
    observeClaim(action: () => Promise<void>) { onClaim = action },
    holdClaim() { claimGate = gate(); claimEntered = gate(); return { entered: claimEntered.promise, release: claimGate.release } },
    holdDirectory() { directoryGate = gate(); directoryEntered = gate(); return { entered: directoryEntered.promise, release: directoryGate.release } } }
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
  await until(async () => cold.finishes.length === 1 && (await journal(cold.privateRoot)).length === 0, 'cold gap cleanup')
  assert.equal(z.object({ state: z.string() }).parse(cold.finishes[0]!.result).state, 'uncertain')
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
  await until(async () => f.finishes.length === 1 && (await journal(f.privateRoot)).length === 0, 'recovered stop and cleanup')
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
  await until(async () => f.finishes.length === 1 && (await journal(f.privateRoot)).length === 0, 'new stop observation completion')
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
    await until(async () => f.finishes.length === 1 && (await journal(f.privateRoot)).length === 0, 'unstarted registration recovery')
    assert.equal(f.docker.count('create'), 1); assert.equal(f.docker.count('start'), 0); assert.equal(f.docker.count('rm'), 1)
    assert.equal(z.object({ state: z.string() }).parse(f.finishes[0]!.result).state, 'uncertain')
    const registrations = f.requests.filter(item => item.path === '/devices/agent/register')
    assert(registrations.length >= (ack === 'lost' ? 2 : 1))
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
    await until(async () => f.finishes.length === 1 && (await journal(f.privateRoot)).length === 0, 'valid duplicate registration recovery')
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
  const registrations = f.requests.filter(item => item.path === '/devices/agent/register')
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

test('a cold process retains a lost-claim intent without reclaiming, creating, or inventing a dispatch generation', workerTestOptions, async t => {
  const f = await fixture(t), job = f.job(), held = f.holdClaim()
  f.claimAck('lost'); f.advertise([job]); f.worker.start()
  await held.entered
  const [intent] = await journal(f.privateRoot); assert(intent?.processId); assert.equal(intent.stage, 'claiming')
  const closing = f.worker.close(); held.release(); await closing
  const claims = f.requests.filter(item => item.path === '/devices/agent/claim'); assert.equal(claims.length, 1)
  const child = await f.makeChild(); child.start()
  // Observe the real cold worker refusing its predecessor's generation through its public status path.
  await until(async () => await child.notice() === 'device_claiming_requires_review', 'cold intent review notice')
  await child.close()
  assert.deepEqual((await journal(f.privateRoot))[0], intent)
  assert.deepEqual(intent.queuedJob, job); assert.equal(intent.dispatchId, undefined); assert.equal(intent.owner, undefined)
  assert.equal(f.requests.filter(item => item.path === '/devices/agent/claim').length, 1)
  for (const path of ['/devices/agent/register', '/devices/agent/finish']) assert.equal(f.requests.filter(item => item.path === path).length, 0)
  assert.equal(f.docker.calls.length, 0)
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
