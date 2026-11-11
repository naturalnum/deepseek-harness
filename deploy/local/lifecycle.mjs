/** Preserve the current candidate namespace and perform one confirmed application stop or start. */
import { randomUUID } from 'node:crypto'
import path from 'node:path'
import { setTimeout as delay } from 'node:timers/promises'
import {
  CANDIDATE_CONTAINER, CandidateError, engineRequest, execInCandidate, inspectCandidate, inspectExec,
} from './inspect.mjs'

export { engineRequest, inspectExec } from './inspect.mjs'

const IDENTITY = String.raw`
const fs=require('node:fs'),expected=JSON.parse(process.argv[1]),base='/proc/'+expected.pid;
const stat=fs.readFileSync(base+'/stat','utf8'),ticks=stat.slice(stat.lastIndexOf(')')+2).split(/\s+/)[19];
const status=fs.readFileSync(base+'/status','utf8'),argv=fs.readFileSync(base+'/cmdline','utf8').split('\0').filter(Boolean);
const uid=status.match(/^Uid:\s+(.*)$/m)?.[1].trim().split(/\s+/);
if(ticks!==expected.startTicks||fs.readlinkSync(base+'/ns/mnt')!==expected.namespaceId||!uid?.every(value=>Number(value)===expected.uid))throw Error('identity changed');
if(expected.kind==='app'){
 if(!argv.includes('/opt/dsh-installed-products/apps/cli/lib/bin.js')||!fs.readlinkSync(base+'/exe').endsWith('/node24'))throw Error('application changed');
}else throw Error('unsupported identity');
if(expected.signal)process.kill(expected.pid,'SIGTERM');
console.log(expected.signal?'termination dispatched':'identity confirmed');
`

// Every varying value is a positional argument. The shell text never contains interpolated input.
const LAUNCH = `set -eu
umask 077
set -C
exec 1>"$1"
exec 2>&1
exec 3>&- 4>&- 5>&- 9>&-
exec nsenter -t "$8" -m --root --wd=/ /usr/bin/env -i \\
 PATH=/dsh-tools:/usr/local/sbin:/usr/local/bin:/usr/sbin:/usr/bin:/sbin:/bin \\
 HOME=/tmp/dsh-feature-home XDG_CACHE_HOME=/tmp/dsh-feature-cache TMPDIR=/tmp \\
 DSH_HOME="$6" DSH_TELEMETRY_DISABLED=1 NARB_DISABLE_NATIVE_CACHE=1 \\
 setpriv --no-new-privs --bounding-set=-all --inh-caps=-all --ambient-caps=-all \\
 --reuid 2000 --regid 2000 --clear-groups --seccomp-filter "$4" \\
 /bin/sh -eu -c '
  "$1" "$2" app-check
  cd "$3"
  exec "$1" --report-exclude-network "$3/apps/cli/lib/bin.js" --profile cloud --shutdown-timeout-ms "$4"
 ' pe-cloud-application "$2" "$3" "$5" "$7"
`

function budget(snapshot) {
  if (!Number.isSafeInteger(snapshot.shutdownTimeoutMs) || snapshot.shutdownTimeoutMs <= 0) {
    throw new CandidateError('未确认应用原有的关闭预算。')
  }
  return snapshot.shutdownTimeoutMs
}

/** Construct the established privilege-restricted launch using positional shell arguments. */
export function buildLaunchCommand(snapshot, holder, logPath) {
  if (!holder?.pid || holder.namespaceId !== snapshot.namespaceId) throw new CandidateError('启动所需的命名空间保留进程未确认。')
  for (const key of ['nodePath', 'appCheckPath', 'seccompPath', 'appCwd', 'profileHome']) {
    if (typeof snapshot[key] !== 'string' || !snapshot[key].startsWith('/')) throw new CandidateError('启动所需路径尚未确认。')
  }
  if (!logPath.startsWith('/opt/dsh-features/')) throw new CandidateError('日志位置不是既有候选日志目录。')
  return ['/bin/sh', '-c', LAUNCH,
    'pe-cloud-start', logPath, snapshot.nodePath, snapshot.appCheckPath, snapshot.seccompPath,
    snapshot.appCwd, snapshot.profileHome, String(budget(snapshot)), String(holder.pid)]
}

