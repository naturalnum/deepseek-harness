/** Assemble only new private inputs. Never invokes Docker, mount, a socket or an old profile. */
import fs from 'node:fs'
import path from 'node:path'
import { createHash, randomBytes, randomUUID } from 'node:crypto'
import { createRequire } from 'node:module'
import { pathToFileURL } from 'node:url'
const need = (value, message) => { if (!value) throw new Error(message) }
const hash = bytes => createHash('sha256').update(bytes).digest('hex')
const absolute = value => { need(typeof value === 'string' && value.startsWith('/') && path.posix.normalize(value) === value
  && !/[\0\r\n,:]/.test(value), 'Canonical absolute new input path required'); return value }
const integer = value => { need(Number.isSafeInteger(value) && value > 0 && value <= 2147483647, 'Explicit finite integer required'); return value }
const image = value => { need(typeof value === 'string' && /^sha256:[0-9a-f]{64}$/.test(value), 'Actual immutable supplier digest required'); return value }
const read = (file, maximum = 1048576) => { const info = fs.lstatSync(file)
  need(info.isFile() && !info.isSymbolicLink() && info.nlink === 1 && info.size > 0 && info.size <= maximum, 'Bounded ordinary new input required')
  return fs.readFileSync(file) }
const pinned = reference => { const bytes = read(absolute(reference.path)); need(hash(bytes) === reference.sha256, 'Pinned public/new source changed'); return bytes }
const options = {}, args = process.argv.slice(2)
while (args.length) { const key = args.shift(), value = args.shift()
  need(['--input', '--sha256', '--output-dir', '--check-only'].includes(key) && value !== undefined && options[key] === undefined, 'Exact assembly arguments required')
  options[key] = value }
need(options['--check-only'] === undefined || options['--check-only'] === 'true', 'Only explicit check-only true is permitted')
const checkOnly = options['--check-only'] === 'true'
need(checkOnly || process.platform === 'linux' && process.getuid() === 0, 'Only the executing Root writes new private SDK inputs')
const raw = read(absolute(options['--input']))
need(hash(raw) === options['--sha256'], 'Pin the exact new assembly parameters')
const input = JSON.parse(raw)
need(input.schema === 'dsh-science-sdk-assembly/v2' && !/REQUIRED_NEW|__PLACEHOLDER__/.test(raw.toString('utf8')), 'Complete actual new SDK assembly inputs required')
const output = absolute(options['--output-dir'])
need(!fs.existsSync(output), 'Only a new private output directory is permitted')
for (const ref of Object.values(input.publicSources)) pinned(ref)
const expectedSources = {"config": "aa59b60b3a65a83a6877c82c02cf8db380ea51b388ea47fcdfa4534f08a4fc42", "dockerService": "8d255753184dd56dd41ab05f02ade5131fea7ca1f9690b401a692a703400f24b", "containerOps": "7f1cb5e0309fb568528ea6e86ba88f639c3e8cd6253d19fbb2129f59eca4602b", "deletionCompletion": "96496b09fdb4b5bf094cb34c96b24671f2ae2679a9e06234a50ad85a6ebc35a4", "originalCompletion": "48828236e1a23684fcbaffc417b89014e3248494255a585aebbdbff14e9ff088", "nativeSeccomp": "80ca9cc186fe92d45ddf4e58e9dfc2ebb0332a4ffad8c4f858bccc9d66875ccd"}
for (const [key, sha256] of Object.entries(expectedSources)) need(input.publicSources[key]?.sha256 === sha256, "Exact retained Native SDK source required: " + key)
const seccomp = pinned(input.publicSources.nativeSeccomp).toString("utf8"); JSON.parse(seccomp)
const candidateSource = pinned(input.supplierCompletionSource).toString("utf8")
const workload=image(input.images.workload),server=image(input.images.server)
need((workload === "sha256:32c17c742af43a6d9c89c69441fbc543751af41b0f61bf8294ed00ac3a4df62f" && server === "sha256:e4fc713db05339d41b70215f2ffdbc1c37f8948b92c949eb4cd2c164ce90038a")
  || (workload === "sha256:6f1b2bc9a315d612dfd211e40e545d80593cd19bb43a26f2dc24e1eaa86a73b8" && server === "sha256:66ee3b642097f325f2338603f88fdcd865b9f8a99cfc37dfdd0ee0934f7d6e40"), "Only an exact reviewed Native pair is selected")
