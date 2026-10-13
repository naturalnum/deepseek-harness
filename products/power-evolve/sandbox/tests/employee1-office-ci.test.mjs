/** Actual Linux installers and Docker reconciliation; only the create-response transport fault is controlled. */
import assert from 'node:assert/strict'
import { execFileSync, spawn } from 'node:child_process'
import { createHash, randomUUID } from 'node:crypto'
import { chmod, link, lstat, mkdir, mkdtemp, readFile, readdir, realpath, rm, symlink, writeFile } from 'node:fs/promises'
import { createRequire } from 'node:module'
import { createServer, request } from 'node:http'
import { tmpdir } from 'node:os'
import { join, resolve } from 'node:path'
import test from 'node:test'
import { parseOfficeCiArguments, prepareOfficeCi } from '../../../../.github/power-evolve-office/reproduce-office-closure.mjs'
import { nativeDockerCoverageArguments } from '../../scripts/cloud-coverage.mjs'

async function removeFixture(path) {
  const status = await lstat(path)
  if (status.isDirectory()) {
    await chmod(path, 0o700)
    for (const name of await readdir(path)) await removeFixture(join(path, name))
  }
  await rm(path, { recursive: true, force: true })
}

async function fixture(t) {
  const root = await mkdtemp(join(await realpath(tmpdir()), 'pe-office-ci-boundary-'))
  t.after(() => removeFixture(root))
  const validator = join(root, 'validator.mjs'), out = join(root, 'new-output'), cache = join(root, 'cache')
  await writeFile(validator, 'export const testFixture=true\n'); await mkdir(cache)
  return { root, validator, out, cache }
}
const options = f => parseOfficeCiArguments(['--out', f.out, '--mode', 'online', '--validator', f.validator])

async function actualSdkProbe(t, report) {
  const prefix = process.platform === 'darwin' ? ['--context', 'orbstack'] : []
  const runId = randomUUID(), owner = 'power-evolve-office-unit-probe'
  const executionRoot = '/pe-office-probe', runtime = executionRoot + '/products/power-evolve/sandbox'
  const coverage = process.env.PE_CLOUD_COVERAGE_INPUT
    ? nativeDockerCoverageArguments(process.env.PE_CLOUD_COVERAGE_INPUT, { executionRoot }) : []
  const program = `
    import {createHash} from 'node:crypto';
    import {readFile} from 'node:fs/promises';
    import {loadOfficePreviewDependencies} from '${runtime}/office-preview.mjs';
    const d=await loadOfficePreviewDependencies();
    const moduleHash=createHash('sha256').update(await readFile('${runtime}/office-preview.mjs')).digest('hex');
    console.log(JSON.stringify({version:d.version,create:typeof d.createConverter,
      job:typeof d.jobSchema.parse,result:typeof d.resultSchema.parse,failure:typeof d.failureSchema.parse,moduleHash}));
  `
  const args = [...prefix, 'create', '--name', 'pe-office-unit-' + runId, '--label', 'codex.owner=' + owner,
    '--label', 'powerevolve.dev/run=' + runId, '--user', `${process.getuid()}:${process.getgid()}`,
    '--network', 'none', '--read-only', '--cap-drop', 'ALL', '--security-opt', 'no-new-privileges',
    '--mount', `type=bind,source=${report.paths.context}/runtime,target=${runtime},readonly`,
    ...coverage, report.installerBase, 'node', '--input-type=module', '-e', program]
  const id = execFileSync('docker', args, { encoding: 'utf8' }).trim()
  assert.match(id, /^[a-f0-9]{64}$/u)
  try {
    const result = JSON.parse(execFileSync('docker', [...prefix, 'start', '--attach', id], { encoding: 'utf8', timeout: 60_000 }))
    assert.deepEqual(result, { version: '0.1.1', create: 'function', job: 'function', result: 'function', failure: 'function',
      moduleHash: report.manifest.files.find(file => file.path === 'office-preview.mjs').sha256 })
  } finally {
    let item = JSON.parse(execFileSync('docker', [...prefix, 'inspect', id], { encoding: 'utf8' }))[0]
    assert.equal(item.Id, id); assert.equal(item.Config.Labels['codex.owner'], owner)
    assert.equal(item.Config.Labels['powerevolve.dev/run'], runId)
    if (item.State.Running) {
      execFileSync('docker', [...prefix, 'stop', '--time', '10', id])
      item = JSON.parse(execFileSync('docker', [...prefix, 'inspect', id], { encoding: 'utf8' }))[0]
    }
    assert.equal(item.State.Running, false); assert.equal(item.State.Pid, 0)
    execFileSync('docker', [...prefix, 'rm', id])
    t.diagnostic(JSON.stringify({ operation: 'Linux-SDK-source-probe', containerId: id,
      removed: true, running: item.State.Running, pid: item.State.Pid }))
  }
}

