/** Injected Docker responses cover capture identity and layout; no daemon, image or container runs here. */
import assert from 'node:assert/strict'
import { randomUUID } from 'node:crypto'
import test from 'node:test'
import { stdioDeviceDeploymentV2 } from '@power-evolve/contracts/stdio-mcp'
import { DockerCommandError, OwnedDeviceContainer, OWNED_DEVICE_CONTAINER_LABELS,
  ownedContainerOwner, ownedContainerReceipt, type DockerClient, type DockerCommandResult,
  type OwnedContainerCaptureRequest } from '../src/device/owned-container.ts'

const config = { commandTimeoutMs: 2345, stopTimeoutMs: 1234, stopGraceSeconds: 2 }
const owner = ownedContainerOwner.parse({ deviceId: randomUUID(), enrollmentId: randomUUID(), executionId: randomUUID(),
  creationId: randomUUID(), requestDigest: 'c'.repeat(64) })
const receipt = ownedContainerReceipt.parse({ containerId: 'b'.repeat(64), imageId: 'sha256:' + 'a'.repeat(64), owner })
const pin = stdioDeviceDeploymentV2.parse({ kind: 'desktop', deploymentId: randomUUID(), protocolVersion: 2,
  platform: { os: 'linux', architecture: 'arm64' }, configImageId: receipt.imageId })
const request: OwnedContainerCaptureRequest = { receipt, pin,
  workspaceMount: { source: '/private/fixture/project', destination: '/workspace', readOnly: false },
  homeMount: { source: '/private/fixture/home', destination: '/home/agent', readOnly: false } }
const labels = { [OWNED_DEVICE_CONTAINER_LABELS.schema]: '1', [OWNED_DEVICE_CONTAINER_LABELS.imageId]: receipt.imageId,
  ...Object.fromEntries(Object.entries(owner).map(([field, value]) => [OWNED_DEVICE_CONTAINER_LABELS[field as keyof typeof owner], value])),
  'fixture.extra-label': 'preserved' }
const state = { Running: false, ExitCode: 0, Status: 'created', StartedAt: '0001-01-01T00:00:00Z', FinishedAt: '0001-01-01T00:00:00Z',
  Pid: 0, Paused: false, Restarting: false, Dead: false, OOMKilled: false, Error: '' }
const mounts = [{ Type: 'bind', Source: request.workspaceMount.source, Destination: '/workspace', RW: true, Mode: '', Propagation: 'rprivate' },
  { Type: 'bind', Source: request.homeMount.source, Destination: '/home/agent', RW: true, Mode: '', Propagation: 'rprivate' }]
const tmpfs = { Type: 'tmpfs', Source: '', Destination: '/tmp', RW: true, Mode: '', Propagation: '' }
function output(value: object): DockerCommandResult { return { stdout: JSON.stringify(value), stderr: '' } }
function image(overrides: object = {}): DockerCommandResult {
  return output({ Id: receipt.imageId, Os: 'linux', Architecture: 'arm64', ...overrides })
}
function container(overrides: object = {}): DockerCommandResult {
  return output({ Id: receipt.containerId, Image: receipt.imageId, Labels: labels, State: state, Mounts: mounts, RestartCount: 0, ...overrides })
}
class DockerReplacement implements DockerClient {
  readonly calls: { args: readonly string[]; timeoutMs: number }[] = []
  constructor(private readonly results: (DockerCommandResult | Error)[]) {}
  async run(args: readonly string[], timeoutMs: number): Promise<DockerCommandResult> {
    this.calls.push({ args: [...args], timeoutMs })
    const next = this.results.shift()
    assert(next, 'Unexpected Docker request')
    if (next instanceof Error) throw next
    return next
  }
}
function assertReadOnly(docker: DockerReplacement): void {
  for (const { args, timeoutMs } of docker.calls) {
    assert(['image', 'container'].includes(args[0]!))
    assert.equal(args[1], 'inspect'); assert.equal(args[2], '--format')
    assert.equal(args.length, 5); assert.equal(timeoutMs, config.commandTimeoutMs)
    assert(!args[3]!.includes('Env')); assert(!args[3]!.includes('Cmd'))
    assert.equal(args[4], args[0] === 'image' ? pin.configImageId : receipt.containerId)
  }
}