const originalCompletion=pinned(input.publicSources.originalCompletion).toString("utf8")
const before="NATIVE_AMD64_IMAGE = 'sha256:84d3c8cd1520dfb2b088f9d3dbd296f4d18fabed3b18fb0aea01e6e378f9d5eb'"
need(originalCompletion.split(before).length === 2 && candidateSource === originalCompletion.replace(before,"NATIVE_AMD64_IMAGE = '"+workload+"'"), "Only the exact Native selector may change; original guards remain byte-identical")
const require = createRequire(pathToFileURL(absolute(input.installAnchor)))
const { parseStorageDeploymentPlan } = await import(pathToFileURL(require.resolve('@deepseek-ai/dsh-pe-cloud-files/root')).href)
const { parseRootDeploymentInput } = await import(pathToFileURL(require.resolve('@deepseek-ai/dsh-pe-opensandbox')).href)
const planBytes = pinned(input.plan), plan = parseStorageDeploymentPlan(planBytes, 4096)
need(plan.version === 3 && plan.slots.length === 3 && plan.maxAccounts === 3, 'A measured three-slot v3 physical plan is required')
need(input.plan.finalPath === '/run/dsh-feature-root/storage-plan.json' && plan.baseConfigPath === '/opt/dsh-features/account-base.yml', 'Use the launcher original final plan/base paths')
const domains = plan.slots.flatMap(slot => {
  need(slot.environmentBank.mode === 'session-directories' && slot.environmentBank.slots.length === 1 && /^slot-[01]$/.test(slot.environmentBank.slots[0].slotId), 'Exactly one preallocated Session-directory environment per account is required')
  return [{ role: 'project', domain: slot.projects }, { role: 'environment', domain: slot.environmentBank.slots[0].domain }]
})
const allowed = domains.map(row => row.domain.rootPath)
need(allowed.length === 6 && new Set(allowed).size === 6
  && !allowed.some(value => plan.slots.some(slot => value === slot.private.rootPath || value.startsWith(slot.private.rootPath + '/'))), 'Only three project and three environment domains may be exposed')
const backend = input.backend
need(backend.dataRoot === '/backend-store', 'Only this run isolated backend data root is permitted')
need(/^[0-9a-f]{64}$/.test(backend.containerId) && backend.generation.backendId === backend.containerId
  && Number.isSafeInteger(backend.generation.pid) && backend.generation.pid > 1
  && /^[0-9]{1,20}$/.test(backend.generation.startTicks) && /^mnt:\[[0-9]{1,20}\]$/.test(backend.generation.mountNamespace), 'Actual original backend dockerd generation required')
need(backend.socket.path === '/run/backend/docker.sock' && Number.isSafeInteger(backend.socket.device) && backend.socket.device >= 0
  && Number.isSafeInteger(backend.socket.inode) && backend.socket.inode > 0, 'Actual backend Unix socket identity required')
need(backend.engineEndpoint === 'unix:///run/backend/docker.sock', 'Create the SDK only through this run inner Docker engine')
const sdk = input.sdk, limits = input.limits
integer(sdk.listenPort); integer(sdk.workloadPidsLimit); integer(sdk.serverMemoryMiB); integer(sdk.serverPidsLimit)
need(sdk.listenPort <= 65535 && /^\d+\.\d+\.\d+\.\d+$/.test(sdk.backendIpv4), 'Actual new SDK backend IPv4/port required')
const endpoint = new URL(sdk.lifecycleBaseUrl)
need(endpoint.href === sdk.lifecycleBaseUrl && endpoint.protocol === 'http:' && endpoint.hostname === sdk.backendIpv4
  && Number(endpoint.port || '80') === sdk.listenPort && endpoint.pathname === '/v1' && !endpoint.username && !endpoint.password && !endpoint.search && !endpoint.hash,
  'SDK URL must reach this new backend network namespace directly')
absolute(sdk.backendWorkPath); absolute(sdk.backendIsolationPath)
need(!allowed.some(root => sdk.backendWorkPath === root || sdk.backendWorkPath.startsWith(root + '/')),
  'Controller state must not be placed in an account public domain')
