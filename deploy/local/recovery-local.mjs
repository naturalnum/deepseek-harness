#!/usr/bin/env node
/** Recover the existing cold carrier through its original direct Engine exec, lifecycle and host smoke. */
import fs from 'node:fs'
import { dirname, isAbsolute, join, resolve } from 'node:path'
import { fileURLToPath, pathToFileURL } from 'node:url'
import { createHash, randomUUID } from 'node:crypto'
import { spawn } from 'node:child_process'
import { setTimeout as delay } from 'node:timers/promises'
import { CandidateError, inspectCandidate } from './inspect.mjs'
import { createLifecycle } from './lifecycle.mjs'
import { assertCandidateLock } from './candidate-lock.mjs'
import { requireNativeReleaseComplete } from './native-delivery.mjs'
import nativeState from './native-delivery-state.cjs'
import { readOptions } from '../smoke/options.mjs'
import { createRecoveryEngine } from './recovery-engine.mjs'

const ROOT = resolve(dirname(fileURLToPath(import.meta.url)), '../..')
const HELP = '用法：node deploy/local/recovery-local.mjs --input 本机私密JSON --sha256 SHA256\n仅在本实例正常收尾、备份和真实carrier冷重启后恢复。原事务未结清则拒绝；原冒烟未过不报告恢复成功。'
const digest = bytes => createHash('sha256').update(bytes).digest('hex')
const fail = () => { throw new CandidateError('本机冷重建未确认；保留原操作锁、原exec及私密日志，不重试或释放资源。') }
const absolute = value => typeof value === 'string' && isAbsolute(value) && resolve(value) === value && !value.includes('\0')

const FAILED_PREPARATION_OBSERVATION = String.raw`
const fs=require('node:fs'),crypto=require('node:crypto'),expected=JSON.parse(process.argv[1]);
const read=path=>{
 const posix=require('node:path').posix;
 if(!path.startsWith('/')||posix.normalize(path)!==path||path.includes('\0'))throw Error('invalid input path');
 for(let parent=posix.dirname(path);parent!=='/';parent=posix.dirname(parent)){const s=fs.lstatSync(parent);if(!s.isDirectory()||s.isSymbolicLink()||s.uid!==0||(s.mode&0o022)!==0)throw Error('unprotected parent')}
 const fd=fs.openSync(path,fs.constants.O_RDONLY|fs.constants.O_NOFOLLOW);
 try{const a=fs.fstatSync(fd);if(!a.isFile()||a.nlink!==1||a.uid!==0||(a.mode&0o077)!==0||a.size<1||a.size>1048576)throw Error('unprotected input');
 const bytes=fs.readFileSync(fd),b=fs.fstatSync(fd),n=fs.lstatSync(path);if(['dev','ino','size','mtimeMs','ctimeMs'].some(k=>a[k]!==b[k]||b[k]!==n[k]))throw Error('input changed');return bytes;
 }finally{fs.closeSync(fd)}
};
const input=read(expected.input),hash=bytes=>crypto.createHash('sha256').update(bytes).digest('hex');
if(hash(input)!==expected.sha256)throw Error('input changed');
const spec=JSON.parse(input),dir=spec.operationDirectory,metadata=JSON.parse(read(spec.snapshotDirectory+'/metadata.json'));
const identity=pid=>{const s=fs.readFileSync('/proc/'+pid+'/stat','utf8');return {pid,startTicks:s.slice(s.lastIndexOf(')')+2).split(/\s+/)[19],namespace:fs.readlinkSync('/proc/'+pid+'/ns/mnt')}};
const carrier=identity(1);
if(carrier.startTicks===metadata.carrier.startTicks)throw Error('carrier not cold');
for(const previous of metadata.namespaceReferences){try{if(identity(previous.pid).startTicks===previous.startTicks)throw Error('original process live')}catch(e){if(!['ENOENT','ESRCH'].includes(e.code))throw e}}
const names=fs.readdirSync(dir).sort(),files=['input.json','journal.jsonl','launch.log','measurement.json','ready.json'].sort();
if(JSON.stringify(names)!==JSON.stringify(files))throw Error('preparation state changed');
for(const name of files){const p=dir+'/'+name,s=fs.lstatSync(p);if(!s.isFile()||s.isSymbolicLink()||s.nlink!==1||s.uid!==0||(s.mode&0o7777)!==0o600||name!=='input.json'&&s.size!==0)throw Error('launch evidence exists')}
const processes=[];
for(const name of fs.readdirSync('/proc').filter(x=>/^[1-9]\d*$/.test(x))){const pid=Number(name);if(pid===process.pid)continue;try{
 const argv=fs.readFileSync('/proc/'+pid+'/cmdline','utf8').split('\0').filter(Boolean),id=identity(pid);
 if(id.namespace!==carrier.namespace||pid!==1&&JSON.stringify(argv)!==JSON.stringify(expected.initialCommand))throw Error('other process live');
 processes.push(id);
}catch(e){if(!['ENOENT','ESRCH'].includes(e.code))throw e}}
console.log(JSON.stringify({inputSha256:hash(input),operationDirectory:dir,carrier,processes,stage:'staged-before-launch'}));
`

