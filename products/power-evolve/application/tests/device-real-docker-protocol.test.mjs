/** Opt-in real PG, Docker and public Worker integration; HTTP faults are injected, no Agent or Electron is launched. */
import assert from 'node:assert/strict'
import test from 'node:test'
import { createServer } from 'node:http'
import { fork } from 'node:child_process'
import { chmod, copyFile, lstat, mkdir, mkdtemp, readFile, readdir, realpath, rm, writeFile } from 'node:fs/promises'
import { join } from 'node:path'
import { tmpdir } from 'node:os'
import { setTimeout as delay } from 'node:timers/promises'
import { createHash, randomUUID } from 'node:crypto'
import { Readable } from 'node:stream'
import { unzipSync, zipSync } from 'fflate'
import { DesktopWorker } from '../lib/device/worker.js'
import { OwnedDeviceContainer, ScrubbedDockerClient } from '../lib/device/owned-container.js'
import { DeviceService } from '../lib/platform/devices.js'
import { FileService } from '../lib/platform/files.js'
import { IdentityService } from '../lib/platform/identity.js'
import { SkillService } from '../lib/platform/skills.js'
import { encodeOfficeCommand } from '../lib/host/office.js'
import { routeExecutionResolutionApproval } from '../lib/platform/execution-resolution-routes.js'
import { deviceClaimRequest, deviceContainerRegistration, deviceFinishRequest, deviceClaimClosureRequest,
  deviceMaterialRequest } from '@power-evolve/contracts/device-execution'
import { deviceProtocolFixture } from './device-execution-protocol-fixture.mjs'
import { taskCredential } from './task-credential-fixture.mjs'

const image = process.env.PE_DEVICE_TEST_IMAGE
const options = { timeout: 60000, skip: !image || !['darwin', 'linux'].includes(process.platform) }
const hash = bytes => createHash('sha256').update(bytes).digest('hex')
const materialBinary = Buffer.from([0, 255, 13, 10, 128, 1, 254])
async function until(condition, label) {
  const deadline = Date.now() + 20000
  while (!await condition()) {
    if (Date.now() >= deadline) throw new Error(`Device integration deadline: ${label}`)
    await delay(50)
  }
}

async function cleanupRoot(root) {
  const writable = async path => {
    const stat = await lstat(path)
    if (!stat.isDirectory() || stat.isSymbolicLink()) return
    await chmod(path, 0o700)
    for (const entry of await readdir(path, { withFileTypes: true })) if (entry.isDirectory()) await writable(join(path, entry.name))
  }
  await writable(root)
  await rm(root, { recursive: true, force: true })
}