/** Create lifecycle operations with explicit external operations for fixture-based failure checks. */
export function createLifecycle({
  inspect = inspectCandidate, execute = execInCandidate, engine = engineRequest,
  execution = inspectExec, wait = () => delay(250), now = Date.now,
} = {}) {
  async function detached(command) {
    const created = await engine('POST', '/containers/' + CANDIDATE_CONTAINER + '/exec', {
      AttachStdin: false, AttachStdout: false, AttachStderr: false, Tty: false, User: '0', Cmd: command,
    })
    if (!/^[a-f0-9]{64}$/.test(created?.Id)) throw new CandidateError('Docker 未返回有效的启动标识。')
    try { await engine('POST', '/exec/' + created.Id + '/start', { Detach: true, Tty: false }) }
    catch (error) {
      const failure = new CandidateError('候选进程的启动结果未确认。', error instanceof CandidateError ? error.exitCode : null)
      failure.execId = created.Id
      throw failure
    }
    return created.Id
  }

  async function identify(snapshot, process, signal) {
    const anchor = snapshot.namespacePid ?? snapshot.appPid
    if (!anchor) throw new CandidateError('当前没有可用的候选命名空间入口。')
    await execute(['/proc/' + anchor + '/root/dsh-tools/node24', '-e', IDENTITY,
      JSON.stringify({ ...process, namespaceId: snapshot.namespaceId, signal })])
  }

  async function waitForExit(execId, timeoutMs) {
    const deadline = now() + timeoutMs
    while (true) {
      const state = await execution(execId)
      if (!state.running) {
        if (state.exitCode !== 0) throw new CandidateError(`应用已退出，退出码${state.exitCode}，产品文件未改动；运行复位脚本后用start恢复。`, state.exitCode)
        return state
      }
      if (now() >= deadline) throw new CandidateError('应用在原有关闭期限加30秒后仍未退出；不强杀、不重复发信号。')
      await wait()
    }
  }

  async function ensureNamespaceHolder(snapshot) {
    const current = await inspect()
    if (current.namespaceId !== snapshot.namespaceId) throw new CandidateError('候选挂载命名空间已经变化。')
    if (current.namespaceKeeperPid) {
      return { pid: current.namespaceKeeperPid, startTicks: current.namespaceKeeperStartTicks,
        namespaceId: current.namespaceId, execId: null, owned: false }
    }
    if (!current.appPid || current.appPid !== snapshot.appPid || current.appStartTicks !== snapshot.appStartTicks) {
      throw new CandidateError('原应用已不在，不能为它保留命名空间。')
    }
    const timeoutMs = budget(snapshot)
    await identify(current, { kind: 'app', pid: current.appPid, startTicks: current.appStartTicks, uid: 2000 }, false)
    const execId = await detached(['nsenter', '-t', String(current.appPid), '-m', '--root', '--wd=/',
      '/usr/bin/env', '-i', 'PATH=/usr/sbin:/usr/bin:/sbin:/bin', '/bin/sleep', 'infinity'])
    const deadline = now() + timeoutMs
    try {
      while (true) {
        const state = await execution(execId)
        if (!state.running) throw new CandidateError('临时命名空间保留进程未保持运行。', state.exitCode)
        if (state.hostPid > 0) {
          const observed = await inspect()
          if (observed.namespaceId === current.namespaceId && observed.namespaceKeeperPid
            && !current.namespaceProcesses.some(row => row.pid === observed.namespaceKeeperPid)) {
            return { pid: observed.namespaceKeeperPid, startTicks: observed.namespaceKeeperStartTicks,
              namespaceId: observed.namespaceId, execId, hostPid: state.hostPid, owned: true }
          }
          if (observed.namespaceId !== current.namespaceId || observed.namespaceKeeperPid
            || observed.issues.some(issue => issue.includes('多个保留进程'))) {
            throw new CandidateError('临时保留进程未能唯一关联到原命名空间。')
          }
        }
        if (now() >= deadline) throw new CandidateError('临时命名空间保留进程未确认就绪。')
        await wait()
      }
    } catch (error) {
      const failure = new CandidateError('临时命名空间保留结果未确认；原应用未停止，保留现场。', error instanceof CandidateError ? error.exitCode : null)
      failure.holderExecId = execId
      throw failure
    }
  }

  async function stopApplication(snapshot) {
    const current = await inspect()
    if (current.appPid !== snapshot.appPid || current.appStartTicks !== snapshot.appStartTicks
      || current.appExecId !== snapshot.appExecId || current.namespaceId !== snapshot.namespaceId) {
      throw new CandidateError('应用身份已经变化；没有发送停止信号。')
    }
    if (!current.canStopSafely || !snapshot.appExecId) throw new CandidateError('正常停止所需的命名空间和启动记录尚未确认。')
    const timeoutMs = budget(snapshot)
    const before = await execution(snapshot.appExecId)
    if (!before.running) throw new CandidateError('原应用启动记录已结束；没有发送停止信号。')
    await identify(current, { kind: 'app', pid: snapshot.appPid, startTicks: snapshot.appStartTicks, uid: 2000 }, true)
    const state = await waitForExit(snapshot.appExecId, timeoutMs + 30000)
    return { execId: state.execId, exitCode: state.exitCode, normalExit: true }
  }

  async function startApplication(snapshot, holder) {
    const current = await inspect()
    if (current.appPid) throw new CandidateError('候选应用仍在运行，不能再启动一个。')
    if (!current.canStart || current.namespaceId !== snapshot.namespaceId
      || current.namespaceKeeperPid !== holder?.pid || current.namespaceKeeperStartTicks !== holder.startTicks) {
      throw new CandidateError('启动所需的原命名空间和保留进程尚未确认。')
    }
    if (!snapshot.logPath) throw new CandidateError('未确认原应用日志目录。')
    const logPath = path.posix.join(path.posix.dirname(snapshot.logPath), 'pe-cloud-' + randomUUID() + '.log')
    let execId
    try { execId = await detached(buildLaunchCommand(snapshot, holder, logPath)) }
    catch (error) { error.logPath = logPath; throw error }
    return { execId, logPath, namespaceId: current.namespaceId }
  }

  return { ensureNamespaceHolder, stopApplication, startApplication }
}

const lifecycle = createLifecycle()
export const ensureNamespaceHolder = lifecycle.ensureNamespaceHolder
export const stopApplication = lifecycle.stopApplication
export const startApplication = lifecycle.startApplication