// The native search consumer executes this exact public program path in AgentData's read-only world.
const searchRequire = createRequire(path.join(path.dirname(input.installAnchor), 'packages/fs/tool-fs-search/package.json'))
const searchProgramPath = absolute(searchRequire('@vscode/ripgrep').rgPath)
const searchProgramBytes = read(searchProgramPath, 16777216)
need(hash(searchProgramBytes) === '193906679498de4d939345b937fa24e0e69a03c244bd70c859f5e41232713f21'
  && searchProgramBytes.subarray(0, 4).equals(Buffer.from([127, 69, 76, 70]))
  && searchProgramBytes.readUInt16LE(18) === 62, 'Exact installed Linux x64 native search program required')
const searchProgramName = 'ripgrep-linux-x64-1.18.0.public'
const backendSearchProgramPath = sdk.backendWorkPath + '/' + searchProgramName
const apiKey = randomBytes(32).toString('hex'), execdToken = randomBytes(32).toString('hex'), identity = 'science-' + randomUUID()
const policy = { version: 2, generation: backend.generation, socket: backend.socket, image: workload,
  entrypoint: ['/usr/bin/tail', '-f', '/dev/null'], platform: 'amd64', apiKeySha256: hash(apiKey), admitCreates: true, historical: [], storageMode: 'shared-path' }
const policyBytes = JSON.stringify(policy, null, 2) + '\n', policySha = hash(policyBytes)
const config = { server: { host: '0.0.0.0', port: sdk.listenPort, api_key: apiKey, limit_concurrency: 128,
    thread_pool_size: 32, timeout_graceful_shutdown: 10, max_sandbox_timeout_seconds: 600 },
  proxy: { resolve_internal: true }, log: { level: 'WARNING' }, runtime: { type: 'docker', execd_image: image(input.images.execd), execd_run_as_init: true },
  store: { type: 'sqlite', path: '/work/control.db' }, storage: { allowed_host_paths: allowed },
  docker: { native_bwrap_profile: true, api_timeout: 2, network_mode: 'bridge', host_ip: sdk.backendIpv4, publish_host: '0.0.0.0',
    port_range_min: 40000, port_range_max: 60000, no_new_privileges: true, pids_limit: sdk.workloadPidsLimit,
    drop_capabilities: ['AUDIT_WRITE', 'MKNOD', 'NET_ADMIN', 'NET_RAW', 'SYS_ADMIN', 'SYS_MODULE', 'SYS_PTRACE', 'SYS_TIME', 'SYS_TTY_CONFIG'],
    seccomp_profile: seccomp, deletion_completion_policy: '/work/deletion-completion-policy.json', deletion_completion_sha256: policySha,
    sandbox_binds: [sdk.backendIsolationPath + ':/etc/dsh-native-isolation.toml:ro',
      backendSearchProgramPath + ':' + searchProgramPath + ':ro'],
    sandbox_env: { EXECD_ACCESS_TOKEN: execdToken, EXECD_ISOLATION_CONFIG: '/etc/dsh-native-isolation.toml' } }, ingress: { mode: 'direct' } }
const lines = []
const scalar = value => typeof value === 'string' ? JSON.stringify(value) : Array.isArray(value) ? '[' + value.map(scalar).join(',') + ']' : JSON.stringify(value)
function table(value, keys = []) {
  if (keys.length) lines.push('[' + keys.join('.') + ']')
  for (const [key, item] of Object.entries(value)) if (item === null || typeof item !== 'object' || Array.isArray(item)) lines.push(key + '=' + scalar(item))
  for (const [key, item] of Object.entries(value)) if (item !== null && typeof item === 'object' && !Array.isArray(item)) table(item, [...keys, key])
}
table(config)
const toml = lines.join('\n') + '\n'
// Execd runs only Root's pinned prep/loader. AgentData owns the ordinary UID/capability/seccomp/bwrap boundary.
// Applying the user-process floor here denies Root's private claim and namespace construction.
const isolation = { allowed_writable: [...domains.filter(row => row.role === 'project').map(row => row.domain.rootPath), '/opt/session-env'],
  upper_max_bytes: integer(sdk.isolationUpperMaxBytes), hardening: { enabled: false }, landlock: { enabled: false } }
