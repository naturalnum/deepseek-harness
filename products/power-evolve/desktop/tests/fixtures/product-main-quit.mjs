/** Runs the frozen production main; only CLI behavior, dialog answers and loopback HTML are replacements. */
import assert from 'node:assert/strict'
import { writeSync } from 'node:fs'
import { readFile, writeFile } from 'node:fs/promises'
import { createServer } from 'node:http'
import { createServer as createPortReservation } from 'node:net'
import { join } from 'node:path'
import { pathToFileURL } from 'node:url'
import { setTimeout as delay } from 'node:timers/promises'
import { app, BrowserWindow, dialog } from 'electron'

const root = process.env.PE_QUIT_GATE_ROOT, scenario = process.env.PE_QUIT_GATE_SCENARIO
const compiled = process.env.PE_QUIT_GATE_COMPILED, node = process.env.PE_QUIT_GATE_NODE
if ([root, scenario, compiled, node].some(value => value === undefined)) throw new Error('invalid_product_quit_fixture')
app.disableHardwareAcceleration()
app.commandLine.appendSwitch('use-mock-keychain')
let stage = 'startup', failure, finishing = false, exited = false
const servers = [], dialogs = [], cases = []

async function until(check, code, limit = 5000) {
  const deadline = Date.now() + limit
  while (!await check()) { if (Date.now() > deadline) throw new Error(code); await delay(10) }
}
async function records() {
  try { return (await readFile(join(root, 'cli.jsonl'), 'utf8')).trim().split('\n').map(line => JSON.parse(line)) }
  catch (error) { if (error.code === 'ENOENT') return []; throw error }
}
function alive(pid) {
  try { process.kill(pid, 0); return true }
  catch (error) { if (error.code === 'ESRCH') return false; throw error }
}
async function serve() {
  const server = createServer((_request, response) => {
    response.writeHead(200, { 'content-type': 'text/html; charset=utf-8', 'cache-control': 'no-store' })
    response.end('<!doctype html><title>Product quit fixture</title><h1>Cloud fixture</h1>')
  })
  servers.push(server)
  await new Promise((resolve, reject) => { server.once('error', reject); server.listen(0, '127.0.0.1', resolve) })
  return `http://127.0.0.1:${server.address().port}`
}
async function devicePort() {
  const server = createPortReservation()
  await new Promise((resolve, reject) => { server.once('error', reject); server.listen(0, '127.0.0.1', resolve) })
  const port = server.address().port
  await new Promise(resolve => server.close(resolve))
  return port
}
dialog.showMessageBox = async (...args) => {
  const options = args.find(value => Array.isArray(value?.buttons))
  assert(options)
  const cancel = scenario === 'starting' && dialogs.length === 0 && options.buttons.length === 2
  dialogs.push({ type: options.type, buttons: options.buttons.length, response: cancel ? 0 : options.buttons.length === 2 ? 1 : 0,
    retainedRecords: /Original records|原记录/u.test(options.message) })
  return { response: dialogs.at(-1).response, checkboxChecked: false }
}