async function fixture(t, loseRegistrationAck = false, commandTimeoutMs = 1234, loseClaimAck = false, loseResolutionAck = false,
  keepClaimAckLost = false, loseClaimClosureAck = false) {
  const root = await mkdtemp(join(await realpath(tmpdir()), 'pe-device-real-'))
  const project = join(root, 'project'), privateRoot = join(root, 'private')
  await mkdir(project, { mode: 0o777 }); await chmod(project, 0o777)
  const docker = new ScrubbedDockerClient(), dockerCalls = []
  const containers = new OwnedDeviceContainer({ commandTimeoutMs: 15000, stopTimeoutMs: 10000, stopGraceSeconds: 1 }, {
    run: async (args, timeoutMs) => { dockerCalls.push(args[0]); return docker.run(args, timeoutMs) },
  })
  const receipts = new Map(), mounts = new Map(), workers = []
  let server, origin, lost = false, lostClosure = false, lostClaimClosure = false, lastFinish, lostClaimExecutionId
  let beforeMaterial
  let allowClaimClosureAck = !loseClaimClosureAck
  t.after(async () => {
    await Promise.all(workers.map(worker => worker.close()))
    server?.closeAllConnections()
    if (server) await new Promise(resolve => server.close(resolve))
    for (const receipt of receipts.values()) {
      const state = await containers.inspect(receipt)
      if (state?.Running) await containers.stop(receipt)
      if (await containers.inspect(receipt)) await containers.remove(receipt)
    }
    await cleanupRoot(root)
  })
  const platform = await deviceProtocolFixture(t)
  const files = new FileService(platform.pool, join(root, 'cloud'), undefined,
    { executable: '/usr/bin/python3', timeoutMs: 3000 })
  await files.init()
  const skills = new SkillService(platform.pool, join(root, 'cloud'), join(root, 'skill-private'))
  await skills.init()
  platform.devices = new DeviceService(platform.tasks, commandTimeoutMs, files, skills)
  const identities = new IdentityService(platform.pool, 3600000)
  async function route(req, res) {
    let text = ''
    for await (const bytes of req) { text += bytes; if (text.length > 524288) throw new Error('request_too_large') }
    const input = JSON.parse(text), token = req.headers.authorization?.replace(/^Bearer /u, '') ?? ''
    let reply
    if (req.url.startsWith('/approvals/executions/')) {
      const user = await identities.authenticate(token, 'approval')
      reply = await routeExecutionResolutionApproval(null, req.url, user, input, token,
        req.headers.origin, origin, platform.devices)
      if (req.url === '/approvals/executions/resolve' && loseResolutionAck && !lostClosure) {
        lostClosure = true; res.destroy(); return
      }
      res.writeHead(200, { 'content-type': 'application/json' }).end(JSON.stringify(reply)); return
    }
    switch (req.url) {
      case '/devices/enroll': reply = await platform.devices.enroll(input.code, input.name, input.instanceId); break
      case '/devices/agent/directory': reply = await platform.devices.directory(token, input.label); break
      case '/devices/agent/jobs': reply = await platform.devices.jobs(token, input.instanceId); break
      case '/devices/agent/files/read': reply = await platform.devices.readCloud(token, input.directoryId, input.path); break
      case '/devices/agent/files/put': reply = await platform.devices.putCloud(token, input.directoryId, input.requestId, input.path, input.data); break
      case '/devices/agent/material':
        await beforeMaterial?.()
        reply = await platform.devices.material(token, deviceMaterialRequest.parse(input)); break
      case '/devices/agent/claim': {
        const value = deviceClaimRequest.parse(input)
        reply = await platform.devices.claim(token, value.instanceId, value.executionId, value.processId)
        if (loseClaimAck && (!lost || keepClaimAckLost && value.executionId === lostClaimExecutionId)) {
          lost = true; lostClaimExecutionId = value.executionId; res.destroy(); return
        }
        break
      }
      case '/devices/agent/claim/close': {
        reply = await platform.devices.closeUnstartedClaim(token, deviceClaimClosureRequest.parse(input))
        if (!allowClaimClosureAck) { lostClaimClosure = true; res.destroy(); return }
        break
      }
      case '/devices/agent/register': {
        const value = deviceContainerRegistration.parse(input)
        receipts.set(value.receipt.containerId, value.receipt)
        mounts.set(value.receipt.containerId, JSON.parse((await docker.run(['inspect', '--format', '{{json .Mounts}}', value.receipt.containerId], 5000)).stdout))
        reply = await platform.devices.register(token, value)
        if (loseRegistrationAck && !lost) { lost = true; res.destroy(); return }
        break
      }
      case '/devices/agent/registered': reply = await platform.devices.registered(token, deviceContainerRegistration.parse(input)); break
      case '/devices/agent/finish': {
        lastFinish = deviceFinishRequest.parse(input)
        reply = await platform.devices.finish(token, lastFinish); break
      }
      default: res.writeHead(404).end('{}'); return
    }
    res.writeHead(200, { 'content-type': 'application/json' }).end(JSON.stringify(reply))
  }
  server = createServer((req, res) => { void route(req, res).catch(error => {
    if (!res.destroyed) res.writeHead(error.status ?? 500, { 'content-type': 'application/json' }).end(JSON.stringify({ error: error.code ?? 'fixture_failure' }))
  }) })
  await new Promise(resolve => server.listen(0, '127.0.0.1', resolve))
  origin = `http://127.0.0.1:${server.address().port}`
  const makeWorker = async privateDirectory => {
    const worker = new DesktopWorker(origin, privateDirectory, image,
      { pollMs: 100, contactGraceMs: 5000, commandPollMs: 50, platformRequestTimeoutMs: 3000,
        coordinationRoot: join(root, 'writers'), pythonExecutable: '/usr/bin/python3', fileOperationTimeoutMs: 3000 }, containers)
    workers.push(worker); await worker.init()
    return worker
  }
  const makeDevice = async (user, directory, privateDirectory = join(root, randomUUID())) => {
    const worker = await makeWorker(privateDirectory)
    const pair = await platform.devices.pair(user, await taskCredential(platform.pool, user))
    await worker.pair(pair.code, 'Real Docker test Device')
    const grant = await worker.authorize(directory)
    const state = JSON.parse(await readFile(join(privateDirectory, 'device.json'), 'utf8'))
    const device = { deviceId: state.deviceId, directoryId: grant.directoryId, instanceId: state.instanceId, token: state.token }
    return { worker, device, privateRoot: privateDirectory }
  }
  const { worker, device } = await makeDevice(platform.alice, project, privateRoot)
  const op = await platform.operation(platform.alice, device)
  const approval = async (path, input, token, selectedOrigin = origin) => {
    const response = await fetch(origin + path, { method: 'POST', headers: {
      'content-type': 'application/json', authorization: `Bearer ${token}`, origin: selectedOrigin,
    }, body: JSON.stringify(input), signal: AbortSignal.timeout(5000) })
    return { status: response.status, body: await response.json() }
  }
  return { ...platform, worker, device, project, privateRoot, origin, containers, op, files, skills, makeDevice, makeWorker,
    root, mounts, beforeMaterial: hook => { beforeMaterial = hook },
    trackReceipt: receipt => { receipts.set(receipt.containerId, receipt) },
    approval, dockerCalls, lastFinish: () => lastFinish, lost: () => lost, lostClosure: () => lostClosure,
    lostClaimClosure: () => lostClaimClosure, releaseClaimClosureAck: () => { allowClaimClosureAck = true } }
}

async function uploadMaterial(f, user, version, marker) {
  const entries = {
    'device-material/SKILL.md': Buffer.from('---\nname: device-material\ndescription: Read the pinned local fixture\n---\nRun scripts/read.py with desktop_exec.\n'),
    'device-material/skill-package.json': Buffer.from(JSON.stringify({ schemaVersion: 1, version })),
    'device-material/scripts/read.py': Buffer.from(`from pathlib import Path\np = Path(__file__).parent\nassert p.joinpath('data.bin').read_bytes() == bytes([0, 255, 13, 10, 128, 1, 254])\nprint(${JSON.stringify(marker)})\n`),
    'device-material/scripts/data.bin': materialBinary,
  }
  const archive = Buffer.from(zipSync(entries, { level: 9, mtime: '2020-01-01T00:00:00.000Z' }))
  const ticket = await f.skills.issueUploadTicket(user, randomUUID(), archive.length, hash(archive), f.origin)
  return (await f.skills.upload(ticket.ticket, Readable.from([archive]))).item
}

async function executeCommand(f, operation, worker, privateRoot, callId, command) {
  await f.tasks.renew(operation.grant.token)
  const receipt = await f.devices.propose(operation.grant.token, callId, command, '')
  worker.start()
  await until(async () => (await f.row(receipt.executionId)).stop_observation !== null, 'material command stop')
  await until(async () => JSON.parse(await readFile(join(privateRoot, 'journal.json'), 'utf8')).length === 0, 'material command cleanup')
  const row = await f.row(receipt.executionId)
  assert.equal(row.state, 'succeeded', row.result?.stderr)
  assert.equal(row.result.exitCode, 0)
  assert.equal(await f.continuations(receipt.executionId), 1)
  assert.equal(await f.containers.inspect(row.container_receipt), null)
  return row
}

