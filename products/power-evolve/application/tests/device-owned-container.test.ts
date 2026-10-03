/** Docker CLI replacements verify identity and argv sequencing; no real daemon or container runs here. */
import assert from 'node:assert/strict'
import test from 'node:test'
import { randomUUID } from 'node:crypto'
import { mkdtemp, rm, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { DockerCommandError, OwnedContainerError, OwnedDeviceContainer, ScrubbedDockerClient,
  OWNED_DEVICE_CONTAINER_LABELS, ownedContainerOwner, ownedContainerReceipt,
  type DockerClient, type DockerCommandResult, type OwnedContainerCreateRequest } from '../src/device/owned-container.ts'

const config = { commandTimeoutMs: 15000, stopTimeoutMs: 10000, stopGraceSeconds: 2 }
const owner = ownedContainerOwner.parse({ deviceId: randomUUID(), enrollmentId: randomUUID(), executionId: randomUUID(),
  creationId: randomUUID(), requestDigest: 'c'.repeat(64) })
const receipt = ownedContainerReceipt.parse({ containerId: 'b'.repeat(64), imageId: 'sha256:' + 'a'.repeat(64), owner })
const request: OwnedContainerCreateRequest = { name: 'pe-local-' + owner.executionId.replaceAll('-', ''),
  imageId: receipt.imageId, owner, options: ['--network', 'none', '--read-only', '--entrypoint', '/bin/bash'],
  command: ['-lc', 'printf fixture'] }
const labels = { [OWNED_DEVICE_CONTAINER_LABELS.schema]: '1', [OWNED_DEVICE_CONTAINER_LABELS.imageId]: receipt.imageId,
  ...Object.fromEntries(Object.entries(owner).map(([field, value]) => [OWNED_DEVICE_CONTAINER_LABELS[field as keyof typeof owner], value])) }
const created = { Running: false, ExitCode: 0, Status: 'created', StartedAt: '0001-01-01T00:00:00Z', FinishedAt: '0001-01-01T00:00:00Z' }
function inspected(overrides: object = {}): DockerCommandResult {
  return { stdout: JSON.stringify({ Id: receipt.containerId, Image: receipt.imageId, Labels: labels, State: created, ...overrides }), stderr: '' }
}
class DockerReplacement implements DockerClient {
  readonly calls: string[][] = []
  readonly timeouts: number[] = []
  constructor(private readonly results: (DockerCommandResult | Error)[]) {}
  async run(args: readonly string[], timeoutMs: number): Promise<DockerCommandResult> {
    assert(timeoutMs > 0 && timeoutMs <= 15000)
    this.calls.push([...args])
    this.timeouts.push(timeoutMs)
    const next = this.results.shift()
    assert(next, 'Unexpected replacement Docker request')
    if (next instanceof Error) throw next
    return next
  }
}
const ok = { stdout: '', stderr: '' }
function exactInspect(args: string[], locator: string): void {
  assert.deepEqual(args.slice(0, 3), ['container', 'inspect', '--format'])
  assert.equal(args.at(-1), locator)
  assert(!args[3]!.includes('Env'))
  assert(!args[3]!.includes('Cmd'))
}

test('local image resolution freezes the actual image ID without pull', async () => {
  const docker = new DockerReplacement([{ stdout: JSON.stringify(receipt.imageId), stderr: '' }])
  assert.equal(await new OwnedDeviceContainer(config, docker).resolveImage('fixture:mutable'), receipt.imageId)
  assert.deepEqual(docker.calls[0], ['image', 'inspect', '--format', '{{json .Id}}', 'fixture:mutable'])
})

test('create binds the immutable image and all frozen labels, then verifies returned exact ID without start', async () => {
  const docker = new DockerReplacement([{ stdout: receipt.containerId + '\n', stderr: '' }, inspected()])
  assert.deepEqual(await new OwnedDeviceContainer(config, docker).create(request), receipt)
  const argv = docker.calls[0]!
  assert.deepEqual(argv.slice(0, 1 + request.options.length), ['create', ...request.options])
  for (const [key, value] of Object.entries(labels)) {
    const index = argv.indexOf(`${key}=${value}`)
    assert(index > request.options.length); assert.equal(argv[index - 1], '--label')
  }
  assert.deepEqual(argv.slice(-3), [receipt.imageId, ...request.command])
  exactInspect(docker.calls[1]!, receipt.containerId)
  assert.equal(docker.calls.length, 2)
})

test('lost create acknowledgement adopts one matching name observation and never retries create', async () => {
  const docker = new DockerReplacement([new DockerCommandError('docker_command_failed'), inspected()])
  assert.deepEqual(await new OwnedDeviceContainer(config, docker).create(request), receipt)
  assert.equal(docker.calls.length, 2); assert.equal(docker.calls[0]![0], 'create')
  exactInspect(docker.calls[1]!, request.name)
})

test('cold creation-intent lookup is read-only and captures a receipt before any later exact-ID cleanup', async () => {
  const docker = new DockerReplacement([inspected(), inspected(), ok])
  const containers = new OwnedDeviceContainer(config, docker)
  const found = await containers.findCreated(request)
  assert.deepEqual(found, receipt); exactInspect(docker.calls[0]!, request.name)
  await containers.remove(found!)
  exactInspect(docker.calls[1]!, receipt.containerId)
  assert.deepEqual(docker.calls[2], ['rm', receipt.containerId])
  assert(!docker.calls.some(args => ['start', 'create'].includes(args[0]!)))
})

test('same-name foreign container is rejected on direct lookup and on lost-create recovery', async () => {
  const foreign = inspected({ Labels: { ...labels, [OWNED_DEVICE_CONTAINER_LABELS.creationId]: randomUUID() } })
  for (const creating of [false, true]) {
    const docker = new DockerReplacement(creating ? [new DockerCommandError('docker_command_failed'), foreign] : [foreign])
    const containers = new OwnedDeviceContainer(config, docker)
    await assert.rejects(creating ? containers.create(request) : containers.findCreated(request),
      { code: 'container_identity_mismatch' })
    assert(!docker.calls.some(args => ['start', 'stop', 'rm'].includes(args[0]!)))
    assert.equal(docker.calls.filter(args => args[0] === 'container').length, 1)
  }
})

test('exact ID, actual image, label image, schema and every frozen owner mismatch reject inspection', async () => {
  const variants = [inspected({ Id: 'd'.repeat(64) }), inspected({ Image: 'sha256:' + 'e'.repeat(64) }),
    ...Object.keys(labels).map(key => inspected({ Labels: { ...labels, [key]: 'mismatched-fixture' } }))]
  for (const result of variants) {
    const docker = new DockerReplacement([result])
    await assert.rejects(new OwnedDeviceContainer(config, docker).inspect(receipt), { code: 'container_identity_mismatch' })
    exactInspect(docker.calls[0]!, receipt.containerId); assert.equal(docker.calls.length, 1)
  }
})

test('start stop logs and removal inspect exact ID first and use configured timeout and stop grace', async () => {
  const running = { ...created, Running: true, Status: 'running' }, exited = { ...created, Status: 'exited' }
  const docker = new DockerReplacement([inspected(), ok, inspected({ State: running }), ok,
    inspected({ State: exited }), { stdout: 'fixture-output', stderr: '' }, inspected({ State: exited }), ok])
  const containers = new OwnedDeviceContainer({ commandTimeoutMs: 3000, stopTimeoutMs: 2000, stopGraceSeconds: 7 }, docker)
  await containers.start(receipt); await containers.stop(receipt)
  assert.equal((await containers.logs(receipt)).stdout, 'fixture-output'); await containers.remove(receipt)
  for (const index of [0, 2, 4, 6]) exactInspect(docker.calls[index]!, receipt.containerId)
  assert.deepEqual(docker.calls[1], ['start', receipt.containerId])
  assert.deepEqual(docker.calls[3], ['stop', '--time', '7', receipt.containerId])
  assert.deepEqual(docker.calls[5], ['logs', receipt.containerId])
  assert.deepEqual(docker.calls[7], ['rm', receipt.containerId])
  assert(!docker.calls.flat().includes(request.name)); assert(!docker.calls.flat().includes('--force'))
  assert.deepEqual(docker.timeouts, [3000, 3000, 3000, 2000, 3000, 3000, 3000, 3000])
})

test('a running observation rejects removal before an rm request', async () => {
  const docker = new DockerReplacement([inspected({ State: { ...created, Running: true, Status: 'running' } })])
  await assert.rejects(new OwnedDeviceContainer(config, docker).remove(receipt), { code: 'container_running' })
  assert.equal(docker.calls.length, 1)
})

test('a lost start acknowledgement is not replayed and its caller can inspect the same ID', async () => {
  const running = { ...created, Running: true, Status: 'running' }
  const docker = new DockerReplacement([inspected(), new DockerCommandError('docker_command_failed'), inspected({ State: running })])
  const containers = new OwnedDeviceContainer(config, docker)
  await assert.rejects(containers.start(receipt), { code: 'docker_command_failed' })
  assert.deepEqual(await containers.inspect(receipt), running)
  assert.equal(docker.calls.filter(args => args[0] === 'start').length, 1)
})

test('missing exact container remains null, never stop evidence or permission to mutate by name', async () => {
  const absent = () => new DockerCommandError('docker_not_found')
  const docker = new DockerReplacement([absent()])
  assert.equal(await new OwnedDeviceContainer(config, docker).inspect(receipt), null)
  exactInspect(docker.calls[0]!, receipt.containerId)
  for (const method of ['start', 'stop', 'logs', 'remove'] as const) {
    const replacement = new DockerReplacement([absent()])
    await assert.rejects(new OwnedDeviceContainer(config, replacement)[method](receipt), { code: 'container_missing' })
    assert.equal(replacement.calls.length, 1)
  }
  const missingCreate = new DockerReplacement([new DockerCommandError('docker_command_failed'), absent()])
  await assert.rejects(new OwnedDeviceContainer(config, missingCreate).create(request), { code: 'create_unconfirmed' })
  assert.equal(missingCreate.calls.length, 2)
  const missingLookup = new DockerReplacement([absent()])
  assert.equal(await new OwnedDeviceContainer(config, missingLookup).findCreated(request), null)
})

test('unknown daemon or malformed inspection fails closed rather than returning absent', async () => {
  for (const result of [new Error('raw private fixture diagnostic'), { stdout: '{broken-json', stderr: '' },
    { ...inspected(), outputTruncated: true }]) {
    const docker = new DockerReplacement([result])
    await assert.rejects(new OwnedDeviceContainer(config, docker).inspect(receipt), { code: 'container_inspection_unavailable' })
  }
})

test('durable receipts reject missing identity, shortened ID and incomplete owner fields', () => {
  assert.equal(ownedContainerReceipt.safeParse({}).success, false)
  assert.equal(ownedContainerReceipt.safeParse({ ...receipt, containerId: receipt.containerId.slice(0, 12) }).success, false)
  assert.equal(ownedContainerReceipt.safeParse({ ...receipt, owner: { deviceId: owner.deviceId } }).success, false)
})

test('logs retain an explicit bounded partial-output result', async () => {
  const docker = new DockerReplacement([inspected(), { stdout: 'x'.repeat(70000), stderr: 'fixture-error', outputTruncated: true }])
  const output = await new OwnedDeviceContainer(config, docker).logs(receipt)
  assert.equal(Buffer.byteLength(output.stdout), 65536)
  assert.equal(output.stdoutTruncated, true); assert.equal(output.stderrTruncated, true)
})

test('CLI replacement receives scrubbed environment and fixed failure codes, with explicit max-buffer output', async t => {
  const directory = await mkdtemp(join(tmpdir(), 'pe-owned-docker-replacement-'))
  t.after(() => rm(directory, { recursive: true, force: true }))
  const executable = join(directory, 'docker-replacement')
  await writeFile(executable, `#!${process.execPath}\nif(process.argv[2]==='broken'){process.stderr.write('private fixture path and command');process.exit(1)}\nif(process.argv[2]==='missing'){process.stderr.write('Error response from daemon: No such container: fixture');process.exit(1)}\nif(process.argv[2]==='overflow'){process.stdout.write('x'.repeat(1048576));}else{console.log(JSON.stringify({keys:Object.keys(process.env).sort(),args:process.argv.slice(2)}))}\n`, { mode: 0o700 })
  const docker = new ScrubbedDockerClient(executable, { PATH: process.env.PATH, HOME: directory,
    DOCKER_HOST: 'unix://fixture-only.sock', PROVIDER_API_KEY: 'fixture-only', TOKEN: 'fixture-only', UNRELATED: 'fixture-only' })
  const result = JSON.parse((await docker.run(['probe'], 2000)).stdout)
  // Node on macOS adds its own CoreFoundation encoding metadata after exec; it is not inherited configuration.
  assert.deepEqual(result, { keys: ['DOCKER_HOST', 'HOME', 'PATH',
    ...(process.platform === 'darwin' ? ['__CF_USER_TEXT_ENCODING'] : [])], args: ['probe'] })
  await assert.rejects(docker.run(['broken'], 2000), error => {
    assert(error instanceof DockerCommandError); assert.equal(error.code, 'docker_command_failed')
    assert.equal(error.message, 'docker_command_failed'); assert(!('stderr' in error)); assert(!('cause' in error)); return true
  })
  await assert.rejects(docker.run(['missing'], 2000), { code: 'docker_not_found', message: 'docker_not_found' })
  const partial = await docker.run(['overflow'], 2000)
  assert.equal(partial.outputTruncated, true); assert(partial.stdout.length > 0 && partial.stdout.length <= 512 * 1024)
  assert.equal(new OwnedContainerError('container_identity_mismatch').message, 'container_identity_mismatch')
})
