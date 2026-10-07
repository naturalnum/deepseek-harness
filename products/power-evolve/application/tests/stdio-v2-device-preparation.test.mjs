/** Built-artifact tests with synthetic Docker responses; no daemon, private journal or execution runs. */
import assert from 'node:assert/strict'
import { randomUUID } from 'node:crypto'
import test from 'node:test'
import { StdioDevicePreparationV2 } from '../lib/device/stdio-v2-preparation.js'
import { OwnedDeviceContainer, OWNED_DEVICE_CONTAINER_LABELS, DockerCommandError } from '../lib/device/owned-container.js'
import { stdioTaskSchemasV2 } from '@power-evolve/contracts/stdio-mcp'
import { stdioCatalogFingerprintV2, stdioSha256V2 } from '@power-evolve/connector-runner/stdio-v2-digest'

const uuid = randomUUID, clone = value => JSON.parse(JSON.stringify(value))
const limits = { runtimeMs: 2000, requestMs: 1000, stdinGraceMs: 100, terminateGraceMs: 100, killGraceMs: 100,
  maxInputBytes: 65536, maxMessageBytes: 16384, maxProtocolBytes: 65536, maxProtocolMessages: 100,
  maxJsonDepth: 30, maxJsonNodes: 10000, maxPages: 4, maxTools: 10, maxCatalogBytes: 16384,
  maxToolBytes: 8192, maxResultBytes: 16384, maxStderrBytes: 4096 }
const budget = { maxDepth: limits.maxJsonDepth, maxNodes: limits.maxJsonNodes, maxBytes: limits.maxInputBytes }
const sha = (domain, value) => stdioSha256V2(domain, value, budget)
const config = { commandTimeoutMs: 2345, stopTimeoutMs: 1234, stopGraceSeconds: 2 }

