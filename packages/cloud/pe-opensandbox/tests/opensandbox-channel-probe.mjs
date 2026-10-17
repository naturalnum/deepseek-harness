/** Opt-in real-channel probe. Owns only its labelled, time-limited containers and private scratch. */
import { spawn, spawnSync } from 'node:child_process'
import { createHash, randomBytes, randomUUID } from 'node:crypto'
import { mkdtemp, mkdir, chmod, writeFile, readFile, rm } from 'node:fs/promises'
import { createRequire } from 'node:module'
import { dirname, join, resolve } from 'node:path'
import { fileURLToPath, pathToFileURL } from 'node:url'
import { setTimeout as delay } from 'node:timers/promises'

const args = new Map()
for (let i = 2; i < process.argv.length; i += 2) args.set(process.argv[i], process.argv[i + 1])
for (const key of ['--sdk-root', '--server-image', '--execd-image', '--image', '--out']) {
  if (!args.get(key)) throw new Error(`required probe argument: ${key}`)
}
const series = args.get('--series') ?? 'm1'
if (!['m1', 'm2', 'm3'].includes(series)) throw new Error('unsupported probe series')
const task = `pe-${series}-${randomUUID()}`
const taskLabelKey = `pe-${series}-task`
const label = `${taskLabelKey}=${task}`
const apiKey = randomBytes(32).toString('hex')
const qualifyHardening = args.get('--qualify-hardening') === 'true'
const enableIsolation = qualifyHardening && args.get('--enable-isolation') === 'true'
const diagnoseIsolation = series === 'm3'
const isolatedUidMode = args.get('--isolated-uid-mode') ?? 'setpriv'
if (!['setpriv', 'userns'].includes(isolatedUidMode)) throw new Error('unsupported native uid mode')
if (diagnoseIsolation && (!qualifyHardening || !enableIsolation)) throw new Error('M3 requires authenticated hardening and isolation')
const execdToken = qualifyHardening ? randomBytes(32).toString('hex') : ''
const report = { kind: 'real-channel-feasibility-only', task, startedAt: new Date().toISOString(), phases: [], observations: {}, errors: [], cleanup: {} }
const head = spawnSync('git', ['rev-parse', 'HEAD'], { encoding: 'utf8', timeout: 2000 })
report.executionSource = {
  productHeadAtStart: head.status === 0 ? head.stdout.trim() : null,
  probeScriptSha256: createHash('sha256').update(await readFile(fileURLToPath(import.meta.url))).digest('hex'),
  nativeProductCodeImported: false,
}
const owned = new Set()
let scratch, serverId, sandbox, manager

