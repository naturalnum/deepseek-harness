/** Produce a fresh compatibility cohort from fixed source37 services, then seal it with current built maintenance. */
import assert from 'node:assert/strict'
import { spawnSync } from 'node:child_process'
import { randomUUID, randomBytes, createHash } from 'node:crypto'
import { constants } from 'node:fs'
import { chmod, copyFile, link, lstat, mkdir, open, readFile, unlink, writeFile } from 'node:fs/promises'
import { createRequire } from 'node:module'
import { join, resolve } from 'node:path'
import { fileURLToPath } from 'node:url'
import { setTimeout as delay } from 'node:timers/promises'
import { assertOwnedBuiltInputDirectory } from './owned-built-input-directory.mjs'

const repository = resolve(fileURLToPath(new URL('../..', import.meta.url)))
const flags = new Map()
for (let index = 2; index < process.argv.length; index += 2) {
  const key = process.argv[index], value = process.argv[index + 1]
  assert(['--out', '--owner', '--runner-temp', '--admin-url-file', '--current-image', '--gateway'].includes(key) && value && !flags.has(key))
  flags.set(key, value)
}
assert.equal(flags.size, 6); assert.equal(process.platform, 'linux')
const out = resolve(flags.get('--out')), owner = flags.get('--owner')
await assertOwnedBuiltInputDirectory({ out, owner, runnerTemp: resolve(flags.get('--runner-temp')), empty: true })
const hostUid = process.getuid(), hostGid = process.getgid(), context = join(out, 'context'), logRoot = join(out, 'logs')
await mkdir(context, { mode: 0o700 }); await mkdir(logRoot, { mode: 0o700 })
const lockFile = join(repository, '.github/power-evolve-built/schema37-producer/runtime-inputs.lock.json')
const lockBytes = await readFile(lockFile)
const lock = JSON.parse(lockBytes.toString('utf8'))
const { loadAll, dump } = createRequire(join(repository, 'products/power-evolve/application/package.json'))('js-yaml')
const { Pool } = createRequire(join(repository, 'products/power-evolve/application/package.json'))('pg')
const json = (file, value) => writeFile(file, JSON.stringify(value, null, 2) + '\n', { flag: 'wx', mode: 0o600 })
let serial = 0
async function run(command, args, options = {}) {
  const log = await open(join(logRoot, String(serial++) + '.log'), 'wx', 0o600)
  try {
    const child = spawnSync(command, args, { cwd: repository, shell: false, encoding: 'utf8', timeout: options.timeout ?? 300000,
      env: { ...process.env, ...options.env }, stdio: ['ignore', log.fd, log.fd] })
    assert(!child.error && !child.signal && child.status === 0, 'Owned fixture command failed; inspect its private numbered log')
  } finally { await log.close() }
}
function value(command, args) {
  const child = spawnSync(command, args, { cwd: repository, shell: false, encoding: 'utf8', timeout: 30000 })
  assert(!child.error && !child.signal && child.status === 0, 'Owned fixture metadata command failed')
  return child.stdout.trim()
}
async function download(name, input, destination) {
  const attempts = 3, attemptTimeoutMs = 180000
  const transportCodes = new Set(['UND_ERR_SOCKET', 'UND_ERR_CONNECT_TIMEOUT', 'UND_ERR_HEADERS_TIMEOUT',
    'UND_ERR_BODY_TIMEOUT', 'UND_ERR_RES_CONTENT_LENGTH_MISMATCH', 'ECONNRESET', 'ECONNREFUSED', 'ETIMEDOUT', 'EAI_AGAIN'])
  for (let attempt = 1; attempt <= attempts; attempt++) {
    const partial = destination + '.partial-' + randomUUID(), deadline = AbortSignal.timeout(attemptTimeoutMs)
    let handle, bytes = 0, response
    try {
      handle = await open(partial, 'wx', 0o600)
      response = await fetch(input.url, { signal: deadline })
      assert(response.ok && response.body, 'Pinned public runtime download failed: ' + name)
      const digest = createHash(input.algorithm)
      for await (const chunk of response.body) {
        const data = Buffer.from(chunk)
        digest.update(data); bytes += data.length
        await handle.writeFile(data)
      }
      assert(bytes > 100 && digest.digest('hex') === input.digest, 'Pinned runtime bytes differ: ' + name)
      await handle.sync(); await handle.close(); handle = undefined
      await link(partial, destination)
      await json(join(logRoot, 'download-' + name + '-' + attempt + '.json'),
        { name, attempt, attempts, attemptTimeoutMs, status: 'verified', bytes, algorithm: input.algorithm, digest: input.digest })
      return
    } catch (error) {
      const code = error.cause?.code ?? error.code ?? null
      const transportFailure = transportCodes.has(code) || deadline.aborted && ['TimeoutError', 'AbortError'].includes(error.name)
      const retry = transportFailure && attempt < attempts
      const record = { name, attempt, attempts, attemptTimeoutMs, status: 'failed', bytes,
        errorName: error.name, code, httpStatus: response?.status ?? null, transportFailure, retry }
      await json(join(logRoot, 'download-' + name + '-' + attempt + '.json'), record)
      console.error(JSON.stringify(record))
      if (!retry) throw error
    } finally {
      try { if (handle) await handle.close() }
      finally {
        try { await unlink(partial) }
        catch (error) { if (error.code !== 'ENOENT') throw error }
      }
    }
    await delay(1000 * attempt)
  }
}
function nativeLinuxArchitecture(value) {
  if (['amd64', 'x86_64', 'x64'].includes(value)) return 'amd64'
  if (['arm64', 'aarch64'].includes(value)) return 'arm64'
  throw new Error('Schema37 fixture requires native Linux amd64 or arm64')
}
const daemon = value('docker', ['info', '--format', '{{.OSType}}/{{.Architecture}}']).split('/')
assert.equal(daemon[0], 'linux')
const architecture = nativeLinuxArchitecture(daemon[1])
assert.equal(nativeLinuxArchitecture(process.arch), architecture, 'Fixture host and Docker daemon must use the same native architecture')
const runtimeInputs = lock.architectures[architecture]
assert(runtimeInputs, 'Native architecture has no pinned runtime inputs')
const image = value('docker', ['image', 'inspect', '--format', '{{.Id}}', flags.get('--current-image')])
const baseAlias = { reference: 'pe-ci-schema37-base:' + owner, imageId: image, created: false, originalTags: [] }
assert.match(image, /^sha256:[a-f0-9]{64}$/u)
assert.equal(value('docker', ['image', 'inspect', '--format', '{{.Os}}/{{.Architecture}}', image]), 'linux/' + architecture)
assert.equal(value('git', ['rev-parse', '--verify', lock.sourceCommit + '^{commit}']), lock.sourceCommit)
const sourceTar = join(out, 'original-source.tar'), archiveHandle = await open(sourceTar, 'wx', 0o600)
try {
  const child = spawnSync('git', ['--no-optional-locks', 'archive', '--format=tar', lock.sourceCommit],
    { cwd: repository, shell: false, stdio: ['ignore', archiveHandle.fd, 'pipe'] })
  assert(!child.error && !child.signal && child.status === 0, 'Fixed original source archive failed')
} finally { await archiveHandle.close() }
await mkdir(join(context, 'original'), { mode: 0o700 })
await run('tar', ['-xf', sourceTar, '-C', join(context, 'original')])
await copyFile(join(context, 'original/products/power-evolve/connector-runner/tests/stdio-v2-fixture.mjs'), join(context, 'ci-stdio-v2-fixture.mjs'))
await mkdir(join(context, 'producer'), { mode: 0o700 })
await writeFile(join(context, 'producer/runtime-inputs.lock.json'), lockBytes, { flag: 'wx', mode: 0o600 })
for (const name of ['bootstrap-profile.mjs', 'stdio-profile.mjs', 'resolution-profile.mjs', 'runner-profile.mjs', 'seal-current.mjs']) {
  await copyFile(join(repository, '.github/power-evolve-built/schema37-producer', name), join(context, 'producer', name))
}
for (const role of ['bootstrap', 'stdio', 'resolution', 'runner']) {
  const directory = join(context, 'profiles', 'pe-ci-' + role)
  await mkdir(directory, { recursive: true, mode: 0o700 })
  await json(join(directory, 'package.json'), { name: 'dsh-profile-pe-ci-' + role, private: true, type: 'module', dsh: { profile: { bundles: [] } } })
  await writeFile(join(directory, 'cordis.patch.yml'), dump([{ insert: [{ id: 'ci-compat-' + role,
    name: 'file:///opt/pe-ci-producer/' + role + '-profile.mjs', ...role === 'runner' ? {} : { config: { parameterFile: '/pe-ci-data/parameters/' + role + '.json' } } }] }]),
  { flag: 'wx', mode: 0o600 })
}
await writeFile(join(context, 'Dockerfile'), 'FROM ' + baseAlias.reference + '\nUSER root\nCOPY original /opt/pe-ci-original\n'
  + 'RUN ln -s /opt/power-evolve/node_modules /opt/pe-ci-original/node_modules\nCOPY producer /opt/pe-ci-producer\n'
  + 'COPY profiles /opt/pe-ci-dsh/profiles\nCOPY ci-stdio-v2-fixture.mjs /opt/power-evolve/ci-stdio-v2-fixture.mjs\n'
  + 'RUN chmod 755 /opt/pe-ci-original /opt/pe-ci-producer /opt/pe-ci-dsh/profiles /opt/pe-ci-dsh/profiles/* && chmod 444 /opt/pe-ci-producer/* /opt/pe-ci-dsh/profiles/*/*\n'
  + 'ENV DSH_HOME=/opt/pe-ci-dsh DSH_TELEMETRY_DISABLED=1 NODE_OPTIONS=--import=tsx/esm TSX_TSCONFIG_PATH=/opt/pe-ci-original/tsconfig.base.json\n'
  + 'CMD ["node","--import","tsx/esm","apps/cli/lib/bin.js","--profile","pe-ci-runner"]\n', { flag: 'wx', mode: 0o600 })
