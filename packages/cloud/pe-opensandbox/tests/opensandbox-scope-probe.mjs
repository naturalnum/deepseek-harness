/** One explicitly authorized M4 experiment; native APIs only, never a product provider. */
import { spawnSync } from 'node:child_process'
import { createHash, randomBytes, randomUUID } from 'node:crypto'
import { chmod, mkdir, mkdtemp, readFile, rm, writeFile } from 'node:fs/promises'
import { createRequire } from 'node:module'
import { dirname, join, resolve } from 'node:path'
import { fileURLToPath, pathToFileURL } from 'node:url'
import { setTimeout as delay } from 'node:timers/promises'

const args = new Map()
for (let i = 2; i < process.argv.length; i += 2) args.set(process.argv[i], process.argv[i + 1])
for (const key of ['--workspace-root', '--sdk-root', '--out']) {
  if (!args.get(key)) throw new Error(`required probe argument: ${key}`)
}
const workspaceRoot = resolve(args.get('--workspace-root'))
const sdkRoot = resolve(args.get('--sdk-root'))
const reportPath = resolve(args.get('--out'))
const expected = {
  server: { ref: 'sha256:a03ed486116398931f98b11ec2789fc40677ea2e27f264603e0e92a487163a91', id: 'sha256:a03ed486116398931f98b11ec2789fc40677ea2e27f264603e0e92a487163a91' },
  execd: { ref: 'opensandbox/execd@sha256:1a6fc28b5efe098f6c168ea606dbad6bde2d1fc479329b4c8a6279c82ee02e94', id: 'sha256:39ee9357842bc4a931a208170484ae6d1e33985f5d256b13d654a7c3ce35cbdf' },
  workload: { ref: 'python@sha256:090ba77e2958f6af52a5341f788b50b032dd4ca28377d2893dcf1ecbdfdfe203', id: 'sha256:3a1883e6bd3272095de9407f33bcb0119dcc664e6cff2952cd0931caa8e0bf9f' },
}
const task = `pe-m4-${randomUUID()}`
const label = `pe-m4-task=${task}`
const apiKey = randomBytes(32).toString('hex')
const token = randomBytes(32).toString('hex')
const nonce = randomUUID()
const bounds = Object.freeze({ physicalCreates: 1, innerCreates: 2, cpu: 0.5, memoryMiB: 192, pids: 64, ttlSeconds: 90, controlWatchdogSeconds: 180, controlMemoryMiB: 512, controlCpu: 0.5, controlPids: 128, serviceSeconds: 30, descendantSeconds: 25, maxBytes: 65536, stopObservationMs: 5000 })
const report = { kind: 'm4-one-physical-two-inner-scope-fixture', task, allocationIntentId: randomUUID(), startedAt: new Date().toISOString(), bounds, expectedImages: expected, phases: [], observations: {}, errors: [], allocation: { state: 'not-submitted', createCalls: 0 }, scopes: {}, cleanup: {} }
const owned = new Set()
const scopeHandles = new Map()
const pendingRuns = new Set()
let scratch, serverId, sandbox, physicalId, manifestCreated = false

function docker(argv, allowFailure = false, timeoutMs = 10000) {
  const x = spawnSync('docker', argv, { encoding: 'utf8', timeout: timeoutMs, maxBuffer: 1024 * 1024 })
  if (x.status !== 0 && !allowFailure) throw new Error(`Docker ${argv[0]} failed (${x.error?.name ?? x.status})`)
  return { status: x.status, stdout: x.stdout?.trim() ?? '', stderr: x.stderr?.trim() ?? '' }
}
function inspect(id) {
  const x = docker(['inspect', id], true)
  if (x.status === 0) return JSON.parse(x.stdout)[0]
  if (/no such (object|container)/i.test(x.stderr + x.stdout)) return undefined
  throw new Error('trusted Docker observation failed; absence unknown')
}
function fail(error) {
  return { name: error?.name ?? 'Error', status: error?.status ?? error?.statusCode ?? null,
    message: String(error?.message ?? error).replaceAll(apiKey, '[REDACTED]').replaceAll(token, '[REDACTED]').replaceAll(scratch ?? '\0', '[PRIVATE-SCRATCH]').slice(0, 2400) }
}
function check(condition, message) { if (!condition) throw new Error(message) }
async function persist() { if (manifestCreated) await writeFile(reportPath, JSON.stringify(report, null, 2) + '\n', { mode: 0o600 }) }
async function phase(name) { report.phases.push({ name, at: new Date().toISOString() }); await persist(); process.stdout.write(JSON.stringify({ probe: 'opensandbox-m4', phase: name }) + '\n') }
function py(code) { return ['python3', '-u', '-c', code].map(s => `'${s.replaceAll("'", "'\\''")}'`).join(' ') }