function fixture(phase = 'discover') {
  const userId = uuid(), deviceId = uuid(), enrollmentId = uuid(), directoryId = uuid(), executionId = uuid(), processId = uuid()
  const pin = { kind: 'desktop', deploymentId: uuid(), protocolVersion: 2, platform: { os: 'linux', architecture: 'arm64' },
    configImageId: `sha256:${'a'.repeat(64)}` }
  const configuration = { name: 'Synthetic tools', invocation: { program: '/usr/bin/node', argv: ['server.mjs', '--label', '😀'], cwd: '.' } }
  const tools = [{ name: 'read_note', inputSchema: { type: 'object', properties: { path: { type: 'string' } } },
    annotations: { readOnlyHint: true }, extension: { retained: '保留\0😀' } },
  { name: 'write_note', inputSchema: { type: 'object', properties: { text: { type: 'string' } } }, _meta: { nested: [3, 1] } }]
  const image = { kind: 'desktop', platform: pin.platform, configImageId: pin.configImageId }
  const task = stdioTaskSchemasV2(limits).task.parse({ formatVersion: 2, actionId: uuid(), userId, sessionId: uuid(),
    connectionId: uuid(), configRevision: 2, configDigest: sha('configuration', configuration),
    scopeBinding: { kind: 'desktop', userId, deviceId, directoryId, enrollmentId, home: { kind: 'enrollment', enrollmentId } },
    expectedDeploymentPin: pin, invocation: configuration.invocation, limits, phase,
    origin: phase === 'discover' ? { kind: 'stdio_discovery', requestId: uuid() }
      : { kind: 'operation', operationId: uuid(), rootOperationId: uuid(), callKey: 'synthetic-call' },
    ...(phase === 'call' ? { selection: { catalogId: uuid(), catalogDigest: stdioCatalogFingerprintV2(tools, limits),
      rawCatalog: tools, catalogImageExpectation: image, rawName: 'write_note', rawDescriptor: tools[1],
      arguments: { text: 'exact\0正文😀', nested: { order: [false, null] } } } } : {}) })
  const receipt = { containerId: 'b'.repeat(64), imageId: pin.configImageId,
    owner: { deviceId, enrollmentId, executionId, creationId: uuid(), requestDigest: sha('task', task) } }
  const request = { receipt, pin, workspaceMount: { source: '/synthetic/private/project', destination: '/workspace', readOnly: false },
    homeMount: { source: '/synthetic/private/home', destination: '/home/agent', readOnly: false } }
  const labels = { [OWNED_DEVICE_CONTAINER_LABELS.schema]: '1', [OWNED_DEVICE_CONTAINER_LABELS.imageId]: receipt.imageId,
    ...Object.fromEntries(Object.entries(receipt.owner).map(([key, value]) => [OWNED_DEVICE_CONTAINER_LABELS[key], value])),
    'synthetic.extra': 'retained\0😀' }
  const inspection = { Id: receipt.containerId, Image: receipt.imageId, Labels: labels,
    State: { Running: false, ExitCode: 0, Status: 'created', StartedAt: '0001-01-01T00:00:00Z', FinishedAt: '0001-01-01T00:00:00Z',
      Pid: 0, Paused: false, OOMKilled: false, Error: '', extension: { all: 'unchanged' } },
    Mounts: [{ Type: 'bind', Source: request.homeMount.source, Destination: '/home/agent', RW: true, Mode: '', Propagation: 'rprivate' },
      { Type: 'tmpfs', Source: '', Destination: '/tmp', RW: true, Mode: '', Propagation: '' },
      { Type: 'bind', Source: request.workspaceMount.source, Destination: '/workspace', RW: true, Mode: '', Propagation: 'rprivate' }], RestartCount: 0,
    Config: { Labels: labels, Cmd: ['runner.mjs'], Entrypoint: ['node'], Env: ['LANG=C.UTF-8'], User: '1000:1000',
      WorkingDir: '/workspace', Tty: false, OpenStdin: true, extension: { full: 'preserved' } },
    HostConfig: { Binds: [`${request.workspaceMount.source}:/workspace`, `${request.homeMount.source}:/home/agent`],
      SecurityOpt: ['no-new-privileges'], CapDrop: ['ALL'], PidsLimit: 256, ReadonlyRootfs: false, NetworkMode: 'none',
      Tmpfs: { '/tmp': 'rw,noexec,nosuid' }, extension: { raw: [3, 1] } }, Path: 'node', Args: ['runner.mjs'] }
  const calls = []
  let imageOutput = { Id: receipt.imageId, Os: 'linux', Architecture: 'arm64' }, failure = null, truncated = false
  const docker = { async run(args, timeoutMs) {
    calls.push({ args: [...args], timeoutMs })
    assert.equal(args[1], 'inspect'); assert.equal(args[2], '--format'); assert.equal(args.length, 5)
    assert(['image', 'container'].includes(args[0])); assert.equal(timeoutMs, config.commandTimeoutMs)
    assert.equal(args[4], args[0] === 'image' ? request.pin.configImageId : request.receipt.containerId)
    if (failure) throw failure
    return { stdout: JSON.stringify(args[0] === 'image' ? imageOutput : inspection), stderr: '', outputTruncated: truncated }
  } }
  const containers = new OwnedDeviceContainer(config, docker), service = new StdioDevicePreparationV2(containers), ref = { kind: 'desktop', executionId }
  const capture = () => service.capture(task, ref, request, processId)
  return { task, ref, request, processId, containers, service, capture, calls, inspection, image,
    changeImage(value) { imageOutput = { ...imageOutput, ...value } }, fail(error) { failure = error }, truncate() { truncated = true } }
}

test('original discovery captures exact private owner/image/scope and complete inspection without start authority', async () => {
  const f = fixture(), before = JSON.stringify([f.task, f.ref, f.request]), prepared = await f.capture()
  assert.equal(prepared.actionId, f.task.actionId); assert.deepEqual(prepared.executionRef, f.ref)
  assert.equal(prepared.taskDigest, f.request.receipt.owner.requestDigest); assert.deepEqual(prepared.expectedDeploymentPin, f.request.pin)
  assert.deepEqual(prepared.actualExecutorImage, f.image); assert.deepEqual(prepared.capture.receipt, f.request.receipt)
  assert.equal(prepared.capture.directoryId, f.task.scopeBinding.directoryId); assert.equal(prepared.capture.processId, f.processId)
  assert.deepEqual(prepared.capture.workspaceMount, f.request.workspaceMount); assert.deepEqual(prepared.capture.homeMount, f.request.homeMount)
  assert.equal(prepared.fullScopeDigest, sha('scope', { scopeBinding: f.task.scopeBinding,
    workspaceMount: f.request.workspaceMount, homeMount: f.request.homeMount }))
  assert.equal(prepared.specDigest, sha('spec', { inspection: f.inspection, image: f.image }))
  assert.equal(JSON.stringify([f.task, f.ref, f.request]), before)
  for (const field of ['grantOnce', 'permit', 'startAuthorized', 'stopEvidence']) assert.equal(Object.hasOwn(prepared, field), false)
  assert.equal(f.calls.length, 2)
})