lines.length = 0; table(isolation); const isolationToml = lines.join('\n') + '\n'
const deployment = { schema: 'pe-opensandbox-root-deployment-v2', selection: { serverImageDigest: server,
    execdImageDigest: input.images.execd, apiKeyDeploymentIdentity: identity },
  lifecycle: { ...limits.lifecycle, lifecycleBaseUrl: sdk.lifecycleBaseUrl, apiKey, deploymentIdentity: identity,
    environmentVersion: input.environmentVersion, provider: input.provider, imageDigest: workload, payloadSha256: input.payloadSha256,
    entrypoint: ['/usr/bin/tail', '-f', '/dev/null'], platform: 'amd64' },
  bootstrap: { ...limits.bootstrap, execdAccessToken: execdToken, agentPort: 8080 }, skillCopies: { maxCopiesPerOperation: 8 },
  storage: { mode: 'shared-path', plan: { path: input.plan.finalPath, sha256: input.plan.sha256 }, limits: limits.storage } }
parseRootDeploymentInput(deployment)
need(deployment.lifecycle.maxRecords >= 40 && deployment.bootstrap.maxRecords >= 40, 'The original 40-allocation inventory must remain bounded and retainable')
const deploymentBytes = JSON.stringify(deployment, null, 2) + '\n'
const mounts = [{ Type: 'bind', Source: sdk.backendWorkPath, Target: '/work', ReadOnly: false },
  { Type: 'bind', Source: '/proc', Target: '/owner-observation/proc', ReadOnly: true },
  { Type: 'bind', Source: '/sys/fs/cgroup', Target: '/owner-observation/cgroup', ReadOnly: true },
  { Type: 'bind', Source: backend.socket.path, Target: backend.socket.path, ReadOnly: false },
  ...allowed.map(root => ({ Type: 'bind', Source: root, Target: root, ReadOnly: false }))]
for (const name of ['config.toml', 'deletion-completion-policy.json', 'verify-science-sdk-v2.py', 'SDK-CONTRACT.json']) {
  mounts.push({ Type: 'bind', Source: sdk.backendWorkPath + '/' + name, Target: '/work/' + name, ReadOnly: true })
}
const create = { Image: server, User: '0:0', Env: ['HOME=/work', 'DOCKER_HOST=unix:///run/backend/docker.sock', 'PYTHONDONTWRITEBYTECODE=1'],
  Entrypoint: ['/bin/sh'], Cmd: ['-eu', '-c', 'python /work/verify-science-sdk-v2.py --check-views && exec opensandbox-server --config /work/config.toml'],
  WorkingDir: '/work', HostConfig: { NetworkMode: 'host', PidMode: 'host',
    Mounts: mounts, CapAdd: ['SYS_PTRACE'], SecurityOpt: ['no-new-privileges=true'], Memory: sdk.serverMemoryMiB * 1048576, PidsLimit: sdk.serverPidsLimit,
    Tmpfs: { '/tmp': 'rw,nosuid,nodev,size=67108864,mode=1777' } }, Labels: { 'dsh.feature': 'isolated-science-sdk-20261107', 'pe.integration': 'ea8d7f50-19df-41f2-87b5-76f62983e47e' } }
const requirements = { schema: 'dsh-science-sdk-mount-requirements/v2', backendId: backend.containerId, engineEndpoint: backend.engineEndpoint,
  domainTargets: domains.map(({ role, domain }) => ({ role, path: domain.rootPath, backing: domain.backing,
    expectedDevice: domain.rootDevice, expectedRootInode: domain.rootInode, minimumBytes: domain.minimumBytes, maximumBytes: domain.maximumBytes, minimumInodes: domain.minimumInodes, maximumInodes: domain.maximumInodes })),
  backendIsolationPath: sdk.backendIsolationPath, backendWorkPath: sdk.backendWorkPath,
  publicPrograms: [{ sourcePath: searchProgramPath, backendPath: backendSearchProgramPath, destinationPath: searchProgramPath,
    bytes: searchProgramBytes.length, sha256: hash(searchProgramBytes), mode: '0555', readOnly: true }],
  workDomain: { path: sdk.backendWorkPath, filesystem: 'tmpfs', bytes: 33554432, inodes: 1024, uid: 0, mode: '0700',
    rootHeld: true, mountOptions: 'rw,nosuid,nodev,size=33554432,nr_inodes=1024,mode=0700,uid=0,gid=0',
    retirement: 'Retain this original domain, including unknown records, until all original terminal releases and selected-server exit are actually confirmed.' },
  instructions: 'Root must bind these six original physical domains at exactly these backend paths before creating the SDK server. Compare actual filesystem/backing identity; application namespace mount IDs need not match. No private/control/backing parent mounts.',
  provisioned: false }