const factsCode = (name, writes) => `import os,pathlib,json,stat,fcntl,ctypes,time,urllib.request
ctypes.CDLL(None).prctl(15,${JSON.stringify(`pe4-facts-${name.toLowerCase()}`)}.encode(),0,0,0)
nonce=${JSON.stringify(nonce)}
if ${writes ? 'True' : 'False'}:
 pathlib.Path('/workspace/shared-marker').write_text(nonce)
 pathlib.Path('/opt/session-env/home/shared-marker').write_text(nonce)
status={}
for line in pathlib.Path('/proc/self/status').read_text().splitlines():
 k,_,v=line.partition(':')
 if k in ['Uid','Gid','Groups','CapInh','CapPrm','CapEff','CapBnd','CapAmb','NoNewPrivs','Seccomp','NSpid']:status[k]=v.strip()
maps={}
for key in ['uid_map','gid_map','setgroups']:
 try:maps[key]=pathlib.Path('/proc/self',key).read_text().strip()
 except OSError as e:maps[key]={'errno':e.errno}
namespaces={k:os.readlink('/proc/self/ns/'+k) for k in ['pid','user','net','mnt','cgroup']}
fds=[]
for name in os.listdir('/proc/self/fd')[:32]:
 try:
  fd=int(name);target=os.readlink('/proc/self/fd/'+name);s=os.fstat(fd)
  kind='pipe' if target.startswith('pipe:') else 'socket' if target.startswith('socket:') else 'anon' if target.startswith('anon_inode:') else 'device' if stat.S_ISCHR(s.st_mode) else 'regular' if stat.S_ISREG(s.st_mode) else 'other'
  fds.append({'fd':fd,'kind':kind,'inode':s.st_ino,'flags':fcntl.fcntl(fd,fcntl.F_GETFL),'descriptorFlags':fcntl.fcntl(fd,fcntl.F_GETFD)})
 except OSError:pass
d={'uid':os.getuid(),'euid':os.geteuid(),'gid':os.getgid(),'egid':os.getegid(),'groups':os.getgroups(),'pid':os.getpid(),'status':status,'maps':maps,'namespaces':namespaces,'fds':fds,'tokenInEnvironment':'EXECD_ACCESS_TOKEN' in os.environ,'projectMarker':pathlib.Path('/workspace/shared-marker').read_text(),'environmentMarker':pathlib.Path('/opt/session-env/home/shared-marker').read_text()}
try:urllib.request.urlopen('http://127.0.0.1:44772/ping',timeout=.5);d['parentManagementReachable']=True
except Exception as e:d['parentManagementError']=type(e).__name__
print(json.dumps(d),flush=True)
time.sleep(2)
`
const snapshotCode = `import pathlib,os,json,stat
rows=[]
for p in pathlib.Path('/proc').iterdir():
 if not p.name.isdigit():continue
 try:
  s=(p/'stat').read_text().rsplit(')',1)[1].split();status={}
  for line in (p/'status').read_text().splitlines():
   k,_,v=line.partition(':')
   if k in ['Uid','Gid','Groups','CapInh','CapPrm','CapEff','CapBnd','CapAmb','NoNewPrivs','Seccomp','NSpid']:status[k]=v.strip()
  row={'pid':int(p.name),'comm':(p/'comm').read_text().strip(),'state':s[0],'ppid':int(s[1]),'pgrp':int(s[2]),'session':int(s[3]),'startTimeTicks':int(s[19]),'status':status,'namespaces':{},'maps':{}}
  for k in ['pid','user','net','mnt','cgroup']:
   try:row['namespaces'][k]=os.readlink(str(p/'ns'/k))
   except OSError as e:row['namespaces'][k]={'errno':e.errno}
  if row['pid']==1 or row['comm'].startswith('pe4-') or row['comm'] in ['bash','bwrap']:
   for k in ['uid_map','gid_map','setgroups']:
    try:row['maps'][k]=(p/k).read_text().strip()
    except OSError as e:row['maps'][k]={'errno':e.errno}
  if row['pid']==1 or row['comm'].startswith('pe4-'):
   row['fds']=[];names=list((p/'fd').iterdir());row['fdMetadataTruncated']=len(names)>64
   for q in names[:64]:
    try:
     target=os.readlink(q);f=os.stat(q);kind='pipe' if target.startswith('pipe:') else 'socket' if target.startswith('socket:') else 'anon' if target.startswith('anon_inode:') else 'device' if stat.S_ISCHR(f.st_mode) else 'regular' if stat.S_ISREG(f.st_mode) else 'other';flags=[v.split(':',1)[1].strip() for v in (p/'fdinfo'/q.name).read_text().splitlines() if v.startswith('flags:')];row['fds'].append({'fd':int(q.name),'kind':kind,'inode':f.st_ino,'flagsFromProc':flags})
    except FileNotFoundError:pass
    except OSError as e:row['fds'].append({'fd':int(q.name),'metadataError':e.errno})
  rows.append(row)
 except FileNotFoundError:pass
print(json.dumps(rows[:64]))
`
const serviceCode = `import ctypes,time,http.server
ctypes.CDLL(None).prctl(15,b'pe4-service',0,0,0)
class Handler(http.server.BaseHTTPRequestHandler):
 def do_GET(self):
  body=b'pe4-live';self.send_response(200);self.send_header('Content-Length',str(len(body)));self.end_headers();self.wfile.write(body)
 def log_message(self,*args):pass
s=http.server.HTTPServer(('127.0.0.1',18080),Handler);s.timeout=.2;end=time.monotonic()+30
while time.monotonic()<end:s.handle_request()
s.server_close()
`
const descendantCode = `import ctypes,time,pathlib
ctypes.CDLL(None).prctl(15,b'pe4-desc',0,0,0)
p=pathlib.Path('/workspace/m4-counter');end=time.monotonic()+25;i=0
while time.monotonic()<end:
 i+=1;p.write_text(str(i));time.sleep(.1)
`
const parentCode = `import ctypes,subprocess,sys,os,json
ctypes.CDLL(None).prctl(15,b'pe4-parent',0,0,0)
p=subprocess.Popen([sys.executable,'-c',bytes.fromhex('${Buffer.from(descendantCode).toString('hex')}').decode()],start_new_session=True,stdin=subprocess.DEVNULL,stdout=subprocess.DEVNULL,stderr=subprocess.DEVNULL)
print(json.dumps({'parentPid':os.getpid(),'descendantPid':p.pid}))
`
const fixtureCode = `import pathlib
pathlib.Path('/workspace/m4-bytes.bin').write_bytes(bytes(range(256))*16+b'\\xff\\xfe\\xc0\\xaf\\xe4\\xbd\\xa0\\r\\n\\0')
print('written')
`
for (const code of [factsCode('A', true), factsCode('B', false), snapshotCode, serviceCode, descendantCode, parentCode, fixtureCode]) {
  const x = spawnSync('python3', ['-c', 'import ast,sys;ast.parse(sys.stdin.read())'], { input: code, encoding: 'utf8', timeout: 2000 })
  check(x.status === 0, 'fixed diagnostic Python failed offline syntax validation')
}
if (args.get('--validate-only') === 'true') { process.stdout.write('M4 fixed scripts syntax valid; no resources created\n'); process.exit(0) }
if (args.get('--execute-authorized-once') !== 'true') throw new Error('explicit one-experiment flag required')