test('call keeps the full original task digest including raw tool metadata, arguments and revision', async () => {
  const f = fixture('call'), prepared = await f.capture()
  assert.equal(prepared.taskDigest, sha('task', f.task)); assert.equal(f.task.configRevision, 2)
  assert.equal(f.task.selection.arguments.text, 'exact\0正文😀')
  assert.deepEqual(f.task.selection.rawCatalog[0].extension, { retained: '保留\0😀' })
  assert.equal(f.calls.length, 2)
})

test('changed action/task/config/selection fields cannot update the original receipt digest', async () => {
  for (const mutate of [f => { f.task.actionId = uuid() }, f => { f.task.sessionId = uuid() }, f => { f.task.connectionId = uuid() },
    f => { f.task.configRevision++ }, f => { f.task.configDigest = 'c'.repeat(64) }, f => { f.task.invocation.argv.push('changed') },
    f => { f.task.origin.requestId = uuid() }, f => { f.task.limits.maxMessageBytes++ }]) {
    const f = fixture(); mutate(f)
    await assert.rejects(f.capture, /original_mismatch/u); assert.deepEqual(f.calls, [])
  }
  for (const mutate of [f => { f.task.selection.arguments.nested.order.reverse() },
    f => { f.task.selection.rawCatalog[0].extension.retained += 'changed' }, f => { f.task.origin.callKey += 'changed' }]) {
    const f = fixture('call'); mutate(f)
    await assert.rejects(f.capture, /original_mismatch/u); assert.deepEqual(f.calls, [])
  }
})

test('desktop target, original execution ref, device/enrollment and journal task digest must match before I/O', async () => {
  for (const mutate of [f => { f.ref.kind = 'cloud' }, f => { f.ref.executionId = uuid() },
    f => { f.request.receipt.owner.deviceId = uuid() }, f => { f.request.receipt.owner.enrollmentId = uuid() },
    f => { f.request.receipt.owner.executionId = uuid() }, f => { f.request.receipt.owner.requestDigest = 'c'.repeat(64) }]) {
    const f = fixture(); mutate(f)
    await assert.rejects(f.capture, /original_mismatch/u); assert.deepEqual(f.calls, [])
  }
  const f = fixture(); f.task.configRevision = 0
  await assert.rejects(f.capture); assert.deepEqual(f.calls, [])
})

test('invalid process ID rejects; the original journal establishes a valid process, not this UUID parser', async () => {
  const f = fixture()
  for (const process of ['not-a-process', '', null, true]) {
    await assert.rejects(() => f.service.capture(f.task, f.ref, f.request, process)); assert.deepEqual(f.calls, [])
  }
  const original = await f.capture(), other = await f.service.capture(f.task, f.ref, f.request, uuid())
  assert.equal(original.taskDigest, other.taskDigest); assert.notEqual(original.capture.processId, other.capture.processId)
  assert.notEqual(sha('prepared', original), sha('prepared', other))
  // The authorization service compares whole original Prepared/owner; this assembler issues neither start permission nor identity attestation.
})

test('trusted deployment ID/platform/image must exactly match the original frozen pin', async () => {
  for (const mutate of [f => { f.request.pin = { ...f.request.pin, deploymentId: uuid() } },
    f => { f.request.pin = { ...f.request.pin, platform: { os: 'linux', architecture: 'amd64' } } },
    f => { f.request.pin = { ...f.request.pin, configImageId: `sha256:${'c'.repeat(64)}` } },
    f => { f.request.receipt.imageId = `sha256:${'c'.repeat(64)}` }]) {
    const f = fixture(); mutate(f)
    await assert.rejects(f.capture, /original_mismatch/u); assert.deepEqual(f.calls, [])
  }
  const f = fixture(); f.request.pin.configImageId = 'mutable:tag'
  await assert.rejects(f.capture); assert.deepEqual(f.calls, [])
})