const PUBLISHED_RECOVERY_OBSERVATION = String.raw`
const fs=require('node:fs'),crypto=require('node:crypto'),expected=JSON.parse(process.argv[1]);
const hash=bytes=>crypto.createHash('sha256').update(bytes).digest('hex');
const read=path=>{const fd=fs.openSync(path,fs.constants.O_RDONLY|fs.constants.O_NOFOLLOW);try{
 const a=fs.fstatSync(fd);if(!a.isFile()||a.nlink!==1||a.uid!==0||(a.mode&0o077)!==0||a.size<1||a.size>1048576)throw Error('unprotected observation');
 const bytes=fs.readFileSync(fd),b=fs.fstatSync(fd),n=fs.lstatSync(path);if(['dev','ino','size','mtimeMs','ctimeMs'].some(k=>a[k]!==b[k]||b[k]!==n[k]))throw Error('changed observation');return bytes;
}finally{fs.closeSync(fd)}};
const input=read(expected.input);if(hash(input)!==expected.sha256)throw Error('original input changed');
const spec=JSON.parse(input),meta=JSON.parse(read(spec.snapshotDirectory+'/metadata.json')),dir=spec.operationDirectory;
const control=JSON.parse(read(dir+'/recovery-control.json')),ready=JSON.parse(read(dir+'/ready.json')),measurement=read(dir+'/measurement.json');
const stat=fs.readFileSync('/proc/1/stat','utf8'),ticks=stat.slice(stat.lastIndexOf(')')+2).split(/\s+/)[19];
if(control.carrier.startTicks!==ticks||control.snapshotDirectory!==spec.snapshotDirectory||control.resourceId!==meta.launch.resourceId
 ||ready.resourceId!==control.resourceId||ready.configurationComplete!==true||hash(measurement)!==ready.planSha256)throw Error('publication binding mismatch');
const rows=read(dir+'/launch.log').toString('utf8').split('\n').filter(Boolean).flatMap(line=>{try{return [JSON.parse(line)]}catch(error){return []}});
const sealed=rows.filter(r=>r.phase==='sealed-new-root-inputs-not-application-ready'&&r.resourceId===ready.resourceId);
if(sealed.length!==1||sealed[0].planSha256!==ready.planSha256||!Number.isSafeInteger(sealed[0].shellPid))throw Error('sealed publication missing');
const pid=sealed[0].shellPid,home='/proc/'+pid+'/root/run/dsh-feature-root';
if(hash(fs.readFileSync(home+'/rootDeployment.json'))!==ready.rootDeploymentSha256||hash(fs.readFileSync(home+'/profiles/cloud/cordis.patch.yml'))!==ready.profileSha256
 ||hash(fs.readFileSync(home+'/storage-plan.json'))!==ready.planSha256)throw Error('sealed inputs changed');
for(const [file,key]of[['credentials.json','credentialsBytes'],['profiles/cloud/package.json','packageBytes'],['profiles/cloud/cordis.yml','mutableProfileBytes']]){
 if(hash(fs.readFileSync(home+'/'+file))!==meta.fileSha256[key])throw Error('original input changed');
}
console.log(JSON.stringify({ready:false,cliRunning:true,inputsValidated:true,publicationObserved:true,applicationPid:pid,
 namespaceId:sealed[0].mountNamespace,appCheckPath:meta.launch.scripts.steps.path,productMount:meta.storage.support.find(r=>r.role==='products')??null}));
`