function snapshot(timeoutMs = 10000) {
  const x = docker(['exec', physicalId, 'python3', '-c', snapshotCode], false, timeoutMs)
  check(Buffer.byteLength(x.stdout) <= bounds.maxBytes, 'trusted snapshot exceeded output budget')
  return JSON.parse(x.stdout)
}
async function run(scope, code, onText) {
  let stdout = '', stderr = ''
  const collect = (old, next) => { check(Buffer.byteLength(old) + Buffer.byteLength(next) <= bounds.maxBytes, 'user text exceeded budget'); return old + next }
  const operation = scope.run(py(code), { timeout_seconds: 8, envs: { HOME: '/opt/session-env/home', PATH: '/usr/local/bin:/usr/bin:/bin' } }, {
    skipAccumulation: true,
    onStdout: e => { stdout = collect(stdout, e.text); onText?.(stdout) },
    onStderr: e => { stderr = collect(stderr, e.text) },
  }, AbortSignal.timeout(10000)).then(result => ({ exitCode: result.exitCode, reportedError: Boolean(result.error), stdout, stderr }), error => ({ failure: fail(error), stdout, stderr }))
  pendingRuns.add(operation)
  operation.finally(() => pendingRuns.delete(operation))
  return operation
}
async function facts(name, writes) {
  let parsed
  const ready = Promise.withResolvers()
  const operation = run(scopeHandles.get(name), factsCode(name, writes), text => {
    try { parsed = JSON.parse(text) }
    catch (error) {
      // SSE may split the JSON fact document; the bounded readiness wait rejects an incomplete final document.
      if (error instanceof SyntaxError) return
      throw error
    }
    ready.resolve()
  })
  await Promise.race([ready.promise, operation.then(() => { if (!parsed) throw new Error('facts process produced no JSON') }), delay(5000).then(() => { throw new Error('facts readiness budget exhausted') })])
  report.observations[`facts${name}`] = { program: parsed, trustedObservationPending: true }
  await persist()
  let rows
  try { rows = snapshot() }
  catch (error) { report.observations[`facts${name}`].trustedObservationFailure = fail(error); await persist(); throw error }
  const proc = rows.find(x => x.comm === `pe4-facts-${name.toLowerCase()}`)
  check(proc, 'actual facts process was not observed while alive')
  const outcome = await operation
  report.observations[`facts${name}`] = { program: parsed, trustedProcess: proc, trustedProcesses: rows, outcome }
  await persist()
  check(outcome.exitCode === 0 && !outcome.reportedError && !outcome.failure, 'facts program failed')
  check(parsed.uid === 65534 && parsed.euid === 65534 && parsed.gid === 65534 && parsed.egid === 65534, 'nonroot user identity mismatch')
  check(['CapEff', 'CapPrm', 'CapAmb'].every(k => BigInt(`0x${parsed.status[k]}`) === 0n), 'user retains unexpected effective/permitted/ambient capabilities')
  check(parsed.status.NoNewPrivs === '1' && parsed.status.Seccomp === '2', 'user no-new-privileges/seccomp floor absent')
  check(!parsed.tokenInEnvironment && !parsed.parentManagementReachable, 'user management boundary failed')
  check(parsed.fds.every(x => x.fd <= 2 || !['pipe', 'socket'].includes(x.kind)), 'unexpected non-stdio pipe/socket inherited')
  check(proc.namespaces.pid === parsed.namespaces.pid && proc.namespaces.user === parsed.namespaces.user && proc.namespaces.net === parsed.namespaces.net, 'trusted and program namespace identity mismatch')
  check(parsed.projectMarker === nonce && parsed.environmentMarker === nonce, 'approved project/environment not shared')
  const init = rows.find(x => x.namespaces.pid === parsed.namespaces.pid && x.status.NSpid?.split(/\s+/).at(-1) === '1')
  check(init, 'inner namespace init not identified')
  report.scopes[name].identity = { namespaces: parsed.namespaces, init: { pid: init.pid, startTimeTicks: init.startTimeTicks }, program: { pid: proc.pid, startTimeTicks: proc.startTimeTicks } }
  await persist()
}
async function createScope(name) {
  check(Object.keys(report.scopes).length < bounds.innerCreates, 'inner scope limit reached')
  report.scopes[name] = { state: 'creating', createCalls: 1, uidMode: 'userns', deleteCalls: 0 }
  await phase(`create-inner-${name}`)
  const scope = await sandbox.isolation.create({ workspace: { path: '/workspace', mode: 'rw' }, profile: 'strict', uid: 65534, gid: 65534, uid_mode: 'userns',
    extra_writable: ['/opt/session-env'], share_net: false, env_passthrough: { mode: 'allow', keys: ['PATH'] }, idle_timeout_seconds: 60 })
  scopeHandles.set(name, scope)
  Object.assign(report.scopes[name], { state: 'ready', id: scope.sessionId })
  await persist()
}
async function deleteScope(name) {
  const state = report.scopes[name]
  check(state && state.deleteCalls === 0, 'scope delete already attempted; no blind mutation retry')
  state.deleteCalls = 1; state.state = 'deleting'; await persist()
  try { await scopeHandles.get(name).delete(); state.state = 'deleted'; await persist() }
  catch (error) { state.state = 'delete-unknown'; state.deleteFailure = fail(error); await persist(); throw error }
}
async function healthB() {
  const x = await run(scopeHandles.get('B'), "import urllib.request;print(urllib.request.urlopen('http://127.0.0.1:18080/health',timeout=1).read(32).decode())")
  check(x.exitCode === 0 && x.stdout.trim() === 'pe4-live' && !x.reportedError && !x.failure, 'B actual health failed')
  return x
}
async function passiveKnownRangeWait(identity, signal) {
  while (!signal.aborted) {
    const row = snapshot().find(x => x.pid === identity.pid && x.startTimeTicks === identity.startTimeTicks)
    if (!row || ['Z', 'X'].includes(row.state)) return true
    await delay(25)
  }
  return false
}

