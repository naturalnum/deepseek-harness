/** Update or roll back the existing local candidate, preserving its mount namespace and data. */
import { randomUUID } from 'node:crypto'
import { spawn } from 'node:child_process'
import { chmod, mkdir, open, readFile, rename, writeFile } from 'node:fs/promises'
import { dirname, join, resolve } from 'node:path'
import { fileURLToPath, pathToFileURL } from 'node:url'
import { setTimeout as delay } from 'node:timers/promises'
import { verifyBundle } from '../bundle.mjs'
import { CandidateError, execInCandidate, execInNamespace, inspectCandidate, inspectExec } from './inspect.mjs'
import { ensureNamespaceHolder, startApplication, stopApplication } from './lifecycle.mjs'
import { preflight } from './dependencies.mjs'
import { backupData, dataLayout, dockerToFile } from './backup.mjs'
import { readOptions } from '../smoke/options.mjs'
import { assertCandidateLock, readLineArguments } from './candidate-lock.mjs'
import nativeDeliveryState from './native-delivery-state.cjs'
import { requireNativeReleaseComplete } from './native-delivery.mjs'

export const { requireOrdinaryUpdateState } = nativeDeliveryState
export { runNativeDelivery } from './native-delivery.mjs'

const ROOT = resolve(dirname(fileURLToPath(import.meta.url)), '../..')
const STATE = join(dirname(ROOT), 'local-state')
const LATEST = join(STATE, 'latest.json')
const ENTRY = 'http://127.0.0.1:32802'

async function saveState(state) {
  await mkdir(STATE, { recursive: true, mode: 0o700 })
  await chmod(STATE, 0o700)
  const temporary = join(STATE, `.state-${randomUUID()}`)
  await writeFile(temporary, `${JSON.stringify(state, null, 2)}\n`, { mode: 0o600 })
  await rename(temporary, LATEST)
}

async function stageFile(snapshot, filename, target) {
  await execInCandidate(['/bin/sh', '-c', 'umask 077; cat > "$1"', 'pe-cloud-stage', target],
    { input: await readFile(filename) })
}

/** Construct the actual remote Node entry that receives public product metadata through stdin. */
export function buildProductProgram(code) {
  return `${code}\nconst executeProduct=module.exports.execute;let data='';process.stdin.setEncoding('utf8');process.stdin.on('data',c=>data+=c);process.stdin.on('end',()=>{try{console.log(JSON.stringify(executeProduct(JSON.parse(data))))}catch(_error){console.error('产品文件操作未完成。');process.exitCode=1}});`
}

async function productOperation(state, mode) {
  const code = await readFile(join(ROOT, 'deploy/local/product-files.cjs'), 'utf8')
  const program = buildProductProgram(code)
  return JSON.parse(await execInNamespace(state.namespace, [state.namespace.nodePath, '-e', program], { input: JSON.stringify({
    mode, productRoot: state.snapshot.productRoot, productDevice: state.snapshot.productDevice,
    namespaceId: state.snapshot.namespaceId, archivePath: state.stageView + '/products.tar.gz',
    manifest: state.manifest, backupDir: state.stageView + '/rollback',
  }) }))
}

async function dataFormatChange(state) {
  const helper = await readFile(join(ROOT, 'deploy/local/data-format.cjs'), 'utf8')
  const code = `${helper}\nconst input=JSON.parse(process.argv[1]);const rollback=JSON.parse(require('node:fs').readFileSync(input.stage+'/rollback/rollback.json','utf8'));console.log(JSON.stringify(module.exports.compareDataFormats(input.product,input.stage+'/rollback/new',rollback.plan)));`
  return JSON.parse(await execInNamespace(state.namespace, [state.namespace.nodePath, '-e', code,
    JSON.stringify({ product: state.snapshot.productRoot, stage: state.stageView })]))
}