async function uncertainDockerTransport(t, f, effect) {
  const direct = process.platform === 'darwin' ? ['--context', 'orbstack'] : []
  const context = JSON.parse(execFileSync('docker', [...direct, 'context', 'inspect'], { encoding: 'utf8' }))[0]
  const endpoint = context.Endpoints.docker.Host
  assert.ok(endpoint.startsWith('unix://'), 'These Linux installer tests require a local Docker socket')
  const socketRoot = await mkdtemp(join(await realpath('/tmp'), 'pe-office-proxy-'))
  const socket = join(socketRoot, 'docker-proxy.sock'), name = 'pe-office-ci-boundary-' + randomUUID()
  const description = 'Owned Office CI transport boundary ' + name
  let createdId
  const server = createServer((incoming, response) => {
    if (incoming.method === 'POST' && incoming.url.includes('/containers/create') && effect === 'absent') {
      incoming.resume(); response.writeHead(500, { 'content-type': 'application/json' })
      response.end(JSON.stringify({ message: 'Owned transport rejected before create' })); return
    }
    const forward = request({ socketPath: endpoint.slice('unix://'.length), path: incoming.url,
      method: incoming.method, headers: incoming.headers }, (reply) => {
      if (incoming.method === 'POST' && incoming.url.includes('/containers/create') && effect === 'created') {
        const chunks = []
        reply.on('data', chunk => chunks.push(chunk))
        reply.once('end', () => {
          assert.equal(reply.statusCode, 201)
          createdId = JSON.parse(Buffer.concat(chunks).toString()).Id
          response.writeHead(500, { 'content-type': 'application/json' })
          response.end(JSON.stringify({ message: 'Owned transport lost the successful create response' }))
        })
      } else { response.writeHead(reply.statusCode, reply.headers); reply.pipe(response) }
    })
    forward.once('error', () => { response.writeHead(502); response.end() })
    incoming.pipe(forward)
  })
  t.after(async () => {
    try {
      const metadata = JSON.parse(execFileSync('docker', ['context', 'inspect', name], { encoding: 'utf8' }))[0]
      assert.equal(metadata.Metadata.Description, description)
      execFileSync('docker', ['context', 'rm', name])
    } finally {
      if (server.listening) {
        server.closeAllConnections()
        await new Promise(resolve => server.close(resolve))
      }
      await rm(socketRoot, { recursive: true, force: true })
    }
  })
  await new Promise((resolve, reject) => { server.once('error', reject); server.listen(socket, resolve) })
  execFileSync('docker', ['context', 'create', name, '--description', description, '--docker', 'host=unix://' + socket])
  return { name, created: () => createdId }
}