test('actual immutable image mismatch is refused by the original capture adapter', async () => {
  for (const image of [{ Id: `sha256:${'c'.repeat(64)}` }, { Os: 'windows' }, { Architecture: 'amd64' }]) {
    const f = fixture(); f.changeImage(image)
    await assert.rejects(f.capture, { code: 'image_identity_mismatch' }); assert.equal(f.calls.length, 1)
  }
})

test('actual container ID/image and every owner label still pass through exact original adapter checks', async () => {
  for (const mutate of [f => { f.inspection.Id = 'c'.repeat(64) }, f => { f.inspection.Image = `sha256:${'c'.repeat(64)}` },
    ...Object.values(OWNED_DEVICE_CONTAINER_LABELS).map(key => f => { f.inspection.Labels[key] = 'wrong' }),
    f => { f.request.receipt.owner.creationId = uuid() }]) {
    const f = fixture(); mutate(f)
    await assert.rejects(f.capture, { code: 'container_identity_mismatch' }); assert.equal(f.calls.length, 2)
  }
})

test('both private mount sources require canonical paths, fixed destinations and observed writable binds', async () => {
  for (const field of ['workspaceMount', 'homeMount']) {
    for (const source of ['relative', '/synthetic/../private/project', '/synthetic/private/\nproject']) {
      const f = fixture(); f.request[field].source = source
      await assert.rejects(f.capture, { code: 'container_mount_mismatch' }); assert.deepEqual(f.calls, [])
    }
    const f = fixture(); f.request[field].source += '-foreign'
    await assert.rejects(f.capture, { code: 'container_mount_mismatch' }); assert.equal(f.calls.length, 2)
    for (const patch of [{ readOnly: true }, { destination: '/foreign' }]) {
      const g = fixture(); Object.assign(g.request[field], patch)
      await assert.rejects(g.capture); assert.deepEqual(g.calls, [])
    }
  }
})

test('running/restarted containers, duplicate mounts and an additional writable scope remain refused', async () => {
  for (const mutate of [f => { f.inspection.State.Running = true }, f => { f.inspection.State.Status = 'exited' },
    f => { f.inspection.RestartCount = 1 }, f => { f.inspection.Mounts.push(clone(f.inspection.Mounts[0])) },
    f => { f.inspection.Mounts.push({ ...f.inspection.Mounts[0], Destination: '/extra' }) },
    f => { f.inspection.Mounts[0].RW = false }]) {
    const f = fixture(); mutate(f)
    await assert.rejects(f.capture, /container_not_created|container_restarted|container_mount_mismatch/u)
    assert.equal(f.calls.length, 2)
  }
})

test('spec digest covers full Config/HostConfig/Path/Args and State/Mounts/Labels without projection', async () => {
  const f = fixture(), original = await f.capture()
  for (const mutate of [g => { g.inspection.State.extension.all = 'changed' },
    g => { g.inspection.Mounts[0].Propagation = 'private' }, g => { g.inspection.Labels['synthetic.extra'] = 'changed' },
    g => { g.inspection.Config.extension.full = 'changed' }, g => { g.inspection.HostConfig.PidsLimit++ },
    g => { g.inspection.HostConfig.extension.raw.reverse() }, g => { g.inspection.Path = 'other' },
    g => { g.inspection.Args.push('--changed') }]) {
    const g = fixture(); mutate(g); const prepared = await g.capture()
    assert.equal(prepared.specDigest, sha('spec', { inspection: g.inspection, image: g.image }))
    // Compare the same original observation before/after a nonprojected field changes.
    const observed = clone(f.inspection); mutate({ inspection: observed })
    assert.notEqual(sha('spec', { inspection: observed, image: f.image }), original.specDigest)
  }
})