test('real Device executes pinned binary package bytes with a read-only mount and retains an isolated Home across restart', options, async t => {
  const f = await fixture(t, false, 15000)
  const first = await uploadMaterial(f, f.alice, '1.0.0', 'ALICE-PINNED-ONE')
  const operation = await f.operation(f.alice, f.device)
  const latest = await uploadMaterial(f, f.alice, '2.0.0', 'ALICE-LATEST-TWO')
  const base = `/opt/power-evolve/skills/sha256/${first.packageDigest}/skill`
  const command = `set -eu; test "$HOME" = /home/agent; python3 ${base}/scripts/read.py; printf 'alice-home\n' > "$HOME/remember.txt"; if printf bad > ${base}/scripts/data.bin; then exit 51; fi; test ! -e /opt/power-evolve/skills/sha256/${latest.packageDigest}; printf 'HOME=%s\n' "$HOME"`
  const original = await executeCommand(f, operation, f.worker, f.privateRoot, 'pinned-first', command)
  assert.match(original.result.stdout, /ALICE-PINNED-ONE/u)
  assert.doesNotMatch(original.result.stdout, /ALICE-LATEST-TWO/u)
  assert.match(original.result.stdout, /HOME=\/home\/agent/u)
  assert.deepEqual(original.dispatch_request.materials.map(binding => binding.version), ['1.0.0'])
  const mounted = f.mounts.get(original.container_receipt.containerId)
  assert.deepEqual(mounted.map(mount => mount.Destination).sort(), ['/workspace', '/home/agent', base.slice(0, -'/skill'.length)].sort())
  assert.equal(mounted.find(mount => mount.Destination === base.slice(0, -'/skill'.length)).RW, false)
  assert.equal(mounted.find(mount => mount.Destination === '/home/agent').Source, join(f.privateRoot, 'execution-homes', f.device.instanceId))
  assert.equal(await readFile(join(f.privateRoot, 'execution-homes', f.device.instanceId, 'remember.txt'), 'utf8'), 'alice-home\n')
  await f.worker.close()
  const restarted = await f.makeWorker(f.privateRoot)
  const restored = await executeCommand(f, operation, restarted, f.privateRoot, 'pinned-after-restart',
    `set -eu; test "$HOME" = /home/agent; test "$(cat "$HOME/remember.txt")" = alice-home; python3 ${base}/scripts/read.py`)
  assert.match(restored.result.stdout, /ALICE-PINNED-ONE/u)
  const secondPackage = await uploadMaterial(f, f.bob, '1.0.0', 'BOB-PRIVATE-ONE')
  const bobProject = join(f.root, 'bob-project'); await mkdir(bobProject, { mode: 0o700 })
  const bob = await f.makeDevice(f.bob, bobProject)
  const bobOp = await f.operation(f.bob, bob.device)
  const bobBase = `/opt/power-evolve/skills/sha256/${secondPackage.packageDigest}/skill`
  const bobRow = await executeCommand(f, bobOp, bob.worker, bob.privateRoot, 'bob-private',
    `set -eu; test ! -e "$HOME/remember.txt"; test ! -e ${base}; python3 ${bobBase}/scripts/read.py; printf 'bob-home\n' > "$HOME/remember.txt"`)
  assert.match(bobRow.result.stdout, /BOB-PRIVATE-ONE/u)
  assert.equal(await readFile(join(bob.privateRoot, 'execution-homes', bob.device.instanceId, 'remember.txt'), 'utf8'), 'bob-home\n')
  assert.equal(await readFile(join(f.privateRoot, 'execution-homes', f.device.instanceId, 'remember.txt'), 'utf8'), 'alice-home\n')
  assert.equal(bobRow.dispatch_request.materials[0].skillId, secondPackage.skillId)
  const claim = original.container_receipt.owner
  await assert.rejects(f.devices.material(bob.device.token, { instanceId: f.device.instanceId,
    executionId: original.id, processId: original.dispatch_process_id, dispatchId: claim.creationId,
    digest: claim.requestDigest, skillId: first.skillId }), { code: 'execution_not_found' })
})

test('cancelling a real Worker material request seals the original claim before Docker creation', options, async t => {
  const f = await fixture(t, false, 15000)
  await uploadMaterial(f, f.alice, '1.0.0', 'NEVER-RUN')
  const operation = await f.operation(f.alice, f.device)
  let entered = false, release
  const gate = new Promise(resolve => { release = resolve })
  t.after(() => release())
  f.beforeMaterial(async () => { entered = true; await gate })
  const receipt = await f.devices.propose(operation.grant.token, 'cancel-material', "printf 'MUST-NOT-RUN' > forbidden.txt", '')
  f.worker.start()
  await until(() => entered, 'material request arrival')
  const closing = f.worker.close()
  release()
  await closing
  const restarted = await f.makeWorker(f.privateRoot); restarted.start()
  await until(async () => (await f.row(receipt.executionId)).error_code === 'device_claim_closed_without_start', 'claim permanently fenced')
  await until(async () => JSON.parse(await readFile(join(f.privateRoot, 'journal.json'), 'utf8')).length === 0, 'cancelled material journal cleanup')
  assert.equal(f.dockerCalls.filter(call => call === 'create').length, 0)
  assert.equal(f.dockerCalls.filter(call => call === 'start').length, 0)
  const row = await f.row(receipt.executionId)
  assert.equal(row.container_receipt, null); assert.equal(row.start_authorized_at, null)
  assert.equal(row.result, null); assert.equal(row.stop_observation, null)
  await assert.rejects(readFile(join(f.project, 'forbidden.txt')), { code: 'ENOENT' })
  assert.equal(await f.continuations(receipt.executionId), 1)
})