function docker(argv, { allowFailure = false } = {}) {
  const child = spawnSync('docker', argv, { encoding: 'utf8', timeout: 20000, maxBuffer: 1024 * 1024 })
  if (child.status !== 0 && !allowFailure) {
    const error = new Error(`docker ${argv[0]} failed`)
    error.name = child.error?.name ?? 'DockerCommandError'
    throw error
  }
  return { status: child.status, text: child.stdout?.trim() ?? '', diagnostic: child.stderr?.trim() ?? '' }
}
function inspect(id) {
  const found = docker(['inspect', id], { allowFailure: true })
  if (found.status === 0) return JSON.parse(found.text)[0]
  if (/No such (object|container)/i.test(found.diagnostic) || /No such (object|container)/i.test(found.text)) return undefined
  throw new Error('Docker observation failed; absence is unconfirmed')
}
function mark(phase) {
  report.phases.push({ phase, at: new Date().toISOString() })
  process.stdout.write(JSON.stringify({ probe: `opensandbox-${series}`, phase }) + '\n')
}
function failure(error) {
  let message = String(error?.message ?? '').replaceAll(apiKey, '[REDACTED]').replaceAll(scratch ?? '\0', '[PRIVATE-SCRATCH]')
  if (execdToken) message = message.replaceAll(execdToken, '[REDACTED]')
  return { name: error?.name ?? 'UnknownError', status: error?.status ?? error?.statusCode ?? null, message: message.slice(0, 1800) }
}
function processSnapshot(containerId) {
  const result = docker(['exec', containerId, 'python3', '-c', 'import os,pathlib,json;d=[];\nfor p in pathlib.Path("/proc").iterdir():\n if not p.name.isdigit():continue\n try:\n  s=(p/"stat").read_text().rsplit(")",1)[1].split();status=(p/"status").read_text().splitlines();d.append({"pid":int(p.name),"comm":(p/"comm").read_text().strip(),"state":s[0],"ppid":int(s[1]),"pgrp":int(s[2]),"session":int(s[3]),"startTimeTicks":int(s[19]),"identity":[x for x in status if x.startswith(("Uid:","Gid:","NSpid:"))]})\n except FileNotFoundError:pass\nprint(json.dumps(d[:64]))'])
  return JSON.parse(result.text)
}
async function startProcessTrace(containerId) {
  const code = 'import pathlib,json,time;print(json.dumps({"ready":True}),flush=True);previous={};events=[];start=time.monotonic();truncated=False;\nwhile time.monotonic()-start<6:\n current={};\n for p in pathlib.Path("/proc").iterdir():\n  if not p.name.isdigit():continue\n  try:\n   s=(p/"stat").read_text().rsplit(")",1)[1].split();identity=[x for x in (p/"status").read_text().splitlines() if x.startswith(("Uid:","Gid:","NSpid:"))];row={"pid":int(p.name),"comm":(p/"comm").read_text().strip(),"state":s[0],"ppid":int(s[1]),"pgrp":int(s[2]),"session":int(s[3]),"startTimeTicks":int(s[19]),"identity":identity};current[p.name]=row\n  except FileNotFoundError:pass\n for k,row in current.items():\n  if previous.get(k)!=row:\n   if len(events)<64:events.append({"ms":round((time.monotonic()-start)*1000),"kind":"seen",**row})\n   else:truncated=True\n for k,row in previous.items():\n  if k not in current:\n   if len(events)<64:events.append({"ms":round((time.monotonic()-start)*1000),"kind":"gone","pid":row["pid"],"startTimeTicks":row["startTimeTicks"]})\n   else:truncated=True\n previous=current;time.sleep(.01)\nprint(json.dumps({"durationMs":round((time.monotonic()-start)*1000),"events":events,"truncated":truncated}),flush=True)'
  const child = spawn('docker', ['exec', containerId, 'python3', '-u', '-c', code], { stdio: ['ignore', 'pipe', 'pipe'] })
  let stdout = '', stderr = '', readyResolved = false
  let resolveReady
  const ready = new Promise(resolve => { resolveReady = resolve })
  const completed = new Promise(resolve => {
    child.stdout.on('data', chunk => {
      stdout += chunk.toString()
      if (stdout.length > 65536) child.kill()
      if (!readyResolved && stdout.includes('\n')) { readyResolved = true; resolveReady(true) }
    })
    child.stderr.on('data', chunk => { stderr = (stderr + chunk.toString()).slice(-2000) })
    child.on('error', error => { resolveReady(false); resolve({ observerFailure: failure(error) }) })
    child.on('close', status => {
      resolveReady(false)
      const lines = stdout.trim().split('\n')
      try { resolve({ observerExitCode: status, ...JSON.parse(lines.at(-1)), diagnostic: stderr }) }
      catch { resolve({ observerExitCode: status, observerFailure: 'incomplete process trace', diagnostic: stderr }) }
    })
  })
  const watchdog = setTimeout(() => child.kill(), 10000)
  completed.finally(() => clearTimeout(watchdog))
  const started = await Promise.race([ready, delay(2000).then(() => false)])
  if (!started) child.kill()
  return { started, completed }
}
async function command(code, { argv = false, ...options } = {}) {
  let stdout = '', stderr = ''
  const append = (current, text) => {
    if (Buffer.byteLength(current) + Buffer.byteLength(text) > 16384) throw new Error('probe output limit exceeded')
    return current + text
  }
  const script = argv ? code : ['python3', '-c', code].map(s => `'${s.replaceAll("'", "'\\''")}'`).join(' ')
  const result = await sandbox.commands.run(script, {
    workingDirectory: '/workspace', timeoutSeconds: 8,
    envs: { HOME: '/opt/session-env/home', PATH: '/opt/session-env/venv/bin:/usr/local/bin:/usr/bin:/bin' },
    ...options,
  }, {
    skipAccumulation: true,
    onStdout: event => { stdout = append(stdout, event.text) },
    onStderr: event => { stderr = append(stderr, event.text) },
  }, AbortSignal.timeout(12000))
  return { exitCode: result.exitCode ?? null, reportedError: Boolean(result.error), stdout, stderr, commandId: result.id }
}
async function create(Sandbox, connectionConfig, image) {
  mark('create-single-sandbox')
  sandbox = await Sandbox.create({
    connectionConfig, image, timeoutSeconds: 90, readyTimeoutSeconds: 35,
    resource: { cpu: '0.5', memory: '192Mi' }, secureAccess: args.get('--observe-unsecured-docker') !== 'true',
    metadata: { [taskLabelKey]: task },
    ...(enableIsolation ? { extensions: { 'bootstrap.execd.isolation': 'enable' } } : {}),
    volumes: [
      { name: 'project', host: { path: join(scratch, 'project') }, mountPath: '/workspace' },
      { name: 'environment', host: { path: join(scratch, 'environment') }, mountPath: '/opt/session-env' },
    ],
  })
  const ids = docker(['ps', '-aq', '--filter', `label=${label}`]).text.split(/\s+/).filter(Boolean)
  const inspected = ids.map(inspect)
  for (const row of inspected) if (row) owned.add(row.Id)
  const match = inspected.find(row => row?.Name === `/sandbox-${sandbox.id}`)
  if (!match) throw new Error('task sandbox physical identity was not observed')
  return match
}