test('CI flags reject ambiguity and preserve explicit architecture/mode choices', () => {
  const valid = parseOfficeCiArguments(['--out', '/tmp/new-owned', '--mode', 'online', '--arch', 'x64'])
  assert.equal(valid.arch, 'x64'); assert.equal(valid.mode, 'online')
  assert.equal(parseOfficeCiArguments(['--out', '/tmp/new-owned', '--mode', 'online']).arch, 'arm64')
  const invalid = [[], ['--unknown', 'value'], ['--out'], ['--out', '--mode'],
    ['--out', '/tmp/new', '--out', '/tmp/second'], ['--out', 'relative', '--mode', 'online'],
    ['--out', '/tmp/new', '--mode', 'invalid'], ['--out', '/tmp/new', '--mode', 'online', '--arch', 's390x'],
    ['--out', '/tmp/new', '--mode', 'offline'], ['--out', '/tmp/new', '--mode', 'online', '--cache', '/tmp/cache'],
    ['--out', '/tmp/new,src=/outside', '--mode', 'online'], ['--out', '/tmp/new\nline', '--mode', 'online']]
  for (const argv of invalid) assert.throws(() => parseOfficeCiArguments(argv))
})

test('CI preparation rejects existing output without modifying its files', async (t) => {
  const f = await fixture(t); await mkdir(f.out); await writeFile(join(f.out, 'keep'), 'original')
  await assert.rejects(prepareOfficeCi(options(f)))
  assert.deepEqual(await readdir(f.out), ['keep'])
  assert.equal(await readFile(join(f.out, 'keep'), 'utf8'), 'original')
  await assert.rejects(prepareOfficeCi(parseOfficeCiArguments(['--out', f.out, '--mode', 'online'])))
  assert.deepEqual(await readdir(f.out), ['keep'])
})

test('CI validator aliases, linked cache files and cache/output overlap fail before allocation', async (t) => {
  for (const kind of ['validator-alias', 'validator-directory', 'cache-alias', 'cache-root-alias',
    'cache-hardlink', 'cache-fifo', 'parent-alias', 'overlap']) await t.test(kind, async (t) => {
    const f = await fixture(t)
    const argv = ['--out', f.out, '--mode', 'offline', '--cache', f.cache, '--validator', f.validator]
    if (kind === 'validator-alias') {
      const alias = join(f.root, 'alias.mjs'); await symlink(f.validator, alias); argv[argv.length - 1] = alias
    }
    if (kind === 'cache-alias') await symlink(f.validator, join(f.cache, 'unsafe'))
    if (kind === 'validator-directory') argv[argv.length - 1] = f.cache
    if (kind === 'cache-root-alias') {
      const alias = join(f.root, 'cache-alias'); await symlink(f.cache, alias); argv[5] = alias
    }
    if (kind === 'cache-hardlink') await link(f.validator, join(f.cache, 'unsafe'))
    if (kind === 'cache-fifo') execFileSync('mkfifo', [join(f.cache, 'unsafe')])
    if (kind === 'parent-alias') {
      const alias = join(f.root, 'parent-alias'); await symlink(f.cache, alias); argv[1] = join(alias, 'new')
    }
    if (kind === 'overlap') argv[1] = join(f.cache, 'nested')
    await assert.rejects(prepareOfficeCi(parseOfficeCiArguments(argv)))
    assert.equal((await readdir(f.root)).includes('new-output'), false)
  })
})

test('CI cancellation before allocation leaves no output or owned installer', async (t) => {
  const f = await fixture(t)
  await assert.rejects(prepareOfficeCi(options(f), AbortSignal.abort()))
  assert.equal((await readdir(f.root)).includes('new-output'), false)
})