async function ready(state, launch) {
  const deadline = Date.now() + state.snapshot.shutdownTimeoutMs
  while (Date.now() < deadline) {
    const execution = await inspectExec(launch.execId)
    if (!execution.running) throw new CandidateError('候选应用启动后退出；请检查本次应用日志。', execution.exitCode)
    try {
      const response = await fetch(`${ENTRY}/cloud/bootstrap`, { signal: AbortSignal.timeout(Math.max(1, deadline - Date.now())) })
      await response.body?.cancel()
      if (response.status === 401) return
    } catch (_error) { /* Startup readiness is the next successful unauthenticated bootstrap, not a fixed sleep. */ }
    await delay(250)
  }
  throw new CandidateError('候选入口未在应用已有关闭预算内就绪。')
}

async function smoke(args) {
  return new Promise((resolveRun, reject) => {
    const child = spawn(process.execPath, [join(ROOT, 'deploy/smoke/check.mjs'), ...args], { cwd: ROOT, stdio: 'inherit' })
    child.once('error', () => reject(new CandidateError('无法运行候选冒烟检查。')))
    child.once('exit', (code, signal) => code === 0 && signal === null
      ? resolveRun() : reject(new CandidateError('候选冒烟未通过；保留回滚入口与备份。', code)))
  })
}

export function smokeArguments(args, allowMcp = false) {
  for (let index = 0; index < args.length; index++) {
    if (allowMcp && ['--mcp-offline', '--mcp-recover'].includes(args[index])) continue
    if (!['--credentials', '--account', '--continue-session', '--continue-marker'].includes(args[index])
      || !args[index + 1] || args[index + 1].startsWith('--')) {
      throw new CandidateError('更新仅接受私密测试账号和已有对话检查参数。')
    }
    index++
  }
  return args
}

async function startAndVerify(state) {
  try { state.launch = await startApplication(state.snapshot, state.holder) }
  catch (error) {
    if (error.execId) {
      state.launch = { execId: error.execId, logPath: error.logPath, namespaceId: state.snapshot.namespaceId }
      state.phase = 'start-unconfirmed'
      await saveState(state)
    }
    throw error
  }
  state.phase = 'started'
  await saveState(state)
  console.log(`启动日志：${state.launch.logPath}`)
  await ready(state, state.launch)
}

async function update(bundle, args) {
  let previous
  try { previous = JSON.parse(await readFile(LATEST, 'utf8')) }
  catch (error) { if (error.code !== 'ENOENT') throw error }
  requireOrdinaryUpdateState(previous)
  if (previous?.stopAttempted && !previous.recoveredOriginal
    && !['verified', 'rolled-back'].includes(previous.phase)) {
    throw new CandidateError('已有未完成的更新；先检查保留状态或执行回滚，不重复停止应用。')
  }
  const smokeArgs = smokeArguments(args, true)
  try { await readOptions(smokeArgs) }
  catch (_error) { throw new CandidateError('冒烟检查参数或私密账号文件无效；没有进行更新。') }
  const manifest = await verifyBundle(bundle)
  const snapshot = await inspectCandidate()
  if (!snapshot.appPid) throw new CandidateError('更新前应用不在运行；先复核已有更新状态。')
  const compatible = await preflight(snapshot, manifest)
  console.log(`预检：依赖、SSH 插件及 ripgrep 就绪（${compatible.nodeVersion}）`)
  const layout = await dataLayout(snapshot)
  const operation = randomUUID()
  const state = { format: 'pe-cloud-local-update/v1', operation, phase: 'preparing', manifest, snapshot, layout,
    smokeArgs, backupDirectory: join(STATE, operation),
    stageGlobal: `/opt/dsh-features/pe-cloud-delivery/${operation}` }
  state.stageView = '/proc/1/root' + state.stageGlobal
  state.holder = null
  let stopped = false
  let installAttempted = false
  try {
    state.holder = await ensureNamespaceHolder(snapshot)
    state.namespace = { ...snapshot, namespacePid: state.holder.pid }
    await saveState(state)
    await execInCandidate(['/bin/mkdir', '-p', '-m', '700', state.stageGlobal])
    await stageFile(state.namespace, join(bundle, 'products.tar.gz'), state.stageGlobal + '/products.tar.gz')
    console.log('准备产品回滚备份…')
    console.log(await productOperation(state, 'prepare'))
    state.dataFormat = await dataFormatChange(state)
    state.dataFormatChanged = state.dataFormat.changed
    state.phase = 'prepared'
    await saveState(state)
    state.stopAttempted = true
    await saveState(state)
    await stopApplication(snapshot)
    stopped = true
    state.phase = 'stopped'
    await saveState(state)
    // A stopped application gives one consistent database/account snapshot before any file replacement.
    await backupData(state.namespace, state.backupDirectory, layout)
    await dockerToFile(['exec', snapshot.container, 'cat', state.stageGlobal + '/rollback/old.tar.gz'], join(state.backupDirectory, 'products-before.tar.gz'))
    state.backupCompleted = true
    state.phase = 'backed-up'
    await saveState(state)
    installAttempted = true
    console.log(await productOperation(state, 'install'))
    state.phase = 'installed'
    await saveState(state)
    await startAndVerify(state)
    await smoke(state.smokeArgs)
    state.phase = 'verified'
    await saveState(state)
    console.log(`更新完成：${manifest.sourceCommit}；回滚资料：${state.backupDirectory}`)
  } catch (error) {
    const failureAt = state.phase
    if (stopped && !installAttempted) {
      // No product byte was changed; restore the original process after a backup failure.
      try {
        await startAndVerify(state)
        state.recoveredOriginal = true
        console.log('更新未执行，原应用已恢复就绪')
      }
      catch (_recoveryError) { console.error('原应用恢复未确认，保留命名空间与状态供复核') }
    }
    if (error.holderExecId) state.holderStartUnconfirmed = error.holderExecId
    state.failureAt = failureAt
    state.phase = 'failed'
    await saveState(state)
    throw error
  }
}

