/** Opt-in real Electron gate; compiled product and desktop modules are required, never substituted. */
import assert from 'node:assert/strict'
import { spawn } from 'node:child_process'
import { access, mkdir, mkdtemp, rm } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { dirname, join } from 'node:path'
import { test } from 'node:test'
import { fileURLToPath } from 'node:url'

const electron = process.env.PE_DESKTOP_ELECTRON
const expected = ['owned-host-ipc', 'invalid-preferences', 'same-origin-iframe-denied', 'foreign-window-denied',
  'platform-denied', 'stale-frame-denied', 'foreign-navigation-denied', 'foreign-redirect-denied', 'foreign-popup-denied',
  'trusted-approval-main-navigation', 'explicit-load-denied', 'reopened-window-ownership', 'deployment-session-isolation']

/** Collect a bounded result from one independently owned Electron process and wait for its exit. */
async function runElectron(root) {
  const fixture = fileURLToPath(new URL('./fixtures/electron-policy-main.mjs', import.meta.url))
  const env = { PATH: '/usr/bin:/bin:/usr/sbin:/sbin', HOME: join(root, 'home'), TMPDIR: join(root, 'tmp'),
    XDG_CACHE_HOME: join(root, 'cache'), XDG_CONFIG_HOME: join(root, 'config'), LANG: 'en_US.UTF-8' }
  if (process.platform === 'win32' && process.env.SystemRoot !== undefined) env.SystemRoot = process.env.SystemRoot
  const child = spawn(electron, [fixture, `--pe-policy-root=${root}`], { cwd: dirname(fixture), env,
    stdio: ['ignore', 'pipe', 'pipe'], detached: process.platform !== 'win32' })
  let output = ''
  let diagnostic = ''
  let progressBuffer = ''
  let bytes = 0
  let overflow = false
  let timedOut = false
  const terminate = () => {
    try {
      if (process.platform === 'win32') child.kill('SIGKILL')
      else process.kill(-child.pid, 'SIGKILL')
    } catch (error) {
      if (error.code !== 'ESRCH') throw error
    }
  }
  const timer = setTimeout(() => { timedOut = true; terminate() }, 60000)
  child.stdout.on('data', chunk => {
    bytes += chunk.length
    if (bytes > 128 * 1024) { overflow = true; terminate(); return }
    output += chunk.toString('utf8')
    progressBuffer += chunk.toString('utf8')
    const lines = progressBuffer.split('\n')
    progressBuffer = lines.pop()
    for (const line of lines) if (/^PE_ELECTRON_POLICY_PROGRESS [a-z-]+$/.test(line)) console.log(line)
  })
  // Drain Electron diagnostics without copying raw messages into test output.
  child.stderr.on('data', chunk => {
    bytes += chunk.length
    if (diagnostic.length < 4096) diagnostic += chunk.toString('utf8').slice(0, 4096 - diagnostic.length)
    if (bytes > 128 * 1024) { overflow = true; terminate() }
  })
  let outcome
  try {
    outcome = await new Promise((resolve, reject) => {
      child.once('error', reject)
      child.once('close', (code, signal) => { resolve({ code, signal }) })
    })
  } finally { clearTimeout(timer) }
  const progress = output.split('\n').filter(line => line.startsWith('PE_ELECTRON_POLICY_PROGRESS ')).at(-1) ?? 'no fixture progress'
  const startupCode = diagnostic.includes('ERR_MODULE_NOT_FOUND') ? 'ERR_MODULE_NOT_FOUND'
    : diagnostic.includes('Cannot find module') ? 'MODULE_NOT_FOUND' : 'no module diagnostic'
  assert.equal(timedOut, false, `Electron policy fixture exceeded its deadline (${progress}; ${startupCode})`)
  assert.equal(overflow, false, 'Electron policy fixture exceeded its output budget')
  const lines = output.split('\n').filter(line => line.startsWith('PE_ELECTRON_POLICY_RESULT '))
  assert.equal(lines.length, 1, 'Electron must return exactly one bounded policy result')
  const result = JSON.parse(lines[0].slice('PE_ELECTRON_POLICY_RESULT '.length))
  assert.equal(outcome.code, 0, JSON.stringify(result.failure ?? outcome))
  assert.equal(outcome.signal, null)
  return result
}

test('real Electron Cloud IPC, frame ownership and navigation', { skip: electron === undefined, timeout: 75000 }, async context => {
  await access(electron)
  for (const name of ['preferences', 'window-policy', 'config', 'partition']) {
    await access(new URL(`../lib/types/${name}.js`, import.meta.url))
  }
  const root = await mkdtemp(join(tmpdir(), 'pe-electron-policy-'))
  try {
    await Promise.all(['home', 'tmp', 'cache', 'config', 'user-data'].map(name => mkdir(join(root, name), { mode: 0o700 })))
    const result = await runElectron(root)
    assert.equal(result.complete, true)
    assert.match(result.electron, /^44\./)
    assert.deepEqual(result.cases.map(value => value.name), expected)
    assert.deepEqual(result.cleanup, { windows: 0, servers: 0 })
    for (const value of result.cases) await context.test(value.name, () => { assert.equal(value.passed, true) })
  } finally { await rm(root, { recursive: true, force: true }) }
})