test('actual offline empty cache failure preserves its stage and removes the exact installer', async (t) => {
  const f = await fixture(t)
  const argv = ['--out', f.out, '--mode', 'offline', '--cache', f.cache, '--validator', f.validator, '--arch', process.arch]
  if (process.platform === 'darwin') argv.push('--docker-context', 'orbstack')
  await assert.rejects(prepareOfficeCi(parseOfficeCiArguments(argv)))
  const report = JSON.parse(await readFile(join(f.out, 'reproduction.json'), 'utf8'))
  assert.equal(report.failureStage, 'install')
  assert.notEqual(report.install.status, 0)
  assert.match(report.containerId, /^[a-f0-9]{64}$/u)
  assert.equal(report.containerRemoved, true)
  assert.equal(report.containerState.Running, false); assert.equal(report.containerState.Pid, 0)
  t.diagnostic(JSON.stringify({ operation: 'empty-cache-negative', containerId: report.containerId,
    removed: report.containerRemoved, running: report.containerState.Running, pid: report.containerState.Pid }))
  assert.equal((await readdir(f.out)).includes('context'), true)
  const before = createHash('sha256').update(await readFile(f.validator)).digest('hex')
  assert.equal(before, createHash('sha256').update('export const testFixture=true\n').digest('hex'))
})

test('uncertain Docker create replies reconcile only the actual owned installer', async (t) => {
  for (const effect of ['absent', 'created']) await t.test(effect, async (t) => {
    const f = await fixture(t), transport = await uncertainDockerTransport(t, f, effect)
    const argv = ['--out', f.out, '--mode', 'offline', '--cache', f.cache, '--validator', f.validator,
      '--arch', process.arch, '--docker-context', transport.name]
    await assert.rejects(prepareOfficeCi(parseOfficeCiArguments(argv)))
    const report = JSON.parse(await readFile(join(f.out, 'reproduction.json'), 'utf8'))
    assert.equal(report.failureStage, 'create')
    if (effect === 'absent') {
      assert.equal(report.createRecovery.absent, true)
      assert.equal(report.containerId, undefined)
    } else {
      assert.equal(report.containerId, transport.created())
      assert.equal(report.createRecovery.status, 0)
      assert.equal(report.containerRemoved, true)
      assert.equal(report.containerState.Running, false); assert.equal(report.containerState.Pid, 0)
      t.diagnostic(JSON.stringify({ operation: 'create-recovery', containerId: report.containerId,
        removed: report.containerRemoved, running: report.containerState.Running, pid: report.containerState.Pid }))
    }
  })
})