const tag = 'pe-ci-schema37:' + owner, cluster = 'pe-ci-' + owner.slice(0, 18), registry = 'pe-ci-registry-' + owner
const bin = join(out, 'bin'), storage = join(out, 'storage'), generated = join(out, 'generated'), parameters = join(out, 'parameters')
for (const directory of [bin, storage, generated, parameters]) await mkdir(directory, { mode: 0o700 })
const kind = join(bin, 'kind'), gvisor = join(bin, 'gvisor.tar.bz2')
await download('kind', runtimeInputs.downloads.kind, kind); await chmod(kind, 0o755)
const kubectlFile = join(bin, 'kubectl')
await download('kubectl', runtimeInputs.downloads.kubectl, kubectlFile); await chmod(kubectlFile, 0o755)
await download('gvisor', runtimeInputs.downloads.gvisor, gvisor); await run('tar', ['-xjf', gvisor, '-C', bin]); await chmod(bin, 0o755)
await writeFile(join(bin, 'runsc-shim.toml'), 'binary_name="/usr/local/bin/pe-ci-gvisor/runsc"\n[runsc_config]\n platform="systrap"\n', { flag: 'wx', mode: 0o644 })
const adminInput = await open(resolve(flags.get('--admin-url-file')), constants.O_RDONLY | constants.O_NOFOLLOW)
let adminText
try {
  const before = await adminInput.stat()
  assert(before.isFile() && before.uid === hostUid && (before.mode & 0o077) === 0 && before.size <= 65536,
    'The caller must own its bounded private PG input')
  adminText = await adminInput.readFile('utf8')
  const after = await adminInput.stat()
  assert.equal(after.size, before.size); assert.equal(after.mtimeMs, before.mtimeMs)
  assert.equal(Buffer.byteLength(adminText), before.size)
} finally { await adminInput.close() }
const adminUrl = new URL(adminText.trim())
assert(['127.0.0.1', 'localhost', '[::1]'].includes(adminUrl.hostname))
const suffix = randomUUID().replaceAll('-', ''), sourceName = 'pe_ci_schema37_' + suffix, sourceRole = 'pe_ci_schema37_owner_' + suffix
const sourceUrl = new URL(adminUrl); sourceUrl.pathname = '/' + sourceName; sourceUrl.username = sourceRole; sourceUrl.password = randomBytes(32).toString('hex')
const admin = new Pool({ connectionString: adminUrl.href, max: 1 })
let databaseCreated = false, roleCreated = false, registryCreated = false, clusterCreated = false, imageCreated = false, published = false
const producerContainers = [], resourceRecord = join(out, 'owned-resources.json')
const sealedContainer = { name: 'pe-ci-producer-seal-' + owner, id: null, imageId: null }
const containerIds = {}, kindNodeIds = []
const disposalScript = join(out, 'storage-cleanup.mjs')
await copyFile(join(repository, '.github/power-evolve-built/schema37-producer/cleanup-storage.mjs'), disposalScript)
await chmod(disposalScript, 0o600)
let publishedReference
const recordResources = () => writeFile(resourceRecord, JSON.stringify({ owner, cluster, registry,
  helperTag: tag, sourceName, sourceRole, producerContainers, containerIds, sealedContainer, kindNodeIds, baseAlias }) + '\n', { mode: 0o600 })
