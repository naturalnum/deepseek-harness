/** Actual package inclusion of the current cloud schema, independent of prepared lib outputs. */
import assert from 'node:assert/strict'
import { spawnSync } from 'node:child_process'
import { mkdtempSync, readFileSync, rmSync } from 'node:fs'
import { createRequire } from 'node:module'
import { tmpdir } from 'node:os'
import { dirname, join, resolve } from 'node:path'
import { test } from 'node:test'
import { nativePureJavaScriptChildEnvironment } from '../../scripts/cloud-coverage.mjs'

const root = resolve(import.meta.dirname, '../../../..')
const app = resolve(root, 'products/power-evolve/application')
const require = createRequire(import.meta.url)

test('real application pack includes both Schema v2 assets and keeps Contracts as a peer', () => {
  const folder = mkdtempSync(join(tmpdir(), 'employee6-peer-pack-'))
  try {
    const before = readFileSync(join(app, 'package.json'), 'utf8')
    const manifest = JSON.parse(before)
    for (const hook of ['prepack', 'prepare', 'postpack']) assert.equal(manifest.scripts[hook], undefined)
    const managerPath = require.resolve('pnpm')
    const manager = JSON.parse(readFileSync(managerPath, 'utf8'))
    const result = spawnSync(process.execPath, [resolve(dirname(managerPath), manager.bin.pnpm), '--dir', app,
      'pack', '--pack-destination', folder, '--json'], {
      cwd: root, encoding: 'utf8', shell: false, timeout: 30000, maxBuffer: 16 * 1024 * 1024,
      env: nativePureJavaScriptChildEnvironment(),
    })
    assert.equal(result.error, undefined, String(result.error))
    assert.equal(result.signal, null, result.stderr)
    assert.equal(result.status, 0, result.stdout + result.stderr)
    const report = JSON.parse(result.stdout)
    for (const asset of ['assets/cloud-schema-v2.sql', 'assets/cloud-schema-v2.manifest.json']) {
      assert(report.files.some(file => file.path === asset), 'Missing shipped asset ' + asset)
    }
    assert.equal(manifest.peerDependencies['@power-evolve/contracts'], 'workspace:~')
    assert.equal(manifest.devDependencies['@power-evolve/contracts'], 'workspace:~')
    assert.equal(manifest.dependencies['@power-evolve/contracts'], undefined)
    assert.equal(readFileSync(join(app, 'package.json'), 'utf8'), before)
  } finally { rmSync(folder, { recursive: true, force: true }) }
})