test('captureImage reads the exact immutable config ID and returns the actual OS and architecture', async () => {
  const docker = new DockerReplacement([image()])
  assert.deepEqual(await new OwnedDeviceContainer(config, docker).captureImage(pin),
    { kind: 'desktop', configImageId: receipt.imageId, platform: { os: 'linux', architecture: 'arm64' } })
  assert.deepEqual(docker.calls[0]!.args, ['image', 'inspect', '--format',
    '{"Id":{{json .Id}},"Os":{{json .Os}},"Architecture":{{json .Architecture}}}', receipt.imageId])
  assertReadOnly(docker)
  assert.throws(() => stdioDeviceDeploymentV2.parse({ ...pin, configImageId: 'fixture:mutable' }))
})

test('image config ID, OS and architecture mismatches reject without a container request', async () => {
  for (const mismatch of [{ Id: 'sha256:' + 'd'.repeat(64) }, { Os: 'windows' }, { Architecture: 'amd64' }, { Architecture: 'aarch64' }]) {
    const docker = new DockerReplacement([image(mismatch)])
    await assert.rejects(new OwnedDeviceContainer(config, docker).captureContainer(request), { code: 'image_identity_mismatch' })
    assert.equal(docker.calls.length, 1); assertReadOnly(docker)
  }
})

test('unavailable, truncated and malformed image observations reject without raw Docker diagnostics', async () => {
  for (const failure of [new DockerCommandError('docker_not_found'), new DockerCommandError('docker_command_failed'),
    { ...image(), outputTruncated: true }, { stdout: '{invalid', stderr: 'private diagnostic' }, image({ Id: 'fixture:tag' }), image({ Os: null })]) {
    const docker = new DockerReplacement([failure])
    await assert.rejects(new OwnedDeviceContainer(config, docker).captureImage(pin), { code: 'image_unavailable', message: 'image_unavailable' })
    assert.equal(docker.calls.length, 1); assertReadOnly(docker)
  }
})

test('capture preserves full selected State, Mounts and labels for a created container with two authorized binds', async () => {
  for (const actualMounts of [mounts, [...mounts, tmpfs]]) {
    const docker = new DockerReplacement([image(), container({ Mounts: actualMounts })])
    const captured = await new OwnedDeviceContainer(config, docker).captureContainer(request)
    assert.deepEqual(captured.image, { kind: 'desktop', configImageId: receipt.imageId, platform: pin.platform })
    assert.deepEqual(captured.inspection, { Id: receipt.containerId, Image: receipt.imageId, Labels: labels,
      State: state, Mounts: actualMounts, RestartCount: 0 })
    assert.equal(docker.calls.length, 2)
    assert.deepEqual(docker.calls[1]!.args, ['container', 'inspect', '--format',
      '{"Id":{{json .Id}},"Image":{{json .Image}},"Labels":{{json .Config.Labels}},"State":{{json .State}},"Mounts":{{json .Mounts}},"RestartCount":{{json .RestartCount}}}', receipt.containerId])
    assertReadOnly(docker)
  }
})

test('receipt image conflict rejects before any Docker inspection', async () => {
  const docker = new DockerReplacement([])
  const foreign = ownedContainerReceipt.parse({ ...receipt, imageId: 'sha256:' + 'd'.repeat(64) })
  await assert.rejects(new OwnedDeviceContainer(config, docker).captureContainer({ ...request, receipt: foreign }), { code: 'container_identity_mismatch' })
  assert.deepEqual(docker.calls, [])
})

test('exact container ID, image and every original owner label must still match', async () => {
  const variants = [{ Id: 'd'.repeat(64) }, { Image: 'sha256:' + 'd'.repeat(64) }, { Labels: null },
    ...Object.values(OWNED_DEVICE_CONTAINER_LABELS).map(key => ({ Labels: { ...labels, [key]: 'foreign-fixture' } }))]
  for (const variant of variants) {
    const docker = new DockerReplacement([image(), container(variant)])
    await assert.rejects(new OwnedDeviceContainer(config, docker).captureContainer(request), { code: 'container_identity_mismatch' })
    assert.equal(docker.calls.length, 2); assertReadOnly(docker)
  }
})

test('running or previously exited containers and nonzero restarts cannot be captured for start', async () => {
  for (const actual of [{ State: { ...state, Running: true } }, { State: { ...state, Status: 'running' } },
    { State: { ...state, Status: 'exited' } }, { RestartCount: 1 }]) {
    const docker = new DockerReplacement([image(), container(actual)])
    await assert.rejects(new OwnedDeviceContainer(config, docker).captureContainer(request),
      { code: 'RestartCount' in actual ? 'container_restarted' : 'container_not_created' })
    assertReadOnly(docker)
  }
})

