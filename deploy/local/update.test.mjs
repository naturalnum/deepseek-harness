/** Exercise the actual Node -e/stdin boundary without accessing the candidate environment. */
import assert from 'node:assert/strict'
import { createHash } from 'node:crypto'
import { execFileSync, spawnSync } from 'node:child_process'
import { chmodSync, existsSync, mkdirSync, mkdtempSync, readFileSync, realpathSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { test } from 'node:test'
import { buildProductProgram, requireProductOnlyRollback, startSavedApplication } from './update.mjs'

test('the real product program prepares from asynchronous stdin and leaves the installed product untouched', t => {
  const directory = realpathSync(mkdtempSync(join(tmpdir(), 'pe-update-program-')))
  t.after(() => rmSync(directory, { recursive: true, force: true }))
  const product = join(directory, 'product'), source = join(directory, 'source')
  const backupDir = join(directory, 'rollback'), archivePath = join(directory, 'products.tar.gz')
  const path = 'apps/web/dist/index.html'
  for (const root of [product, source]) mkdirSync(join(root, 'apps/web/dist'), { recursive: true })
  writeFileSync(join(product, path), 'installed product before update')
  writeFileSync(join(source, path), 'candidate product after update')
  chmodSync(join(source, path), 0o644)
  const bytes = readFileSync(join(source, path))
  execFileSync('tar', ['-czf', archivePath, '-C', source, path])
  const manifest = { managedRoots: ['apps/web/dist'], files: [{ path, size: bytes.length, mode: 0o644,
    sha256: createHash('sha256').update(bytes).digest('hex') }] }
  const helper = readFileSync(new URL('./product-files.cjs', import.meta.url), 'utf8')
  const result = spawnSync(process.execPath, ['-e', buildProductProgram(helper)], {
    input: JSON.stringify({ mode: 'prepare', productRoot: product, archivePath, manifest, backupDir }),
    encoding: 'utf8',
  })
  assert.equal(result.error, undefined)
  assert.equal(result.signal, null, 'the subprocess must finish by itself')
  assert.equal(result.status, 0, result.stderr)
  assert.deepEqual(JSON.parse(result.stdout), { mode: 'prepare', files: 1, changed: 1, added: 0, removed: 0 })
  assert.equal(existsSync(join(backupDir, 'rollback.json')), true)
  assert.equal(readFileSync(join(product, path), 'utf8'), 'installed product before update')
})

function savedStart() {
  const state = { format: 'pe-cloud-local-update/v1', phase: 'failed', failureAt: 'prepared', stopAttempted: true,
    snapshot: { namespaceId: 'mnt:[200]', appCwd: '/opt/dsh-installed-products' }, holder: { pid: 21 } }
  const current = { appPid: null, namespaceId: 'mnt:[200]', namespaceKeeperPid: 21 }
  return { state, current }
}

test('start reuses saved launch inputs and the existing keeper, marking recovery only after readiness', async () => {
  const { state, current } = savedStart()
  state.rollbackStopExecId = 'failed-previous-rollback-stop'
  const phases = []
  const originalSnapshot = state.snapshot, originalHolder = state.holder
  await startSavedApplication(state, {
    inspect: async () => current,
    launch: async saved => {
      assert.equal(saved.snapshot, originalSnapshot)
      assert.equal(saved.holder, originalHolder)
      assert.equal(saved.recoveredOriginal, false)
      saved.launch = { execId: 'new-start' }
      saved.phase = 'started'
    },
    save: async saved => { phases.push({ phase: saved.phase, recovered: saved.recoveredOriginal }) },
  })
  assert.equal(state.phase, 'recovered')
  assert.equal(state.recoveredOriginal, true)
  assert.equal(state.failureAt, undefined)
  assert.equal(state.rollbackStopExecId, undefined)
  assert.equal(state.holder, originalHolder)
  assert.deepEqual(phases, [{ phase: 'failed', recovered: false }, { phase: 'recovered', recovered: true }])
})

test('start does not duplicate an unconfirmed Docker exec', async () => {
  const { state, current } = savedStart()
  state.launch = { execId: 'previous-start' }
  let launches = 0
  await assert.rejects(startSavedApplication(state, {
    inspect: async () => current,
    execution: async id => { assert.equal(id, 'previous-start'); return { running: true } },
    launch: async () => { launches++ },
    save: async () => {},
  }), /没有再次启动/)
  assert.equal(launches, 0)
})

test('a failed first start remains failed with its launch identity and is never retried automatically', async () => {
  const { state, current } = savedStart()
  let launches = 0
  const failure = new Error('fixed startup failure')
  await assert.rejects(startSavedApplication(state, {
    inspect: async () => current,
    launch: async saved => {
      launches++
      saved.launch = { execId: 'unconfirmed-start' }
      saved.phase = 'start-unconfirmed'
      throw failure
    },
    save: async () => {},
  }), error => error === failure)
  assert.equal(launches, 1)
  assert.equal(state.phase, 'failed')
  assert.equal(state.failureAt, 'start-unconfirmed')
  assert.equal(state.launch.execId, 'unconfirmed-start')
  assert.equal(state.recoveredOriginal, false)
  assert.equal(state.holder.pid, 21)
})

test('cross-format rollback refuses before the candidate can be stopped', () => {
  const state = { dataFormatChanged: true }
  assert.throws(() => requireProductOnlyRollback(state), /请找评审者处理，应用未停止/)
  assert.doesNotThrow(() => requireProductOnlyRollback({ dataFormatChanged: false }))
  assert.deepEqual(state, { dataFormatChanged: true })
})
