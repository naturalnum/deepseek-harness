/** Discover the existing local candidate without exposing its credentials or environment. */
import { execFile } from 'node:child_process'
import http from 'node:http'
import { pathToFileURL } from 'node:url'

export const CANDIDATE_CONTAINER = 'dsh-features-20261107-runtime'
const CLI_PATH = '/opt/dsh-installed-products/apps/cli/lib/bin.js'

/** A deployment failure whose diagnostic contains no external command output. */
export class CandidateError extends Error {
  constructor(message, exitCode = null) {
    super(message)
    this.name = 'CandidateError'
    this.exitCode = exitCode
  }
}

async function docker(args, { input } = {}) {
  return new Promise((resolve, reject) => {
    const child = execFile('docker', args, { encoding: 'utf8', maxBuffer: 8 * 1024 * 1024 }, (error, stdout) => {
      if (error) reject(new CandidateError('候选环境命令执行失败。', typeof error.code === 'number' ? error.code : null))
      else resolve(stdout)
    })
    child.stdin?.end(input)
  })
}

/** Execute an argv array in the fixed candidate container; stderr is never included in failures. */
export async function execInCandidate(args, options = {}) {
  return docker(['exec', '--interactive', CANDIDATE_CONTAINER, ...args], options)
}

/** Enter a discovered candidate mount namespace without changing its mount configuration. */
export async function execInNamespace(snapshot, args, options = {}) {
  if (!snapshot.namespacePid) throw new CandidateError('没有可用的候选挂载命名空间。')
  return execInCandidate(['nsenter', '-t', String(snapshot.namespacePid), '-m', '--root', '--wd=/', ...args], options)
}

/** Call the active local Docker Engine socket; remote TCP contexts are not accepted. */
export async function engineRequest(method, requestPath, payload) {
  const endpoint = (await docker(['context', 'inspect', '--format', '{{.Endpoints.docker.Host}}'])).trim()
  if (!endpoint.startsWith('unix://')) throw new CandidateError('候选更新只支持本机 Docker socket。')
  const body = payload === undefined ? undefined : JSON.stringify(payload)
  return new Promise((resolve, reject) => {
    const request = http.request({
      socketPath: endpoint.slice('unix://'.length), method, path: requestPath,
      headers: body === undefined ? {} : { 'Content-Type': 'application/json', 'Content-Length': Buffer.byteLength(body) },
    }, response => {
      const chunks = []
      response.on('data', chunk => chunks.push(chunk))
      response.on('error', () => reject(new CandidateError('无法读取本机 Docker 响应。')))
      response.on('end', () => {
        if (response.statusCode < 200 || response.statusCode >= 300) {
          reject(new CandidateError('本机 Docker 请求失败。', response.statusCode))
          return
        }
        const raw = Buffer.concat(chunks).toString('utf8')
        if (!raw) { resolve(null); return }
        try { resolve(JSON.parse(raw)) }
        catch (_error) { reject(new CandidateError('本机 Docker 响应格式无效。')) }
      })
    })
    request.on('error', () => reject(new CandidateError('无法访问本机 Docker socket。')))
    request.end(body)
  })
}

/** Read the lifecycle status of one already identified Docker exec, omitting its command and environment. */
export async function inspectExec(execId, { request = engineRequest } = {}) {
  if (!/^[a-f0-9]{64}$/.test(execId)) throw new CandidateError('应用启动标识无效。')
  let result
  try { result = await request('GET', '/exec/' + execId + '/json') }
  catch (error) {
    if (error instanceof CandidateError && error.exitCode === 404) {
      return { execId, running: false, exitCode: null, hostPid: 0, missing: true }
    }
    throw error
  }
  return { execId: result.ID, running: result.Running, exitCode: result.ExitCode, hostPid: result.Pid }
}

/** Select a unique application and an independently retained namespace holder from sanitized process rows. */
export function selectProcessState(rows, containerNamespaceId) {
  const apps = rows.filter(row => row.isApp)
  if (apps.length > 1) throw new CandidateError('候选环境存在多个应用实例，不能选择。')
  const app = apps[0] ?? null
  const holders = rows.filter(row => row.isHolder && row.namespaceId !== containerNamespaceId)
  const namespaces = [...new Set(holders.map(row => row.namespaceId))]
  if (!app && namespaces.length > 1) throw new CandidateError('候选环境存在多个保留的挂载命名空间，不能选择。')
  const namespaceId = app?.namespaceId ?? namespaces[0] ?? null
  if (!namespaceId) throw new CandidateError('未发现应用或保留的候选挂载命名空间。')
  const matchingHolders = holders.filter(row => row.namespaceId === namespaceId)
  const holder = matchingHolders.length === 1 ? matchingHolders[0] : null
  const issues = []
  if (!holder) issues.push(matchingHolders.length ? '同命名空间存在多个保留进程，不能选择。' : '没有独立保留挂载命名空间的进程；停止应用前必须先保留它。')
  return { app, holder, namespaceId, namespacePid: holder?.pid ?? app?.pid ?? null, issues }
}