test('real Device Office creates three editable formats and renders their saved local bytes', options, async t => {
  const f = await fixture(t, false, 15000)
  const catalog = await f.skills.catalog(f.alice)
  for (const id of ['builtin.word', 'builtin.excel', 'builtin.powerpoint']) {
    const release = catalog.items.find(item => item.id === id)
    assert.equal(release.version, '1.0.2')
    await f.skills.installBuiltin(f.alice, randomUUID(), id, release.version)
  }
  const operation = await f.operation(f.alice, f.device)
  const docx = '/workspace/device-word.docx', xlsx = '/workspace/device-excel.xlsx', pptx = '/workspace/device-slides.pptx'
  const commands = [
    'load_skill word',
    `create ${docx}`,
    `batch ${docx} --commands '${JSON.stringify([{ command: 'add', parent: '/body', type: 'p', props: { text: 'Device Office Word QA', size: '18pt', bold: 'true' } },
      { command: 'add', parent: '/body', type: 'p', props: { text: 'Saved local editable document.' } }])}'`,
    `validate ${docx}`,
    `create ${xlsx}`,
    `add ${xlsx} / --type sheet --prop name=QA`,
    `batch ${xlsx} --commands '${JSON.stringify([{ command: 'set', path: '/QA/A1', props: { value: '18' } },
      { command: 'set', path: '/QA/A2', props: { value: '24' } },
      { command: 'set', path: '/QA/A3', props: { formula: 'SUM(A1:A2)' } }])}'`,
    `validate ${xlsx}`,
    `create ${pptx}`,
    `batch ${pptx} --commands '${JSON.stringify([{ command: 'add', parent: '/', type: 'slide' },
      { command: 'add', parent: '/slide[1]', type: 'shape', props: { text: 'Device Office PPT QA', x: '2cm', y: '2cm', width: '20cm', height: '3cm', size: '24pt' } }])}'`,
    `validate ${pptx}`,
  ]
  const executions = []
  for (const [index, command] of commands.entries()) {
    const row = await executeCommand(f, operation, f.worker, f.privateRoot, `device-office-${index}`, encodeOfficeCommand(command))
    executions.push(row.id)
    assert.equal(row.dispatch_request.materials.length, 3)
    assert(row.dispatch_request.materials.every(binding => binding.version === '1.0.2'))
    if (index === 0) assert.match(row.result.stdout, /PowerEvolve Office runtime constraint/u)
  }
  const xml = async (name, path) => Buffer.from(unzipSync(await readFile(join(f.project, name)))[path]).toString('utf8')
  assert.match(await xml('device-word.docx', 'word/document.xml'), /Device Office Word QA/u)
  assert.match(await xml('device-excel.xlsx', 'xl/worksheets/sheet2.xml'), /<(?:\w+:)?f>SUM\(A1:A2\)<\/(?:\w+:)?f>/u)
  assert.match(await xml('device-slides.pptx', 'ppt/slides/slide1.xml'), /Device Office PPT QA/u)
  const render = 'set -eu; mkdir /workspace/previews; libreoffice -env:UserInstallation=file:///tmp/device-office-lo --headless --convert-to pdf --outdir /workspace/previews /workspace/device-word.docx /workspace/device-excel.xlsx /workspace/device-slides.pptx; for name in device-word device-excel device-slides; do test -s /workspace/previews/$name.pdf; pdfinfo /workspace/previews/$name.pdf; pdftotext -layout /workspace/previews/$name.pdf /workspace/previews/$name.txt; pdftoppm -f 1 -singlefile -png -r 72 /workspace/previews/$name.pdf /workspace/previews/$name; done'
  const rendered = await executeCommand(f, operation, f.worker, f.privateRoot, 'device-office-render', render)
  executions.push(rendered.id)
  assert.match(await readFile(join(f.project, 'previews/device-word.txt'), 'utf8'), /Device Office Word QA/u)
  assert.match(await readFile(join(f.project, 'previews/device-excel.txt'), 'utf8'), /42/u)
  assert.match(await readFile(join(f.project, 'previews/device-slides.txt'), 'utf8'), /Device Office PPT QA/u)
  const formats = ['device-word.docx', 'device-excel.xlsx', 'device-slides.pptx']
  for (const path of formats) {
    const local = await readFile(join(f.project, path))
    const exported = await f.worker.exportFile(f.device.directoryId, path, `device-output/${path}`, randomUUID())
    assert.equal(exported.revision, hash(local))
    const cloud = await f.files.read(f.alice, `device-output/${path}`)
    assert.deepEqual(Buffer.from(cloud.data, 'base64'), local)
    await assert.rejects(f.files.read(f.bob, `device-output/${path}`), { code: 'file_not_found' })
  }
  if (process.env.PE_DEVICE_TEST_ARTIFACT_DIR) {
    const target = process.env.PE_DEVICE_TEST_ARTIFACT_DIR
    await mkdir(target, { recursive: true, mode: 0o700 })
    const paths = [...formats, ...['device-word', 'device-excel', 'device-slides'].flatMap(name => ['pdf', 'png', 'txt'].map(extension => `previews/${name}.${extension}`))]
    const artifacts = []
    for (const path of paths) {
      const bytes = await readFile(join(f.project, path))
      await copyFile(join(f.project, path), join(target, path.replace('previews/', '')))
      artifacts.push({ name: path, sha256: hash(bytes), size: bytes.length })
    }
    await writeFile(join(target, 'office-evidence.json'), JSON.stringify({ image, executions, artifacts,
      services: ['real PG', 'real Docker', 'public Worker', 'real OfficeCLI', 'real LibreOffice', 'real POSIX'],
      replacements: ['loopback fixture routing; no DSH Profile, browser, Agent, or model'], visualInspection: 'pending' }, null, 2) + '\n')
  }
})

test('real Device Git executes once and persists exact Docker stop identity before cleanup', options, async t => {
  const f = await fixture(t)
  const command = "git init -q && git -c user.name=DeviceQA -c user.email=device-qa@example.invalid commit --allow-empty -qm init && printf 'ONCE\\n' >> marker.txt && git rev-parse --is-inside-work-tree"
  const accepted = await f.devices.propose(f.op.grant.token, 'real-git-call', command, '.')
  f.worker.start()
  await until(async () => (await f.row(accepted.executionId)).stop_observation !== null, 'durable stop')
  await until(async () => JSON.parse(await readFile(join(f.privateRoot, 'journal.json'), 'utf8')).length === 0, 'journal cleanup')
  const row = await f.row(accepted.executionId)
  assert.equal(row.state, 'succeeded'); assert.equal(row.result.exitCode, 0)
  assert.match(row.result.stdout, /true/u); assert.equal(await readFile(join(f.project, 'marker.txt'), 'utf8'), 'ONCE\n')
  assert.equal(row.container_receipt.containerId.length, 64)
  assert.equal(row.container_receipt.owner.creationId, row.dispatch_id)
  assert.equal(row.stop_observation.receipt.containerId, row.container_receipt.containerId)
  assert.equal(row.stop_observation.Running, false); assert.equal(await f.continuations(accepted.executionId), 1)
  assert.equal(await f.containers.inspect(row.container_receipt), null)
  assert.equal((await f.devices.finish(f.device.token, f.lastFinish())).stopConfirmed, true)
  assert.equal(await f.continuations(accepted.executionId), 1)
  const bob = await f.enroll(f.bob)
  await assert.rejects(f.devices.finish(bob.token, f.lastFinish()), { code: 'execution_not_found' })
})

