/** Opt-in real Docker inspection of a private never-started container; no App, journal or user project is touched. */
import assert from 'node:assert/strict'
import test from 'node:test'
import { randomUUID } from 'node:crypto'
import { mkdtemp, mkdir, realpath, rm } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { OwnedDeviceContainer, ScrubbedDockerClient, ownedContainerOwner } from '../lib/device/owned-container.js'
import { StdioDevicePreparationV2 } from '../lib/device/stdio-v2-preparation.js'
import { stdioDeviceDeploymentV2, stdioExecutionRefV2, stdioTaskSchemasV2 } from '@power-evolve/contracts/stdio-mcp'
import { stdioSha256V2 } from '@power-evolve/connector-runner/stdio-v2-digest'

const imageReference = process.env.PE_STDIO_CAPTURE_IMAGE
const limits = { runtimeMs: 10000, requestMs: 2000, stdinGraceMs: 100, terminateGraceMs: 100, killGraceMs: 1000,
  maxInputBytes: 262144, maxMessageBytes: 16384, maxProtocolBytes: 262144, maxProtocolMessages: 100,
  maxJsonDepth: 40, maxJsonNodes: 10000, maxPages: 4, maxTools: 10, maxCatalogBytes: 32768,
  maxToolBytes: 16384, maxResultBytes: 16384, maxStderrBytes: 4096 }
const budget = { maxDepth: limits.maxJsonDepth, maxNodes: limits.maxJsonNodes, maxBytes: limits.maxInputBytes }
const sha = (domain, value) => stdioSha256V2(domain, value, budget)