/**
 * Reuse the normal lifecycle without ordinary save/recovery in a native-owned operation.
 * @param {object} state Prepared controller state with its current namespace and product rollback plan.
 * @param {object} profile Fixed publisher, single-profile binder and actual tuple observer with current approved pins.
 * @returns {object} Fixed effects for the one native operation; failures propagate with no automatic recovery.
 */
export function nativeUpdateEffects(state, { publish, unbind, bind, seal, observeTuple }) {
  return {
    publish, unbind, bind, seal, observeTuple,
    checkPair: async () => {
      if (await observeTuple() !== state.nativeOriginalTupleSha256) {
        throw new nativeDeliveryState.NativeDeliveryUnconfirmed('original-group-mismatch')
      }
    },
    stop: () => stopApplication(state.snapshot),
    backup: async () => {
      await backupData(state.namespace, state.backupDirectory, state.layout)
      await dockerToFile(['exec', state.snapshot.container, 'cat', state.stageGlobal + '/rollback/old.tar.gz'],
        join(state.backupDirectory, 'products-before.tar.gz'))
    },
    install: () => productOperation(state, 'install'),
    start: async () => {
      try { state.launch = await startApplication(state.snapshot, state.holder) }
      catch (error) {
        if (error.execId) state.launch = { execId: error.execId, logPath: error.logPath, namespaceId: state.snapshot.namespaceId }
        throw error
      }
      await ready(state, state.launch)
    },
    verify: () => smoke(state.smokeArgs),
  }
}

/**
 * Prepare the original managed product plan for a native-owned operation without writing ordinary latest state.
 * @param {string} bundle Verified local product bundle directory.
 * @param {object} manifest The exact result of the normal bundle verifier.
 * @param {string[]} args Original smoke arguments, using the same existing account parser.
 * @param {string} operation Native operation UUID generated by the controller.
 * @param {Function} save Durable private native state writer, never ordinary saveState.
 * @returns {Promise<object>} Prepared lifecycle state; no stop, product install, bind or application launch occurs.
 */
