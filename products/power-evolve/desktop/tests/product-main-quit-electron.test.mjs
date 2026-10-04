/** Opt-in real Electron production-main quit regressions; not DSH/Worker/Docker or real-dialog E2E. */
import assert from 'node:assert/strict'
import { spawn } from 'node:child_process'
import { createHash, randomUUID } from 'node:crypto'
import { access, copyFile, mkdir, mkdtemp, readFile, readdir, rm, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { isAbsolute, join } from 'node:path'
import { test } from 'node:test'
import { fileURLToPath } from 'node:url'
import { setTimeout as delay } from 'node:timers/promises'

const electron = process.env.PE_DESKTOP_ELECTRON
const desktop = process.env.PE_DESKTOP_GATE_PACKAGE ?? fileURLToPath(new URL('..', import.meta.url))
const evidence = process.env.PE_DESKTOP_QUIT_EVIDENCE
const label = process.env.PE_DESKTOP_QUIT_RUN_LABEL ?? 'run'

/** Copy the actual shipped bundle and preloads once; all cases use the same immutable bytes. */
async function snapshot(root) {
  assert(isAbsolute(desktop)); assert(/^[a-z][a-z0-9-]{0,40}$/u.test(label))
  const compiled = join(root, 'compiled'); await mkdir(compiled, { mode: 0o700 })
  const names = (await readdir(join(desktop, 'lib'))).filter(name => name === 'main.js' || name.endsWith('.cjs')).sort()
  for (const required of ['main.js', 'preload-cloud.cjs', 'preload-device.cjs']) assert(names.includes(required))
  const hashes = {}
  for (const name of names) {
    const path = join(desktop, 'lib', name), original = await readFile(path)
    await copyFile(path, join(compiled, name))
    assert.deepEqual(await readFile(path), original, 'Production artifacts changed during snapshot')
    const frozen = await readFile(join(compiled, name)); assert.deepEqual(frozen, original)
    hashes[name] = createHash('sha256').update(frozen).digest('hex')
  }
  return { compiled, hashes }
}

/** Await the real Electron process and confirm that no descendants remain in its owned process group. */
async function run(root, compiled, scenario) {
  const application = join(root, 'app'); await mkdir(application, { mode: 0o700 })
  await copyFile(new URL('./fixtures/product-main-quit.mjs', import.meta.url), join(application, 'fixture.mjs'))
  await copyFile(new URL('./fixtures/product-quit-cli.mjs', import.meta.url), join(root, 'cli.mjs'))
  await writeFile(join(application, 'package.json'), JSON.stringify({ type: 'module', main: 'fixture.mjs' }), { mode: 0o600 })
  const env = { PATH: '/usr/bin:/bin:/usr/sbin:/sbin', HOME: join(root, 'home'), TMPDIR: join(root, 'tmp'),
    XDG_CACHE_HOME: join(root, 'cache'), XDG_CONFIG_HOME: join(root, 'config'), LANG: 'en_US.UTF-8',
    PE_QUIT_GATE_ROOT: root, PE_QUIT_GATE_SCENARIO: scenario, PE_QUIT_GATE_COMPILED: compiled,
    PE_QUIT_GATE_NODE: process.execPath }
  if (process.platform === 'win32' && process.env.SystemRoot !== undefined) env.SystemRoot = process.env.SystemRoot
  const child = spawn(electron, [application, '--config', join(root, 'cloud.json'), '--data-dir', join(root, 'user-data'),
    '--device-config', join(root, 'device.json')], { cwd: application, env,
    stdio: ['ignore', 'pipe', 'pipe'], detached: process.platform !== 'win32' })
  let output = '', bytes = 0, timedOut = false, overflow = false
  const terminate = () => {
    try { if (process.platform === 'win32') child.kill('SIGKILL'); else process.kill(-child.pid, 'SIGKILL') }
    catch (error) { if (error.code !== 'ESRCH') throw error }
  }
  const timer = setTimeout(() => { timedOut = true; terminate() }, 20000)
  child.stdout.on('data', chunk => {
    bytes += chunk.length
    if (bytes > 128 * 1024) { overflow = true; terminate(); return }
    output += chunk.toString('utf8')
  })
  child.stderr.on('data', chunk => { bytes += chunk.length; if (bytes > 128 * 1024) { overflow = true; terminate() } })
  let exit
  try { exit = await new Promise((resolve, reject) => {
    child.once('error', reject); child.once('close', (code, signal) => resolve({ code, signal }))
  }) } finally { clearTimeout(timer) }
  let processGroupGone = true
  if (process.platform !== 'win32') {
    for (let attempt = 0; attempt < 100; attempt++) {
      try { process.kill(-child.pid, 0); processGroupGone = false }
      catch (error) { if (error.code !== 'ESRCH') throw error; processGroupGone = true; break }
      await delay(10)
    }
    if (!processGroupGone) terminate()
  }
  const lines = output.split('\n').filter(line => line.startsWith('PE_PRODUCT_QUIT_RESULT '))
  assert.equal(timedOut, false, 'Product quit gate exceeded its deadline')
  assert.equal(overflow, false, 'Product quit gate exceeded its output budget')
  assert.equal(lines.length, 1, 'Production main gate must emit one result')
  return { ...JSON.parse(lines[0].slice('PE_PRODUCT_QUIT_RESULT '.length)), exit, processGroupGone }
}

test('production Electron main owns quit confirmation and residual warnings', { skip: electron === undefined, timeout: 75000 }, async t => {
  await access(electron)
  if (evidence !== undefined) { assert(isAbsolute(evidence)); await mkdir(evidence, { mode: 0o700, recursive: true }) }
  const root = await mkdtemp(join(tmpdir(), 'pe-product-main-quit-'))
  try {
    const frozen = await snapshot(root)
    for (const scenario of ['starting', 'stopped-residual', 'empty']) await t.test(scenario, async () => {
      const directory = join(root, scenario); await mkdir(directory, { mode: 0o700 })
      for (const name of ['home', 'tmp', 'cache', 'config', 'user-data']) await mkdir(join(directory, name), { mode: 0o700 })
      const result = { ...await run(directory, frozen.compiled, scenario), compiled: frozen.hashes }
      if (evidence !== undefined) await writeFile(join(evidence, `${label}-${scenario}-${randomUUID()}.json`),
        JSON.stringify(result, null, 2) + '\n', { mode: 0o600, flag: 'wx' })
      assert.equal(result.processGroupGone, true, 'Owned Electron descendants remained')
      assert.deepEqual(result.cleanup, { windows: 0, servers: 0, ownedChildren: 0 })
      assert.equal(result.complete, true, JSON.stringify(result.failure))
      assert.deepEqual(result.exit, { code: 0, signal: null })
      assert.match(result.electron, /^44\./u)
      if (scenario === 'starting') assert(result.cases.some(value => value.name === 'starting-cancel-keeps-child-and-app'))
      if (scenario === 'stopped-residual') assert(result.cases.some(value => value.name === 'stopped-residual-retained-warning'))
      if (scenario === 'empty') assert(result.cases.some(value => value.name === 'empty-drain-without-warning'))
    })
  } finally { await rm(root, { recursive: true, force: true }) }
})