test('real Docker supplies complete immutable Device preparation without starting its user program', {
  timeout: 30000, skip: !imageReference && 'Set PE_STDIO_CAPTURE_IMAGE to an already-local operator-selected image',
}, async () => {
  const docker = new ScrubbedDockerClient(), commands = [], inspections = []
  const transport = { async run(args, timeoutMs) {
    commands.push([...args])
    const result = await docker.run(args, timeoutMs)
    if (args[0] === 'container' && args[1] === 'inspect' && args[3]?.includes('HostConfig')) inspections.push(JSON.parse(result.stdout))
    return result
  } }
  const containers = new OwnedDeviceContainer({ commandTimeoutMs: 5000, stopTimeoutMs: 5000, stopGraceSeconds: 1 }, transport)
  const root = await mkdtemp(join(await realpath(tmpdir()), 'pe-stdio-capture-'))
  let receipt, creationAttempted = false
  try {
    const workspace = join(root, 'workspace'), home = join(root, 'home')
    await mkdir(workspace, { mode: 0o700 }); await mkdir(home, { mode: 0o700 })
    const imageId = await containers.resolveImage(imageReference)
    const rawImage = await docker.run(['image', 'inspect', '--format', '{"Os":{{json .Os}},"Architecture":{{json .Architecture}}}', imageId], 5000)
    assert(!rawImage.outputTruncated)
    const actual = JSON.parse(rawImage.stdout)
    const pin = stdioDeviceDeploymentV2.parse({ kind: 'desktop', deploymentId: randomUUID(), protocolVersion: 2,
      platform: { os: actual.Os, architecture: actual.Architecture }, configImageId: imageId })
    const deviceId = randomUUID(), enrollmentId = randomUUID(), processId = randomUUID(), executionId = randomUUID(), userId = randomUUID()
    const invocation = { program: 'node', argv: ['never-started.mjs', 'literal argument'], cwd: '.' }
    const task = stdioTaskSchemasV2(limits).task.parse({ formatVersion: 2, actionId: randomUUID(), userId,
      sessionId: randomUUID(), connectionId: randomUUID(), configRevision: 1, configDigest: sha('configuration', { name: 'Capture QA', invocation }),
      scopeBinding: { kind: 'desktop', userId, deviceId, enrollmentId, directoryId: randomUUID(),
        home: { kind: 'enrollment', enrollmentId } }, expectedDeploymentPin: pin,
      invocation, limits,
      phase: 'discover', origin: { kind: 'stdio_discovery', requestId: randomUUID() },
    })
    const owner = ownedContainerOwner.parse({ deviceId, enrollmentId, executionId, creationId: randomUUID(), requestDigest: sha('task', task) })
    creationAttempted = true
    receipt = await containers.create({ name: `pe-stdio-capture-${executionId}`, owner, imageId,
      options: ['--network', 'none', '--read-only', '--tmpfs', '/tmp:rw,nosuid,size=64m', '--cap-drop', 'ALL',
        '--security-opt', 'no-new-privileges', '--pids-limit', '128', '--memory', '128m', '--cpus', '0.1', '--user', '1000:1000',
        '--mount', `type=bind,source=${workspace},target=/workspace`, '--mount', `type=bind,source=${home},target=/home/agent`,
        '--env', 'HOME=/home/agent', '--env', 'PATH=/usr/local/bin:/usr/bin:/bin', '--env', 'LANG=C.UTF-8',
        '--workdir', '/workspace', '--entrypoint', '/usr/bin/node'], command: ['/never-started.mjs'] })
    const request = { receipt, pin, workspaceMount: { source: workspace, destination: '/workspace', readOnly: false },
      homeMount: { source: home, destination: '/home/agent', readOnly: false } }
    const adapter = new StdioDevicePreparationV2(containers), ref = stdioExecutionRefV2.parse({ kind: 'desktop', executionId })
    const prepared = await adapter.capture(task, ref, request, processId)
    const repeated = await adapter.capture(task, ref, request, processId)
    function differences(left, right, path = '') {
      if (JSON.stringify(left) === JSON.stringify(right)) return []
      if (left && right && typeof left === 'object' && typeof right === 'object') {
        return [...new Set([...Object.keys(left), ...Object.keys(right)])].flatMap(key => differences(left[key], right[key], `${path}/${key}`))
      }
      return [path]
    }
    assert.equal(repeated.specDigest, prepared.specDigest, `Actual inspect changed fields: ${differences(inspections[0], inspections[1]).join(',')}`)
    assert.deepEqual(repeated, prepared)
    assert.equal(prepared.taskDigest, owner.requestDigest); assert.equal(prepared.capture.actualContainerId, receipt.containerId)
    const observed = await containers.captureContainer(request)
    const mounts = observed.inspection.Mounts.toSorted((left, right) => left.Destination < right.Destination ? -1 : left.Destination > right.Destination ? 1 : 0)
    assert.equal(prepared.specDigest, sha('spec', { inspection: { ...observed.inspection, Mounts: mounts }, image: observed.image }))
    assert.equal(observed.inspection.Config.User, '1000:1000'); assert.equal(observed.inspection.Config.WorkingDir, '/workspace')
    assert.deepEqual(observed.inspection.Config.Entrypoint, ['/usr/bin/node']); assert.deepEqual(observed.inspection.Config.Cmd, ['/never-started.mjs'])
    assert.equal(observed.inspection.HostConfig.ReadonlyRootfs, true); assert.equal(observed.inspection.HostConfig.NetworkMode, 'none')
    assert.equal(observed.inspection.HostConfig.PidsLimit, 128); assert(observed.inspection.HostConfig.CapDrop.includes('ALL'))
    assert(observed.inspection.HostConfig.SecurityOpt.includes('no-new-privileges'))
    assert.equal(observed.inspection.State.Status, 'created'); assert.equal(observed.inspection.State.Running, false)
    await assert.rejects(adapter.capture(task, ref, { ...request, workspaceMount: { ...request.workspaceMount, source: home } }, processId),
      error => error.code === 'container_mount_mismatch')
    assert(commands.every(args => args[0] === 'create' || args[1] === 'inspect'))
  } finally {
    // Exact immutable identity and ordinary rm only; a changed/running container is retained for diagnosis.
    if (receipt) await containers.remove(receipt)
    if (receipt || !creationAttempted) await rm(root, { recursive: true })
  }
})