try {
  try {
    const previous = JSON.parse(await readFile(resolve(args.get('--out')), 'utf8'))
    if (qualifyHardening) report.prequalificationRaw = previous
    else report.precedingEvidence = previous
    report.priorAttempts = [...(previous.priorAttempts ?? []), {
      task: previous.task, failedAt: previous.failedAt, errors: previous.errors, cleanup: previous.cleanup, observations: previous.observations,
    }]
  } catch (error) { if (error.code !== 'ENOENT') throw error }
  report.unsecuredDockerObservationOnly = args.get('--observe-unsecured-docker') === 'true'
  report.hardeningConfigurationCandidate = qualifyHardening
  report.isolationExtensionCandidate = enableIsolation
  report.isolatedUidMode = isolatedUidMode
  const here = dirname(fileURLToPath(import.meta.url))
  scratch = await mkdtemp(join(here, `.${series}-private-`))
  for (const name of ['project', 'environment', 'tmp']) await mkdir(join(scratch, name), { mode: 0o700 })
  if (enableIsolation) for (const name of ['project', 'environment']) await chmod(join(scratch, name), 0o777)
  const requireSdk = createRequire(join(resolve(args.get('--sdk-root')), 'package.json'))
  const imported = await import(pathToFileURL(requireSdk.resolve('@alibaba-group/opensandbox')).href)
  const { Sandbox, SandboxManager } = imported.Sandbox ? imported : imported.default
  const sdkPackage = JSON.parse(await readFile(join(resolve(args.get('--sdk-root')), 'node_modules/@alibaba-group/opensandbox/package.json'), 'utf8'))
  report.sdkVersion = sdkPackage.version
  report.images = Object.fromEntries(['--server-image', '--execd-image', '--image'].map(k => [k.slice(2), args.get(k)]))
  for (const image of Object.values(report.images)) docker(['image', 'inspect', image])
  const hardeningMount = join(scratch, 'isolation.toml')
  if (qualifyHardening) await writeFile(hardeningMount, 'allowed_writable=["/workspace","/opt/session-env"]\nupper_max_bytes=1048576\n[hardening]\nenabled=true\n[landlock]\nenabled=true\n', { mode: 0o600 })
  const runtimeOptions = qualifyHardening ? 'execd_run_as_init=true\n' : ''
  const dockerOptions = qualifyHardening ? `sandbox_binds=[${JSON.stringify(`${hardeningMount}:/etc/pe-m1-isolation.toml:ro`)}]\n[docker.sandbox_env]\nEXECD_ACCESS_TOKEN=${JSON.stringify(execdToken)}\nEXECD_ISOLATION_CONFIG="/etc/pe-m1-isolation.toml"\n` : ''
  const config = `[server]\nhost="0.0.0.0"\nport=8080\napi_key="${apiKey}"\n[proxy]\nresolve_internal=true\n[log]\nlevel="WARNING"\n[runtime]\ntype="docker"\nexecd_image=${JSON.stringify(args.get('--execd-image'))}\n${runtimeOptions}[store]\ntype="sqlite"\npath=${JSON.stringify(join(scratch, 'control.db'))}\n[storage]\nallowed_host_paths=[${JSON.stringify(join(scratch, 'project'))},${JSON.stringify(join(scratch, 'environment'))}]\n[docker]\nnetwork_mode="bridge"\nhost_ip="127.0.0.1"\npublish_host="127.0.0.1"\nno_new_privileges=true\npids_limit=64\n${dockerOptions}[ingress]\nmode="direct"\n`
  await writeFile(join(scratch, 'config.toml'), config, { mode: 0o600 })
  mark('start-task-control-server')
  serverId = docker(['run', '-d', '--pull', 'never', '--name', task, '--label', label,
    '--memory', '512m', '--cpus', '0.5', '--pids-limit', '128', '--security-opt', 'no-new-privileges:true',
    '-p', '127.0.0.1::8080', '-v', '/var/run/docker.sock:/var/run/docker.sock',
    '-v', `${scratch}:${scratch}`, '-e', `TMPDIR=${join(scratch, 'tmp')}`,
    '--entrypoint', 'sh', args.get('--server-image'), '-c',
    'opensandbox-server --config "$1" & pid=$!; (sleep 180; kill "$pid" 2>/dev/null) & wait "$pid"',
    '--', join(scratch, 'config.toml')]).text
  owned.add(serverId)
  const server = inspect(serverId)
  const port = server.NetworkSettings.Ports['8080/tcp'][0].HostPort
  const domain = `127.0.0.1:${port}`
  let healthy = false
  for (let i = 0; i < 40; i++) {
    try {
      const response = await fetch(`http://${domain}/health`, { headers: { 'OPEN-SANDBOX-API-KEY': apiKey }, signal: AbortSignal.timeout(1000) })
      if (response.ok) { healthy = true; break }
    } catch (error) { /* Startup observation continues within this bounded loop. */ }
    await delay(250)
  }
  if (!healthy) throw new Error('task control server did not become healthy')
  const version = docker(['exec', serverId, 'python', '-c', 'import importlib.metadata;print(importlib.metadata.version("opensandbox-server"))']).text
  report.serverVersion = version
  const connectionConfig = { domain, protocol: 'http', apiKey, useServerProxy: true, requestTimeoutSeconds: 15,
    ...(qualifyHardening ? { headers: { 'X-EXECD-ACCESS-TOKEN': execdToken } } : {}),
  }
  manager = SandboxManager.create({ connectionConfig })
  const physical = await create(Sandbox, connectionConfig, args.get('--image'))
  report.observations.physicalLimits = {
    cpuNano: physical.HostConfig.NanoCpus, memoryBytes: physical.HostConfig.Memory, pids: physical.HostConfig.PidsLimit,
    readonlyRootfs: physical.HostConfig.ReadonlyRootfs, storageOptions: physical.HostConfig.StorageOpt ?? null,
    tmpfs: physical.HostConfig.Tmpfs ?? null, imageId: physical.Image,
    security: { privileged: physical.HostConfig.Privileged, capAdd: physical.HostConfig.CapAdd, capDrop: physical.HostConfig.CapDrop,
      securityOptions: physical.HostConfig.SecurityOpt, maskedPaths: physical.HostConfig.MaskedPaths, readOnlyPaths: physical.HostConfig.ReadonlyPaths,
      restartPolicy: physical.HostConfig.RestartPolicy },
    mounts: physical.Mounts.map(m => ({ type: m.Type, destination: m.Destination, writable: m.RW })),
  }
  if (qualifyHardening) {
    mark('qualify-existing-token-hardening-options')
    report.observations.isolationCapabilities = await sandbox.isolation.capabilities()
    const code = 'import os,json,urllib.request,urllib.error,pathlib;d={"uid":os.getuid(),"tokenInWorkloadEnvironment":"EXECD_ACCESS_TOKEN" in os.environ};\ntry:\n d["proc1TokenReadable"]=b"EXECD_ACCESS_TOKEN=" in pathlib.Path("/proc/1/environ").read_bytes()\nexcept OSError as e:d["proc1ReadErrno"]=e.errno\ntry:\n pathlib.Path("/pe-m1-root-write").write_text("probe");d["rootWriteAllowed"]=True\nexcept OSError as e:d["rootWriteErrno"]=e.errno\ntry:\n req=urllib.request.Request("http://127.0.0.1:44772/command",data=json.dumps({"command":"printf forged > /workspace/forged-control"}).encode(),headers={"Content-Type":"application/json"});r=urllib.request.urlopen(req,timeout=2);r.read(2048);d["unauthenticatedManagementStartStatus"]=r.status\nexcept urllib.error.HTTPError as e:d["unauthenticatedManagementStartStatus"]=e.code\nexcept Exception as e:d["managementProbeError"]=type(e).__name__\nd["writeMarkerVisible"]=pathlib.Path("/workspace/forged-control").exists();print(json.dumps(d))'
    for (const uid of diagnoseIsolation ? [65534] : [0, 65534]) {
      const run = await command(code, { uid, gid: uid, workingDirectory: '/tmp', envs: { HOME: '/tmp', PATH: '/usr/local/bin:/usr/bin:/bin' } })
      report.observations[`restrictedWorkloadUid${uid}`] = { exitCode: run.exitCode, reportedError: run.reportedError, diagnostic: run.stderr.slice(0, 1500), ...(run.stdout ? JSON.parse(run.stdout) : {}) }
    }
    if (!diagnoseIsolation) {
      const writes = await command('import pathlib,os,json;d={};\nfor p in ["/tmp","/run","/dev/shm","/workspace","/opt/session-env"]:\n try:\n  f=pathlib.Path(p,"pe-m1-small-write");f.write_bytes(b"x");f.unlink();v=os.statvfs(p);d[p]={"writeAllowed":True,"filesystemBytes":v.f_blocks*v.f_frsize,"filesystemInodes":v.f_files}\n except OSError as e:d[p]={"errno":e.errno}\nprint(json.dumps(d))')
      report.observations.hardeningWritableSurfaces = { exitCode: writes.exitCode, ...(writes.stdout ? { paths: JSON.parse(writes.stdout) } : {}), hardBytesAndInodesProven: false }
    }
    if (enableIsolation) {
      mark('qualify-existing-strict-isolated-session')
      let isolated
      let trace
      if (diagnoseIsolation) {
        report.observations.isolationBefore = { sessions: await sandbox.isolation.list(), processes: processSnapshot(physical.Id) }
        trace = await startProcessTrace(physical.Id)
        if (!trace.started) throw new Error('trusted process observer did not start')
      }
      try {
        isolated = await sandbox.isolation.create({ workspace: { path: '/workspace', mode: 'rw' }, profile: 'strict', uid: 65534, gid: 65534,
          uid_mode: isolatedUidMode, extra_writable: ['/opt/session-env'], share_net: false, env_passthrough: { mode: 'allow', keys: ['PATH'] }, idle_timeout_seconds: 15 })
        const code = 'import os,json,pathlib,urllib.request;d={"uid":os.getuid(),"tokenInEnvironment":"EXECD_ACCESS_TOKEN" in os.environ,"paths":{}};\nfor p in ["/","/tmp","/run","/dev/shm","/workspace","/opt/session-env"]:\n try:\n  v=os.statvfs(p);d["paths"][p]={"readOnly":bool(v.f_flag & os.ST_RDONLY),"filesystemBytes":v.f_blocks*v.f_frsize,"filesystemInodes":v.f_files};f=pathlib.Path(p,"pe-m1-small-write");f.write_bytes(b"x");f.unlink();d["paths"][p]["writeAllowed"]=True\n except OSError as e:d["paths"].setdefault(p,{})["writeErrno"]=e.errno\ntry:\n urllib.request.urlopen("http://127.0.0.1:44772/ping",timeout=1);d["parentManagementReachable"]=True\nexcept Exception as e:d["parentManagementError"]=type(e).__name__\nprint(json.dumps(d))'
        let stdout = '', stderr = ''
        const script = ['python3', '-c', code].map(s => `'${s.replaceAll("'", "'\\''")}'`).join(' ')
        const run = await isolated.run(script, { timeout_seconds: 8, envs: { HOME: '/opt/session-env', PATH: '/usr/local/bin:/usr/bin:/bin' } }, {
          skipAccumulation: true,
          onStdout: e => { if (stdout.length + e.text.length > 16384) throw new Error('isolated probe output limit exceeded'); stdout += e.text },
          onStderr: e => { if (stderr.length + e.text.length > 16384) throw new Error('isolated probe diagnostic limit exceeded'); stderr += e.text },
        }, AbortSignal.timeout(12000))
        report.observations.strictIsolatedSession = { exitCode: run.exitCode, reportedError: Boolean(run.error), diagnostic: stderr.slice(0, 1500), ...(stdout ? JSON.parse(stdout) : {}), hardBytesAndInodesProven: false }
      } catch (error) { report.observations.strictIsolatedSession = { failure: failure(error), hardBytesAndInodesProven: false } }
      finally {
        if (isolated) await isolated.delete()
        if (trace) {
          report.observations.isolationProcessTrace = await trace.completed
          try { report.observations.isolationAfter = { sessions: await sandbox.isolation.list(), processes: processSnapshot(physical.Id) } }
          catch (error) { report.observations.isolationAfter = { observationFailure: failure(error) } }
          const logs = docker(['logs', '--tail', '80', physical.Id], { allowFailure: true })
          let diagnostic = (logs.text + '\n' + logs.diagnostic).replaceAll(apiKey, '[REDACTED]').replaceAll(scratch, '[PRIVATE-SCRATCH]')
          if (execdToken) diagnostic = diagnostic.replaceAll(execdToken, '[REDACTED]')
          report.observations.isolationContainerDiagnostic = diagnostic.slice(-10000)
        }
      }
    }
    mark('qualification-finished')
  } else {
  mark('argv-and-environment')
  try {
    const argv = await command(['python3', '-c', 'import json,sys;print(json.dumps(sys.argv[1:]))', 'a b', '$HOME', 'x;y', '$(id)'], { argv: true })
    report.observations.argv = { supported: !argv.reportedError && argv.stdout.trim() === '["a b", "$HOME", "x;y", "$(id)"]', exitCode: argv.exitCode, reportedError: argv.reportedError }
  } catch (error) { report.observations.argv = { supported: false, failure: failure(error) } }
  const setup = await command('import os,venv,pathlib;os.makedirs("/opt/session-env/home",exist_ok=True);venv.create("/opt/session-env/venv",with_pip=False);pathlib.Path("/opt/session-env/home/retained").write_text("probe-retained");print("prepared")')
  const reused = await command('import os,pathlib;print(pathlib.Path(os.environ["HOME"],"retained").read_text())')
  report.observations.explicitSandboxReuse = { prepared: setup.stdout.trim() === 'prepared', retained: reused.stdout.trim() === 'probe-retained', sameSandboxId: sandbox.id, automaticSessionCoordinator: false }
  const disks = await command('import os,json;print(json.dumps({p:{"readOnly":bool(os.statvfs(p).f_flag & os.ST_RDONLY),"filesystemBytes":os.statvfs(p).f_blocks*os.statvfs(p).f_frsize,"filesystemInodes":os.statvfs(p).f_files} for p in ["/","/tmp","/opt/session-env/home","/workspace","/opt/session-env"]}))')
  report.observations.writableFilesystemFacts = { paths: JSON.parse(disks.stdout), accountOrInodeQuotaProven: false, diskFillingAttempted: false }
  mark('user-control-and-descendants')
  const control = await command('import os,json,urllib.request,urllib.error,pathlib;d={"uid":os.getuid(),"proc1Readable":os.access("/proc/1/environ",os.R_OK)};\ntry:\n req=urllib.request.Request("http://127.0.0.1:44772/command",data=json.dumps({"command":"printf forged > /workspace/forged-control"}).encode(),headers={"Content-Type":"application/json"});r=urllib.request.urlopen(req,timeout=2);r.read(2048);d["unauthenticatedManagementStartStatus"]=r.status;d["forgedMarkerWritten"]=pathlib.Path("/workspace/forged-control").exists()\nexcept urllib.error.HTTPError as e:d["unauthenticatedManagementStartStatus"]=e.code\nexcept Exception as e:d["managementProbeError"]=type(e).__name__\nprint(json.dumps(d))')
  report.observations.controlIdentity = JSON.parse(control.stdout)
  const descendant = await command('import subprocess,sys;code=bytes.fromhex("'+Buffer.from('import os,time,pathlib;pathlib.Path("/workspace/descendant.pid").write_text(str(os.getpid()));time.sleep(25)').toString('hex')+'").decode();p=subprocess.Popen([sys.executable,"-c",code],start_new_session=True,stdin=subprocess.DEVNULL,stdout=subprocess.DEVNULL,stderr=subprocess.DEVNULL);print(p.pid)')
  await delay(250)
  const descendantPid = Number(descendant.stdout.trim())
  if (!Number.isSafeInteger(descendantPid) || descendantPid <= 1 || descendant.exitCode !== 0) {
    report.observations.parentDoneVersusRange = { probeValid: false, parentExitCode: descendant.exitCode, pid: descendantPid, diagnostic: descendant.stderr.slice(0, 1500) }
  } else {
    const observer = docker(['exec', physical.Id, 'python3', '-c', `import pathlib,json;d={};\nfor k,pid in [("target",${descendantPid}),("negative",1073741824)]:\n try:\n  s=pathlib.Path("/proc",str(pid),"stat").read_text().rsplit(")",1)[1].split();d[k]={"pid":pid,"present":True,"state":s[0],"running":s[0] not in ["Z","X"],"ppid":int(s[1]),"pgrp":int(s[2]),"session":int(s[3]),"startTimeTicks":int(s[19])}\n except FileNotFoundError:d[k]={"pid":pid,"present":False}\nprint(json.dumps(d))`])
    const observed = JSON.parse(observer.text)
    report.observations.parentDoneVersusRange = { probeValid: true, parentExitCode: descendant.exitCode, pid: descendantPid, descendantAlive: observed.target.running === true,
      trustedObserver: { kind: 'Docker exec in exact observed task container', containerId: physical.Id, ...observed }, newSessionRequested: true, diagnostic: descendant.stderr.slice(0, 1500) }
  }
  const service = await sandbox.commands.run('python3 -c \'import time;time.sleep(25)\'', { background: true, timeoutSeconds: 30 }, { skipAccumulation: true }, AbortSignal.timeout(10000))
  let foregroundId
  const started = Promise.withResolvers()
  const running = sandbox.commands.run('python3 -c \'import time;time.sleep(25)\'', { timeoutSeconds: 30 }, { skipAccumulation: true, onInit: event => { foregroundId = event.id; started.resolve() } }, AbortSignal.timeout(12000)).then(result => ({ resolved: true, exitCode: result.exitCode ?? null }), error => ({ resolved: false, failure: failure(error) }))
  await Promise.race([started.promise, delay(5000).then(() => { throw new Error('foreground init not observed') })])
  await sandbox.commands.interrupt(foregroundId)
  const stoppedForeground = await running
  const serviceStatus = await sandbox.commands.getCommandStatus(service.id)
  report.observations.commandInterrupt = { foreground: stoppedForeground, independentBackgroundStillRunning: serviceStatus.running === true }
  await sandbox.commands.interrupt(service.id)
  mark('whole-allocation-stop-and-cold-rebuild')
  const old = sandbox, oldPhysicalId = physical.Id
  await old.kill()
  report.observations.wholeAllocationStopped = inspect(oldPhysicalId) === undefined || inspect(oldPhysicalId).State.Running === false
  try {
    await old.commands.run('touch /workspace/late-must-not-exist', undefined, { skipAccumulation: true }, AbortSignal.timeout(5000))
    report.observations.requestAfterDelete = { rejected: false }
  } catch (error) { report.observations.requestAfterDelete = { rejected: true, failure: failure(error), permanentDelayedSpawnGuarantee: false } }
  await old.close()
  await create(Sandbox, connectionConfig, args.get('--image'))
  const restored = await command('import pathlib,json;print(json.dumps({"environmentRetained":pathlib.Path("/opt/session-env/home/retained").read_text()=="probe-retained","lateMarkerExists":pathlib.Path("/workspace/late-must-not-exist").exists()}))')
  report.observations.coldEnvironment = { ...(JSON.parse(restored.stdout)), newSandboxId: sandbox.id, previousSandboxId: old.id }
  mark('probe-finished')
  }
} catch (error) {
  report.errors.push(failure(error))
  report.failedAt = report.phases.at(-1)?.phase ?? 'preparation'
  if (serverId) {
    const logs = docker(['logs', '--tail', '12', serverId], { allowFailure: true })
    let diagnostic = (logs.text + '\n' + logs.diagnostic).replaceAll(apiKey, '[REDACTED]').replaceAll(scratch, '[PRIVATE-SCRATCH]')
    if (execdToken) diagnostic = diagnostic.replaceAll(execdToken, '[REDACTED]')
    report.controlDiagnostic = diagnostic.slice(-5000)
  }
} finally {
  mark('cleanup')
  if (sandbox) {
    try { await sandbox.kill() } catch (error) { report.cleanup.sdkKillError = failure(error) }
    try { await sandbox.close() } catch (error) { report.cleanup.sdkCloseError = failure(error) }
  }
  if (manager) { try { await manager.close() } catch (error) { report.cleanup.managerCloseError = failure(error) } }
  const labelled = docker(['ps', '-aq', '--filter', `label=${label}`], { allowFailure: true })
  report.cleanup.observerErrors = []
  for (const id of labelled.text.split(/\s+/).filter(Boolean)) {
    try { const row = inspect(id); if (row) owned.add(row.Id) }
    catch (error) { report.cleanup.observerErrors.push(failure(error)) }
  }
  const knownCompute = [...owned].filter(id => id !== serverId)
  for (const id of knownCompute) docker(['rm', '-f', id], { allowFailure: true })
  if (serverId) docker(['rm', '-f', serverId], { allowFailure: true })
  const remaining = docker(['ps', '-aq', '--filter', `label=${label}`], { allowFailure: true })
  report.cleanup.remainingLabelledContainers = remaining.status === 0 ? remaining.text.split(/\s+/).filter(Boolean).length : null
  report.cleanup.knownContainerIds = [...owned]
  report.cleanup.knownContainersAbsent = labelled.status === 0 && remaining.status === 0
  for (const id of owned) {
    try { if (inspect(id) !== undefined) report.cleanup.knownContainersAbsent = false }
    catch (error) { report.cleanup.knownContainersAbsent = false; report.cleanup.observerErrors.push(failure(error)) }
  }
  if (scratch && report.cleanup.knownContainersAbsent) await rm(scratch, { recursive: true, force: true })
  report.cleanup.privateScratchRemoved = report.cleanup.knownContainersAbsent
  report.completedAt = new Date().toISOString()
  await writeFile(resolve(args.get('--out')), JSON.stringify(report, null, 2) + '\n')
  process.stdout.write(JSON.stringify({ report: resolve(args.get('--out')), failedAt: report.failedAt ?? null, observations: Object.keys(report.observations), cleanup: report.cleanup }) + '\n')
  if (report.errors.length || report.cleanup.remainingLabelledContainers || !report.cleanup.knownContainersAbsent) process.exitCode = 1
}