for (const gap of ['after-create', 'before-create']) test(`an actual Worker death ${gap} permanently seals the original creation without starting or replaying it`, options, async t => {
  let child, exited, f
  t.after(async () => {
    if (child && child.exitCode === null && child.signalCode === null) child.kill('SIGKILL')
    await exited
    if (f) {
      await writeFile(join(f.project, 'release-next'), 'release\n')
      const entries = JSON.parse(await readFile(join(f.privateRoot, 'journal.json'), 'utf8'))
      for (const entry of entries) if (entry.owner && entry.imageId) {
        const receipt = entry.receipt ?? await f.containers.findCreated({ name: entry.container,
          imageId: entry.imageId, owner: entry.owner })
        if (receipt) f.trackReceipt(receipt)
      }
    }
  })
  f = await fixture(t, false, 15000)
  await f.worker.close()
  const accepted = await f.devices.propose(f.op.grant.token, 'real-create-to-journal-gap',
    "printf 'MUST-NOT-RUN\\n' >> forbidden.txt", '.')
  const workerModule = new URL('../lib/device/worker.js', import.meta.url).href
  const dockerModule = new URL('../lib/device/owned-container.js', import.meta.url).href
  const launch = { origin: f.origin, privateRoot: f.privateRoot, image, gap,
    options: { pollMs: 100, contactGraceMs: 5000, commandPollMs: 50, platformRequestTimeoutMs: 3000,
      coordinationRoot: join(f.privateRoot, '..', 'writers'), pythonExecutable: '/usr/bin/python3', fileOperationTimeoutMs: 3000 } }
  const script = join(f.privateRoot, 'create-gap-child.mjs')
  await writeFile(script, `import { DesktopWorker } from ${JSON.stringify(workerModule)}
import { OwnedDeviceContainer, ScrubbedDockerClient } from ${JSON.stringify(dockerModule)}
const configuration = ${JSON.stringify(launch)}
const docker = new ScrubbedDockerClient()
const containers = new OwnedDeviceContainer({ commandTimeoutMs: 15000, stopTimeoutMs: 10000, stopGraceSeconds: 1 }, {
  run: async (args, timeoutMs) => {
    if (args[0] === 'create' && configuration.gap === 'before-create') {
      await new Promise((resolve, reject) => process.send({ type: 'creating', args }, error => error ? reject(error) : resolve()))
      await new Promise(() => {})
    }
    const result = await docker.run(args, timeoutMs)
    if (args[0] === 'create') {
      await new Promise((resolve, reject) => process.send({ type: 'created' }, error => error ? reject(error) : resolve()))
      await new Promise(() => {})
    }
    return result
  }
})
const worker = new DesktopWorker(configuration.origin, configuration.privateRoot, configuration.image, configuration.options, containers)
await worker.init(); worker.start()
`, { mode: 0o600 })
  child = fork(script, [], { execPath: process.execPath, execArgv: [], stdio: ['ignore', 'ignore', 'ignore', 'ipc'],
    env: Object.fromEntries(['PATH', 'HOME', 'DOCKER_HOST'].flatMap(key => process.env[key] ? [[key, process.env[key]]] : [])) })
  exited = new Promise(resolve => child.once('close', resolve))
  let created = false, failure, lateArguments
  child.on('error', error => { failure = error })
  child.on('message', message => {
    if (message?.type === (gap === 'before-create' ? 'creating' : 'created')) {
      created = true; lateArguments = message.args
    }
  })
  await until(() => { if (failure) throw failure; return created }, 'original creation checkpoint before receipt persistence')
  const [intent] = JSON.parse(await readFile(join(f.privateRoot, 'journal.json'), 'utf8'))
  assert.equal(intent.stage, 'claimed'); assert.equal(intent.receipt, undefined)
  const receipt = await f.containers.findCreated({ name: intent.container, imageId: intent.imageId, owner: intent.owner })
  if (gap === 'after-create') {
    assert(receipt); f.trackReceipt(receipt)
    assert.equal((await f.containers.inspect(receipt)).Status, 'created')
  } else assert.equal(receipt, null)
  assert.equal((await f.row(accepted.executionId)).container_receipt, null)
  child.kill('SIGKILL'); await exited
  assert.equal(child.signalCode, 'SIGKILL')
  const recovering = await f.makeWorker(f.privateRoot)
  recovering.start()
  await until(async () => (await f.row(accepted.executionId)).state === 'cancelled', 'original creation permanently sealed')
  const row = await f.row(accepted.executionId)
  assert.equal(row.dispatch_process_id, intent.processId)
  for (const key of ['container_receipt', 'start_authorized_at', 'stop_request_id', 'stop_observation', 'result']) assert.equal(row[key], null)
  const closed = (await f.pool.query('SELECT receipt FROM pe_device_claim_closures WHERE execution_id=$1', [row.id])).rows
  assert.equal(closed.length, 1); assert.equal(closed[0].receipt.dispatchId, intent.dispatchId)
  assert.equal(closed[0].receipt.startNeverAuthorized, true)
  assert.equal(f.dockerCalls.filter(verb => verb === 'create' || verb === 'start').length, 0)
  await assert.rejects(readFile(join(f.project, 'forbidden.txt')), { code: 'ENOENT' })
  await until(async () => JSON.parse(await readFile(join(f.privateRoot, 'journal.json'), 'utf8')).length === 0,
    'original creation retirement')
  if (receipt) assert.equal(await f.containers.inspect(receipt), null)
  assert.equal(await f.continuations(row.id), 1)
  if (gap === 'before-create') {
    const pendingPath = join(f.privateRoot, 'sealed-creations', `${row.id}.json`)
    const pending = await readFile(pendingPath)
    const record = JSON.parse(pending)
    assert.equal(record.closure.executionId, row.id); assert.equal(record.owner.creationId, intent.dispatchId)
    assert.equal(record.imageId, intent.imageId); assert.equal(record.removalConfirmed, false)
    await recovering.close()
    const reopened = await f.makeWorker(f.privateRoot); reopened.start()
    assert.deepEqual(await readFile(pendingPath), pending)
  }
  const command = (gap === 'before-create' ? 'printf READY > ready-next; while [ ! -e release-next ]; do sleep 0.1; done; ' : '')
    + "git init -q && printf 'ONCE\\n' >> marker.txt"
  const next = await f.devices.propose(f.op.grant.token, 'fresh-after-actual-death', command, '.')
  if (gap === 'before-create') {
    await until(async () => {
      try { return await readFile(join(f.project, 'ready-next'), 'utf8') === 'READY' }
      catch (error) { if (error.code === 'ENOENT') return false; throw error }
    }, 'fresh command actually running while old cleanup remains pending')
    const slotPath = join(f.privateRoot, '..', 'writers', 'writer-slot.json')
    const activeSlot = await readFile(slotPath)
    assert.equal(JSON.parse(activeSlot).slot.owner.executionId, next.executionId)
    assert.equal((await f.row(next.executionId)).state, 'running')
    assert(Array.isArray(lateArguments) && lateArguments.every(value => typeof value === 'string') && lateArguments[0] === 'create')
    // A real late container is injected from the original captured create arguments; this is not a surviving CLI claim.
    const result = await new ScrubbedDockerClient().run(lateArguments, 15000)
    const lateReceipt = { containerId: result.stdout.trim(), imageId: intent.imageId, owner: intent.owner }
    assert.match(lateReceipt.containerId, /^[a-f0-9]{64}$/u); f.trackReceipt(lateReceipt)
    await until(async () => await f.containers.inspect(lateReceipt) === null, 'exact late resource removed while fresh writer remains running')
    assert.deepEqual(await readFile(slotPath), activeSlot)
    assert.equal((await f.row(next.executionId)).state, 'running')
    await assert.rejects(f.devices.register(f.device.token, { instanceId: f.device.instanceId, executionId: row.id,
      processId: intent.processId, dispatchId: intent.dispatchId, receipt: lateReceipt }), { code: 'device_claim_closed' })
    await writeFile(join(f.project, 'release-next'), 'release\n')
  }
  await until(async () => (await f.row(next.executionId)).state === 'succeeded', 'fresh Git after sealed original creation')
  await until(async () => JSON.parse(await readFile(join(f.privateRoot, 'journal.json'), 'utf8')).length === 0,
    'fresh Git exact container cleanup')
  assert.equal(await readFile(join(f.project, 'marker.txt'), 'utf8'), 'ONCE\n')
  assert.equal(f.dockerCalls.filter(verb => verb === 'create').length, 1)
  assert.equal(f.dockerCalls.filter(verb => verb === 'start').length, 1)
  await assert.rejects(readFile(join(f.project, 'forbidden.txt')), { code: 'ENOENT' })
})

