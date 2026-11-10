/** SSH is an ordinary original managed Subprocess range; keys stay in that range's private PID space and memory FDs. */
import { deflateSync } from 'node:zlib'
import { PROBE_SCRIPT } from '@deepseek-ai/dsh-remote-server-cloud'
import type { SubprocessOutcome, SubprocessSpawnSpec } from '@deepseek-ai/dsh-subprocess'
import type { Context } from '@deepseek-ai/cordis'
import { deadline, timeoutOf } from '@deepseek-ai/dsh-timeout'
import type { RemoteServer } from '@deepseek-ai/dsh-remote-server-cloud'
import type { RemoteExecOutcome, BoundedOutput } from '@deepseek-ai/dsh-remote-server-cloud'
import type { RemoteCredential } from '@deepseek-ai/dsh-pe-cloud-files'
import { accountServiceAvailability, accountTerminalLimits } from './account-port.ts'
import { ExecutionStateError } from './errors.ts'

/** Root-selected readonly image executables and operation bounds. No account/browser path selects these. */
export interface RemoteSshConfig {
  readonly pythonPath: string
  readonly sshPath: string
  readonly timeoutMs: number
  readonly probeTimeoutMs: number
  readonly connectTimeoutSeconds: number
  readonly outputMaxBytes: number
  readonly stopWaitMs: number
}

// -I -S excludes environment/site/current-directory Python discovery. There is no local shell evaluation.
const HELPER = String.raw`import os,sys,json,subprocess,fcntl,zlib,base64
stage=1
try:
 raw=sys.stdin.buffer.read(4097)
 if len(raw)>4096: raise ValueError()
 v=json.loads(raw)
 del raw
 if type(v) is not dict or set(v)!={'privateKey','knownHosts','host','user','port','connect',('probe' if 'probe' in v else 'command')}: raise ValueError()
 if any(type(v[k]) is not str for k in ('privateKey','knownHosts','host','user','probe' if 'probe' in v else 'command')): raise ValueError()
 if any(type(v[k]) is not int or not 1<=v[k]<=m for k,m in (('port',65535),('connect',60))): raise ValueError()
 if 'probe' in v: v['command']=zlib.decompress(base64.b64decode(v.pop('probe'),validate=True)).decode()
 stage=2
 fds=[]
 for name in ('privateKey','knownHosts'):
  stage=3
  fd=os.memfd_create('ssh-private',os.MFD_ALLOW_SEALING)
  os.fchmod(fd,0o600)
  data=v.pop(name).encode()
  os.write(fd,data); os.lseek(fd,0,0); del data
  stage=4
  fcntl.fcntl(fd,fcntl.F_ADD_SEALS,fcntl.F_SEAL_WRITE|fcntl.F_SEAL_GROW|fcntl.F_SEAL_SHRINK|fcntl.F_SEAL_SEAL)
  fds.append(fd)
 base='/proc/'+str(os.getpid())+'/fd/'
 a=[sys.argv[1],'-F/dev/null','-oBatchMode=yes','-oStrictHostKeyChecking=yes','-oGlobalKnownHostsFile=/dev/null','-oUserKnownHostsFile='+base+str(fds[1]),'-oIdentitiesOnly=yes','-oIdentityAgent=none','-oPreferredAuthentications=publickey','-oControlPath=none','-oConnectTimeout='+str(v.pop('connect')),'-i'+base+str(fds[0]),'-p'+str(v.pop('port')),'--',v.pop('user')+'@'+v.pop('host'),v.pop('command')]
 stage=5
 p=subprocess.Popen(a,stdin=subprocess.DEVNULL,close_fds=True)
 outcome=p.wait()
 for fd in fds: os.close(fd)
 sys.exit(outcome)
except Exception as error:
 sys.stderr.write('SSH private execution setup failed at '+str(stage)+' ('+type(error).__name__+')\n')
 sys.exit(255)
`

/** Original account providers must be present and the Root must explicitly enable both remote native consumers.
 * @param ctx Original account tool scope.
 * @param config Trusted Root request policy.
 */
export function assertRemoteSshAvailable(ctx: Context, config: RemoteSshConfig): void {
  const native = accountTerminalLimits(ctx)
  if (accountServiceAvailability(ctx).remoteServers !== true || native === undefined) unavailable()
  if (!['/usr/local/bin/python3', '/usr/bin/python3'].includes(config.pythonPath) || config.sshPath !== '/usr/bin/ssh') unavailable()
  for (const n of [config.timeoutMs, config.probeTimeoutMs, config.connectTimeoutSeconds, config.outputMaxBytes, config.stopWaitMs]) {
    if (!Number.isSafeInteger(n) || n < 1 || n > 2147483647) unavailable()
  }
  if (config.timeoutMs > native.maxTimeoutMs || config.probeTimeoutMs > native.maxTimeoutMs
    || config.outputMaxBytes > native.maxOutputBytes || config.connectTimeoutSeconds > 60) unavailable()
}
function unavailable(): never { throw new ExecutionStateError('cloud/execution-unavailable', 'Account SSH execution is unavailable.') }