/** Bind the unique container application to its Docker exec by the independently observed host process id. */
export function matchApplicationExec(app, topRows, executions) {
  if (!app) return null
  const hostRows = topRows.filter(row => row.comm === app.comm)
  if (hostRows.length !== 1) return null
  const matches = executions.filter(row => row.running && row.hostPid === hostRows[0].pid)
  return matches.length === 1 ? matches[0] : null
}

const PROBE = String.raw`
const fs = require('node:fs'), {execFileSync} = require('node:child_process');
const anchor = process.argv[1], cli = '/opt/dsh-installed-products/apps/cli/lib/bin.js';
const root = '/proc/' + anchor + '/root';
const read = (name) => fs.readFileSync(name, 'utf8');
const link = (name) => {try{return fs.readlinkSync(name)}catch(error){if(error.code==='ENOENT'||error.code==='ESRCH')return null;throw error}};
const present = (name, directory=false) => {try{const s=fs.statSync(root+name);return directory?s.isDirectory():s.isFile()}catch(error){if(error.code==='ENOENT')return false;throw error}};
const rows=[];
for(const name of fs.readdirSync('/proc')){
 if(!/^\d+$/.test(name)||Number(name)===process.pid)continue;
 try{
  const base='/proc/'+name, argv=read(base+'/cmdline').split('\0').filter(Boolean), status=read(base+'/status');
  const executable=link(base+'/exe'), namespaceId=link(base+'/ns/mnt');
  const isApp=argv.includes(cli)&&executable?.endsWith('/node24');
  const isHolder=argv.length===2&&argv[0].split('/').at(-1)==='sleep'&&argv[1]==='infinity';
  const stat=read(base+'/stat'), parts=stat.slice(stat.lastIndexOf(')')+2).split(/\s+/);
  const row={pid:Number(name),uid:Number(status.match(/^Uid:\s+(\d+)/m)[1]),gid:Number(status.match(/^Gid:\s+(\d+)/m)[1]),comm:read(base+'/comm').trim(),namespaceId,startTicks:parts[19],isApp:Boolean(isApp),isHolder};
  if(isApp){const position=argv.indexOf('--shutdown-timeout-ms'), raw=argv[position+1];row.shutdownTimeoutMs=position>=0&&/^\d+$/.test(raw)?Number(raw):null;row.cwd=link(base+'/cwd');row.nodePath=executable;row.stdoutPath=link(base+'/fd/1');row.stderrPath=link(base+'/fd/2');}
  rows.push(row);
 }catch(error){if(error.code!=='ENOENT'&&error.code!=='ESRCH')throw error;}
}
const productRoot='/opt/dsh-installed-products';
let productDevice=null,productReadOnly=null,productFilesystem=null,productBlockReadOnly=null;
try{
 const raw=execFileSync('nsenter',['-t',anchor,'-m','--root','--wd=/','findmnt','--json','--target',productRoot,'--output','TARGET,SOURCE,FSTYPE,OPTIONS'],{encoding:'utf8',stdio:['ignore','pipe','pipe']});
 const mounts=JSON.parse(raw).filesystems.filter(row=>row.target===productRoot);
 if(mounts.length===1){const mount=mounts[0];productDevice=typeof mount.source==='string'&&/^\/dev\/[A-Za-z0-9/_-]+$/.test(mount.source)?mount.source:null;productReadOnly=mount.options.split(',').includes('ro');productFilesystem=mount.fstype;
  if(productDevice){const ro=execFileSync('nsenter',['-t',anchor,'-m','--root','--wd=/','blockdev','--getro',productDevice],{encoding:'utf8',stdio:['ignore','pipe','pipe']}).trim();productBlockReadOnly=ro==='1'?true:ro==='0'?false:null;}}
}catch(_error){/* A missing product observation remains null and prevents a safe update. */}
const profileHome=present('/run/dsh-feature-root',true)&&present('/run/dsh-feature-root/profiles/cloud/cordis.patch.yml')?'/run/dsh-feature-root':null;
console.log(JSON.stringify({rows,containerNamespaceId:link('/proc/1/ns/mnt'),productRoot:present(productRoot,true)?productRoot:null,productDevice,productReadOnly,productFilesystem,productBlockReadOnly,nodePath:present('/dsh-tools/node24')?'/dsh-tools/node24':null,appCheckPath:present('/opt/dsh-features/feature-namespace-steps.v3.mjs')?'/opt/dsh-features/feature-namespace-steps.v3.mjs':null,seccompPath:present('/opt/dsh-feature-assets/app-seccomp.bpf')?'/opt/dsh-feature-assets/app-seccomp.bpf':null,profileHome}));
`

