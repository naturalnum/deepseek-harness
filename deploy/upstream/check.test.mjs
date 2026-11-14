import assert from 'node:assert/strict'
import { execFileSync, spawnSync } from 'node:child_process'
import { mkdtempSync, mkdirSync, renameSync, rmSync, unlinkSync, writeFileSync } from 'node:fs'
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
  const ledger = paths => write('deploy/upstream/ledger.tsv', '路径\t类别\t原因\t撤销条件\n'
    + paths.map(path => `${path}\t扩展点\t原有登记\t上游提供等价能力`).join('\n') + '\n')
  const run = (...args) => spawnSync(process.execPath, [check, ...args], { cwd: root, encoding: 'utf8' })
  return { base, ledger, run }
}

test('matches modified, deleted and renamed source while excluding own, new, test, document and config paths', () => {
  const f = fixture()
  f.ledger(['src/main.ts', 'src/remove.ts', 'src/renamed.ts'])
  const actual = f.run(f.base)
  assert.equal(actual.status, 0, actual.stderr)
  assert.match(actual.stdout, /3 changed source files; 3 ledger rows; matched/u)
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
