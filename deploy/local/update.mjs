/** Update or roll back the existing local candidate, preserving its mount namespace and data. */
import { randomUUID } from 'node:crypto'
import { spawn } from 'node:child_process'
import { chmod, mkdir, open, readFile, rename, writeFile } from 'node:fs/promises'
import { dirname, join, resolve } from 'node:path'
import { fileURLToPath, pathToFileURL } from 'node:url'
import { setTimeout as delay } from 'node:timers/promises'
import { verifyBundle } from '../bundle.mjs'
import { CandidateError, execInCandidate, execInNamespace, inspectCandidate, inspectExec } from './inspect.mjs'
import { ensureNamespaceHolder, releaseNamespaceHolder, startApplication, stopApplication } from './lifecycle.mjs'
import { preflight } from './dependencies.mjs'
import { backupData, dataLayout, dockerToFile, restoreData } from './backup.mjs'
import { readOptions } from '../smoke/options.mjs'

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

function smokeArguments(args) {
  for (let index = 0; index < args.length; index += 2) {
    if (!['--credentials', '--account', '--continue-session', '--continue-marker'].includes(args[index])
      || !args[index + 1] || args[index + 1].startsWith('--')) {
      throw new CandidateError('更新仅接受私密测试账号和已有对话检查参数。')
    }
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

async function releaseVerifiedHolder(state) {
  await releaseNamespaceHolder(state.snapshot, state.holder)
  state.holder = null
  await saveState(state)
}

async function update(bundle, args) {
  let previous
  try { previous = JSON.parse(await readFile(LATEST, 'utf8')) }
  catch (error) { if (error.code !== 'ENOENT') throw error }
  if (previous?.stopAttempted && !previous.recoveredOriginal
    && !['verified', 'rolled-back'].includes(previous.phase)) {
    throw new CandidateError('已有未完成的更新；先检查保留状态或执行回滚，不重复停止应用。')
  }
  const smokeArgs = smokeArguments(args)
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
  let stopAttempted = false
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
    stopAttempted = true
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
    await releaseVerifiedHolder(state)
    state.phase = 'verified'
    await saveState(state)
    console.log(`更新完成：${manifest.sourceCommit}；回滚资料：${state.backupDirectory}`)
  } catch (error) {
    const failureAt = state.phase
    if (!stopAttempted && state.holder) {
      try { await releaseNamespaceHolder(snapshot, state.holder); state.holder = null }
      catch (_releaseError) { /* The recorded holder remains available for recovery. */ }
    }
    if (stopped && !installAttempted) {
      // No product byte was changed; restore the original process after a backup failure.
      try {
        await startAndVerify(state)
        await releaseVerifiedHolder(state)
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

async function rollback(args) {
  const state = JSON.parse(await readFile(LATEST, 'utf8'))
  if (state.format !== 'pe-cloud-local-update/v1'
    || state.backupCompleted !== true
    || !['backed-up', 'installed', 'start-unconfirmed', 'started', 'verified'].includes(state.failureAt ?? state.phase)) {
    throw new CandidateError('当前没有完成备份的版本可执行标准回滚；保留现场供复核。')
  }
  const smokeArgs = args.length ? smokeArguments(args) : state.smokeArgs
  try { await readOptions(smokeArgs) }
  catch (_error) { throw new CandidateError('冒烟检查参数或私密账号文件无效；没有执行回滚。') }
  if (state.rollbackStopExecId) {
    const previousStop = await inspectExec(state.rollbackStopExecId)
    if (previousStop.running || previousStop.exitCode !== 0) {
      throw new CandidateError('上次回滚未确认正常停止；保留现场，不重复发信号。')
    }
  }
  const current = await inspectCandidate()
  if (current.namespaceId !== state.snapshot.namespaceId) {
    throw new CandidateError('候选环境已重建，不能对另一代应用执行本次回滚。')
  }
  if (!state.holder || current.namespaceKeeperPid !== state.holder.pid) state.holder = await ensureNamespaceHolder(current)
  state.namespace = { ...current, namespacePid: state.holder.pid }
  await saveState(state)
  if (current.appPid) {
    state.rollbackStopExecId = current.appExecId
    await saveState(state)
    await stopApplication(current)
  }
  else if (state.launch && (await inspectExec(state.launch.execId)).running) throw new CandidateError('新应用状态未确认，不替换产品文件。')
  console.log(await productOperation(state, 'restore'))
  // Product-only updates preserve current data. Cross-format restoration is recorded separately below.
  if (state.dataFormatChanged === true) {
    await restoreData(state.namespace, state.backupDirectory, state.layout, state.stageView + '/accounts-restore.tar.gz')
  }
  await startAndVerify(state)
  await smoke(smokeArgs)
  await releaseVerifiedHolder(state)
  state.phase = 'rolled-back'
  delete state.failureAt
  delete state.rollbackStopExecId
  await saveState(state)
  console.log('回滚完成，冒烟检查通过')
}

async function main(argv) {
  if (process.versions.node !== '24.19.0') throw new CandidateError('请使用 Node 24.19.0 运行候选更新。')
  const [mode, ...args] = argv
  if (mode === '--help' || !mode || args.includes('--help')) {
    console.log('用法：deploy/local/update <产品包目录> [私密账号参数] [--continue-session 旧对话] [--continue-marker 旧回复标记]\n      deploy/local/rollback [相同检查参数]\n仅操作本机候选环境；正常停止不确认时停止更新，绝不强杀。')
    return
  }
  await mkdir(STATE, { recursive: true, mode: 0o700 })
  const lock = await open(join(STATE, 'operation.lock'), 'wx', 0o600)
  try {
    if (mode === 'rollback') await rollback(args)
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
    console.error(error instanceof CandidateError ? error.message : '候选更新未完成；保留功能状态与备份供复核。')
    if (error instanceof CandidateError && error.exitCode !== null) console.error(`退出码：${error.exitCode}`)
    process.exitCode = 1
  })
}
