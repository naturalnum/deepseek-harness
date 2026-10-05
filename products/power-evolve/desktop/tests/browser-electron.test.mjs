/** Opt-in real Electron browser gate with isolated HTTP authority substitutes; this is not PostgreSQL E2E. */
import assert from 'node:assert/strict'
import { spawn } from 'node:child_process'
import { createHash } from 'node:crypto'
import { access, copyFile, mkdir, mkdtemp, readFile, rm, symlink } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { dirname, isAbsolute, join, resolve } from 'node:path'
import test from 'node:test'
import { fileURLToPath } from 'node:url'

const electron = process.env.PE_DESKTOP_ELECTRON
const desktop = process.env.PE_DESKTOP_GATE_PACKAGE ?? fileURLToPath(new URL('..', import.meta.url))
const expected = ['owned-session-cookie-and-scope', 'workspace-storage-and-release', 'frame-and-session-denials',
  'product-endpoints-and-aliases-denied', 'cookie-account-retirement-and-logout',
  'late-account-and-navigation-observations', 'strict-bounded-scope-and-deadline',
  'same-cookie-service-revocation', 'window-close-retirement']

/** Freeze product modules and record the real compiled upstream helper that their imports use. */
async function snapshot(root) {
  assert(isAbsolute(desktop), 'The tested desktop package must be absolute')
  const directory = join(root, 'compiled'), hashes = {}
  await mkdir(directory, { mode: 0o700 })
  for (const name of ['browser', 'browser-authorization', 'browser-network', 'config', 'window-policy']) {
    const target = join(directory, name + '.js')
    await copyFile(join(desktop, 'lib/types', name + '.js'), target)
    hashes['product/' + name + '.js'] = createHash('sha256').update(await readFile(target)).digest('hex')
  }
  for (const name of ['assembly', 'browser-guests']) {
    const path = resolve(desktop, '../../../apps/desktop/lib/types', name + '.js')
    hashes['upstream/' + name + '.js'] = createHash('sha256').update(await readFile(path)).digest('hex')
  }
  await symlink(resolve(desktop, 'node_modules'), join(directory, 'node_modules'), 'dir')
  return hashes
}

/** Drain bounded output and await only the independently owned Electron process group. */
async function run(root) {
  const fixture = fileURLToPath(new URL('./fixtures/browser-main.mjs', import.meta.url))
  const env = { PATH: '/usr/bin:/bin:/usr/sbin:/sbin', HOME: join(root, 'home'), TMPDIR: join(root, 'tmp'),
    XDG_CACHE_HOME: join(root, 'cache'), XDG_CONFIG_HOME: join(root, 'config'), LANG: 'en_US.UTF-8' }
  if (process.platform === 'win32' && process.env.SystemRoot !== undefined) env.SystemRoot = process.env.SystemRoot
  const child = spawn(electron, [fixture, `--pe-browser-gate-root=${root}`], { cwd: dirname(fixture), env,
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
  child.stderr.on('data', chunk => { bytes += chunk.length; if (bytes > 128 * 1024) { overflow = true; terminate() } })
  let outcome
  try {
    outcome = await new Promise((resolveExit, reject) => {
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
  assert.equal(timedOut, false, 'Browser gate exceeded its deadline')
  assert.equal(overflow, false, 'Browser gate exceeded its output budget')
  const lines = output.split('\n').filter(line => line.startsWith('PE_BROWSER_ELECTRON_RESULT '))
  assert.equal(lines.length, 1, 'Electron must return one bounded browser result')
  const result = JSON.parse(lines[0].slice('PE_BROWSER_ELECTRON_RESULT '.length))
  assert.equal(outcome.code, 0, JSON.stringify(result.failure ?? outcome))
  assert.equal(outcome.signal, null)
  assert.equal(processGroupGone, true, 'Owned Electron descendants remained after exit')
  return result
}

test('real Electron product browser guests with controlled HTTP scope observations', { skip: electron === undefined, timeout: 75000 }, async t => {
  await access(electron)
  const root = await mkdtemp(join(tmpdir(), 'pe-browser-electron-'))
  try {
    await Promise.all(['home', 'tmp', 'cache', 'config', 'user-data'].map(name => mkdir(join(root, name), { mode: 0o700 })))
    const compiled = await snapshot(root), result = await run(root)
    assert.equal(result.complete, true)
    assert.match(result.electron, /^44\./)
    assert.deepEqual(result.cases.map(value => value.name), expected)
    assert.deepEqual(result.cleanup, { windows: 0, guests: 0, servers: 0 })
    console.log('PE_BROWSER_ELECTRON_EVIDENCE ' + JSON.stringify({ ...result, compiled }))
    for (const value of result.cases) await t.test(value.name, () => { assert.equal(value.passed, true) })
  } finally { await rm(root, { recursive: true, force: true }) }
})