test('actual cold Linux npm install and disconnected cache replay preserve the fixed closure', async (t) => {
  const f = await fixture(t)
  await writeFile(f.validator, await readFile('products/power-evolve/contracts/lib/browser/office-preview.js'))
  const onlineArgs = ['--out', f.out, '--mode', 'online', '--arch', process.arch, '--validator', f.validator]
  if (process.platform === 'darwin') onlineArgs.push('--docker-context', 'orbstack')
  const online = await prepareOfficeCi(parseOfficeCiArguments(onlineArgs), new AbortController().signal)
  assert.equal(online.stage, 'complete')
  assert.equal(online.install.status, 0)
  assert.equal(online.basePull.status, 0)
  assert.equal(online.containerRemoved, true)
  assert.equal(online.containerState.Running, false)
  assert.equal(online.containerState.Pid, 0)
  t.diagnostic(JSON.stringify({ operation: 'cold-online', arch: process.arch, containerId: online.containerId,
    removed: online.containerRemoved, running: online.containerState.Running, pid: online.containerState.Pid }))
  assert.equal(online.manifest.sdkVersion, '0.1.1')
  assert.equal(online.manifest.packages.length, 18)
  const rootKit = JSON.parse(await readFile(createRequire(import.meta.url).resolve('@deepseek-ai/libreoffice-kit/package.json'), 'utf8'))
  assert.equal(rootKit.version, '0.1.5')
  assert.equal(online.manifest.packages.find(pkg => pkg.name === rootKit.name).version, '0.1.1')
  const offlineArgs = ['--out', join(f.root, 'replay'), '--mode', 'offline', '--arch', process.arch,
    '--cache', online.paths.cache, '--validator', f.validator]
  if (process.platform === 'darwin') offlineArgs.push('--docker-context', 'orbstack')
  const offline = await prepareOfficeCi(parseOfficeCiArguments(offlineArgs))
  assert.deepEqual(offline.manifest, online.manifest)
  assert.equal(offline.install.status, 0)
  assert.equal(offline.containerRemoved, true)
  assert.equal(offline.containerState.Running, false)
  assert.equal(offline.containerState.Pid, 0)
  t.diagnostic(JSON.stringify({ operation: 'offline-replay', containerId: offline.containerId,
    removed: offline.containerRemoved, running: offline.containerState.Running, pid: offline.containerState.Pid }))
  assert.equal(offline.createArgs[offline.createArgs.indexOf('--network') + 1], 'none')
  const validator = await readFile(f.validator)
  assert.deepEqual(await readFile(join(offline.paths.context, 'runtime/office-preview-contract.mjs')), validator)
  await actualSdkProbe(t, offline)
  const entry = resolve('.github/power-evolve-office/reproduce-office-closure.mjs')
  const cliArgs = [...offlineArgs]; cliArgs[1] = join(f.root, 'cli-replay')
  const output = JSON.parse(execFileSync(process.execPath, [entry, ...cliArgs], { encoding: 'utf8', timeout: 120_000 }))
  assert.equal(output.sdkVersion, '0.1.1'); assert.equal(output.packages, 18)
  const cli = JSON.parse(await readFile(join(cliArgs[1], 'reproduction.json'), 'utf8'))
  assert.equal(cli.containerRemoved, true); assert.equal(cli.containerState.Pid, 0)
  assert.deepEqual(cli.manifest, offline.manifest)
  t.diagnostic(JSON.stringify({ operation: 'CLI-offline-replay', containerId: cli.containerId,
    removed: cli.containerRemoved, running: cli.containerState.Running, pid: cli.containerState.Pid }))

  const cancelArgs = [...offlineArgs]; cancelArgs[1] = join(f.root, 'cli-cancel')
  const child = spawn(process.execPath, [entry, ...cancelArgs], { stdio: ['ignore', 'pipe', 'pipe'] })
  child.stdout.resume(); child.stderr.resume()
  const closed = new Promise((resolve, reject) => { child.once('error', reject); child.once('close', resolve) })
  const prefix = process.platform === 'darwin' ? ['--context', 'orbstack'] : []
  let running = false
  try {
    const deadline = Date.now() + 45_000
    while (!running && child.exitCode === null && Date.now() < deadline) {
      const record = await readFile(join(cancelArgs[1], 'reproduction.json'), 'utf8').catch(() => undefined)
      if (!record) continue
      let pending
      try { pending = JSON.parse(record) } catch (_incompleteAtomicRead) { continue }
      if (!pending.containerId) continue
      const state = JSON.parse(execFileSync('docker', [...prefix, 'inspect', pending.containerId], { encoding: 'utf8' }))[0]
      assert.equal(state.Id, pending.containerId)
      assert.equal(state.Config.Labels['codex.owner'], 'power-evolve-office-ci')
      assert.equal(state.Config.Labels['powerevolve.dev/run'], pending.runId)
      running = state.State.Running
    }
    assert.equal(running, true, 'Actual owned installer must be running before termination')
    child.kill('SIGTERM')
    assert.notEqual(await closed, 0)
    const cancelled = JSON.parse(await readFile(join(cancelArgs[1], 'reproduction.json'), 'utf8'))
    assert.equal(cancelled.failureStage, 'install'); assert.equal(cancelled.containerRemoved, true)
    assert.equal(cancelled.containerState.Running, false); assert.equal(cancelled.containerState.Pid, 0)
    assert.equal(cancelled.stage, 'install')
    t.diagnostic(JSON.stringify({ operation: 'CLI-SIGTERM', containerId: cancelled.containerId,
      removed: cancelled.containerRemoved, running: cancelled.containerState.Running, pid: cancelled.containerState.Pid }))
  } finally {
    if (child.exitCode === null) child.kill('SIGTERM')
    await closed
  }
})