export async function prepareNativeProductUpdate(bundle, manifest, args, operation, save) {
  if (!/^[a-f0-9]{8}-[a-f0-9]{4}-[a-f0-9]{4}-[a-f0-9]{4}-[a-f0-9]{12}$/.test(operation)) {
    throw new nativeDeliveryState.NativeDeliveryUnconfirmed('invalid-operation')
  }
  const smokeArgs = smokeArguments(args, true)
  await readOptions(smokeArgs)
  const snapshot = await inspectCandidate()
  if (!snapshot.appPid) throw new CandidateError('更新前应用不在运行；先复核已有更新状态。')
  await preflight(snapshot, manifest)
  const state = { operation, phase: 'native-preparing', manifest, snapshot, smokeArgs,
    layout: await dataLayout(snapshot), backupDirectory: join(STATE, operation),
    stageGlobal: '/opt/dsh-features/pe-cloud-delivery/' + operation }
  state.stageView = '/proc/1/root' + state.stageGlobal
  await save(state)
  state.holder = await ensureNamespaceHolder(snapshot)
  state.namespace = { ...snapshot, namespacePid: state.holder.pid }
  await save(state)
  await execInCandidate(['/bin/mkdir', '-m', '700', state.stageGlobal])
  await execInCandidate(['/bin/mkdir', '-m', '700', state.stageGlobal + '/native-record'])
  await stageFile(state.namespace, join(bundle, 'products.tar.gz'), state.stageGlobal + '/products.tar.gz')
  await productOperation(state, 'prepare')
  state.dataFormat = await dataFormatChange(state)
  state.dataFormatChanged = state.dataFormat.changed
  state.phase = 'native-prepared'
  await save(state)
  const probe = `const fs=require('node:fs');const fd=fs.openSync(process.argv[1],fs.constants.O_RDONLY|fs.constants.O_DIRECTORY|fs.constants.O_NOFOLLOW);let result;try{const s=fs.fstatSync(fd);if(s.uid!==0||s.gid!==0||(s.mode&0o7777)!==0o700)throw Error('native-record-directory');result={path:process.argv[1],device:String(s.dev),inode:String(s.ino)}}finally{fs.closeSync(fd)}console.log(JSON.stringify(result));`
  state.nativeJournal = JSON.parse(await execInCandidate(['/proc/' + state.holder.pid + '/root/dsh-tools/node24',
    '-e', probe, state.stageGlobal + '/native-record']))
  await save(state)
  return state
}

/** Cross-format rollback requires a separately rehearsed recovery procedure. */
export function requireProductOnlyRollback(state) {
  if (state.dataFormatChanged === true) {
    throw new CandidateError('此次更新涉及数据格式变化，不能自动回滚；请找评审者处理，应用未停止。')
  }
}

/** Require the retained rollback stop to have a confirmed successful exit. */
export async function requireConfirmedRollbackStop(state, execution = inspectExec) {
  if (!state.rollbackStopExecId) return
  const previousStop = await execution(state.rollbackStopExecId)
  if (previousStop.missing || previousStop.running || previousStop.exitCode !== 0) {
    throw new CandidateError('停止结果已无法确认，复位后用 start。')
  }
}

/** Save the attempted rollback stop before signalling and its completion before replacing files. */
export async function stopForRollback(state, current, { stop = stopApplication, save = saveState } = {}) {
  state.rollbackStopExecId = current.appExecId
  await save(state)
  await stop(current)
  delete state.rollbackStopExecId
  await save(state)
}

/**
 * Reject native or incomplete ordinary rollback state before environment inspection or stop.
 * @param {object} state Latest saved controller state.
 * @returns {void} Returns only when ordinary product rollback is eligible.
 */
export function requireOrdinaryRollbackState(state) {
  requireOrdinaryUpdateState(state)
  requireProductOnlyRollback(state)
  if (state.format !== 'pe-cloud-local-update/v1'
    || state.backupCompleted !== true
    || !['backed-up', 'installed', 'start-unconfirmed', 'started', 'verified', 'recovered'].includes(state.failureAt ?? state.phase)) {
    throw new CandidateError('当前没有完成备份的版本可执行标准回滚；保留现场供复核。')
  }
}

