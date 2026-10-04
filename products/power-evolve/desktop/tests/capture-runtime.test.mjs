/** Synthetic package graphs exercise capture and Node resolution; no DSH Profile, Electron, installer or service is launched. */
import assert from 'node:assert/strict'
import { execFileSync } from 'node:child_process'
import { existsSync, mkdirSync, mkdtempSync, readFileSync, realpathSync, rmSync, symlinkSync, writeFileSync, chmodSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { dirname, join, resolve } from 'node:path'
import { fileURLToPath } from 'node:url'
import { test } from 'node:test'
import { captureTrialRuntime, inspectTrialRuntime, verifyTrialRuntime } from '../scripts/capture-runtime.mjs'

const CLI = '@deepseek-ai/dsh', DEVICE = '@power-evolve/device'
const env = Object.fromEntries(Object.entries(process.env).filter(([name]) => !/KEY|SECRET|TOKEN|PASSWORD|^GIT_|^NODE_/iu.test(name)))

function fixture(t) {
  const base = mkdtempSync(join(tmpdir(), 'pe-runtime-capture-'))
  t.after(() => rmSync(base, { recursive: true, force: true }))
  const sourceRoot = join(base, 'source'), output = join(base, 'capture')
  mkdirSync(sourceRoot)
  writeFileSync(join(sourceRoot, 'pnpm-workspace.yaml'), 'packages:\n  - apps/*\n  - products/*\n')
  writeFileSync(join(sourceRoot, '.gitignore'), 'node_modules/\n')
  function packageAt(directory, name, version, dependencies = {}, code = 'export const value = "original"\n', extra = {}) {
    const root = join(sourceRoot, directory)
    mkdirSync(join(root, 'lib'), { recursive: true })
    writeFileSync(join(root, 'package.json'), JSON.stringify({ name, version, type: 'module', files: ['lib'], main: 'lib/index.js',
      exports: { '.': './lib/index.js' }, dependencies, ...extra }))
    writeFileSync(join(root, 'lib/index.js'), code)
    return root
  }
  const cli = packageAt('apps/cli', CLI, '0.1.7-rc.2')
  const device = packageAt('products/device', DEVICE, '0.1.0', {}, 'export const value = "device"\n',
    { files: ['lib', 'cordis.patch.yml'], dsh: { bundle: { patch: './cordis.patch.yml' } } })
  writeFileSync(join(device, 'cordis.patch.yml'), '- insert: []\n')
  function link(root, name, target) {
    const path = join(root, 'node_modules', name)
    mkdirSync(dirname(path), { recursive: true })
    symlinkSync(target, path, 'dir')
  }
  function commit() {
    execFileSync('git', ['init', '--quiet'], { cwd: sourceRoot, env })
    execFileSync('git', ['add', '.'], { cwd: sourceRoot, env })
    execFileSync('git', ['-c', 'user.name=Runtime Fixture', '-c', 'user.email=runtime-fixture@example.invalid', 'commit', '--quiet', '-m', 'synthetic runtime'],
      { cwd: sourceRoot, env })
    return execFileSync('git', ['rev-parse', 'HEAD'], { cwd: sourceRoot, env, encoding: 'utf8' }).trim()
  }
  return { sourceRoot, output, cli, device, packageAt, link, commit }
}
function frozenImport(output, name) {
  return execFileSync(process.execPath, ['--input-type=module', '-e',
    `import {value} from ${JSON.stringify(name)}; console.log(JSON.stringify(value))`],
  { cwd: join(output, 'runtime'), env, encoding: 'utf8', timeout: 5000 }).trim()
}

test('physical objects and finite internal aliases preserve multi-version dependencies and a cycle', t => {
  const f = fixture(t)
  const one = f.packageAt('node_modules/.pnpm/flavor-one/node_modules/flavor', 'flavor', '1.0.0', { [CLI]: 'workspace:*' }, 'export const value = "one"\n')
  const two = f.packageAt('node_modules/.pnpm/flavor-two/node_modules/flavor', 'flavor', '2.0.0', {}, 'export const value = "two"\n')
  f.link(f.cli, 'flavor', one); f.link(f.device, 'flavor', two); f.link(one, CLI, f.cli)
  const cliManifest = JSON.parse(readFileSync(join(f.cli, 'package.json'), 'utf8'))
  const deviceManifest = JSON.parse(readFileSync(join(f.device, 'package.json'), 'utf8'))
  cliManifest.dependencies = { flavor: '^1.0.0' }; deviceManifest.dependencies = { flavor: '^2.0.0' }
  writeFileSync(join(f.cli, 'package.json'), JSON.stringify(cliManifest))
  writeFileSync(join(f.device, 'package.json'), JSON.stringify(deviceManifest))
  writeFileSync(join(f.cli, 'lib/index.js'), 'import {value as flavor} from "flavor"; export const value = "cli-" + flavor\n')
  writeFileSync(join(f.device, 'lib/index.js'), 'import {value as flavor} from "flavor"; export const value = "device-" + flavor\n')
  const record = captureTrialRuntime({ sourceRoot: f.sourceRoot, sourceCommit: f.commit(), output: f.output })
  assert.equal(record.packages.length, 4)
  assert.deepEqual(record.multiVersions, [{ name: 'flavor', versions: ['1.0.0', '2.0.0'] }])
  assert.equal(record.cycles.length, 1)
  assert.equal(record.inventory.aliases.length, 5)
  assert.equal(frozenImport(f.output, CLI), '"cli-one"')
  assert.equal(frozenImport(f.output, DEVICE), '"device-two"')
  for (const alias of record.inventory.aliases) {
    assert.ok(!alias.target.startsWith('/'))
    assert.ok(realpathSync(join(f.output, 'runtime', alias.path)).startsWith(realpathSync(join(f.output, 'runtime')) + '/'))
  }
  assert.ok(existsSync(resolve(f.output, record.paths[DEVICE], 'cordis.patch.yml')))
})

test('same-version physical peer contexts remain distinct objects with their original resolutions', t => {
  const f = fixture(t)
  const peerOne = f.packageAt('node_modules/.pnpm/peer-one/node_modules/peer', 'peer', '1.0.0', {}, 'export const value = "one"\n')
  const peerTwo = f.packageAt('node_modules/.pnpm/peer-two/node_modules/peer', 'peer', '2.0.0', {}, 'export const value = "two"\n')
  const code = 'import {value as peer} from "peer"; export const value = peer\n'
  const contextOne = f.packageAt('node_modules/.pnpm/context-one/node_modules/context', 'context', '1.0.0', {}, code, { peerDependencies: { peer: '*' } })
  const contextTwo = f.packageAt('node_modules/.pnpm/context-two/node_modules/context', 'context', '1.0.0', {}, code, { peerDependencies: { peer: '*' } })
  f.link(contextOne, 'peer', peerOne); f.link(contextTwo, 'peer', peerTwo)
  f.link(f.cli, 'context', contextOne); f.link(f.device, 'context', contextTwo)
  for (const root of [f.cli, f.device]) {
    const m = JSON.parse(readFileSync(join(root, 'package.json'), 'utf8')); m.dependencies = { context: '^1' }
    writeFileSync(join(root, 'package.json'), JSON.stringify(m))
    writeFileSync(join(root, 'lib/index.js'), 'export {value} from "context"\n')
  }
  const captured = captureTrialRuntime({ sourceRoot: f.sourceRoot, sourceCommit: f.commit(), output: f.output })
  assert.equal(new Set(captured.packages.filter(node => node.name === 'context').map(node => node.id)).size, 2)
  assert.equal(frozenImport(f.output, CLI), '"one"')
  assert.equal(frozenImport(f.output, DEVICE), '"two"')
})

test('captured CLI, Profile patch and Python bytes survive source rebuild changes and source removal', t => {
  const f = fixture(t)
  const app = f.packageAt('products/application', '@power-evolve/application', '0.1.0', {}, 'export const value = "application"\n',
    { files: ['lib', 'src/device/local-files.py', 'src/platform/safe-posix.py'] })
  mkdirSync(join(app, 'src/device'), { recursive: true }); mkdirSync(join(app, 'src/platform'), { recursive: true })
  writeFileSync(join(app, 'src/device/local-files.py'), '# original local helper\n')
  writeFileSync(join(app, 'src/platform/safe-posix.py'), '# original sibling helper\n')
  const m = JSON.parse(readFileSync(join(f.device, 'package.json'), 'utf8'))
  m.dependencies = { '@power-evolve/application': 'workspace:*' }
  writeFileSync(join(f.device, 'package.json'), JSON.stringify(m))
  f.link(f.device, '@power-evolve/application', app)
  chmodSync(join(f.cli, 'lib/index.js'), 0o755)
  const captured = captureTrialRuntime({ sourceRoot: f.sourceRoot, sourceCommit: f.commit(), output: f.output })
  const saved = JSON.stringify(captured.inventory)
  writeFileSync(join(f.cli, 'lib/index.js'), 'throw new Error("later build")\n')
  writeFileSync(join(f.device, 'cordis.patch.yml'), 'changed\n')
  writeFileSync(join(app, 'src/device/local-files.py'), '# changed\n')
  rmSync(f.sourceRoot, { recursive: true, force: true })
  assert.equal(frozenImport(f.output, CLI), '"original"')
  const verified = verifyTrialRuntime(f.output)
  assert.equal(JSON.stringify(verified.inventory), saved)
  const appObject = join(f.output, 'runtime/objects', captured.packages.find(node => node.name === '@power-evolve/application').id)
  assert.equal(readFileSync(join(appObject, 'src/device/local-files.py'), 'utf8'), '# original local helper\n')
  assert.equal(readFileSync(join(appObject, 'src/platform/safe-posix.py'), 'utf8'), '# original sibling helper\n')
  assert.equal(readFileSync(resolve(f.output, captured.paths[DEVICE], 'cordis.patch.yml'), 'utf8'), '- insert: []\n')
})

test('explicit workspace manifest fallback closes a missing workspace edge without external fallback', t => {
  const f = fixture(t)
  f.packageAt('products/contracts', '@power-evolve/contracts', '0.1.0')
  const m = JSON.parse(readFileSync(join(f.device, 'package.json'), 'utf8'))
  m.dependencies = { '@power-evolve/contracts': 'workspace:*', 'missing-optional': '^1' }
  m.optionalDependencies = { 'missing-optional': '^1' }
  writeFileSync(join(f.device, 'package.json'), JSON.stringify(m))
  const plan = inspectTrialRuntime({ sourceRoot: f.sourceRoot, sourceCommit: f.commit() })
  assert.equal(plan.missing.length, 0)
  assert.equal(plan.skipped.length, 1)
  assert.equal(plan.packages.find(node => node.name === DEVICE).dependencies[0].resolution, 'workspace-manifest')
  const record = captureTrialRuntime({ sourceRoot: f.sourceRoot, sourceCommit: plan.sourceCommit, output: f.output })
  assert.equal(record.packages.length, 3)
})

test('missing required external dependency is diagnosed and refuses capture before writing', t => {
  const f = fixture(t)
  const m = JSON.parse(readFileSync(join(f.cli, 'package.json'), 'utf8')); m.dependencies = { 'absent-external': '^7' }
  writeFileSync(join(f.cli, 'package.json'), JSON.stringify(m))
  const sourceCommit = f.commit()
  const plan = inspectTrialRuntime({ sourceRoot: f.sourceRoot, sourceCommit })
  assert.equal(plan.missing[0].name, 'absent-external')
  assert.throws(() => captureTrialRuntime({ sourceRoot: f.sourceRoot, sourceCommit, output: f.output }), /trial_runtime_missing_dependencies/u)
  assert.equal(existsSync(f.output), false)
})

test('escaping, absolute, dangling and altered internal aliases are rejected during independent verification', t => {
  const f = fixture(t)
  const record = captureTrialRuntime({ sourceRoot: f.sourceRoot, sourceCommit: f.commit(), output: f.output })
  const path = resolve(f.output, record.paths[CLI])
  const original = record.inventory.aliases.find(alias => alias.path === `node_modules/${CLI}`).target
  for (const target of [f.cli, '../../../../outside', '../missing-object', original + '/lib']) {
    rmSync(path); symlinkSync(target, path)
    assert.throws(() => verifyTrialRuntime(f.output))
  }
})

test('selected payload symlinks, missing built entries, wrong source and existing output fail closed', t => {
  const f = fixture(t)
  const sourceCommit = f.commit()
  assert.throws(() => inspectTrialRuntime({ sourceRoot: f.sourceRoot, sourceCommit: '0'.repeat(40) }), /trial_runtime_source_changed/u)
  mkdirSync(f.output)
  writeFileSync(join(f.output, 'keep'), 'existing')
  assert.throws(() => captureTrialRuntime({ sourceRoot: f.sourceRoot, sourceCommit, output: f.output }), /EEXIST/u)
  assert.equal(readFileSync(join(f.output, 'keep'), 'utf8'), 'existing')
  rmSync(join(f.cli, 'lib/index.js'))
  assert.throws(() => inspectTrialRuntime({ sourceRoot: f.sourceRoot, sourceCommit }), /trial_runtime_source_dirty/u)
  writeFileSync(join(f.cli, 'lib/index.js'), 'export const value = "original"\n')
  rmSync(join(f.cli, 'lib/index.js')); symlinkSync(join(f.device, 'lib/index.js'), join(f.cli, 'lib/index.js'))
  // A newly committed public fixture tests payload validation independently from the clean-HEAD guard.
  const linkedCommit = f.commit()
  assert.throws(() => inspectTrialRuntime({ sourceRoot: f.sourceRoot, sourceCommit: linkedCommit }), /trial_runtime_payload_symlink/u)
})

test('missing compiled workspace entry refuses capture rather than rebuilding or manufacturing it', t => {
  const f = fixture(t)
  const m = JSON.parse(readFileSync(join(f.cli, 'package.json'), 'utf8')); m.bin = { dsh: 'lib/bin.js' }
  writeFileSync(join(f.cli, 'package.json'), JSON.stringify(m))
  const sourceCommit = f.commit()
  assert.throws(() => captureTrialRuntime({ sourceRoot: f.sourceRoot, sourceCommit, output: f.output }), /trial_runtime_missing_entry/u)
  assert.equal(existsSync(f.output), false)
})

test('declared glob exclusions, Node conditions and legacy main extensions preserve installed byte selection', t => {
  const f = fixture(t)
  const external = f.packageAt('node_modules/.pnpm/library/node_modules/library', 'library', '1.0.0', {}, 'export const value = "library"\n',
    { files: ['/lib/*', '!lib/unused.js'], main: 'lib/index', exports: { '.': { 'custom-source': './src/index.ts', import: './lib/index.js' },
      './unused-advertised': './missing.js' } })
  writeFileSync(join(external, 'lib/unused.js'), 'unused\n')
  const m = JSON.parse(readFileSync(join(f.cli, 'package.json'), 'utf8')); m.dependencies = { library: '^1' }
  writeFileSync(join(f.cli, 'package.json'), JSON.stringify(m)); f.link(f.cli, 'library', external)
  const captured = captureTrialRuntime({ sourceRoot: f.sourceRoot, sourceCommit: f.commit(), output: f.output })
  const node = captured.packages.find(node => node.name === 'library')
  assert.deepEqual(node.missingEntries, ['missing.js'])
  assert.ok(!node.files.some(file => file.path === 'lib/unused.js'))
  assert.ok(!node.files.some(file => file.path === 'src/index.ts'))
  assert.ok(!existsSync(join(f.output, 'runtime/objects', node.id, 'missing.js')))
})

test('independent inventory detects in-place bytes changes and CLI help has no capture effects', t => {
  const f = fixture(t)
  const record = captureTrialRuntime({ sourceRoot: f.sourceRoot, sourceCommit: f.commit(), output: f.output })
  const path = resolve(f.output, record.paths[CLI], 'lib/index.js')
  chmodSync(path, 0o644); writeFileSync(path, 'changed bytes\n')
  assert.throws(() => verifyTrialRuntime(f.output), /trial_runtime_inventory_changed/u)
  const operator = fileURLToPath(new URL('../scripts/capture-runtime.mjs', import.meta.url))
  const help = execFileSync(process.execPath, [operator, '--help'], { env, encoding: 'utf8', timeout: 5000 })
  assert.match(help, /inspect\|capture/u)
})
