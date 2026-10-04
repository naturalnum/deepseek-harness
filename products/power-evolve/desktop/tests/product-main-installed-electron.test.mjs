/** Real Electron installed-main gate; installation facts and the owned CLI protocol are fixtures. */
import assert from 'node:assert/strict'
import { spawn } from 'node:child_process'
import { createHash } from 'node:crypto'
import { access, chmod, copyFile, mkdir, mkdtemp, readFile, realpath, rm, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { dirname, isAbsolute, join } from 'node:path'
import { fileURLToPath } from 'node:url'
import { test } from 'node:test'
import { setTimeout as delay } from 'node:timers/promises'

const electron = process.env.PE_DESKTOP_ELECTRON
const desktop = process.env.PE_DESKTOP_GATE_PACKAGE ?? fileURLToPath(new URL('..', import.meta.url))
const evidence = process.env.PE_DESKTOP_INSTALLED_EVIDENCE
const prefix = 'PE_PRODUCT_INSTALLED_RESULT '
const hash = bytes => createHash('sha256').update(bytes).digest('hex')

/** Snapshot the actual production bundle and independent production preloads once. */
async function snapshot(root) {
  assert(isAbsolute(desktop))
  const compiled = join(root, 'compiled'); await mkdir(compiled, { mode: 0o700 })
  const hashes = {}
  for (const name of ['main.js', 'preload-cloud.cjs', 'preload-device.cjs']) {
    const source = join(desktop, 'lib', name), bytes = await readFile(source)
    await copyFile(source, join(compiled, name))
    assert.deepEqual(await readFile(source), bytes, 'Production artifact changed while capturing')
    assert.deepEqual(await readFile(join(compiled, name)), bytes)
    hashes[name] = hash(bytes)
  }
  const fixtures = {}
  for (const name of ['product-installed-main.mjs', 'product-installed-cli.mjs']) {
    fixtures[name] = hash(await readFile(new URL('./fixtures/' + name, import.meta.url)))
  }
  return { compiled, hashes, fixtures, node: { version: process.version, sha256: hash(await readFile(process.execPath)) } }
}

/** Make ordinary physical resources; only the actual Node executable is run. */
async function resources(root) {
  const selected = join(root, 'resources'), runtime = {
    nodeExecutable: 'node/bin/node', cliEntrypoint: 'cli/lib/bin.mjs', pythonExecutable: 'python/bin/python3',
    fileHelper: 'application/device/local-files.py', deviceBundle: 'cli/node_modules/@power-evolve/device',
  }
  await mkdir(selected, { mode: 0o700 })
  for (const path of Object.values(runtime)) await mkdir(dirname(join(selected, path)), { recursive: true, mode: 0o700 })
  await copyFile(process.execPath, join(selected, runtime.nodeExecutable))
  await chmod(join(selected, runtime.nodeExecutable), 0o700)
  await copyFile(new URL('./fixtures/product-installed-cli.mjs', import.meta.url), join(selected, runtime.cliEntrypoint))
  await writeFile(join(selected, runtime.pythonExecutable), '#!/bin/sh\nexit 77\n', { mode: 0o700 })
  await writeFile(join(selected, runtime.fileHelper), '# existence-only fixture; never executed\n', { mode: 0o600 })
  for (const bundle of [runtime.deviceBundle, 'runtime/descriptor-device']) {
    const path = join(selected, bundle); await mkdir(path, { recursive: true, mode: 0o700 })
    await writeFile(join(path, 'package.json'), JSON.stringify({ name: '@power-evolve/device', private: true,
      type: 'module', exports: { './package.json': './package.json' }, dsh: { bundle: { patch: './cordis.patch.yml' } } }), { mode: 0o600 })
    await writeFile(join(path, 'cordis.patch.yml'), '[]\n', { mode: 0o600 })
  }
  return runtime
}

/** Await the owned Electron group; bounded output does not expose Chromium or child stderr. */
async function run(root, compiled, scenario) {
  const application = join(root, 'app'); await mkdir(application, { mode: 0o700 })
  await copyFile(new URL('./fixtures/product-installed-main.mjs', import.meta.url), join(application, 'fixture.mjs'))
  await writeFile(join(application, 'package.json'), JSON.stringify({ type: 'module', main: 'fixture.mjs' }), { mode: 0o600 })
  const runtime = await resources(root)
  const child = spawn(electron, [application], { cwd: application, detached: process.platform !== 'win32',
    env: { PATH: '/usr/bin:/bin:/usr/sbin:/sbin', HOME: join(root, 'home'), TMPDIR: join(root, 'tmp'), DOCKER_HOST: 'unix://fixture-only.sock',
      XDG_CACHE_HOME: join(root, 'cache'), XDG_CONFIG_HOME: join(root, 'config'), LANG: 'en_US.UTF-8',
      PE_INSTALLED_GATE_ROOT: root, PE_INSTALLED_GATE_SCENARIO: scenario, PE_INSTALLED_GATE_COMPILED: compiled,
      PE_INSTALLED_GATE_RUNTIME: JSON.stringify(runtime),
      ...(process.platform === 'win32' && process.env.SystemRoot !== undefined ? { SystemRoot: process.env.SystemRoot } : {}) },
    stdio: ['ignore', 'pipe', 'pipe'] })
  let output = '', bytes = 0, timedOut = false, overflow = false
  const terminate = () => {
    try { if (process.platform === 'win32') child.kill('SIGKILL'); else process.kill(-child.pid, 'SIGKILL') }
    catch (error) { if (error.code !== 'ESRCH') throw error }
  }
  const timer = setTimeout(() => { timedOut = true; terminate() }, 20000)
  const consume = (chunk, stdout) => {
    bytes += chunk.length
    if (bytes > 128 * 1024) { overflow = true; terminate(); return }
    if (stdout) output += chunk.toString('utf8')
  }
  child.stdout.on('data', chunk => consume(chunk, true)); child.stderr.on('data', chunk => consume(chunk, false))
  let exit
  try { exit = await new Promise((resolve, reject) => {
    child.once('error', reject); child.once('close', (code, signal) => resolve({ code, signal }))
  }) } finally { clearTimeout(timer) }
  let processGroupGone = process.platform === 'win32'
  if (process.platform !== 'win32') {
    for (let attempt = 0; attempt < 100; attempt++) {
      try { process.kill(-child.pid, 0) }
      catch (error) { if (error.code !== 'ESRCH') throw error; processGroupGone = true; break }
      await delay(10)
    }
    if (!processGroupGone) terminate()
  }
  assert.equal(timedOut, false, 'Installed main exceeded its deadline')
  assert.equal(overflow, false, 'Installed main exceeded its output budget')
  const lines = output.split('\n').filter(line => line.startsWith(prefix))
  assert.equal(lines.length, 1, 'Installed main must emit one bounded result')
  return { ...JSON.parse(lines[0].slice(prefix.length)), exit, processGroupGone }
}

test('production installed Electron main selects fixed resources and owns local startup and quit',
  { skip: electron === undefined, timeout: 150000 }, async t => {
    await access(electron)
    if (evidence !== undefined) { assert(isAbsolute(evidence)); await mkdir(evidence, { recursive: true, mode: 0o700 }) }
    const root = await realpath(await mkdtemp(join(tmpdir(), 'pe-product-main-installed-')))
    const results = [], frozen = await snapshot(root)
    try {
      for (const scenario of ['installed', 'prepare-quit', 'home-overlay', 'cli-anchor', 'override-config', 'override-data-dir', 'override-device-config']) {
        await t.test(scenario, async () => {
          const directory = join(root, scenario); await mkdir(directory, { mode: 0o700 })
          for (const name of ['home', 'tmp', 'cache', 'config', 'app-data']) await mkdir(join(directory, name), { mode: 0o700 })
          const result = { ...await run(directory, frozen.compiled, scenario), compiled: frozen.hashes }
          results.push(result)
          assert.equal(result.complete, true, JSON.stringify(result.failure))
          assert.equal(result.processGroupGone, true, 'Owned Electron group remained')
          assert.deepEqual(result.cleanup, { windows: 0, servers: 0, ownedChildren: 0 })
          assert.deepEqual(result.exit, { code: 0, signal: null }); assert.match(result.electron, /^44\./u)
          if (evidence !== undefined) await writeFile(join(evidence, scenario + '.json'), JSON.stringify(result, null, 2) + '\n', { mode: 0o600 })
        })
      }
    } finally {
      await rm(root, { recursive: true, force: true })
      if (evidence !== undefined) await writeFile(join(evidence, 'proof.json'), JSON.stringify({
        complete: results.length === 7 && results.every(result => result.complete && result.processGroupGone),
        command: 'PE_DESKTOP_ELECTRON=<Electron44> PE_DESKTOP_GATE_PACKAGE=<built-desktop> PE_DESKTOP_INSTALLED_EVIDENCE=<private-evidence> node --test products/power-evolve/desktop/tests/product-main-installed-electron.test.mjs',
        compiled: frozen.hashes, fixtures: frozen.fixtures, testSha256: hash(await readFile(fileURLToPath(import.meta.url))),
        node: frozen.node, results, temporaryDirectoryRemoved: true,
        scope: 'Real Electron and production bundled main/preloads with installation facts, loopback HTML and owned CLI protocol fixtures. No actual .app, ABI, DSH/Worker, Python/helper execution, model, PostgreSQL or Docker acceptance.',
      }, null, 2) + '\n', { mode: 0o600 })
    }
  })