try {
  const images = {}
  for (const [key, spec] of Object.entries(expected)) {
    const info = JSON.parse(docker(['image', 'inspect', spec.ref]).stdout)[0]
    check(info.Id === spec.id && info.Os === 'linux' && info.Architecture === 'arm64', `cached ${key} image mismatch`)
    images[key] = { id: info.Id, repoDigests: info.RepoDigests, os: info.Os, architecture: info.Architecture }
  }
  check(bounds.physicalCreates === 1 && bounds.innerCreates === 2 && bounds.memoryMiB === 192 && bounds.cpu === 0.5 && bounds.pids === 64 && bounds.ttlSeconds === 90, 'resource plan mismatch')
  const sdkPackage = JSON.parse(await readFile(join(sdkRoot, 'node_modules/@alibaba-group/opensandbox/package.json'), 'utf8'))
  check(sdkPackage.version === '1.1.1', 'SDK version mismatch')
  const requireSdk = createRequire(join(sdkRoot, 'package.json'))
  const imported = await import(pathToFileURL(requireSdk.resolve('@alibaba-group/opensandbox')).href)
  const { Sandbox } = imported.Sandbox ? imported : imported.default
  report.sdkVersion = sdkPackage.version
  report.preCreateValidatedImages = images
  report.executionSource = { productHeadAtStart: spawnSync('git', ['rev-parse', 'HEAD'], { cwd: workspaceRoot, encoding: 'utf8', timeout: 2000 }).stdout.trim(), probeScriptSha256: createHash('sha256').update(await readFile(fileURLToPath(import.meta.url))).digest('hex'), nativeProductCodeImported: false }
  await writeFile(reportPath, JSON.stringify(report, null, 2) + '\n', { flag: 'wx', mode: 0o600 })
  manifestCreated = true
  await phase('persisted-allocation-intent-before-work')
  scratch = await mkdtemp(join(dirname(fileURLToPath(import.meta.url)), '.m4-private-'))
  for (const path of ['project', 'environment', 'environment/home', 'tmp']) await mkdir(join(scratch, path), { mode: 0o700 })
  for (const path of ['project', 'environment', 'environment/home']) await chmod(join(scratch, path), 0o777)
  await writeFile(join(scratch, 'isolation.toml'), 'allowed_writable=["/workspace","/opt/session-env"]\nupper_max_bytes=1048576\n[hardening]\nenabled=true\n[landlock]\nenabled=true\n', { mode: 0o600 })
  const config = `[server]\nhost="0.0.0.0"\nport=8080\napi_key="${apiKey}"\n[proxy]\nresolve_internal=true\n[log]\nlevel="WARNING"\n[runtime]\ntype="docker"\nexecd_image=${JSON.stringify(expected.execd.ref)}\nexecd_run_as_init=true\n[store]\ntype="sqlite"\npath=${JSON.stringify(join(scratch, 'control.db'))}\n[storage]\nallowed_host_paths=[${JSON.stringify(join(scratch, 'project'))},${JSON.stringify(join(scratch, 'environment'))}]\n[docker]\nnetwork_mode="bridge"\nhost_ip="127.0.0.1"\npublish_host="127.0.0.1"\nno_new_privileges=true\npids_limit=64\nsandbox_binds=[${JSON.stringify(`${join(scratch, 'isolation.toml')}:/etc/pe-m4-isolation.toml:ro`)}]\n[docker.sandbox_env]\nEXECD_ACCESS_TOKEN=${JSON.stringify(token)}\nEXECD_ISOLATION_CONFIG="/etc/pe-m4-isolation.toml"\n[ingress]\nmode="direct"\n`
  await writeFile(join(scratch, 'config.toml'), config, { mode: 0o600 })
  await phase('start-owned-control')
  serverId = docker(['run', '-d', '--pull', 'never', '--name', task, '--label', label, '--memory', '512m', '--cpus', '0.5', '--pids-limit', '128', '--security-opt', 'no-new-privileges:true',
    '-p', '127.0.0.1::8080', '-v', '/var/run/docker.sock:/var/run/docker.sock', '-v', `${scratch}:${scratch}`, '-e', `TMPDIR=${join(scratch, 'tmp')}`, '--entrypoint', 'sh', expected.server.ref, '-c',
    'opensandbox-server --config "$1" & pid=$!; (sleep 180; kill "$pid" 2>/dev/null) & wait "$pid"', '--', join(scratch, 'config.toml')]).stdout
  owned.add(serverId); report.control = { id: serverId, state: 'running' }; await persist()
  const control = inspect(serverId)
  check(control.Image === expected.server.id && control.HostConfig.Memory === 536870912 && control.HostConfig.NanoCpus === 500000000 && control.HostConfig.PidsLimit === 128, 'control actual identity/limit mismatch')
  const port = control.NetworkSettings.Ports['8080/tcp'][0].HostPort
  const domain = `127.0.0.1:${port}`
  let healthy = false
  for (let i = 0; i < 40; i++) {
    let response
    try { response = await fetch(`http://${domain}/health`, { headers: { 'OPEN-SANDBOX-API-KEY': apiKey }, signal: AbortSignal.timeout(750) }) }
    catch (error) {
      // Read-only connection failures are expected during this bounded startup poll; no mutation is retried.
      report.control.lastReadinessFailure = fail(error)
    }
    if (response?.ok) { healthy = true; break }
    await delay(150)
  }
  check(healthy, 'owned control readiness failed')
  report.serverVersion = docker(['exec', serverId, 'python', '-c', 'import importlib.metadata;print(importlib.metadata.version("opensandbox-server"))']).stdout
  check(report.serverVersion === '1.1.1', 'server version mismatch')
  report.allocation.createCalls = 1; report.allocation.state = 'creating'; await phase('submit-only-physical-create')
  sandbox = await Sandbox.create({ connectionConfig: { domain, protocol: 'http', apiKey, useServerProxy: true, requestTimeoutSeconds: 5, disableMetrics: true, headers: { 'X-EXECD-ACCESS-TOKEN': token } },
    image: expected.workload.ref, timeoutSeconds: 90, readyTimeoutSeconds: 30, secureAccess: false, resource: { cpu: '0.5', memory: '192Mi' }, metadata: { 'pe-m4-task': task }, extensions: { 'bootstrap.execd.isolation': 'enable' },
    volumes: [{ name: 'project', host: { path: join(scratch, 'project') }, mountPath: '/workspace' }, { name: 'environment', host: { path: join(scratch, 'environment') }, mountPath: '/opt/session-env' }] })
  report.allocation.id = sandbox.id; report.allocation.state = 'ready'; await persist()
  const labelled = docker(['ps', '-aq', '--filter', `label=${label}`]).stdout.split(/\s+/).filter(Boolean).map(inspect)
  for (const row of labelled) if (row) owned.add(row.Id)
  const physical = labelled.find(x => x?.Name === `/sandbox-${sandbox.id}`)
  check(physical, 'exact labelled physical identity not observed')
  physicalId = physical.Id; report.allocation.containerId = physicalId
  check(physical.Image === expected.workload.id && physical.HostConfig.Memory === 201326592 && physical.HostConfig.NanoCpus === 500000000 && physical.HostConfig.PidsLimit === 64 && !physical.HostConfig.Privileged, 'physical actual image/limit mismatch')
  report.observations.physicalConfiguration = { imageId: physical.Image, memoryBytes: physical.HostConfig.Memory, cpuNano: physical.HostConfig.NanoCpus, pids: physical.HostConfig.PidsLimit, privileged: physical.HostConfig.Privileged, capAdd: physical.HostConfig.CapAdd, capDrop: physical.HostConfig.CapDrop, securityOptions: physical.HostConfig.SecurityOpt, restartPolicy: physical.HostConfig.RestartPolicy, readonlyRootfs: physical.HostConfig.ReadonlyRootfs, tmpfs: physical.HostConfig.Tmpfs, mounts: physical.Mounts.map(x => ({ destination: x.Destination, type: x.Type, writable: x.RW })) }
  report.observations.trustedControlBefore = snapshot().find(x => x.pid === 1)
  report.observations.isolationCapabilityClaim = await sandbox.isolation.capabilities()
  await persist()
  await createScope('B'); await createScope('A')
  await phase('capture-actual-user-and-trusted-facts')
  await facts('A', true); await facts('B', false)
  check(report.scopes.A.identity.namespaces.pid !== report.scopes.B.identity.namespaces.pid && report.scopes.A.identity.namespaces.net !== report.scopes.B.identity.namespaces.net && report.scopes.A.identity.namespaces.user !== report.scopes.B.identity.namespaces.user, 'inner namespaces not distinct')
  await phase('start-finite-service-B')
  const service = await scopeHandles.get('B').runBackground(py(serviceCode))
  report.observations.serviceB = { apiRunId: service.run_id ?? service.runId, apiStatusTrustedAsReceipt: false }
  await delay(200)
  report.observations.serviceB.healthBefore = await healthB()
  const serviceBefore = snapshot().find(x => x.comm === 'pe4-service' && x.namespaces.pid === report.scopes.B.identity.namespaces.pid)
  check(serviceBefore, 'B service real process missing')
  report.observations.serviceB.trustedBefore = serviceBefore; await persist()
  await phase('binary-file-range-transport-only')
  const fixtureWrite = await run(scopeHandles.get('A'), fixtureCode)
  check(fixtureWrite.exitCode === 0 && !fixtureWrite.reportedError && !fixtureWrite.failure, 'binary fixture write failed')
  const bytes = Buffer.concat([Buffer.from(Array.from({ length: 4096 }, (_, i) => i % 256)), Buffer.from([255, 254, 192, 175, 228, 189, 160, 13, 10, 0])])
  const whole = await scopeHandles.get('A').files.readBytes('/workspace/m4-bytes.bin', { range: `bytes=0-${bytes.length - 1}` })
  check(whole.byteLength <= bounds.maxBytes && Buffer.from(whole).equals(bytes), 'binary file Range roundtrip mismatch')
  const partial = await scopeHandles.get('A').files.readBytes('/workspace/m4-bytes.bin', { range: 'bytes=255-512' })
  check(Buffer.from(partial).equals(bytes.subarray(255, 513)), 'binary subrange mismatch')
  const chunks = []; let total = 0
  for await (const chunk of scopeHandles.get('A').files.readBytesStream('/workspace/m4-bytes.bin', { range: `bytes=0-${bytes.length - 1}` })) { total += chunk.byteLength; check(total <= bounds.maxBytes, 'byte stream budget exceeded'); chunks.push(Buffer.from(chunk)) }
  check(Buffer.concat(chunks).equals(bytes), 'binary byte stream mismatch')
  report.observations.binaryFileTransport = { byteLength: bytes.length, sha256: createHash('sha256').update(whole).digest('hex'), rangeReadMatched: true, partialMatched: true, streamMatched: true, stdoutCollectQualified: false, scope: 'known fixture file only; not trusted process FD binding or waitpid/argv acceptance' }; await persist()
  await phase('A-parent-exit-and-passive-observation')
  const parent = await run(scopeHandles.get('A'), parentCode)
  check(parent.exitCode === 0 && !parent.reportedError && !parent.failure, 'A parent fixture failed')
  const parentResult = JSON.parse(parent.stdout)
  await delay(100)
  const descendant = snapshot().find(x => x.comm === 'pe4-desc' && x.namespaces.pid === report.scopes.A.identity.namespaces.pid)
  check(descendant && descendant.pgrp === descendant.pid && descendant.session === descendant.pid && descendant.status.NSpid.split(/\s+/).at(-1) === String(parentResult.descendantPid), 'valid setsid descendant identity not established')
  const passiveAbort = new AbortController()
  const timer = setTimeout(() => passiveAbort.abort('probe wait cancelled'), 100)
  const observed = await passiveKnownRangeWait(descendant, passiveAbort.signal); clearTimeout(timer)
  const afterPassive = snapshot().find(x => x.pid === descendant.pid && x.startTimeTicks === descendant.startTimeTicks)
  check(observed === false && afterPassive && !['Z', 'X'].includes(afterPassive.state) && report.scopes.A.deleteCalls === 0, 'passive cancelled wait changed/stopped range')
  report.observations.parentAndPassiveWait = { sdkParentResult: parent, reportedInnerPids: parentResult, trustedDescendant: descendant, waitReturned: observed, descendantStillAlive: true, scopeDeleteCallsDuringWait: 0, nativeSubprocessDoneOrWaitForExitImplemented: false }; await persist()
  await phase('authorized-delete-A-and-confirm-B-live')
  const stopStarted = Date.now()
  await deleteScope('A')
  let scopeGone = false, stopRows
  while (Date.now() - stopStarted < bounds.stopObservationMs) {
    stopRows = snapshot(Math.max(1, bounds.stopObservationMs - (Date.now() - stopStarted)))
    scopeGone = !stopRows.some(x => x.namespaces.pid === report.scopes.A.identity.namespaces.pid)
    if (scopeGone) break
    await delay(50)
  }
  const namespaceEmptyObservedMs = Date.now() - stopStarted
  check(scopeGone && namespaceEmptyObservedMs <= bounds.stopObservationMs, 'A namespace did not become empty within stop observation budget')
  const counter1 = await sandbox.files.readBytes('/workspace/m4-counter', { range: 'bytes=0-63' })
  await delay(350)
  const counter2 = await sandbox.files.readBytes('/workspace/m4-counter', { range: 'bytes=0-63' })
  check(Buffer.from(counter1).equals(Buffer.from(counter2)), 'counter changed after A deletion')
  const serviceAfter = snapshot().find(x => x.pid === serviceBefore.pid && x.startTimeTicks === serviceBefore.startTimeTicks)
  check(serviceAfter && !['Z', 'X'].includes(serviceAfter.state) && serviceAfter.namespaces.pid === serviceBefore.namespaces.pid, 'B exact service identity did not survive A deletion')
  const healthAfter = await healthB()
  const stillPhysical = inspect(physicalId)
  check(stillPhysical?.State.Running, 'physical Sandbox did not survive scoped A deletion')
  let staleRead
  try { await scopeHandles.get('A').get(); staleRead = { rejected: false } } catch (error) { staleRead = { rejected: true, failure: fail(error) } }
  check(staleRead.rejected, 'old scope A remained queryable')
  report.observations.scopedStop = { namespaceEmptyObservedMs, namespaceEmpty: true, counterStableIn350msWindow: true, counterValue: Buffer.from(counter2).toString('ascii'), trustedProcessesAfter: stopRows, oldScopeRead: staleRead, permanentDelayedSpawnProven: false, serviceBExactIdentityAlive: serviceAfter, healthAfter, samePhysicalSandboxAlive: true }; await persist()
  await phase('experiment-observations-complete')
} catch (error) {
  report.errors.push(fail(error)); report.failedAt = report.phases.at(-1)?.name ?? 'pre-resource-validation'
  if (report.allocation.state === 'creating') report.allocation.state = 'create-unknown'
} finally {
  if (manifestCreated) {
    await phase('owned-cleanup')
    for (const name of ['A', 'B']) {
      const state = report.scopes[name]
      if (scopeHandles.has(name) && state.deleteCalls === 0) { try { await deleteScope(name) } catch (error) { report.cleanup[`delete${name}Error`] = fail(error) } }
    }
    if (sandbox) {
      try { await sandbox.kill(); report.allocation.state = 'delete-accepted' } catch (error) { report.cleanup.sdkKillFailure = fail(error) }
      try { await sandbox.close() } catch (error) { report.cleanup.sdkCloseFailure = fail(error) }
    }
    const labelled = docker(['ps', '-aq', '--filter', `label=${label}`], true)
    report.cleanup.observerErrors = []
    for (const id of labelled.stdout.split(/\s+/).filter(Boolean)) {
      try { const row = inspect(id); if (row?.Config.Labels?.['pe-m4-task'] === task) owned.add(row.Id) }
      catch (error) { report.cleanup.observerErrors.push(fail(error)) }
    }
    for (const id of [...owned].filter(x => x !== serverId)) docker(['rm', '-f', id], true)
    if (serverId) docker(['rm', '-f', serverId], true)
    report.cleanup.exactContainerObservations = []
    for (const id of owned) {
      try { report.cleanup.exactContainerObservations.push({ id, absent: inspect(id) === undefined }) }
      catch (error) { report.cleanup.exactContainerObservations.push({ id, absent: null, failure: fail(error) }) }
    }
    const remaining = docker(['ps', '-aq', '--filter', `label=${label}`], true)
    report.cleanup.labelQuerySucceeded = remaining.status === 0
    report.cleanup.remainingLabelledContainers = remaining.status === 0 ? remaining.stdout.split(/\s+/).filter(Boolean).length : null
    report.cleanup.knownContainersAbsent = labelled.status === 0 && remaining.status === 0 && !remaining.stdout && report.cleanup.exactContainerObservations.every(x => x.absent === true)
    report.cleanup.pendingPhysicalCreateTerminalProof = report.allocation.createCalls === 0 || Boolean(report.allocation.id)
    if (scratch && report.cleanup.knownContainersAbsent && report.cleanup.pendingPhysicalCreateTerminalProof) { await rm(scratch, { recursive: true, force: true }); report.cleanup.privateScratchRemoved = true }
    else report.cleanup.privateScratchRemoved = !scratch
    report.cleanup.pendingRunWait = await Promise.race([Promise.allSettled(pendingRuns).then(() => 'settled'), delay(5000).then(() => 'unknown')])
    report.completedAt = new Date().toISOString()
    report.productActivation = 'closed; fixture observations only'
    await persist()
    process.stdout.write(JSON.stringify({ report: reportPath, failedAt: report.failedAt ?? null, observations: Object.keys(report.observations), cleanup: report.cleanup }) + '\n')
    if (report.errors.length || !report.cleanup.knownContainersAbsent || !report.cleanup.pendingPhysicalCreateTerminalProof) process.exitCode = 1
  } else if (report.errors.length) {
    process.stdout.write(JSON.stringify({ resourcesCreated: 0, manifestCreated: false, error: report.errors[0] }) + '\n'); process.exitCode = 1
  }
}