test('cold claim and closure ACK loss permanently retire the old dispatch before fresh real Docker work', options, async t => {
  const f = await fixture(t, false, 1234, true, false, true, true)
  const accepted = await f.devices.propose(f.op.grant.token, 'cold-claim-must-not-run',
    "printf 'MUST-NOT-RUN\\n' >> forbidden.txt", '.')
  f.worker.start()
  await until(async () => f.lost() && (await f.row(accepted.executionId)).dispatch_process_id !== null,
    'committed claim with lost acknowledgement')
  await f.worker.close()
  const journal = JSON.parse(await readFile(join(f.privateRoot, 'journal.json'), 'utf8'))
  assert.equal(journal.length, 1); assert.equal(journal[0].stage, 'claiming')
  const original = await f.row(accepted.executionId)
  assert.equal(journal[0].processId, original.dispatch_process_id)
  const replacement = await f.makeWorker(f.privateRoot)
  replacement.start()
  await until(async () => f.lostClaimClosure(), 'committed closure with lost acknowledgement')
  await replacement.close()
  const afterLoss = JSON.parse(await readFile(join(f.privateRoot, 'journal.json'), 'utf8'))
  assert.equal(afterLoss.length, 1); assert.equal(afterLoss[0].stage, 'claiming')
  f.releaseClaimClosureAck()
  const retried = await f.makeWorker(f.privateRoot)
  retried.start()
  await until(async () => JSON.parse(await readFile(join(f.privateRoot, 'journal.json'), 'utf8')).length === 0,
    'retried closure receipt and writer retirement')
  const row = await f.row(accepted.executionId)
  assert.equal(row.state, 'cancelled'); assert.equal(row.dispatch_process_id, original.dispatch_process_id)
  for (const key of ['container_receipt', 'start_authorized_at', 'stop_request_id', 'stop_observation', 'result']) {
    assert.equal(row[key], null, key)
  }
  const closures = await f.pool.query('SELECT * FROM pe_device_claim_closures WHERE execution_id=$1', [row.id])
  assert.equal(closures.rowCount, 1)
  assert.equal(closures.rows[0].receipt.kind, 'unstarted_claim_closed')
  assert.equal(closures.rows[0].receipt.startNeverAuthorized, true)
  assert.equal(closures.rows[0].receipt.processId, original.dispatch_process_id)
  assert.equal(closures.rows[0].receipt.dispatchId, original.dispatch_id)
  assert.equal(closures.rows[0].request.digest, journal[0].queuedJob.digest)
  assert.equal(await f.continuations(row.id), 1)
  assert.equal(JSON.parse(await readFile(join(f.privateRoot, '..', 'writers', 'writer-slot.json'), 'utf8')).slot, null)
  assert.equal(f.dockerCalls.filter(verb => verb === 'create' || verb === 'start').length, 0)
  await assert.rejects(readFile(join(f.project, 'forbidden.txt')), { code: 'ENOENT' })
  await assert.rejects(f.devices.claim(f.device.token, f.device.instanceId, row.id, original.dispatch_process_id),
    { code: 'device_claim_closed' })
  const next = await f.devices.propose(f.op.grant.token, 'fresh-after-cold-closure',
    "git init -q && printf 'ONCE\\n' >> marker.txt", '.')
  await until(async () => (await f.row(next.executionId)).state === 'succeeded', 'fresh command after permanent closure')
  await until(async () => JSON.parse(await readFile(join(f.privateRoot, 'journal.json'), 'utf8')).length === 0,
    'fresh command journal settlement')
  assert.equal(await readFile(join(f.project, 'marker.txt'), 'utf8'), 'ONCE\n')
  assert.equal(f.dockerCalls.filter(verb => verb === 'create').length, 1)
  assert.equal(f.dockerCalls.filter(verb => verb === 'start').length, 1)
  assert.equal(await f.continuations(row.id), 1)
  await assert.rejects(readFile(join(f.project, 'forbidden.txt')), { code: 'ENOENT' })
})

