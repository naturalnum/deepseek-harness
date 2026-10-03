/** Public Worker recovery uses real private files, native flock and loopback HTTP; Docker commands are replacements. */
import assert from 'node:assert/strict'
import test, { type TestContext } from 'node:test'
import { createHash, randomUUID } from 'node:crypto'
import { createServer, type IncomingMessage, type ServerResponse } from 'node:http'
import { mkdir, mkdtemp, readFile, realpath, rm, stat, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { setTimeout as delay } from 'node:timers/promises'
import { z } from 'zod'
import { DesktopWorker } from '../src/device/worker.ts'
import { DockerCommandError, OwnedDeviceContainer, OWNED_DEVICE_CONTAINER_LABELS, ownedContainerOwner, ownedContainerReceipt,
  type DockerClient, type DockerCommandResult, type OwnedContainerObservation, type OwnedContainerReceipt } from '../src/device/owned-container.ts'

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
  stopObservation: z.object({ Running: z.literal(false), receipt: ownedContainerReceipt }).passthrough().optional(),
  result: z.object({ state: z.string() }).passthrough().optional() }).passthrough())
type JournalRow = z.infer<typeof journalView>[number]
function gate() { let release!: () => void; const promise = new Promise<void>(resolve => { release = resolve }); return { promise, release } }
async function until(condition: () => boolean | Promise<boolean>, label: string): Promise<void> {
  const deadline = Date.now() + 2500
  while (!await condition()) { if (Date.now() >= deadline) throw new Error('Timed out: ' + label); await delay(10) }
}
async function journal(root: string) { return journalView.parse(JSON.parse(await readFile(join(root, 'journal.json'), 'utf8'))) }
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

interface Job { executionId: string; directoryId: string; command: string; cwd: string; timeoutMs: number;
  digest: string; state: 'queued'; cancelRequested: boolean }
