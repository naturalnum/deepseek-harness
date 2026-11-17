import assert from 'node:assert/strict'
import { execFileSync, spawnSync } from 'node:child_process'
import { mkdtempSync, mkdirSync, readFileSync, renameSync, rmSync, unlinkSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { dirname, join } from 'node:path'
import { fileURLToPath } from 'node:url'
import { afterEach, test } from 'node:test'

const check = fileURLToPath(new URL('./check.mjs', import.meta.url))
const roots = []
afterEach(() => { for (const root of roots.splice(0)) rmSync(root, { recursive: true }) })

function fixture() {
  const root = mkdtempSync(join(tmpdir(), 'pe-upstream-check-'))
  roots.push(root)
  const write = (path, text) => {
    mkdirSync(dirname(join(root, path)), { recursive: true })
    writeFileSync(join(root, path), text)
  }
  const git = (...args) => execFileSync('git', args, { cwd: root, encoding: 'utf8' }).trim()
  git('init', '-q')
  for (const path of ['src/main.ts', 'src/remove.ts', 'src/rename.ts', 'src/case.spec.ts',
    'docs/example.ts', 'src/__snapshots__/value.ts', 'tsconfig.build.ts',
    'packages/cloud/example/src/index.ts']) write(path, path + '\n')
  git('add', '.')
  git('-c', 'user.name=Fixture', '-c', 'user.email=fixture@example.test', 'commit', '-qm', 'fixture base')
  const base = git('rev-parse', 'HEAD')
  for (const path of ['src/main.ts', 'src/case.spec.ts', 'docs/example.ts', 'src/__snapshots__/value.ts',
    'tsconfig.build.ts', 'packages/cloud/example/src/index.ts']) write(path, 'changed\n')
  unlinkSync(join(root, 'src/remove.ts'))
  renameSync(join(root, 'src/rename.ts'), join(root, 'src/renamed.ts'))
  git('add', '--', 'src/rename.ts', 'src/renamed.ts')
  write('src/new.ts', 'new\n')
  git('add', '--', 'src/new.ts')
  const ledger = (paths, includeAdded = true) => write('deploy/upstream/ledger.tsv', '路径\t类别\t原因\t撤销条件\n'
    + [...paths, ...includeAdded ? ['src/new.ts'] : []].map(path => `${path}\t扩展点\t原有登记\t上游提供等价能力`).join('\n') + '\n')
  const run = (...args) => spawnSync(process.execPath, [check, ...args], { cwd: root, encoding: 'utf8' })
  return { root, base, ledger, run, write }
}

test('matches modified, deleted and renamed source while tracking additions separately from modified, deleted and renamed paths', () => {
  const f = fixture()
  f.ledger(['src/main.ts', 'src/remove.ts', 'src/renamed.ts'])
  const actual = f.run(f.base)
  assert.equal(actual.status, 0, actual.stderr)
  assert.match(actual.stdout, /3 changed source files; 4 ledger rows; matched/u)
})

test('lists both an unlisted upstream change and a stale ledger path', () => {
  const f = fixture()
  f.ledger(['src/remove.ts', 'src/renamed.ts', 'src/stale.ts'])
  const actual = f.run(f.base)
  assert.equal(actual.status, 1)
  assert.match(actual.stderr, /Unlisted upstream source:\nsrc\/main\.ts/u)
  assert.match(actual.stderr, /Ledger paths without upstream changes:\nsrc\/stale\.ts/u)
})

test('rejects duplicate ledger rows instead of hiding them in a set', () => {
  const f = fixture()
  f.ledger(['src/main.ts', 'src/main.ts', 'src/remove.ts', 'src/renamed.ts'])
  const actual = f.run(f.base)
  assert.equal(actual.status, 2)
  assert.match(actual.stderr, /Duplicate ledger path: src\/main\.ts/u)
})

test('requires the upstream base from the command line', () => {
  const f = fixture()
  const actual = f.run()
  assert.equal(actual.status, 2)
  assert.match(actual.stderr, /Usage: deploy\/upstream\/check <upstream-base>/u)
})

test('requires current generated interface tables for six-column ledgers', () => {
  const f = fixture()
  f.ledger(['src/main.ts', 'src/remove.ts', 'src/renamed.ts'])
  const ledgerPath = join(f.root, 'deploy/upstream/ledger.tsv')
  const lines = readFileSync(ledgerPath, 'utf8').trimEnd().split('\n')
  writeFileSync(ledgerPath, lines[0] + '\t处置\t这一程的状态\n'
    + lines.slice(1).map(line => line + '\t留作口子\t没动').join('\n') + '\n')
  assert.equal(f.run(f.base).status, 1)
  const inventory = fileURLToPath(new URL('./seams_inventory.py', import.meta.url))
  const generated = spawnSync('python3', [inventory, f.base, '--repo', f.root, '--write'], { encoding: 'utf8' })
  assert.equal(generated.status, 0, generated.stderr)
  assert.equal(f.run(f.base).status, 0)
  f.write('packages/cloud/example/src/index.ts', "import { Service } from '@deepseek-ai/cordis'\n")
  const stale = f.run(f.base)
  assert.equal(stale.status, 1)
  assert.match(stale.stderr, /Interface inventory drift/u)
  f.write('packages/cloud/example/src/index.ts', "import { symbols } from '@deepseek-ai/cordis'\nexport const read = (value: object) => Reflect.get(value, symbols.original)\n")
  const refresh = () => spawnSync('python3', [inventory, f.base, '--repo', f.root, '--write'], { encoding: 'utf8' })
  assert.equal(refresh().status, 0)
  const scattered = f.run(f.base)
  assert.equal(scattered.status, 1)
  assert.match(scattered.stderr, /Native internal reads remain outside the declared central files/u)
  f.write('packages/cloud/example/src/index.ts', 'export const phase = (entry: { fiberPhase: string }) => entry.fiberPhase\n')
  assert.equal(refresh().status, 0)
  assert.equal(f.run(f.base).status, 0, 'a public JSON fiberPhase field is not a Native fiber read')
})

test('refuses a missing addition without changing the historical modified-source count', () => {
  const f = fixture()
  const old = ['src/main.ts', 'src/remove.ts', 'src/renamed.ts']
  f.ledger(old, false)
  const missing = f.run(f.base)
  assert.equal(missing.status, 1)
  assert.match(missing.stderr, /Unlisted added Native source:\nsrc\/new\.ts/u)
  f.ledger(old)
  const repaired = f.run(f.base)
  assert.equal(repaired.status, 0, repaired.stderr)
  assert.match(repaired.stdout, /3 changed source files; 4 ledger rows; matched/u)
  assert.match(repaired.stdout, /Added Native source paths \(excluded from historical counts\): 1; all listed/u)
})