test('lost real registration ACK never starts the command and persists unknown separately from stopped', options, async t => {
  const f = await fixture(t, true, 1234, false, true)
  const accepted = await f.devices.propose(f.op.grant.token, 'real-lost-ack', "printf 'MUST-NOT-RUN\\n' >> marker.txt", '.')
  f.worker.start()
  await until(async () => (await f.row(accepted.executionId)).stop_observation !== null, 'cold stop report')
  const row = await f.row(accepted.executionId)
  assert.equal(f.lost(), true); assert.equal(row.state, 'uncertain')
  assert.equal(row.stop_observation.Status, 'created'); assert.equal(row.stop_observation.Running, false)
  assert.equal(row.result.state, 'uncertain'); assert.equal(await f.continuations(accepted.executionId), 0)
  await assert.rejects(readFile(join(f.project, 'marker.txt')), { code: 'ENOENT' })
  assert.equal((await f.devices.jobs(f.device.token, f.device.instanceId)).jobs.length, 0)
  await assert.rejects(f.devices.propose(f.op.grant.token, randomUUID(), 'echo later', '.'), { code: 'execution_busy' })
  const credential = await taskCredential(f.pool, f.alice, 'approval')
  const inspected = await f.approval('/approvals/executions/inspect',
    { executionId: row.id, target: 'desktop' }, credential)
  assert.equal(inspected.status, 200); assert.equal(inspected.body.canStop, true)
  assert.equal(inspected.body.runnerObservation, 'stopped_unknown')
  const request = { requestId: randomUUID(), executionId: row.id, target: 'desktop',
    fingerprint: inspected.body.fingerprint, note: 'Real created container stopped; retain unknown effects.' }
  assert.equal((await f.approval('/approvals/executions/resolve', request,
    await taskCredential(f.pool, f.alice))).status, 401)
  assert.equal((await f.approval('/approvals/executions/resolve', request,
    await taskCredential(f.pool, f.bob, 'approval'))).status, 404)
  assert.equal((await f.approval('/approvals/executions/resolve', request, credential, 'http://127.0.0.1:1')).status, 403)
  await assert.rejects(f.approval('/approvals/executions/resolve', request, credential), { name: 'TypeError' })
  assert.equal(f.lostClosure(), true)
  const status = await f.approval('/approvals/executions/status', { requestId: request.requestId, target: 'desktop' }, credential)
  assert.equal(status.status, 200); assert.equal(status.body.receipt.state, 'completed')
  assert.equal(status.body.receipt.finalState, 'closed_unknown'); assert.equal(status.body.receipt.stopConfirmed, true)
  const retried = await f.approval('/approvals/executions/resolve', request, credential)
  assert.deepEqual(retried.body, status.body.receipt)
  const closed = await f.row(row.id)
  assert.equal(closed.state, 'closed_unknown'); assert.deepEqual(closed.result, row.result)
  assert.deepEqual(closed.stop_observation, row.stop_observation); assert.equal(closed.stop_record_digest, row.stop_record_digest)
  assert.equal(await f.continuations(row.id), 1)
  assert.equal((await f.devices.finish(f.device.token, f.lastFinish())).state, 'closed_unknown')
  const next = await f.devices.propose(f.op.grant.token, 'after-closure', "printf 'AFTER\\n' > after.txt", '.')
  await until(async () => (await f.row(next.executionId)).state === 'succeeded', 'new command after unknown closure')
  assert.equal(await readFile(join(f.project, 'after.txt'), 'utf8'), 'AFTER\n')
  await assert.rejects(readFile(join(f.project, 'marker.txt')), { code: 'ENOENT' })
  assert.equal(await f.continuations(row.id), 1)
})

test('revoking a running real Device blocks new authority but retains its exact stop report', options, async t => {
  const f = await fixture(t, false, 15000)
  const accepted = await f.devices.propose(f.op.grant.token, 'real-revocation',
    "printf 'START\\n' >> marker.txt; sleep 12; printf 'END\\n' >> marker.txt", '.')
  f.worker.start()
  await until(async () => {
    try { return (await readFile(join(f.project, 'marker.txt'), 'utf8')) === 'START\n' }
    catch (error) { if (error.code !== 'ENOENT') throw error; return false }
  }, 'running command marker')
  await f.devices.revoke(f.alice, f.device.deviceId)
  await assert.rejects(f.devices.jobs(f.device.token, f.device.instanceId), { code: 'device_unauthorized' })
  await assert.rejects(f.devices.directory(f.device.token, 'must not authorize'), { code: 'device_unauthorized' })
  await until(async () => (await f.row(accepted.executionId)).stop_observation !== null, 'revoked stop report')
  assert.equal(JSON.parse(await readFile(join(f.privateRoot, 'journal.json'), 'utf8')).length, 1)
  const row = await f.row(accepted.executionId)
  assert.equal(row.state, 'uncertain'); assert.equal(row.result.state, 'uncertain')
  assert.equal(row.stop_observation.Running, false); assert.equal(await f.continuations(accepted.executionId), 0)
  assert.equal(row.stop_observation.receipt.containerId, row.container_receipt.containerId)
  assert.equal(await readFile(join(f.project, 'marker.txt'), 'utf8'), 'START\n')
  await until(async () => await f.containers.inspect(row.container_receipt) === null, 'revoked exact container removal')
  assert.equal((await f.devices.finish(f.device.token, f.lastFinish())).stopConfirmed, true)
  const credential = await taskCredential(f.pool, f.alice, 'approval')
  const inspected = await f.approval('/approvals/executions/inspect', { executionId: row.id, target: 'desktop' }, credential)
  assert.equal(inspected.body.canStop, true)
  const closed = await f.approval('/approvals/executions/resolve', { requestId: randomUUID(), executionId: row.id,
    target: 'desktop', fingerprint: inspected.body.fingerprint, note: 'Real revoked Device stop.' }, credential)
  assert.equal(closed.status, 200); assert.equal(closed.body.finalState, 'closed_unknown')
  assert.equal((await f.devices.finish(f.device.token, f.lastFinish())).state, 'closed_unknown')
  await until(async () => JSON.parse(await readFile(join(f.privateRoot, 'journal.json'), 'utf8')).length === 0, 'revoked journal cleanup after closure')
  assert.equal(await f.continuations(row.id), 1)
  assert.equal(await readFile(join(f.project, 'marker.txt'), 'utf8'), 'START\n')
})