test('alternating Docker mount order keeps Prepared stable without changing raw observations or other arrays', async () => {
  for (const withTmpfs of [false, true]) {
    const f = fixture('call'), observations = [], originalTask = JSON.stringify(f.task)
    if (!withTmpfs) f.inspection.Mounts = f.inspection.Mounts.filter(mount => mount.Type !== 'tmpfs')
    const service = new StdioDevicePreparationV2({ async captureContainer(request) {
      const observed = await f.containers.captureContainer(request)
      observations.push({ observed, bytes: JSON.stringify(observed) })
      Object.freeze(observed.inspection.Mounts)
      return observed
    } })
    const capture = () => service.capture(f.task, f.ref, f.request, f.processId), first = await capture()
    f.inspection.Mounts.reverse()
    assert.deepEqual(await capture(), first)
    f.inspection.Mounts.reverse()
    assert.deepEqual(await capture(), first)
    assert.notEqual(observations[0].bytes, observations[1].bytes)
    for (const { observed, bytes } of observations) assert.equal(JSON.stringify(observed), bytes)
    assert.equal(JSON.stringify(f.task), originalTask); assert.equal(f.calls.length, 6)
  }
})

test('mount set ordering retains Source/RW and every raw metadata field; scope changes still fail the actual adapter', async () => {
  for (const mutate of [f => { f.inspection.Mounts[0].Source += '-foreign' }, f => { f.inspection.Mounts[0].RW = false },
    f => { f.inspection.Mounts[0].Propagation = 'private' }, f => { f.inspection.Mounts[0].extension = { raw: [3, 1] } }]) {
    const f = fixture(), first = await f.capture()
    mutate(f)
    // Isolate the assembler's full digest input; its real adapter separately rejects changed bind permissions/sources.
    const assembler = new StdioDevicePreparationV2({ async captureContainer() { return { inspection: f.inspection, image: f.image } } })
    assert.notEqual((await assembler.capture(f.task, f.ref, f.request, f.processId)).specDigest, first.specDigest)
    if (f.inspection.Mounts[0].Source !== f.request.homeMount.source || !f.inspection.Mounts[0].RW) {
      await assert.rejects(f.capture, { code: 'container_mount_mismatch' })
    } else assert.notEqual((await f.capture()).specDigest, first.specDigest)
  }
})

test('missing full execution configuration cannot be hashed as an observed container spec', async () => {
  for (const field of ['Config', 'HostConfig', 'Path', 'Args']) {
    const f = fixture(); delete f.inspection[field]
    await assert.rejects(f.capture, { code: 'container_inspection_unavailable' }); assert.equal(f.calls.length, 2)
  }
})

test('frozen task limits bound both complete original JSON and complete observed spec without truncating', async () => {
  const f = fixture(); f.task.limits.maxInputBytes = 10
  await assert.rejects(f.capture); assert.deepEqual(f.calls, [])
  const g = fixture(); g.inspection.State.extension.all = 'x'.repeat(limits.maxInputBytes)
  await assert.rejects(g.capture, /stdio_v2_json_bytes_limit/u); assert.equal(g.calls.length, 2)
})

test('unavailable/truncated capture fails without adoption, writer mutation, or any start/cleanup calls', async () => {
  for (const failure of ['truncated', 'unavailable']) {
    const f = fixture(), before = JSON.stringify([f.task, f.ref, f.request])
    if (failure === 'truncated') f.truncate(); else f.fail(new DockerCommandError('docker_command_failed'))
    await assert.rejects(f.capture, { code: 'image_unavailable' })
    assert.equal(JSON.stringify([f.task, f.ref, f.request]), before); assert.equal(f.calls.length, 1)
  }
})

test('each capture rereads the original image/container and never renews the original task digest', async () => {
  const f = fixture(), first = await f.capture(), second = await f.capture()
  assert.deepEqual(second, first); assert.equal(f.calls.length, 4)
  f.inspection.Labels[OWNED_DEVICE_CONTAINER_LABELS.creationId] = uuid()
  await assert.rejects(f.capture, { code: 'container_identity_mismatch' }); assert.equal(f.calls.length, 6)
  assert.equal(first.taskDigest, f.request.receipt.owner.requestDigest)
})