async function finalize() {
  if (finishing) return
  finishing = true
  if (stage !== 'final-quit') failure ??= 'startup_quit_confirmation_missing'
  try {
    const rows = await records(), pid = rows[0]?.pid
    if (pid !== undefined) await until(() => !alive(pid), 'owned_cli_remained_alive', 1000)
    assert.equal(rows.at(-1)?.event, 'terminate-exit')
    cases.push({ name: 'actual-cli-exit-after-terminate', passed: true })
    if (scenario === 'stopped-residual') {
      assert(dialogs.some(value => value.buttons === 1 && value.retainedRecords), 'stopped_residual_warning_missing')
      cases.push({ name: 'stopped-residual-retained-warning', passed: true })
    } else if (scenario === 'empty') {
      assert.equal(dialogs.length, 0, 'empty_drain_warned')
      cases.push({ name: 'empty-drain-without-warning', passed: true })
    } else if (stage === 'final-quit') {
      assert.equal(dialogs.length, 1, 'unexpected_starting_final_warning')
    }
  } catch (error) { failure ??= error instanceof assert.AssertionError ? error.message.split('\n')[0] : error.message }
  const rows = await records(), pid = rows[0]?.pid
  if (pid !== undefined && alive(pid)) {
    process.kill(pid, 'SIGKILL')
    await until(() => !alive(pid), 'cleanup_cli_remained_alive', 2000).catch(() => { failure ??= 'cleanup_cli_remained_alive' })
  }
  for (const window of BrowserWindow.getAllWindows()) window.destroy()
  for (const server of servers) { server.closeAllConnections(); await new Promise(resolve => server.close(resolve)) }
  const result = { scenario, complete: failure === undefined, electron: process.versions.electron, cases, dialogs,
    cleanup: { windows: BrowserWindow.getAllWindows().length, servers: servers.filter(server => server.listening).length,
      ownedChildren: pid !== undefined && alive(pid) ? 1 : 0 },
    substitutes: { cli: 'owned-os-process-protocol-fixture', dialog: 'answers-only', html: 'independent-loopback',
      main: 'unchanged-production-bundle', model: false, profile: false, worker: false, docker: false, pg: false },
    ...(failure === undefined ? {} : { failure: { code: failure } }) }
  writeSync(1, 'PE_PRODUCT_QUIT_RESULT ' + JSON.stringify(result) + '\n')
  exited = true; app.exit(failure === undefined ? 0 : 1)
}

// Production main decides whether to quit; this observer only awaits fixture-server cleanup after that decision.
app.on('will-quit', event => { event.preventDefault(); void finalize() })

async function run() {
  const hostOrigin = await serve(), platformOrigin = await serve(), port = await devicePort()
  process.env.PE_QUIT_GATE_DEVICE_PORT = String(port)
  await writeFile(join(root, 'cloud.json'), JSON.stringify({ hostOrigin, platformOrigin }), { mode: 0o600 })
  await writeFile(join(root, 'device.json'), JSON.stringify({ nodeExecutable: node, cliEntrypoint: join(root, 'cli.mjs'),
    homeDir: join(root, 'home'), profile: 'test-device', workingDir: root, loopbackOrigin: `http://127.0.0.1:${port}`,
    startupTimeoutMs: 5000, requestTimeoutMs: 500, quiesceTimeoutMs: 1500, exitTimeoutMs: 1000,
    maxOutputBytes: 16384, maxMessageBytes: 16384, maxHealthBytes: 4096 }), { mode: 0o600 })
  await import(pathToFileURL(join(compiled, 'main.js')).href)
  let primary
  await until(() => {
    primary = BrowserWindow.getAllWindows().find(window => window.webContents.getURL() === hostOrigin + '/native/')
    return primary !== undefined
  }, 'cloud_window_missing')
  await until(async () => primary.webContents.executeJavaScript('typeof window.powerEvolveDesktopDevice?.openAuthorization === "function"'),
    'production_preload_missing')
  await primary.webContents.executeJavaScript('void powerEvolveDesktopDevice.openAuthorization().catch(() => {}); true')
  await until(async () => (await records()).some(value => value.event === 'spawn'), 'owned_cli_not_spawned')
  if (scenario === 'starting') {
    stage = 'cancel-startup-quit'; app.quit()
    await until(() => finishing || dialogs.length === 1, 'startup_quit_confirmation_missing')
    if (finishing) return
    assert.equal(dialogs[0].buttons, 2); assert.equal(dialogs[0].response, 0)
    await delay(100)
    const rows = await records()
    assert(alive(rows[0].pid)); assert(!primary.isDestroyed())
    assert(!rows.some(value => value.event === 'ready' || value.action === 'quiesce'))
    cases.push({ name: 'starting-cancel-keeps-child-and-app', passed: true })
    await writeFile(join(root, 'release-ready'), '', { mode: 0o600 })
  }
  await until(() => BrowserWindow.getAllWindows().some(window => window.webContents.getURL() === `http://127.0.0.1:${port}/`),
    'local_window_not_loaded')
  cases.push({ name: 'real-preload-opens-owned-device', passed: true })
  stage = 'final-quit'; app.quit()
}
void run().catch(error => {
  failure = error instanceof assert.AssertionError ? error.message.split('\n')[0] : error.message
  stage = 'fixture-error'
  if (!exited) void finalize()
})