test('lost real claim ACK retries the original process and executes the command once', options, async t => {
  const f = await fixture(t, false, 1234, true)
  const accepted = await f.devices.propose(f.op.grant.token, 'real-lost-claim', "printf 'ONCE\\n' >> marker.txt", '.')
  f.worker.start()
  await until(async () => (await f.row(accepted.executionId)).stop_observation !== null, 'original claim recovery')
  await until(async () => JSON.parse(await readFile(join(f.privateRoot, 'journal.json'), 'utf8')).length === 0, 'claim journal cleanup')
  const row = await f.row(accepted.executionId)
  assert.equal(f.lost(), true); assert.equal(row.state, 'succeeded')
  assert.equal(row.container_receipt.owner.creationId, row.dispatch_id)
  assert.equal(await readFile(join(f.project, 'marker.txt'), 'utf8'), 'ONCE\n')
  assert.equal(await f.continuations(accepted.executionId), 1)
})

test('two real users and Devices serialize an explicitly shared ancestor project before Platform claim and Docker create', options, async t => {
  const f = await fixture(t, false, 15000)
  const child = join(f.project, 'child')
  await mkdir(child, { mode: 0o777 }); await chmod(child, 0o777)
  const b = await f.makeDevice(f.bob, child)
  const op = await f.operation(f.bob, b.device)
  const first = await f.devices.propose(f.op.grant.token, 'first-real-writer',
    "printf 'START\\n' > marker.txt; sleep 12; printf 'END\\n' >> marker.txt", '.')
  const second = await f.devices.propose(op.grant.token, 'second-real-writer', "printf 'ONCE\\n' >> marker.txt", '.')
  f.worker.start()
  await until(async () => {
    try { return (await readFile(join(f.project, 'marker.txt'), 'utf8')) === 'START\n' }
    catch (error) { if (error.code !== 'ENOENT') throw error; return false }
  }, 'first actual writer')
  b.worker.start()
  await until(async () => {
    try {
      const entries = JSON.parse(await readFile(join(b.privateRoot, 'journal.json'), 'utf8'))
      return entries.length === 1 && entries[0].stage === 'waiting'
    } catch (error) { if (error.code !== 'ENOENT') throw error; return false }
  }, 'second Device waiting')
  await delay(300)
  const waiting = await f.row(second.executionId)
  assert.equal(waiting.state, 'queued'); assert.equal(waiting.dispatch_process_id, null)
  assert.equal(waiting.container_receipt, null)
  await assert.rejects(readFile(join(child, 'marker.txt')), { code: 'ENOENT' })
  await assert.rejects(b.worker.exportFile(b.device.directoryId, 'marker.txt', 'copy.txt', randomUUID()), /device_directory_busy/u)
  await f.worker.close()
  await until(async () => (await f.row(second.executionId)).state === 'succeeded', 'second writer after exact stop and settlement')
  await until(async () => JSON.parse(await readFile(join(b.privateRoot, 'journal.json'), 'utf8')).length === 0, 'second journal settlement')
  const aRow = await f.row(first.executionId), bRow = await f.row(second.executionId)
  assert.equal(aRow.stop_observation.Running, false); assert.equal(aRow.state, 'cancelled')
  assert.equal(aRow.user_id, f.alice.userId); assert.equal(bRow.user_id, f.bob.userId)
  assert.notEqual(aRow.container_receipt.containerId, bRow.container_receipt.containerId)
  assert.equal(await f.containers.inspect(aRow.container_receipt), null)
  assert.equal(await f.containers.inspect(bRow.container_receipt), null)
  assert.equal(await readFile(join(f.project, 'marker.txt'), 'utf8'), 'START\n')
  assert.equal(await readFile(join(child, 'marker.txt'), 'utf8'), 'ONCE\n')
  assert.equal(await f.continuations(first.executionId), 1); assert.equal(await f.continuations(second.executionId), 1)
})

test('real PG and POSIX explicit Device transfers preserve bytes, refuse overwrites and enforce user ownership', options, async t => {
  const f = await fixture(t)
  const b = await f.makeDevice(f.bob, f.project)
  const bytes = Buffer.from([0, 1, 255, 13, 10, 99])
  await f.files.put(f.alice, randomUUID(), 'input.bin', null, bytes.toString('base64'))
  await f.worker.importFile(f.device.directoryId, 'input.bin', 'received.bin')
  assert.deepEqual(await readFile(join(f.project, 'received.bin')), bytes)
  await assert.rejects(f.worker.importFile(f.device.directoryId, 'input.bin', 'received.bin'), { code: 'file_exists' })
  await f.worker.exportFile(f.device.directoryId, 'received.bin', 'output.bin', randomUUID())
  const result = await f.files.read(f.alice, 'output.bin')
  assert.deepEqual(Buffer.from(result.data, 'base64'), bytes)
  await assert.rejects(f.devices.readCloud(b.device.token, f.device.directoryId, 'input.bin'), { code: 'desktop_directory_unavailable' })
  await assert.rejects(b.worker.importFile(b.device.directoryId, 'input.bin', 'bob.bin'), /platform_404/u)
  await assert.rejects(readFile(join(f.project, 'bob.bin')), { code: 'ENOENT' })
  const row = await f.pool.query('SELECT count(*)::integer AS n FROM pe_desktop_executions')
  assert.equal(row.rows[0].n, 0)
})