await json(resourceRecord, { owner, cluster, registry, helperTag: tag, sourceName, sourceRole,
  producerContainers, containerIds, sealedContainer, kindNodeIds, baseAlias })
function optionalMetadata(kind, name) {
  const child = spawnSync('docker', [kind, 'inspect', '--format', '{{json .}}', name], { cwd: repository, shell: false, encoding: 'utf8', timeout: 15000 })
  assert(!child.error && !child.signal)
  if (child.status === 1) return null
  assert.equal(child.status, 0); return JSON.parse(child.stdout)
}
function assertSealedContainer(actual) {
  assert(actual)
  assert.equal(actual.Name, '/' + sealedContainer.name)
  assert.equal(actual.Config.Labels['codex.owner'], owner)
  assert.equal(actual.Image, sealedContainer.imageId)
  if (sealedContainer.id !== null) assert.equal(actual.Id, sealedContainer.id)
  assert.match(actual.Id, /^[a-f0-9]{64}$/u)
}
function ownedKindNode() {
  const actual = optionalMetadata('container', cluster + '-control-plane')
  if (!actual) return null
  assert.equal(actual.Config.Labels['io.x-k8s.kind.cluster'], cluster)
  assert(actual.Mounts.some(mount => mount.Destination === '/pe-ci-data/storage' && mount.Source === storage))
  if (!kindNodeIds.includes(actual.Id)) kindNodeIds.push(actual.Id)
  return actual
}
try {
  await admin.query('CREATE ROLE "' + sourceRole + '" LOGIN PASSWORD \'' + sourceUrl.password + '\' NOSUPERUSER NOCREATEDB NOCREATEROLE NOINHERIT NOREPLICATION NOBYPASSRLS'); roleCreated = true
  await admin.query('CREATE DATABASE "' + sourceName + '" OWNER "' + sourceRole + '"'); databaseCreated = true
  assert.equal(optionalMetadata('image', baseAlias.reference), null)
  const originalMain = optionalMetadata('image', image)
  assert.equal(originalMain.Id, image)
  baseAlias.originalTags = originalMain.RepoTags ?? []
  assert(baseAlias.originalTags.length > 0, 'The immutable current Main must retain an existing repository tag')
  baseAlias.created = true; await recordResources()
  await run('docker', ['tag', image, baseAlias.reference])
  assert.equal(value('docker', ['image', 'inspect', '--format', '{{.Id}}', baseAlias.reference]), image)
  assert.equal(optionalMetadata('image', tag), null); imageCreated = true
  await run('docker', ['build', '--pull=false', '--label', 'codex.owner=' + owner, '--tag', tag, context])
  assert.equal(value('docker', ['image', 'inspect', '--format', '{{.Id}}', baseAlias.reference]), image)
  assert.equal(value('docker', ['image', 'inspect', '--format', '{{.Id}}', flags.get('--current-image')]), image)
  assert.equal(optionalMetadata('container', registry), null); registryCreated = true
  await run('docker', ['run', '-d', '--name', registry, '--label', 'codex.owner=' + owner, '--publish', flags.get('--gateway') + '::5000', '--publish', '127.0.0.1::5000', 'registry:2'])
  const mappings = value('docker', ['port', registry, '5000/tcp']).split('\n')
  const gateway = mappings.filter(mapping => mapping.startsWith(flags.get('--gateway') + ':'))
  const loopback = mappings.filter(mapping => mapping.startsWith('127.0.0.1:'))
  assert.equal(gateway.length, 1); assert.equal(loopback.length, 1)
  const host = gateway[0], reference = loopback[0] + '/ci-source37:' + owner
  publishedReference = reference
  await run('docker', ['tag', tag, reference]); await run('docker', ['push', reference])
  const manifestResponse = await fetch('http://' + host + '/v2/ci-source37/manifests/' + owner,
    { headers: { Accept: 'application/vnd.docker.distribution.manifest.v2+json, application/vnd.oci.image.manifest.v1+json' } })
  assert(manifestResponse.ok); const manifestJson = await manifestResponse.text()
  const manifestDigest = createHash('sha256').update(manifestJson).digest('hex')
  const descriptor = JSON.parse(manifestJson)
  assert.equal(descriptor.schemaVersion, 2); assert(descriptor.config?.digest, 'Fixture publication must be a single native image manifest')
  const repoDigest = host + '/ci-source37@sha256:' + manifestDigest
  const configResponse = await fetch('http://' + host + '/v2/ci-source37/blobs/' + descriptor.config.digest)
  assert(configResponse.ok); const configJson = await configResponse.text()
  assert.equal('sha256:' + createHash('sha256').update(configJson).digest('hex'), descriptor.config.digest)
  const oci = JSON.parse(configJson); assert.equal(oci.os + '/' + oci.architecture, 'linux/' + architecture)
  await json(join(generated, 'oci-image-binding.json'), { platform: { os: 'linux', architecture }, imageReference: repoDigest,
    configImageId: descriptor.config.digest, runtimeImageIds: [repoDigest, 'docker-pullable://' + repoDigest, 'containerd://' + descriptor.config.digest, descriptor.config.digest], manifestJson, configJson })
  const kubeconfig = join(out, 'kubeconfig.private'), kindConfig = join(out, 'kind-config.yaml')
  await writeFile(kindConfig, dump({ kind: 'Cluster', apiVersion: 'kind.x-k8s.io/v1alpha4', nodes: [{ role: 'control-plane',
    image: lock.kindNodeImage, extraMounts: [{ hostPath: storage, containerPath: '/pe-ci-data/storage' },
      { hostPath: bin, containerPath: '/usr/local/bin/pe-ci-gvisor', readOnly: true }],
    kubeadmConfigPatches: ['kind: ClusterConfiguration\napiServer:\n  extraArgs:\n    service-node-port-range: "30000-32767"'],
  }], containerdConfigPatches: ['[plugins."io.containerd.grpc.v1.cri".containerd.runtimes.runsc]\n  runtime_type="io.containerd.runsc.v1"\n  [plugins."io.containerd.grpc.v1.cri".containerd.runtimes.runsc.options]\n    TypeUrl="io.containerd.runsc.v1.options"\n    ConfigPath="/usr/local/bin/pe-ci-gvisor/runsc-shim.toml"\n',
    '[plugins."io.containerd.grpc.v1.cri".registry.mirrors."' + host + '"]\n endpoint=["http://' + host + '"]\n'] }), { flag: 'wx', mode: 0o600 })
  assert(!value(kind, ['get', 'clusters']).split('\n').includes(cluster)); clusterCreated = true
  await run(kind, ['create', 'cluster', '--name', cluster, '--config', kindConfig, '--kubeconfig', kubeconfig, '--wait', '120s'])
  await chmod(kubeconfig, 0o600)
  const node = value(kind, ['get', 'nodes', '--name', cluster])
  assert.equal(node, cluster + '-control-plane'); ownedKindNode(); await recordResources()
  // Containerd locates its shim through PATH; preserve the complete sidecar directory next to runsc.
  await run('docker', ['exec', node, 'ln', '-s', '/usr/local/bin/pe-ci-gvisor/containerd-shim-runsc-v1', '/usr/local/bin/containerd-shim-runsc-v1'])
  await run('docker', ['exec', node, 'ln', '-s', '/usr/local/bin/pe-ci-gvisor/runsc', '/usr/local/bin/runsc'])
  const kubectl = args => run(kubectlFile, ['--kubeconfig', kubeconfig, ...args])
  for (const key of ['controller-crd', 'controller', 'controller-rbac']) {
    const file = join(out, key + '.yaml'); await download(key, lock.downloads[key], file)
    let text = await readFile(file, 'utf8')
    if (key === 'controller') {
      const documents = loadAll(text)
      const deployment = documents.find(document => document?.kind === 'Deployment')
      assert(deployment)
      const container = deployment.spec.template.spec.containers.find(container => container.name === 'agent-sandbox-controller')
      assert(container); container.image = lock.controllerImage
      text = documents.map(document => dump(document)).join('---\n')
    }
    await writeFile(file, text); await kubectl(['apply', '-f', file])
  }
  await kubectl(['wait', '--for=condition=Established', 'crd/sandboxes.agents.x-k8s.io', '--timeout=120s'])
  await kubectl(['rollout', 'status', 'deployment/agent-sandbox-controller', '-n', 'agent-sandbox-system', '--timeout=120s'])
  const runtime = join(out, 'runtimeclass.yaml'); await writeFile(runtime, 'apiVersion: node.k8s.io/v1\nkind: RuntimeClass\nmetadata:\n  name: gvisor\nhandler: runsc\n', { flag: 'wx', mode: 0o600 }); await kubectl(['apply', '-f', runtime])
  const common = { owner, hostUid, hostGid, hostOut: out, hostAdminFile: resolve(flags.get('--admin-url-file')), sourceName, sourceCommit: lock.sourceCommit, sourceRoot: '/opt/pe-ci-original', targetRoot: '/opt/power-evolve',
    sourceUrl: sourceUrl.href, password: randomBytes(32).toString('hex'), actorFile: '/pe-ci-data/generated/actors.json', dataRoot: '/pe-ci-data/storage/shared',
    kubeconfig: '/pe-ci-data/kubeconfig.private', image: JSON.parse(await readFile(join(generated, 'oci-image-binding.json'), 'utf8')) }
  await json(join(parameters, 'bootstrap.json'), common)
  const mounts = ['--mount', 'type=bind,source=' + out + ',target=/pe-ci-data']
  const role = async (name) => {
    const directory = join(generated, name); await mkdir(directory, { mode: 0o700 })
    const container = 'pe-ci-producer-' + name + '-' + owner
    assert.equal(optionalMetadata('container', container), null); producerContainers.push(container)
    await recordResources()
    await run('docker', ['run', '--name', container, '--label', 'codex.owner=' + owner, '--network', 'host', '--user', '0:0', ...mounts,
      '--env', 'NODE_OPTIONS=--import=tsx/esm', '--env', 'NODE_V8_COVERAGE=/pe-ci-data/generated/' + name + '/v8', tag,
      'node', 'apps/cli/lib/bin.js', '--profile', 'pe-ci-' + name])
    const actual = optionalMetadata('container', container)
    containerIds[container] = actual.Id; await recordResources()
    assert.equal(actual.Config.Labels['codex.owner'], owner)
    assert.equal(actual.State.Running, false); assert.equal(actual.State.ExitCode, 0); assert.equal(actual.State.OOMKilled, false)
    await json(join(generated, name, 'natural-exit.json'), { owner, containerId: actual.Id, exitCode: actual.State.ExitCode,
      OOMKilled: actual.State.OOMKilled, startedAt: actual.State.StartedAt, finishedAt: actual.State.FinishedAt })
    await run('docker', ['rm', actual.Id])
  }
  await role('bootstrap')
  const actors = JSON.parse(await readFile(join(generated, 'actors.json'), 'utf8'))
  const limits = { runtimeMs: 10000, requestMs: 2000, stdinGraceMs: 0, terminateGraceMs: 100, killGraceMs: 1000,
    maxInputBytes: 65536, maxMessageBytes: 8192, maxProtocolBytes: 131072, maxProtocolMessages: 100, maxJsonDepth: 32,
    maxJsonNodes: 5000, maxPages: 10, maxTools: 20, maxCatalogBytes: 16384, maxToolBytes: 8192, maxResultBytes: 8192, maxStderrBytes: 1024 }
  for (const name of ['stdio', 'resolution']) {
    await json(join(parameters, name + '.json'), { ...common, ...actors[name], root: '/pe-ci-data/generated/' + name,
      limits, management: { maxNameBytes: 80, pageItems: 10, maxConnections: 10 }, commandTimeoutMs: 20000 })
    await role(name)
  }
  await json(join(parameters, 'seal.json'), { ...common, adminUrl: adminUrl.href, hostUid, hostGid })
  assert.equal(optionalMetadata('container', sealedContainer.name), null)
  sealedContainer.imageId = value('docker', ['image', 'inspect', '--format', '{{.Id}}', tag])
  producerContainers.push(sealedContainer.name); await recordResources()
  await run('docker', ['create', '--name', sealedContainer.name, '--label', 'codex.owner=' + owner,
    '--network', 'host', '--user', '0:0', ...mounts, '--env', 'NODE_OPTIONS=', sealedContainer.imageId,
    'node', '/opt/pe-ci-producer/seal-current.mjs', '/pe-ci-data/parameters/seal.json'])
  const createdSeal = optionalMetadata('container', sealedContainer.name); assertSealedContainer(createdSeal)
  assert.equal(createdSeal.State.Status, 'created'); assert.equal(createdSeal.State.Running, false)
  sealedContainer.id = createdSeal.Id; containerIds[sealedContainer.name] = createdSeal.Id; await recordResources()
  await run('docker', ['start', '--attach', sealedContainer.id])
  const finishedSeal = optionalMetadata('container', sealedContainer.id); assertSealedContainer(finishedSeal)
  assert.equal(finishedSeal.State.Running, false); assert.equal(finishedSeal.State.ExitCode, 0)
  assert.equal(finishedSeal.State.OOMKilled, false)
  await json(join(out, 'seal-natural-exit.json'), { owner, containerId: finishedSeal.Id, exitCode: 0,
    OOMKilled: false, startedAt: finishedSeal.State.StartedAt, finishedAt: finishedSeal.State.FinishedAt })
  assert((await lstat(join(out, 'maintenance-fixture.json'))).isFile())
  published = true
  await json(join(out, 'producer-terminal.json'), { sourceCommit: lock.sourceCommit, sourceName, owner,
    architecture, currentImageId: image, helperImageId: value('docker', ['image', 'inspect', '--format', '{{.Id}}', tag]),
    source37CompatibilityOnly: true, oldLibLoaded: false, currentBuiltCaptureAndBootstrap: true })
  console.log(JSON.stringify({ prepared: true, fixtureFile: join(out, 'maintenance-fixture.json') }))
} finally {
  try {
    for (const name of producerContainers) {
      const actual = optionalMetadata('container', containerIds[name] ?? name)
      if (!actual) continue
      assert.equal(actual.Config.Labels['codex.owner'], owner)
      assert.equal(actual.Name, '/' + name)
      if (name === sealedContainer.name) {
        assertSealedContainer(actual); sealedContainer.id ??= actual.Id
      }
      containerIds[name] ??= actual.Id; await recordResources()
      if (actual.State.Running) await run('docker', ['stop', '--time', '40', actual.Id])
      const stopped = optionalMetadata('container', actual.Id)
      assert.equal(stopped.Id, actual.Id); assert.equal(stopped.State.Running, false)
      await run('docker', ['rm', actual.Id])
      assert.equal(optionalMetadata('container', actual.Id), null)
    }
    if (clusterCreated) {
      ownedKindNode(); await recordResources()
      await run(kind, ['delete', 'cluster', '--name', cluster])
      assert.equal(ownedKindNode(), null)
      for (const id of kindNodeIds) assert.equal(optionalMetadata('container', id), null)
    }
    if (registryCreated) {
      const actual = optionalMetadata('container', registry)
      if (actual) { assert.equal(actual.Config.Labels['codex.owner'], owner); if (actual.State.Running) await run('docker', ['stop', actual.Id]); await run('docker', ['rm', actual.Id]) }
    }
    assert.equal(value('docker', ['container', 'ls', '--all', '--filter', 'label=codex.owner=' + owner, '--format', '{{.ID}}']), '')
    assert.equal(value('docker', ['container', 'ls', '--all', '--filter', 'label=io.x-k8s.kind.cluster=' + cluster,
      '--format', '{{.ID}}']), '')
    const storageStat = await lstat(storage, { bigint: true })
    const holderStat = await lstat(out, { bigint: true })
    const disposalRequest = join(out, 'storage-cleanup-request.json')
    await json(disposalRequest, { format: 'power-evolve-owned-storage-disposal', purpose: 'destruction-only-not-writer-qualification',
      owner, hostUid, hostGid, hostOut: out, storageIdentity: { dev: storageStat.dev.toString(), ino: storageStat.ino.toString(),
        uid: Number(storageStat.uid), gid: Number(storageStat.gid), mode: Number(storageStat.mode & 0o777n) },
      outIdentity: { dev: holderStat.dev.toString(), ino: holderStat.ino.toString(), uid: Number(holderStat.uid),
        gid: Number(holderStat.gid), mode: Number(holderStat.mode & 0o777n) },
      containers: producerContainers.map(name => ({ name, id: containerIds[name] ?? null, gone: true })),
      cluster: { name: cluster, nodeIds: kindNodeIds, gone: true } })
    const disposal = 'pe-ci-storage-cleanup-' + owner
    let disposalId = null
    assert.equal(optionalMetadata('container', disposal), null)
    await json(join(out, 'storage-cleanup-container.json'), { owner, name: disposal, imageId: image })
    try {
      await run('docker', ['create', '--name', disposal, '--label', 'codex.owner=' + owner, '--network', 'none',
        '--read-only', '--user', '0:0', '--entrypoint', 'node', '--env', 'NODE_OPTIONS=',
        '--mount', 'type=bind,source=' + out + ',target=/pe-ci-cleanup/out',
        '--mount', 'type=bind,source=' + disposalRequest + ',target=/pe-ci-cleanup/request.json,readonly',
        '--mount', 'type=bind,source=' + disposalScript + ',target=/pe-ci-cleanup/cleanup-storage.mjs,readonly',
        image, '/pe-ci-cleanup/cleanup-storage.mjs'])
      const cleanup = optionalMetadata('container', disposal)
      assert.equal(cleanup.Name, '/' + disposal)
      assert.equal(cleanup.Config.Labels['codex.owner'], owner); assert.equal(cleanup.Image, image)
      assert.equal(cleanup.State.Status, 'created'); assert.equal(cleanup.State.Running, false)
      disposalId = cleanup.Id
      await writeFile(join(out, 'storage-cleanup-container.json'), JSON.stringify({ owner, name: disposal,
        containerId: cleanup.Id, imageId: image }) + '\n')
      await run('docker', ['start', '--attach', cleanup.Id])
      const finished = optionalMetadata('container', cleanup.Id)
      assert.equal(finished.Id, cleanup.Id); assert.equal(finished.State.Running, false)
      assert.equal(finished.State.ExitCode, 0); assert.equal(finished.State.OOMKilled, false)
      await json(join(out, 'storage-cleanup.json'), { owner, containerId: finished.Id, exitCode: 0,
        OOMKilled: false, usedAsWriterStopQualification: false })
    } finally {
      const cleanup = optionalMetadata('container', disposalId ?? disposal)
      if (cleanup) {
        assert.equal(cleanup.Name, '/' + disposal)
        if (disposalId !== null) assert.equal(cleanup.Id, disposalId)
        assert.equal(cleanup.Config.Labels['codex.owner'], owner); assert.equal(cleanup.Image, image)
        if (cleanup.State.Running) await run('docker', ['stop', '--time', '40', cleanup.Id])
        assert.equal(optionalMetadata('container', cleanup.Id).State.Running, false)
        await run('docker', ['rm', cleanup.Id])
      }
    }
    if (imageCreated) {
      const actual = optionalMetadata('image', tag)
      if (actual) { assert.equal(actual.Config.Labels['codex.owner'], owner); await run('docker', ['image', 'rm', tag, ...publishedReference && optionalMetadata('image', publishedReference) ? [publishedReference] : []]) }
    }
    if (!published && databaseCreated) await admin.query('DROP DATABASE "' + sourceName + '"')
    if (!published && roleCreated) await admin.query('DROP ROLE "' + sourceRole + '"')
  } finally {
    try {
      if (baseAlias.created) {
        const actual = optionalMetadata('image', baseAlias.reference)
        if (actual) {
          assert.equal(actual.Id, image)
          for (const reference of baseAlias.originalTags) {
            assert.equal(value('docker', ['image', 'inspect', '--format', '{{.Id}}', reference]), image)
          }
          await run('docker', ['image', 'rm', baseAlias.reference])
        }
        assert.equal(optionalMetadata('image', baseAlias.reference), null)
        assert.equal(value('docker', ['image', 'inspect', '--format', '{{.Id}}', image]), image)
        await json(join(out, 'base-alias-cleanup.json'), { owner, reference: baseAlias.reference,
          currentImageId: image, removedOnlyOwnedAlias: true, originalMainTagsPreserved: true })
      }
    } finally { await admin.end() }
  }
}