test('missing, malformed and truncated container observations are never adopted or treated as stopped', async () => {
  const variants: [DockerCommandResult | Error, string][] = [
    [new DockerCommandError('docker_not_found'), 'container_missing'],
    [new DockerCommandError('docker_command_failed'), 'container_inspection_unavailable'],
    [{ ...container(), outputTruncated: true }, 'container_inspection_unavailable'],
    [{ stdout: '{invalid', stderr: 'private diagnostic' }, 'container_inspection_unavailable'],
    [container({ RestartCount: -1 }), 'container_inspection_unavailable'],
    [container({ RestartCount: true }), 'container_inspection_unavailable'],
    [container({ RestartCount: 0.5 }), 'container_inspection_unavailable'],
    [container({ Mounts: null }), 'container_inspection_unavailable'],
    [container({ State: { ...state, Running: 'false' } }), 'container_inspection_unavailable'],
  ]
  for (const [result, code] of variants) {
    const docker = new DockerReplacement([image(), result])
    await assert.rejects(new OwnedDeviceContainer(config, docker).captureContainer(request), { code, message: code })
    assertReadOnly(docker)
  }
})

test('bind source, destination, writable mode and exact type are authority-bearing observations', async () => {
  const variants = [{ Source: '/private/fixture/foreign' }, { Source: request.workspaceMount.source + '/.' },
    { Destination: '/workspace/subdirectory' }, { Destination: '/workspace/../workspace' }, { RW: false }, { Type: 'volume' }]
  for (const variant of variants) {
    for (const index of [0, 1]) {
      const actualMounts = mounts.map((mount, current) => current === index ? { ...mount, ...variant } : mount)
      const docker = new DockerReplacement([image(), container({ Mounts: actualMounts })])
      await assert.rejects(new OwnedDeviceContainer(config, docker).captureContainer(request), { code: 'container_mount_mismatch' })
      assertReadOnly(docker)
    }
  }
})

test('missing, duplicate, shadow and extra bind or volume mounts reject; only one /tmp tmpfs is allowed', async () => {
  const variants = [[], [mounts[0]], [mounts[1]], [...mounts, mounts[0]], [...mounts, mounts[1]],
    [...mounts, { ...mounts[0], Destination: '/workspace/nested' }],
    [...mounts, { ...mounts[0], Destination: '/home' }], [...mounts, { ...mounts[0], Destination: '/etc' }],
    [...mounts, { ...mounts[0], Type: 'volume', Destination: '/tmp' }],
    [...mounts, { ...mounts[0], Destination: '/tmp' }], [...mounts, tmpfs, tmpfs],
    [...mounts, { ...tmpfs, Destination: '/var/tmp' }], [...mounts, { ...tmpfs, Destination: '/tmp/child' }]]
  for (const actualMounts of variants) {
    const docker = new DockerReplacement([image(), container({ Mounts: actualMounts })])
    await assert.rejects(new OwnedDeviceContainer(config, docker).captureContainer(request), { code: 'container_mount_mismatch' })
    assertReadOnly(docker)
  }
})

test('authorized physical sources must be absolute and canonical without control characters', async () => {
  for (const source of ['relative/project', '/private/fixture/../project', '//private/fixture/project',
    '/private/fixture/project/', '/private/fixture/./project', '/private/fixture/line\nproject', '/private/fixture/\0project', '/private/fixture/\u0085project']) {
    for (const field of ['workspaceMount', 'homeMount'] as const) {
      const docker = new DockerReplacement([])
      const actual = { ...request, [field]: { ...request[field], source } }
      await assert.rejects(new OwnedDeviceContainer(config, docker).captureContainer(actual), { code: 'container_mount_mismatch' })
      assert.deepEqual(docker.calls, [])
    }
  }
})

test('a later capture rereads both image and container and rejects observed pre-dispatch drift', async () => {
  for (const drift of ['image', 'mount', 'owner', 'restart'] as const) {
    const nextImage = drift === 'image' ? image({ Architecture: 'amd64' }) : image()
    const nextContainer = container(drift === 'mount' ? { Mounts: [{ ...mounts[0], RW: false }, mounts[1]] }
      : drift === 'owner' ? { Labels: { ...labels, [OWNED_DEVICE_CONTAINER_LABELS.creationId]: randomUUID() } } : { RestartCount: 1 })
    const docker = new DockerReplacement([image(), container(), nextImage, nextContainer])
    const containers = new OwnedDeviceContainer(config, docker)
    const before = await containers.captureContainer(request)
    await assert.rejects(containers.captureContainer(request))
    assert.deepEqual(before.inspection.State, state); assert.deepEqual(before.inspection.Mounts, mounts)
    assert.equal(docker.calls.length, drift === 'image' ? 3 : 4); assertReadOnly(docker)
  }
})