async function rollback(args) {
  const state = JSON.parse(await readFile(LATEST, 'utf8'))
  requireOrdinaryRollbackState(state)
  const smokeArgs = args.length ? smokeArguments(args) : state.smokeArgs
  try { await readOptions(smokeArgs) }
  catch (_error) { throw new CandidateError('冒烟检查参数或私密账号文件无效；没有执行回滚。') }
  await requireConfirmedRollbackStop(state)
  const current = await inspectCandidate()
  if (current.namespaceId !== state.snapshot.namespaceId) {
    throw new CandidateError('候选环境已重建，不能对另一代应用执行本次回滚。')
  }
  if (!state.holder || current.namespaceKeeperPid !== state.holder.pid) state.holder = await ensureNamespaceHolder(current)
  state.namespace = { ...current, namespacePid: state.holder.pid }
  await saveState(state)
  if (current.appPid) {
    await stopForRollback(state, current)
  }
  else if (state.launch && (await inspectExec(state.launch.execId)).running) throw new CandidateError('新应用状态未确认，不替换产品文件。')
  console.log(await productOperation(state, 'restore'))
  await startAndVerify(state)
  await smoke(smokeArgs)
  state.phase = 'rolled-back'
  delete state.failureAt
  delete state.rollbackStopExecId
  await saveState(state)
  console.log('回滚完成，冒烟检查通过')
}

/** Restart the installed version from its saved launch inputs without replacing files or restoring data. */
export async function startSavedApplication(state, {
  inspect = inspectCandidate, execution = inspectExec, launch = startAndVerify, save = saveState,
} = {}) {
  requireOrdinaryUpdateState(state)
  if (state.format !== 'pe-cloud-local-update/v1') throw new CandidateError('没有可复用的候选启动状态；请找评审者处理。')
  const current = await inspect()
  if (current.appPid) throw new CandidateError('候选应用仍在运行，没有再次启动。')
  if (current.namespaceId !== state.snapshot.namespaceId) throw new CandidateError('候选挂载环境已变化，不能复用原启动状态。')
  if (state.launch && (await execution(state.launch.execId)).running) {
    throw new CandidateError('上一次启动尚未确认结束，没有再次启动。')
  }
  if (!state.holder || current.namespaceKeeperPid !== state.holder.pid) state.holder = await ensureNamespaceHolder(current)
  state.namespace = { ...current, namespacePid: state.holder.pid }
  state.recoveredOriginal = false
  await save(state)
  try {
    await launch(state)
    state.phase = 'recovered'
    state.recoveredOriginal = true
    delete state.failureAt
    delete state.rollbackStopExecId
    await save(state)
    return state.launch
  } catch (error) {
    state.failureAt = state.phase
    state.phase = 'failed'
    await save(state)
    throw error
  }
}

async function start() {
  const state = JSON.parse(await readFile(LATEST, 'utf8'))
  await startSavedApplication(state)
  console.log('候选应用已恢复就绪；保留进程继续运行，可以重新执行更新')
}

/**
 * Separate one mutually exclusive first-delivery, same-FD pair or new-asset descriptor from normal arguments.
 * @param {string} mode Existing update/start/rollback mode.
 * @param {string[]} args Original arguments after the candidate line has been read.
 * @returns {object} Native descriptor path when supplied, and the remaining original arguments.
 */
export function nativeArguments(mode, args) {
  const flags = ['--native-input', '--native-successor', '--native-asset-successor']
  const found = flags.filter(flag => args.includes(flag))
  if (!found.length) return { args }
  const flag = found[0], at = args.indexOf(flag)
  if (found.length !== 1 || mode !== 'update' || at === 0 || at !== args.lastIndexOf(flag)
    || !args[at + 1] || args[at + 1].startsWith('--')) {
    throw new CandidateError('原生交付只接受更新产品包和一份互斥的私有固定输入。')
  }
  const inputKey = { '--native-input': 'inputFile', '--native-successor': 'successorFile', '--native-asset-successor': 'assetSuccessorFile' }[flag]
  return { [inputKey]: args[at + 1],
    args: [...args.slice(0, at), ...args.slice(at + 2)] }
}