async function findProbeAnchor() {
  const names = (await execInCandidate(['/bin/ls', '/proc'])).split(/\s+/).filter(value => /^\d+$/.test(value))
  const rootNamespace = (await execInCandidate(['/bin/readlink', '/proc/1/ns/mnt'])).trim()
  const apps = [], holders = []
  for (const name of names) {
    let argv
    try { argv = (await execInCandidate(['/bin/cat', '/proc/' + name + '/cmdline'])).split('\0').filter(Boolean) }
    catch (_error) { continue /* Short-lived processes can exit between directory and cmdline reads. */ }
    if (argv.includes(CLI_PATH)) apps.push(Number(name))
    else if (argv.length === 2 && argv[0].split('/').at(-1) === 'sleep' && argv[1] === 'infinity') {
      const namespace = (await execInCandidate(['/bin/readlink', '/proc/' + name + '/ns/mnt'])).trim()
      if (namespace !== rootNamespace) holders.push(Number(name))
    }
  }
  if (apps.length > 1) throw new CandidateError('候选环境存在多个应用实例，不能选择。')
  if (apps.length === 1) return { pid: apps[0], node: '/proc/' + apps[0] + '/exe' }
  if (holders.length !== 1) throw new CandidateError('没有唯一可用的候选命名空间保留进程。')
  return { pid: holders[0], node: '/proc/' + holders[0] + '/root/dsh-tools/node24' }
}

/** Discover process identities, mount source and launch paths for the fixed local candidate. */
export async function inspectCandidate() {
  const anchor = await findProbeAnchor()
  let observed
  try { observed = JSON.parse(await execInCandidate([anchor.node, '-e', PROBE, String(anchor.pid)])) }
  catch (error) { if (error instanceof CandidateError) throw error; throw new CandidateError('无法解析候选运行态。') }
  const selected = selectProcessState(observed.rows, observed.containerNamespaceId)
  const app = selected.app, holder = selected.holder
  const top = (await docker(['top', CANDIDATE_CONTAINER, '-eo', 'pid,comm'])).trim().split('\n').slice(1).map(line => {
    const fields = line.trim().split(/\s+/)
    return { pid: Number(fields[0]), comm: fields[1] }
  })
  const execIds = JSON.parse(await docker(['inspect', '--format', '{{json .ExecIDs}}', CANDIDATE_CONTAINER])) ?? []
  const executions = await Promise.all(execIds.map(inspectExec))
  const execution = matchApplicationExec(app, top, executions)
  const issues = [...selected.issues]
  if (app && !execution) issues.push('无法唯一关联应用的 Docker 启动记录，不能确认正常退出。')
  for (const key of ['productRoot', 'productDevice', 'nodePath', 'appCheckPath', 'seccompPath', 'profileHome']) {
    if (observed[key] === null) issues.push('未确认启动所需路径：' + key)
  }
  if (observed.productReadOnly !== true || observed.productBlockReadOnly !== true) issues.push('未确认产品挂载与块设备均为只读。')
  if (app && (!app.shutdownTimeoutMs || app.uid !== 2000 || app.gid !== 2000)) issues.push('应用身份或现有关闭预算未确认。')
  return {
    container: CANDIDATE_CONTAINER, appPid: app?.pid ?? null, currentAppPid: app?.pid ?? null,
    appStartTicks: app?.startTicks ?? null, appUid: app?.uid ?? null, appGid: app?.gid ?? null,
    appExecId: execution?.execId ?? null, shutdownTimeoutMs: app?.shutdownTimeoutMs ?? null,
    namespacePid: selected.namespacePid, namespaceId: selected.namespaceId,
    namespaceKeeperPid: holder?.pid ?? null, namespaceKeeperStartTicks: holder?.startTicks ?? null,
    namespaceProcesses: observed.rows.filter(row => row.namespaceId === selected.namespaceId).map(row => ({ pid: row.pid, uid: row.uid, comm: row.comm })),
    productRoot: observed.productRoot, productDevice: observed.productDevice, productReadOnly: observed.productReadOnly,
    productBlockReadOnly: observed.productBlockReadOnly, productFilesystem: observed.productFilesystem,
    nodePath: observed.nodePath, appCheckPath: observed.appCheckPath, seccompPath: observed.seccompPath,
    logPath: app?.stdoutPath?.startsWith('/') ? app.stdoutPath : null,
    appCwd: app?.cwd ?? null, profileHome: observed.profileHome,
    canStopSafely: Boolean(app && holder && execution && issues.length === 0),
    canStart: Boolean(!app && holder && issues.length === 0), issues,
  }
}

if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href) {
  try { console.log(JSON.stringify(await inspectCandidate(), null, 2)) }
  catch (error) {
    console.error(JSON.stringify({ error: error instanceof CandidateError ? error.message : '无法发现候选运行态。', exitCode: error instanceof CandidateError ? error.exitCode : null }))
    process.exitCode = 1
  }
}
