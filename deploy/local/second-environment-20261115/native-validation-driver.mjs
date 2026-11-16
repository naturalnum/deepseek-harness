/** Local validation consumer: real account/session/tool APIs; no model call or replacement transport. */
import fs from 'node:fs'
import { setTimeout as delay } from 'node:timers/promises'
import { randomBytes } from 'node:crypto'
import { ToolCallId } from '@deepseek-ai/dsh-llm'
export const name = 'sdk-linux-native-validation'
export const inject = ['peAccountRuntime', 'appReady']
const TEST = '/tmp/dsh-feature-home/sdk-validation'
const shellArg = value => "'" + value.replaceAll("'", "'\\''") + "'"
export function apply(ctx) {
  const controller = new AbortController()
  ctx.effect(() => () => { controller.abort() })
  ctx.appReady.onReady(() => { fs.mkdirSync(TEST, { recursive: true, mode: 0o700 }); fs.writeFileSync(TEST + '/application-ready.json', JSON.stringify({ at: new Date().toISOString(), appReady: true, uid: process.getuid(), pid: process.pid, startTicks: fs.readFileSync('/proc/self/stat','utf8').slice(fs.readFileSync('/proc/self/stat','utf8').lastIndexOf(')')+2).split(/\s+/)[19], mountNamespace: fs.readlinkSync('/proc/self/ns/mnt'), architecture: process.arch, modelRequestSent: false }) + '\n', { flag: 'wx', mode: 0o600 }); void run().catch(error => {
    fs.writeFileSync(TEST + '/driver-failed.json', JSON.stringify({ status: 'failed-retained', errorName: error?.name, code: error?.code }) + '\n', { mode: 0o600 })
  }) })
  async function run() {
    const requestFile = TEST + '/SDK-TEST-REQUEST.json'
    while (!fs.existsSync(requestFile)) { controller.signal.throwIfAborted(); await delay(250, undefined, { signal: controller.signal }) }
    const request = JSON.parse(fs.readFileSync(requestFile, 'utf8'))
    const result = { status: 'running', accountId: request.accountId, steps: [], usedModel: false }
    const persist = () => fs.writeFileSync(TEST + '/native-results.json', JSON.stringify(result, null, 2) + '\n', { mode: 0o600 })
    fs.writeFileSync(TEST + '/native-results.json', JSON.stringify(result) + '\n', { mode: 0o600, flag: 'wx' })
    result.stage = 'acquire-account'; persist()
    const use = await ctx.peAccountRuntime.acquireAccount(request.accountId, controller.signal)
    try {
      use.assertCurrent()
      const account = use.context
      result.stage = 'native-workspace-adoption'; persist()
      const registered = account.workspaceRegistry.list().find(workspace => workspace.path.endsWith('/default-workspace'))
      if (!registered) throw new Error('The original registered default Workspace is absent')
      const workspace = await account.workspaceController.create({ path: registered.path })
      result.stage = 'native-session-create'; persist()
      const created = await account.sessionController.create({ workspaceId: workspace.workspace.workspaceId, agentPreset: 'standard' })
      const agent = account.agents.get(created.sessionId)
      if (!agent) throw new Error('Original Native Agent absent')
      result.sessionId = created.sessionId; result.workspaceId = workspace.workspace.workspaceId; persist()
      let notifications = 0
      const dispose = account.on('tools/result', () => { notifications++ })
      const call = async (label, name, args, expected) => {
        use.assertCurrent()
        result.stage = label; persist()
        const outcome = await account.tools.execute({ callId: ToolCallId('sdk-linux-' + label), name, agent,
          signal: controller.signal, arguments: args })
        const item = { label, name, arguments: args, outcome, resultNotifications: notifications }
        result.steps.push(item); persist()
        if (outcome.isError || (typeof outcome.value?.exitCode === 'number' && outcome.value.exitCode !== 0) || (expected !== undefined && !JSON.stringify(outcome).includes(expected))) {
          result.status = 'failed-retained'; persist(); throw new Error('Actual Native result rejected at ' + label)
        }
        return outcome
      }
      try {
        await call('linux-view', 'bash', { command: 'uname -s -m; id; sed -n "1,8p" /proc/self/cgroup', description: 'Inspect this managed Linux process' }, 'Linux')
        const marker = randomBytes(18).toString('hex'); result.publicMarker = marker
        await call('byte-write-read', 'bash', { command: "set -eu; printf '%s' '" + marker + "' > sdk-linux-marker.txt; test \"$(wc -c < sdk-linux-marker.txt)\" = 36; cat sdk-linux-marker.txt", description: 'Write and read the owned public marker' }, marker)
        await call('native-glob', 'glob', { pattern: 'sdk-linux-marker.txt' }, 'sdk-linux-marker.txt')
        await call('native-grep', 'grep', { pattern: marker, include: 'sdk-linux-marker.txt' }, marker)
        await call('readonly-program-denial', 'bash', { command: 'python3 -c ' + shellArg("import os,errno; p=" + JSON.stringify(request.searchProgramPath) + ";\ntry:\n f=os.open(p,os.O_WRONLY|os.O_APPEND);os.close(f);raise SystemExit(91)\nexcept OSError as e:\n print('readonly-denied',e.errno);assert e.errno in (errno.EROFS,errno.EACCES,errno.EPERM)"), description: 'Verify the selected program denies writes' }, 'readonly-denied')
        for (const [label, path] of [['private-domain-denial', request.privateMarkerPath], ['foreign-domain-denial', request.foreignMarkerPath]]) {
          await call(label, 'bash', { command: 'python3 -c ' + shellArg("import os,errno; p=" + JSON.stringify(path) + ";\ntry:\n f=os.open(p,os.O_RDONLY);os.close(f);raise SystemExit(92)\nexcept OSError as e:\n print('outside-denied',e.errno);assert e.errno in (errno.ENOENT,errno.EACCES,errno.EPERM)"), description: 'Verify the owned domain boundary' }, 'outside-denied')
        }
        result.status = 'native-commands-and-search-completed'; result.resultNotifications = notifications; persist()
      } finally { dispose() }
    } finally { use.release() }
  }
}
