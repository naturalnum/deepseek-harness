/** Real Electron local-authorization IPC gate; only the chooser and Device identity are substitutes. */
import assert from 'node:assert/strict'
import { spawn } from 'node:child_process'
import { createHash } from 'node:crypto'
import { access, copyFile, mkdir, mkdtemp, readFile, rm, symlink } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { dirname, isAbsolute, join, resolve } from 'node:path'
import { test } from 'node:test'
import { fileURLToPath } from 'node:url'

const electron = process.env.PE_DESKTOP_ELECTRON
const desktop = process.env.PE_DESKTOP_GATE_PACKAGE ?? fileURLToPath(new URL('..', import.meta.url))
const expected = ['owned-host-opener-and-device-picker', 'cloud-picker-denied', 'platform-open-picker-denied',
  'host-iframe-open-picker-denied', 'foreign-open-picker-denied', 'stale-open-picker-event-denied',
  'concurrent-open-awaits-one-load', 'loadfail-retry', 'device-generation-reloads-nonce',
  'pending-picker-navigation-no-path', 'pending-picker-close-no-path', 'unavailable-device-does-not-open']

/** Freeze compiled components beside their real bundled preload, matching production import.meta placement. */
async function snapshot(root) {
  assert(isAbsolute(desktop), 'The tested desktop package must be an absolute path')
  const directory = join(root, 'compiled')
  await mkdir(directory, { mode: 0o700 })
  const hashes = {}
  for (const name of ['config', 'window-policy', 'local-device-window', 'device-ipc']) {
    const path = join(desktop, 'lib/types', name + '.js')
    const frozen = join(directory, name + '.js')
    await copyFile(path, frozen)
    hashes['types/' + name + '.js'] = createHash('sha256').update(await readFile(frozen)).digest('hex')
  }
  for (const name of ['preload-cloud.cjs', 'preload-device.cjs']) {
    const path = join(desktop, 'lib', name)
    const frozen = join(directory, name)
    await copyFile(path, frozen)
    hashes[name] = createHash('sha256').update(await readFile(frozen)).digest('hex')
  }
  await symlink(resolve(desktop, 'node_modules'), join(directory, 'node_modules'), 'dir')
  return hashes
}

/** Collect bounded, nonprivate results and await the one owned Electron process. */
async function run(root) {
  const fixture = fileURLToPath(new URL('./fixtures/local-authorization-main.mjs', import.meta.url))
  const env = { PATH: '/usr/bin:/bin:/usr/sbin:/sbin', HOME: join(root, 'home'), TMPDIR: join(root, 'tmp'),
    XDG_CACHE_HOME: join(root, 'cache'), XDG_CONFIG_HOME: join(root, 'config'), LANG: 'en_US.UTF-8' }
  if (process.platform === 'win32' && process.env.SystemRoot !== undefined) env.SystemRoot = process.env.SystemRoot
  const child = spawn(electron, [fixture, `--pe-local-gate-root=${root}`], { cwd: dirname(fixture), env,
    stdio: ['ignore', 'pipe', 'pipe'], detached: process.platform !== 'win32' })
  let output = '', bytes = 0, timedOut = false, overflow = false
  const terminate = () => {
    try {
      if (process.platform === 'win32') child.kill('SIGKILL')
      else process.kill(-child.pid, 'SIGKILL')
    } catch (error) { if (error.code !== 'ESRCH') throw error }
  }
  const timer = setTimeout(() => { timedOut = true; terminate() }, 60000)
  child.stdout.on('data', chunk => {
    bytes += chunk.length
    if (bytes > 128 * 1024) { overflow = true; terminate(); return }
    output += chunk.toString('utf8')
  })
  child.stderr.on('data', chunk => {
    bytes += chunk.length
    if (bytes > 128 * 1024) { overflow = true; terminate() }
  })
  let exit
  try {
    exit = await new Promise((resolveExit, reject) => {
      child.once('error', reject)
      child.once('close', (code, signal) => { resolveExit({ code, signal }) })
    })
  } finally { clearTimeout(timer) }
  let processGroupGone = true
  if (process.platform !== 'win32') {
    try { process.kill(-child.pid, 0); processGroupGone = false }
    catch (error) { if (error.code !== 'ESRCH') throw error }
    if (!processGroupGone) terminate()
  }
  assert.equal(timedOut, false, 'The local authorization gate exceeded its deadline')
  assert.equal(overflow, false, 'The local authorization gate exceeded its output budget')
  const lines = output.split('\n').filter(line => line.startsWith('PE_LOCAL_AUTHORIZATION_RESULT '))
  assert.equal(lines.length, 1, 'Electron must return one result')
  const result = JSON.parse(lines[0].slice('PE_LOCAL_AUTHORIZATION_RESULT '.length))
  assert.equal(exit.code, 0, JSON.stringify(result.failure ?? exit))
  assert.equal(exit.signal, null)
  assert.equal(processGroupGone, true, 'Electron descendants remained in the owned process group')
  return { ...result, processGroupGone }
}

test('real Electron local authorization ownership and recovery', { skip: electron === undefined, timeout: 75000 }, async context => {
  await access(electron)
  const root = await mkdtemp(join(tmpdir(), 'pe-local-authorization-'))
  try {
    await Promise.all(['home', 'tmp', 'cache', 'config', 'user-data'].map(name => mkdir(join(root, name), { mode: 0o700 })))
    const compiled = await snapshot(root)
    const result = await run(root)
    assert.equal(result.complete, true)
    assert.match(result.electron, /^44\./)
    assert.deepEqual(result.cases.map(value => value.name), expected)
    assert.deepEqual(result.cleanup, { windows: 0, servers: 0, pickers: 0 })
    console.log('PE_LOCAL_AUTHORIZATION_EVIDENCE ' + JSON.stringify({ ...result, compiled }))
    for (const value of result.cases) await context.test(value.name, () => { assert.equal(value.passed, true) })
  } finally { await rm(root, { recursive: true, force: true }) }
})