async function retireFailedPreparation(argv, { signal, report }) {
  if (argv.length !== 5 || argv[1] !== '--input' || argv[3] !== '--sha256' || !/^[a-f0-9]{64}$/.test(argv[4])) fail()
  const bytes = privateInput(argv[2]), request = JSON.parse(bytes)
  if (digest(bytes) !== argv[4] || request.schema !== 'pe-cloud-retire-failed-preparation/v1'
    || !absolute(request.originalInput) || !/^[a-f0-9]{64}$/.test(request.originalInputSha256)
    || !/^[a-f0-9-]{36}$/.test(request.operation) || !Number.isSafeInteger(request.budgetMs)
    || request.budgetMs < 1000 || request.budgetMs > 60000) fail()
  const originalBytes = privateInput(request.originalInput), spec = JSON.parse(originalBytes)
  if (digest(originalBytes) !== request.originalInputSha256 || spec.schema !== 'pe-cloud-cold-recovery-local/v1'
    || !absolute(spec.stateDirectory) || !absolute(spec.rootInput) || !absolute(spec.rootEntry)) fail()
  await assertCandidateLock(spec.workDirectory, request.line)
  const lockPath = join(spec.stateDirectory, 'operation.lock'), originalLock = privateInput(lockPath)
  const records = originalLock.toString('utf8').trim().split('\n').map(line => JSON.parse(line)), header = records[0]
  const original = fs.lstatSync(lockPath)
  const gone = () => { try { process.kill(header.pid, 0); fail() } catch (error) { if (error.code !== 'ESRCH') throw error } }
  if (records.length !== 1 || header.format !== 'pe-cloud-cold-recovery-operation/v1' || header.operation !== request.operation
    || header.inputSha256 !== request.originalInputSha256 || !Number.isSafeInteger(header.pid) || header.pid <= 0
    || String(original.dev) !== request.lockDevice || String(original.ino) !== request.lockInode) fail()
  gone()
  const deadlineAtMs = performance.now() + request.budgetMs
  const transport = createRecoveryEngine({ signal, deadlineAtMs, socketPath: spec.socketPath, dockerPath: spec.dockerPath,
    container: spec.container, maxOutputBytes: 1048576, via: spec.via })
  try {
    const target = await transport.request('GET', '/containers/' + spec.container + '/json')
    if (target?.Id !== spec.containerId || target.Image !== spec.imageId || target.State?.Running !== true
      || !Array.isArray(target.Args) || typeof target.Path !== 'string') fail()
    const originalCommand = [target.Path, ...target.Args]
    const observation = JSON.parse(await transport.runDocker(['exec', '--interactive', '--user', '0', spec.container,
      spec.nodePath, '-e', FAILED_PREPARATION_OBSERVATION, JSON.stringify({ input: spec.rootInput,
        sha256: spec.rootInputSha256, initialCommand: originalCommand })]))
    if (observation.stage !== 'staged-before-launch' || observation.inputSha256 !== spec.rootInputSha256) fail()
    const after = await transport.request('GET', '/containers/' + spec.container + '/json')
    if (after.Id !== target.Id || after.State.Pid !== target.State.Pid || !Array.isArray(after.ExecIDs ?? [])) fail()
    for (const id of after.ExecIDs ?? []) {
      const execution = await transport.inspectExec(id)
      if (execution.running || execution.missing || execution.exitCode === null) fail()
    }
    gone(); within(signal, deadlineAtMs)
    if (!privateInput(lockPath).equals(originalLock)) fail()
    const current = fs.lstatSync(lockPath)
    if (current.dev !== original.dev || current.ino !== original.ino) fail()
    const archive = join(spec.stateDirectory, 'cold-prelaunch-failed-' + header.operation + '.jsonl')
    const receipt = { operation: header.operation, status: 'failed-preparation-archived', inputSha256: header.inputSha256,
      originalLockSha256: digest(originalLock), observation, resourcesReleased: false }
    const receiptFd = fs.openSync(archive + '.receipt.json', 'wx', 0o600)
    try { fs.writeFileSync(receiptFd, JSON.stringify(receipt) + '\n'); fs.fsyncSync(receiptFd) } finally { fs.closeSync(receiptFd) }
    fs.linkSync(lockPath, archive)
    const archived = fs.lstatSync(archive)
    if (archived.dev !== original.dev || archived.ino !== original.ino || !fs.readFileSync(archive).equals(originalLock)) fail()
    const parent = fs.openSync(spec.stateDirectory, fs.constants.O_RDONLY | fs.constants.O_DIRECTORY)
    try {
      fs.fsyncSync(parent)
      const named = fs.lstatSync(lockPath)
      if (named.dev !== original.dev || named.ino !== original.ino || named.nlink !== 2) fail()
      fs.unlinkSync(lockPath); fs.fsyncSync(parent)
    } finally { fs.closeSync(parent) }
    report(JSON.stringify({ status: receipt.status, operation: header.operation, archive, resourcesReleased: false }))
    return 0
  } finally { await transport.close() }
}