async function fixture(t: TestContext) {
  const base = await mkdtemp(join(await realpath(tmpdir()), 'pe-worker-recovery-'))
  const privateRoot = join(base, 'private'), directory = join(base, 'project')
  await mkdir(directory, { mode: 0o700 })
  const deviceId = randomUUID(), directoryId = randomUUID(), docker = new DockerReplacement()
  const requests: { path: string; body: Record<string, unknown> }[] = [], finishes: Record<string, unknown>[] = []
  const allowed = [directoryId], workers: DesktopWorker[] = []
  let jobs: Job[] = [], finishAck: 'valid' | 'wrong-id' | 'running' = 'valid'
  let directoryGate: ReturnType<typeof gate> | undefined
  let directoryEntered: ReturnType<typeof gate> | undefined
  async function route(req: IncomingMessage, res: ServerResponse) {
    const buffers: Buffer[] = []; let length = 0
    for await (const chunk of req) { const bytes = Buffer.from(chunk); length += bytes.length; assert(length <= 65536); buffers.push(bytes) }
    const body = z.record(z.string(), z.unknown()).parse(JSON.parse(Buffer.concat(buffers).toString('utf8')))
    const path = req.url ?? ''; requests.push({ path, body })
    let reply: object
    switch (path) {
      case '/devices/enroll': reply = { deviceId, token: 'synthetic-device-test-token-00000000000000' }; break
      case '/devices/agent/directory': {
        directoryEntered?.release(); await directoryGate?.promise
        const id = allowed.length === 1 && workers.length === 1 && !directoryGate ? directoryId : randomUUID()
        if (!allowed.includes(id)) allowed.push(id)
        reply = { directoryId: id }; break
      }
      case '/devices/agent/jobs': reply = { jobs, directories: [...allowed] }; break
      case '/devices/agent/claim': {
        const job = jobs.find(item => item.executionId === body.executionId); assert(job)
        const { state, cancelRequested, ...claimed } = job; void state; void cancelRequested
        reply = claimed; break
      }
      case '/devices/agent/finish': {
        finishes.push(body); jobs = jobs.filter(job => job.executionId !== body.executionId)
        reply = { executionId: finishAck === 'wrong-id' ? randomUUID() : body.executionId,
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
    directoryGate?.release(); docker.stopGate?.release()
    await Promise.all(workers.map(worker => worker.close()))
    server.closeAllConnections(); await new Promise<void>(resolve => server.close(() => resolve()))
    await rm(base, { recursive: true, force: true })
  })
  const worker = makeWorker(); await worker.init()
  await worker.pair('synthetic-pairing-code-000000', 'Synthetic test device'); await worker.authorize(directory)
  async function seed(stage: 'claimed' | 'created' | 'finished', withReceipt: boolean, withStopped = false): Promise<JournalRow> {
    await worker.close()
    const device = z.object({ instanceId: z.uuid() }).parse(JSON.parse(await readFile(join(privateRoot, 'device.json'), 'utf8')))
    const id = randomUUID(), owner = ownedContainerOwner.parse({ deviceId, enrollmentId: device.instanceId,
      executionId: id, creationId: randomUUID(), requestDigest: 'c'.repeat(64) })
    const receipt = ownedContainerReceipt.parse({ containerId: CONTAINER, imageId: IMAGE, owner })
    const row = { id, container: 'pe-local-' + id.replaceAll('-', ''), owner, imageId: IMAGE, stage, startedAt: Date.now(),
      ...(withReceipt ? { receipt } : {}), ...(withStopped ? { stopObservation: { receipt, ...stopped } } : {}),
      ...(stage === 'finished' ? { result: resultUnknown } : {}) }
    await writeFile(join(privateRoot, 'journal.json'), JSON.stringify([row]), { mode: 0o600 })
    return row
  }
  function job(): Job {
    const command = 'printf synthetic-device-test', cwd = '', timeoutMs = 2000
    return { executionId: randomUUID(), directoryId, command, cwd, timeoutMs, state: 'queued', cancelRequested: false,
      digest: createHash('sha256').update(JSON.stringify({ command, cwd, timeoutMs, deviceId, directoryId })).digest('hex') }
  }
  return { base, privateRoot, directory, docker, worker, makeWorker, seed, job, requests, finishes,
    advertise(value: Job[]) { jobs = value }, ack(value: typeof finishAck) { finishAck = value },
    holdDirectory() { directoryGate = gate(); directoryEntered = gate(); return { entered: directoryEntered.promise, release: directoryGate.release } } }
}

test('fresh public execution saves owner before create and receipt/start intent before start, with native lock exclusion', { timeout: 10000 }, async t => {
  const f = await fixture(t), job = f.job()
  f.docker.onCreate = async () => { const [row] = await journal(f.privateRoot); assert.equal(row?.id, job.executionId); assert.equal(row.stage, 'claimed'); assert(row.owner?.creationId); assert.equal(row.receipt, undefined) }
  f.docker.onStart = async () => { const [row] = await journal(f.privateRoot); assert.equal(row?.receipt?.containerId, CONTAINER); assert.equal(row.receipt.imageId, IMAGE); assert.equal(row.stage, 'started') }
  f.advertise([job]); f.worker.start()
  await until(async () => f.finishes.length === 1 && (await journal(f.privateRoot)).length === 0, 'fresh execution completion')
  assert.equal(z.object({ state: z.string() }).parse(f.finishes[0]!.result).state, 'succeeded')
  assert.equal(f.docker.count('create'), 1); assert.equal(f.docker.count('start'), 1); assert.equal(f.docker.count('rm'), 1)
  assert.equal((await stat(f.privateRoot)).mode & 0o777, 0o700)
  for (const path of ['device.json', 'journal.json', 'device-process.lock']) assert.equal((await stat(join(f.privateRoot, path))).mode & 0o777, 0o600)
  const competing = f.makeWorker(); await assert.rejects(competing.init(), { code: 'device_process_already_owned' })
  await f.worker.close(); const next = f.makeWorker(); await next.init(); await next.close()
})

test('lost create acknowledgement is adopted once; cold create-to-journal recovery never creates or starts', { timeout: 10000 }, async t => {
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

test('foreign same-name or missing exact identity retains journal and blocks new admission', { timeout: 10000 }, async t => {
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

test('failed stop closes boundedly, releases flock, and the next worker recovers before admitting another job', { timeout: 10000 }, async t => {
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

test('a saved stop observation cannot finish a container that is running again before a new exact stop', { timeout: 10000 }, async t => {
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

test('wrong execution identity or nonterminal finish acknowledgement preserves journal and prohibits removal/admission', { timeout: 10000 }, async t => {
  for (const ack of ['wrong-id', 'running'] as const) {
    const f = await fixture(t), row = await f.seed('finished', true, true)
    f.docker.seed(row, stopped); f.ack(ack); f.advertise([f.job()])
    const next = f.makeWorker(); await next.init(); next.start()
    await until(() => f.finishes.length > 0 && notice(next) !== '', 'invalid finish acknowledgement')
    const rows = await journal(f.privateRoot); assert.equal(rows.length, 1); assert.equal(rows[0]!.id, row.id); assert(rows[0]!.stopObservation)
    assert.equal(f.docker.count('rm'), 0); assert.equal(f.requests.filter(item => item.path === '/devices/agent/claim').length, 0)
    await next.close()
  }
})

test('close closes local admission and waits for an in-flight public authorize before releasing its flock', { timeout: 10000 }, async t => {
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