async function main(argv) {
  if (process.versions.node !== '24.19.0') throw new CandidateError('请使用 Node 24.19.0 运行候选更新。')
  const [mode, ...rawArguments] = argv
  const { line, args: lineArgs } = readLineArguments(rawArguments)
  const { inputFile, successorFile, assetSuccessorFile, args } = nativeArguments(mode, lineArgs)
  if (mode === '--help' || !mode || args.includes('--help')) {
    console.log('用法：deploy/local/update <产品包目录> [--line 线名] [私密账号参数] [已有对话参数]\n      首次原生交付可追加 --native-input <私有固定输入>\n      已确认原生组的后继读者对追加 --native-successor <私有后继输入>\n      更换正式目录资产追加 --native-asset-successor <私有新资产输入>\n      node deploy/local/update.mjs continue-native-publish <原operation> --line <原调用线>\n      node deploy/local/update.mjs continue-native-verify <原operation> --line <原调用线>\n      deploy/local/rollback [--line 线名] [相同检查参数]\n      deploy/local/start [--line 线名]\n仅操作本机候选环境；正常停止不确认时停止更新，保留进程始终继续运行。')
    return
  }
  if (mode === 'start' && args.length) throw new CandidateError('start 只接受 --line 线名。')
  await assertCandidateLock(dirname(ROOT), line)
  if (!['continue-native-publish', 'continue-native-verify'].includes(mode)) await mkdir(STATE, { recursive: true, mode: 0o700 })
  requireNativeReleaseComplete(STATE)
  let latest
  try { latest = JSON.parse(await readFile(LATEST, 'utf8')) }
  catch (error) { if (error.code !== 'ENOENT') throw error }
  if (mode === 'continue-native-verify') {
    if (args.length !== 1 || inputFile !== undefined || successorFile !== undefined || assetSuccessorFile !== undefined || !line) {
      throw new CandidateError('验证接续只接受原operation与原调用线。')
    }
    const { continueNativeVerify } = await import('./native-update.mjs')
    await continueNativeVerify({ operation: args[0], line, latest })
    console.log('原操作正常验证及部署锁释放完成；账号与SDK责任保持原owner')
    return
  }
  if (mode === 'continue-native-publish') {
    if (args.length !== 1 || inputFile !== undefined || successorFile !== undefined || assetSuccessorFile !== undefined || !line) {
      throw new CandidateError('发布接续只接受原operation与原调用线。')
    }
    const { continueNativePublish } = await import('./native-update.mjs')
    await continueNativePublish({ operation: args[0], line, latest })
    console.log('同一原生发布接续完成，冒烟检查通过')
    return
  }
  if (latest?.format === nativeDeliveryState.PROJECTION) requireNativeReleaseComplete(STATE, undefined, latest.operation)
  if (inputFile !== undefined || successorFile !== undefined || assetSuccessorFile !== undefined || latest?.format === nativeDeliveryState.PROJECTION) {
    if (mode === 'update' && !args[0]) throw new CandidateError('缺少产品包目录。')
    const { nativeUpdate } = await import('./native-update.mjs')
    await nativeUpdate({ mode, bundle: args[0], args: mode === 'update' ? args.slice(1) : args,
      inputFile, successorFile, assetSuccessorFile, latest })
    console.log('原生匹配组合交付完成，冒烟检查通过')
    return
  }
  const lock = await open(join(STATE, 'operation.lock'), 'wx', 0o600)
  try {
    if (mode === 'start') await start()
    else if (mode === 'rollback') await rollback(args)
    else if (mode === 'update' && args[0]) await update(resolve(args[0]), args.slice(1))
    else throw new CandidateError('缺少产品包目录或命令无效。')
  } finally {
    await lock.close()
    const { unlink } = await import('node:fs/promises')
    await unlink(join(STATE, 'operation.lock'))
  }
}

if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href) {
  main(process.argv.slice(2)).catch(error => {
    console.error(error instanceof CandidateError || error instanceof nativeDeliveryState.NativeDeliveryUnconfirmed
      ? error.message : '候选更新未完成；保留功能状态与备份供复核。')
    if (error instanceof CandidateError && error.exitCode !== null) console.error(`退出码：${error.exitCode}`)
    process.exitCode = 1
  })
}