const verifierBytes = pinned(input.verifier)
const contract = { schema: 'dsh-new-scientific-sdk-contract/v2', sourcePins: {
    'config.py': input.publicSources.config.sha256, 'services/docker/docker_service.py': input.publicSources.dockerService.sha256,
    'services/docker/container_ops.py': input.publicSources.containerOps.sha256,
    'services/docker/deletion_completion.py': input.publicSources.deletionCompletion.sha256,
    'services/docker/completion_view.py': input.supplierCompletionSource.sha256 },
  workDomain: { path: '/work', source: sdk.backendWorkPath, bytes: 33554432, inodes: 1024, mode: '0700', uid: 0, rootHeld: true },
  generation: backend.generation, socket: backend.socket, workloadImageDigest: workload, configSha256: hash(toml),
  policySha256: policySha, allowedHostPaths: allowed, domains: requirements.domainTargets }

const receipt = { schema: 'dsh-science-sdk-assembly-result/v2', engineEndpoint: backend.engineEndpoint, policySha256: policySha, rootDeploymentSha256: hash(deploymentBytes),
  storagePlanSha256: input.plan.sha256, serverConfigSha256: hash(toml), isolationSha256: hash(isolationToml), backendId: backend.containerId,
  workloadImageDigest: workload, serverImageDigest: server, allowedHostPaths: allowed, credentialsGenerated: true, secretsPrinted: false,
  workDomain: { path: '/work', source: sdk.backendWorkPath, bytes: 33554432, inodes: 1024, rootHeld: true,
    retirement: 'All original terminal releases and selected-server exit must actually settle before Root retires the domain.' },
  originalRootDeploymentParserPassed: true, originalSdkModelValidationPending: true, backendViewValidationPending: true,
  dockerExecuted: false, mounted: false, applicationStarted: false }
if (checkOnly) { process.stdout.write(JSON.stringify({ status: 'assembly-checked-no-write', originalRootDeploymentParserPassed: true,
  allowedHostPaths: allowed.length, sdkModelValidationPending: true, dockerExecuted: false }) + '\n'); process.exit(0) }
fs.mkdirSync(output, { mode: 0o700 })
const write = (name, bytes, mode = 0o600) => { const fd = fs.openSync(path.join(output, name), 'wx', mode)
  try { fs.writeFileSync(fd, bytes); fs.fchownSync(fd, 0, 0); fs.fchmodSync(fd, mode); fs.fsyncSync(fd) } finally { fs.closeSync(fd) } }
write(searchProgramName, searchProgramBytes, 0o555)
write('SDK-CONTRACT.json', JSON.stringify(contract, null, 2) + '\n', 0o444)
write('config.toml', toml); write('deletion-completion-policy.json', policyBytes, 0o400); write('isolation.toml', isolationToml, 0o444)
write('rootDeployment.json', deploymentBytes); write('verify-science-sdk-v2.py', verifierBytes, 0o444)
write('sdk-container-create.private.json', JSON.stringify(create, null, 2) + '\n')
write('SDK-CREATE-REQUEST.private.json', JSON.stringify({ engineEndpoint: backend.engineEndpoint,
  backendId: backend.containerId, method: 'POST', path: '/containers/create', bodyFile: 'sdk-container-create.private.json',
  instructions: 'Root submits this body only to the inner Docker engine. No outer Docker PID namespace, root view or image is used.' }, null, 2) + '\n')
write('BACKEND-MOUNTS.private.json', JSON.stringify(requirements, null, 2) + '\n')
write('ASSEMBLY.json', JSON.stringify(receipt, null, 2) + '\n')
process.stdout.write(JSON.stringify({ status: 'new-private-sdk-inputs-assembled-not-started', outputDirectory: output,
  rootDeploymentSha256: receipt.rootDeploymentSha256, policySha256: policySha, secretsPrinted: false, dockerExecuted: false }) + '\n')
