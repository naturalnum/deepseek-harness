/** Built Device Profiles with real kernel locks; no pairing, model, Docker command, or PostgreSQL. */
import assert from 'node:assert/strict'
import { spawn } from 'node:child_process'
import { mkdir, mkdtemp, readFile, realpath, rm, symlink, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { setTimeout as delay } from 'node:timers/promises'
import { fileURLToPath } from 'node:url'
import test from 'node:test'
import yaml from 'js-yaml'

const repository = fileURLToPath(new URL('../../../../', import.meta.url))
const deviceBundle = join(repository, 'products/power-evolve/device')
const supported = ['darwin', 'linux'].includes(process.platform)
const bundleSchema = yaml.DEFAULT_SCHEMA.extend([new yaml.Type('tag:yaml.org,2002:js', {
  kind: 'scalar', construct: value => value,
})])
const bundle = yaml.load(await readFile(join(deviceBundle, 'cordis.patch.yml'), 'utf8'), { schema: bundleSchema })
const deviceConfig = bundle[0].insert.find(row => row.id === 'power-evolve-device').config

async function fixture(t) {
  const root = await mkdtemp(join(await realpath(tmpdir()), 'pe-device-profile-'))
  const owned = []
  t.after(async () => {
    for (const child of owned) await child.stop()
    await rm(root, { recursive: true, force: true })
  })
  const privateDir = join(root, 'private')
  return {
    privateDir,
    async launch(name) {
      const home = join(root, name), profile = join(home, 'profiles/device-lifecycle')
      const readyFile = join(home, 'ready.json')
      await mkdir(join(profile, 'node_modules/@power-evolve'), { recursive: true })
      await symlink(deviceBundle, join(profile, 'node_modules/@power-evolve/device'), 'dir')
      await writeFile(join(profile, 'package.json'), JSON.stringify({ private: true,
        dsh: { profile: { bundles: ['@power-evolve/device'] } } }))
      await writeFile(join(profile, 'cordis.patch.yml'), yaml.dump([
        { id: 'web-server', config: { host: '127.0.0.1', port: 0 } },
        { id: 'power-evolve-device', config: { ...deviceConfig, privateDir, readyFile,
          coordinationRoot: join(root, 'writers'), pythonExecutable: '/usr/bin/python3' } },
      ]))
      const processChild = spawn(process.execPath, [join(repository, 'apps/cli/lib/bin.js'), '--profile', 'device-lifecycle'], {
        cwd: repository,
        env: { PATH: process.env.PATH, HOME: process.env.HOME, DSH_HOME: home, PE_PRIVATE_DIR: root },
        stdio: ['ignore', 'pipe', 'pipe'],
      })
      let stderr = ''
      processChild.stdout.on('data', bytes => { stderr = (stderr + bytes).slice(-8192) })
      processChild.stderr.on('data', bytes => { stderr = (stderr + bytes).slice(-8192) })
      const exit = new Promise((resolve, reject) => {
        processChild.once('error', reject)
        processChild.once('close', (code, signal) => resolve({ code, signal }))
      })
      void exit.catch(() => {})
      const entry = {
        process: processChild,
        async exited() {
          let timer
          try {
            return await Promise.race([exit, new Promise((_, reject) => {
              timer = setTimeout(() => reject(new Error('owned Profile did not exit')), 10000)
            })])
          } finally { clearTimeout(timer) }
        },
        async stop() {
          if (processChild.exitCode === null && processChild.signalCode === null) processChild.kill('SIGTERM')
          try { return await this.exited() }
          catch (error) {
            processChild.kill('SIGKILL')
            await this.exited()
            throw error
          }
        },
        async ready() {
          const deadline = Date.now() + 20000
          while (Date.now() < deadline) {
            if (processChild.exitCode !== null || processChild.signalCode !== null) throw new Error(`Profile failed: ${stderr}`)
            try {
              const value = JSON.parse(await readFile(readyFile, 'utf8'))
              assert.equal(value.pid, processChild.pid)
              const response = await fetch(new URL('/health', value.url), { signal: AbortSignal.timeout(1000) })
              assert.equal(response.status, 200)
              assert.equal((await response.json()).instanceId, value.instanceId)
              return value
            } catch (error) {
              if (error?.code !== 'ENOENT' && !(error instanceof TypeError)) throw error
            }
            await delay(50)
          }
          throw new Error(`owned Profile readiness deadline: ${stderr}`)
        },
        stderr: () => stderr,
        async refused(fragment) {
          const deadline = Date.now() + 10000
          while (Date.now() < deadline) {
            if (stderr.includes(fragment)) {
              await assert.rejects(readFile(readyFile), { code: 'ENOENT' })
              return
            }
            await delay(50)
          }
          throw new Error(`missing refusal diagnostic: ${stderr}`)
        },
      }
      owned.push(entry)
      return entry
    },
  }
}

test('a built Device Profile excludes a rival and releases ownership on normal shutdown',
  { skip: !supported, timeout: 60000 }, async t => {
    const environment = await fixture(t)
    const first = await environment.launch('first')
    await first.ready()
    const rival = await environment.launch('rival')
    await rival.refused('device_process_already_owned')
    await rival.stop()
    assert.deepEqual(await first.stop(), { code: 0, signal: null })
    const successor = await environment.launch('successor')
    await successor.ready()
    assert.deepEqual(await successor.stop(), { code: 0, signal: null })
  })

test('a failed Device Profile initialization releases ownership before a later successful startup',
  { skip: !supported, timeout: 60000 }, async t => {
    const environment = await fixture(t)
    await mkdir(environment.privateDir, { mode: 0o700 })
    await writeFile(join(environment.privateDir, 'device.json'), 'invalid-json', { mode: 0o600 })
    const broken = await environment.launch('broken')
    await broken.refused('SyntaxError')
    await broken.stop()
    await rm(join(environment.privateDir, 'device.json'))
    const repaired = await environment.launch('repaired')
    await repaired.ready()
    assert.deepEqual(await repaired.stop(), { code: 0, signal: null })
  })