/** Construct private input for an original managed range. This value is never a Remote result or model context.
 * @param target Authorized server.
 * @param credential Account-only key borrow.
 * @param command Actual remote command.
 * @param workdir Original execution-world project.
 * @param signal Original operation lifetime.
 * @param config Root-selected readonly executables and bounds.
 * @param probe Fixed trusted probe selection.
 * @returns Native input value; only the original Subprocess provider can admit and execute it.
 */
export function remoteSshSpec(target: RemoteServer, credential: RemoteCredential, command: string, workdir: string,
  signal: AbortSignal, config: RemoteSshConfig, probe: boolean): SubprocessSpawnSpec {
  if (probe && command !== PROBE_SCRIPT) unavailable()
  // The guardian frame includes argv and skill identities; batch input has its own unchanged 4KiB bound.
  const payload = JSON.stringify({ ...credential, host: target.host, user: target.user, port: target.port,
    ...probe ? { probe: deflateSync(PROBE_SCRIPT).toString('base64') } : { command }, connect: config.connectTimeoutSeconds })
  if (Buffer.byteLength(payload) > 4096) throw new Error('cloud/remote-request-too-large')
  return { argv: [config.pythonPath, '-I', '-S', '-c', HELPER, config.sshPath], cwd: workdir,
    stdio: { stdin: { data: payload }, stdout: { maxBytes: config.outputMaxBytes }, stderr: { maxBytes: config.outputMaxBytes } },
    graceMs: config.stopWaitMs, signal }
}

/** Run inside the original registry-minted native call; no Host launcher, replacement Session or execution controller.
 * @param ctx Original scoped provider caller.
 * @param target Authorized current server.
 * @param credential Account credential borrowed only for this actual native range.
 * @param command Exact remote command.
 * @param signal Original tool lifetime.
 * @param config Explicit Root policy.
 * @param current Original account/target check after awaited credential reads and before spawn.
 * @param probe Whether this is the fixed facts probe.
 * @returns Actual exit/connection/timeout facts. Local interruption does not confirm remote termination.
 * @throws A readable error with the original cause for user cancellation or this SSH deadline; other failures remain unchanged.
 */
export async function runRemoteSsh(ctx: Context, target: RemoteServer, credential: RemoteCredential, command: string,
  signal: AbortSignal, config: RemoteSshConfig, current: () => void, probe = false): Promise<RemoteExecOutcome> {
  current(); signal.throwIfAborted(); assertRemoteSshAvailable(ctx, config)
  const subprocess = ctx.get('subprocess'), shell = ctx.get('shell')
  if (subprocess === undefined || shell === undefined) unavailable()
  using timer = deadline(signal, probe ? config.probeTimeoutMs : config.timeoutMs, 'remote-ssh-timeout')
  const workdir = shell.resolve({ command: '', signal: timer.signal }).workdir
  current(); timer.signal.throwIfAborted()
  const handle = subprocess.spawn(remoteSshSpec(target, credential, command, workdir, timer.signal, config, probe))
  let result: SubprocessOutcome
  try {
    result = await handle.done
    // Public handles stay revoked after cancellation; Root retains actual cleanup.
    signal.throwIfAborted()
  } catch (cause) {
    if (signal.aborted && cause === signal.reason && typeof cause === 'object' && cause !== null
      && 'kind' in cause && cause.kind === 'user') {
      throw new Error('本地等待已取消，远端程序可能仍在运行。', { cause })
    }
    if (timer.signal.aborted && cause === timer.signal.reason && timeoutOf(timer.signal, 'remote-ssh-timeout') !== undefined) {
      throw new Error('本地等待已超时，远端程序可能仍在运行。', { cause })
    }
    throw cause
  }
  current()
  if (!await handle.waitForExit(AbortSignal.timeout(config.stopWaitMs))) {
    throw new ExecutionStateError('cloud/stop-unconfirmed', 'The original SSH range has not confirmed cleanup.')
  }
  const read = (name: 'stdout' | 'stderr'): BoundedOutput => {
    const value = handle.collected[name]?.readFrom(0)
    if (value === undefined) unavailable()
    return { text: value.text, truncated: value.lossy, droppedBytes: Math.max(0, value.nextOffset - Buffer.byteLength(value.text)) }
  }
  const stdout = read('stdout'), stderr = read('stderr')
  if (timeoutOf(timer.signal, 'remote-ssh-timeout') !== undefined) {
    return { kind: 'timeout', timeoutMs: probe ? config.probeTimeoutMs : config.timeoutMs, stdout, stderr }
  }
  if (result.exitCode === 255) {
    if (/permission denied|authentication failed/i.test(stderr.text)) return { kind: 'connect-failed',
      failure: 'auth', detail: 'SSH key authentication failed.' }
    if (/host key|HOST IDENTIFICATION|known_hosts/i.test(stderr.text)) {
      return { kind: 'connect-failed', failure: 'unknown', detail: 'SSH host identity verification failed.' }
    }
    return { kind: 'ambiguous', exitCode: 255, detail: 'SSH returned 255; remote completion is unconfirmed.' }
  }
  return { kind: 'completed', exitCode: result.exitCode ?? 255, stdout, stderr }
}