function privateInput(path) {
  if (!absolute(path)) fail()
  const fd = fs.openSync(path, fs.constants.O_RDONLY | fs.constants.O_NOFOLLOW)
  try {
    const before = fs.fstatSync(fd)
    if (!before.isFile() || before.nlink !== 1 || before.uid !== process.getuid()
      || (before.mode & 0o077) !== 0 || before.size < 1 || before.size > 1048576) fail()
    const bytes = fs.readFileSync(fd), after = fs.fstatSync(fd)
    if (['dev', 'ino', 'size', 'mtimeMs', 'ctimeMs'].some(key => before[key] !== after[key])) fail()
    return bytes
  } finally { fs.closeSync(fd) }
}

function within(signal, deadlineAtMs) {
  if (signal.aborted || performance.now() >= deadlineAtMs) fail()
}

// Every submitted child remains owned until close, including cancellation/timeout. Output never enters errors.
async function childResult(executable, args, { signal, deadlineAtMs, logFd }) {
  within(signal, deadlineAtMs)
  const child = spawn(executable, args, { cwd: ROOT, stdio: logFd === undefined ? ['ignore', 'pipe', 'pipe'] : ['ignore', logFd, logFd] })
  let failed = false, stopped = false, bytes = 0
  const chunks = []
  const stop = () => { failed = true; if (!stopped) { stopped = true; child.kill('SIGTERM') } }
  if (logFd === undefined) {
    child.stdout.on('data', chunk => { bytes += chunk.length; if (bytes > 1048576) stop(); else chunks.push(chunk) })
    child.stderr.on('data', chunk => { bytes += chunk.length; if (bytes > 1048576) stop() })
    child.stdout.on('error', () => { failed = true }); child.stderr.on('error', () => { failed = true })
  }
  child.on('error', () => { failed = true })
  signal.addEventListener('abort', stop, { once: true })
  const timer = setTimeout(stop, Math.max(1, deadlineAtMs - performance.now()))
  if (signal.aborted) stop()
  try {
    const result = await new Promise(resolveRun => child.once('close', (code, signal) => resolveRun({ code, signal })))
    within(signal, deadlineAtMs)
    if (failed || result.code !== 0 || result.signal !== null) fail()
    return Buffer.concat(chunks).toString('utf8')
  } finally { clearTimeout(timer); signal.removeEventListener('abort', stop) }
}

/**
 * Recover one genuinely restarted existing candidate; never stop containers or alter native transaction state.
 * @param {string[]} argv Explicit private host input reference and its SHA256; help performs no I/O.
 * @param {object} options Original cancellation signal and nonsecret reporting callback.
 * @returns {Promise<number>} Zero only after the actual original exec, normal keeper, 401 and original host
 * smoke have passed. Failures retain the ordinary operation lock with every known created exec ID.
 */
export async function runLocalRecovery(argv, { signal = new AbortController().signal, report = console.log } = {}) {
  const startedAtMs = performance.now()
  if (argv[0] === 'retire-prelaunch') return retireFailedPreparation(argv, { signal, report })
  const verifyStarted = argv[0] === 'verify-started'
  if (verifyStarted) argv = argv.slice(1)
  if (argv.length === 0 || argv.length === 1 && argv[0] === '--help') { report(HELP); return 0 }
  if (argv.length !== 4 || argv[0] !== '--input' || argv[2] !== '--sha256' || !/^[a-f0-9]{64}$/.test(argv[3])) fail()
  const input = privateInput(argv[1]), spec = JSON.parse(input)
  if (digest(input) !== argv[3] || spec.schema !== 'pe-cloud-cold-recovery-local/v1'
    || !/^[A-Za-z0-9][A-Za-z0-9_.-]*$/.test(spec.container) || !Number.isSafeInteger(spec.budgetMs) || spec.budgetMs < 1000 || spec.budgetMs > 1800000
    || !['dockerPath', 'socketPath', 'nodePath', 'rootEntry', 'rootInput', 'stateDirectory', 'workDirectory', 'logDirectory'].every(key => absolute(spec[key]))
    || spec.stateDirectory !== join(spec.workDirectory, 'local-state') || !/^[a-f0-9]{64}$/.test(spec.rootInputSha256)) fail()
  if (!/^[a-f0-9]{64}$/.test(spec.containerId) || !/^sha256:[a-f0-9]{64}$/.test(spec.imageId)
    || !/^[a-f0-9-]{36}$/.test(spec.resourceId)) fail()
  const deadlineAtMs = startedAtMs + spec.budgetMs
  within(signal, deadlineAtMs)
  const smoke = spec.smoke
  if (!smoke || !absolute(smoke.credentialsPath) || typeof smoke.account !== 'string' || !smoke.account
    || typeof smoke.continueSession !== 'string' || typeof smoke.continueMarker !== 'string') fail()
  const smokeArgs = ['--url', spec.url, '--credentials', smoke.credentialsPath, '--account', smoke.account,
    '--continue-session', smoke.continueSession, '--continue-marker', smoke.continueMarker]
  await readOptions(smokeArgs, {}) // Original parser privately owns credentials/account/origin/session validation.
  await assertCandidateLock(spec.workDirectory, spec.line)
  requireNativeReleaseComplete(spec.stateDirectory)
  let latest
  try { latest = JSON.parse(privateInput(join(spec.stateDirectory, 'latest.json'))) }
  catch (error) { if (error.code !== 'ENOENT') throw error } // Fresh handed-over SDK carriers have no old local-update projection.
  if (latest?.format === nativeState.PROJECTION) {
    if (latest.nativePhase !== 'verified') fail()
    requireNativeReleaseComplete(spec.stateDirectory, undefined, latest.operation)
  } else if (latest !== undefined) {
    nativeState.requireOrdinaryUpdateState(latest)
    if (!['verified', 'recovered', 'rolled-back'].includes(latest.phase)) fail()
  }
  within(signal, deadlineAtMs)
  const operation = randomUUID(), lockPath = join(spec.stateDirectory, 'operation.lock')
  let retainedExec
  if (verifyStarted) {
    const records = privateInput(lockPath).toString('utf8').trim().split('\n').map(line => JSON.parse(line)), original = records[0]
    if (records.length !== 2 || original.format !== 'pe-cloud-cold-recovery-operation/v1' || original.inputSha256 !== argv[3]
      || !Number.isSafeInteger(original.pid) || original.pid <= 0 || !/^[a-f0-9]{64}$/.test(records[1].createdExecId)) fail()
    try { process.kill(original.pid, 0); fail() } catch (error) { if (error.code !== 'ESRCH') throw error }
    retainedExec = records[1].createdExecId
  }
  const lock = fs.openSync(lockPath, verifyStarted ? 'a' : 'wx', 0o600)
  let lockOpen = true, transport, execId, result, appCheckPath, productMount
  const record = value => { fs.writeFileSync(lock, JSON.stringify(value) + '\n'); fs.fsyncSync(lock) }
  try {
    if (!verifyStarted) record({ format: 'pe-cloud-cold-recovery-operation/v1', operation, inputSha256: argv[3], pid: process.pid })
    const parent = fs.openSync(spec.stateDirectory, fs.constants.O_RDONLY | fs.constants.O_DIRECTORY | fs.constants.O_NOFOLLOW)
    try { fs.fsyncSync(parent) } finally { fs.closeSync(parent) }
    if (verifyStarted) {
      const directory = fs.lstatSync(spec.logDirectory)
      if (!directory.isDirectory() || directory.isSymbolicLink() || directory.uid !== process.getuid() || (directory.mode & 0o077) !== 0) fail()
    } else fs.mkdirSync(spec.logDirectory, { mode: 0o700 })
    transport = createRecoveryEngine({ signal, deadlineAtMs, socketPath: spec.socketPath,
      dockerPath: spec.dockerPath, container: spec.container, maxOutputBytes: 1048576, via: spec.via })
    const settings = { signal, deadlineAtMs }
    const execute = (command, options) => transport.runDocker(['exec', '--interactive', '--user', '0', spec.container, ...command], options)
    const stage = async name => JSON.parse(await execute([spec.nodePath, spec.rootEntry, name, '--input', spec.rootInput, '--sha256', spec.rootInputSha256]))
    const engine = async (method, route, payload) => {
      const value = await transport.request(method, route, payload)
      if (method === 'POST' && route === '/containers/' + spec.container + '/exec') {
        if (!/^[a-f0-9]{64}$/.test(value?.Id)) fail()
        record({ createdExecId: value.Id }) // Persist before any start attempt; never replay an unknown request.
      }
      return value
    }
    const inspect = async () => {
      return inspectCandidate({ container: spec.container, execute, appCheckPath, productMount, execution: id => transport.inspectExec(id),
        execIds: async () => (await engine('GET', '/containers/' + spec.container + '/json'))?.ExecIDs ?? [],
        top: async () => {
          const observed = await engine('GET', '/containers/' + spec.container + '/top?ps_args=-eo%20pid%2Ccomm')
          if (!Array.isArray(observed?.Processes) || observed.Titles?.join(',') !== 'PID,COMMAND') fail()
          return observed.Processes.map(row => ({ pid: Number(row[0]), comm: row[1] }))
        } })
    }
    const target = await engine('GET', '/containers/' + spec.container + '/json')
    if (target?.Id !== spec.containerId || target.Image !== spec.imageId || target.State?.Running !== true) fail()
    let published
    if (verifyStarted) {
      execId = retainedExec
      const original = await transport.inspectExec(execId)
      if (!original.running || original.missing) fail()
      published = JSON.parse(await execute([spec.nodePath, '-e', PUBLISHED_RECOVERY_OBSERVATION,
        JSON.stringify({ input: spec.rootInput, sha256: spec.rootInputSha256 })]))
      if (published.publicationObserved !== true) fail()
    } else {
    const prepared = await stage('prepare')
    if (prepared.ready !== false || prepared.storageReady !== true || !Array.isArray(prepared.launchCommand)
      || prepared.resourceId !== spec.resourceId || prepared.launchCommand.some(value => typeof value !== 'string' || value.includes('\0'))) fail()
    const created = await engine('POST', '/containers/' + spec.container + '/exec', {
      AttachStdin: false, AttachStdout: false, AttachStderr: false, Tty: false, User: '0',
      Env: ['PATH=/usr/sbin:/usr/bin:/sbin:/bin'], WorkingDir: '/', Cmd: prepared.launchCommand,
    })
    execId = created.Id
    await engine('POST', '/exec/' + execId + '/start', { Detach: true, Tty: false })
    published = await stage('publish')
    }
    if (published.ready !== false || published.cliRunning !== true || published.inputsValidated !== true || !absolute(published.appCheckPath)) fail()
    appCheckPath = published.appCheckPath
    productMount = published.productMount
    const current = await inspect()
    if (current.appPid !== published.applicationPid || current.namespaceId !== published.namespaceId || current.appExecId !== execId) fail()
    const lifecycle = createLifecycle({ container: spec.container, inspect, execute, engine, execution: id => transport.inspectExec(id) })
    await lifecycle.ensureNamespaceHolder(current)
    const ready = await inspect()
    if (!ready.canStopSafely || ready.appExecId !== execId || ready.namespaceId !== published.namespaceId) fail()
    while (true) {
      within(signal, deadlineAtMs)
      if (!(await transport.inspectExec(execId)).running) fail()
      let status
      try {
        const response = await fetch(new URL('/cloud/bootstrap', spec.url), {
          signal: AbortSignal.any([signal, AbortSignal.timeout(Math.max(1, Math.min(1000, Math.ceil(deadlineAtMs - performance.now()))))]),
        })
        status = response.status; await response.body?.cancel()
      } catch (_error) { status = null } // Startup can briefly refuse a connection; non-401 responses fail below.
      if (status === 401) break
      if (status !== null) fail()
      await delay(Math.min(250, Math.max(1, deadlineAtMs - performance.now())))
    }
    const log = fs.openSync(join(spec.logDirectory, 'smoke.log'), 'wx', 0o600)
    try { await childResult(process.execPath, [join(ROOT, 'deploy/smoke/check.mjs'), ...smokeArgs], { ...settings, logFd: log }); fs.fsyncSync(log) }
    finally { fs.closeSync(log) }
    const final = await inspect()
    within(signal, deadlineAtMs)
    if (!final.canStopSafely || final.appExecId !== execId || final.appPid !== ready.appPid
      || final.appStartTicks !== ready.appStartTicks || final.namespaceId !== ready.namespaceId) fail()
    result = { ready: true, resourcesReady: true, bootstrapStatus: 401, smokeStatus: 'passed',
      appExecId: execId, applicationPid: final.appPid, namespaceId: final.namespaceId }
    await transport.close(); transport = undefined
    const original = fs.fstatSync(lock)
    lockOpen = false; fs.closeSync(lock)
    const named = fs.lstatSync(lockPath)
    if (!named.isFile() || named.isSymbolicLink() || named.nlink !== 1 || named.dev !== original.dev || named.ino !== original.ino) fail()
    fs.unlinkSync(lockPath) // Final fallible release operation; no native receipt or latest state is fabricated.
  } catch (_error) {
    const error = new CandidateError('本机冷重建未通过；原exec、原操作锁及私密日志保留，先核实际终态。')
    error.recoveryExecId = execId ?? null
    error.recoveryOutcome = signal.aborted ? 'cancelled' : performance.now() >= deadlineAtMs ? 'timed-out' : 'unconfirmed'
    throw error
  } finally {
    await transport?.close()
    if (lockOpen) { lockOpen = false; fs.closeSync(lock) }
  }
  report(JSON.stringify(result)); return 0
}

if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href) {
  const controller = new AbortController()
  process.once('SIGINT', () => controller.abort()); process.once('SIGTERM', () => controller.abort())
  runLocalRecovery(process.argv.slice(2), { signal: controller.signal }).then(code => { process.exitCode = code }, error => {
    console.error(JSON.stringify({ ready: false, status: error?.recoveryOutcome ?? 'failed', execId: error?.recoveryExecId ?? null,
      disposition: '原操作责任及私密日志保留；不重放、不清理。' })); process.exitCode = 1
  })
}
