import assert from 'node:assert/strict'
import { createRequire } from 'node:module'
import { mkdtempSync, mkdirSync, readFileSync, realpathSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { dirname, join } from 'node:path'
import { test } from 'node:test'

const { compareDataFormats } = createRequire(import.meta.url)('./data-format.cjs')
const emptyPlan = { changed: [], added: [], removed: [] }
const expected = { session: 4, storageSqlite: 1, sessionQuerySqlite: 8, airalogyRecord: 1 }

function fixture(t) {
  const directory = realpathSync(mkdtempSync(join(tmpdir(), 'pe-data-format-')))
  t.after(() => rmSync(directory, { recursive: true, force: true }))
  const current = join(directory, 'current'), next = join(directory, 'next')
  function put(root, relative, content) {
    const filename = join(root, relative)
    mkdirSync(dirname(filename), { recursive: true })
    writeFileSync(filename, typeof content === 'string' ? content : JSON.stringify(content))
    return filename
  }
  for (const root of [current, next]) {
    put(root, 'packages/core/session/package.json', { exports: { './types': { default: './lib/types/types.js' } } })
    put(root, 'packages/core/session/lib/types/types.js', 'export const SESSION_FORMAT_VERSION = 4;')
    put(root, 'packages/storage/storage-sqlite/package.json', { exports: { '.': { default: './lib/index.js' } } })
    put(root, 'packages/storage/storage-sqlite/lib/index.js', 'const STORAGE_SQLITE_SCHEMA_VERSION = 1;')
    put(root, 'packages/session-query/session-query-sqlite/package.json', { exports: { '.': { default: './lib/index.js' } } })
    put(root, 'packages/session-query/session-query-sqlite/lib/index.js', 'const SESSION_QUERY_SQLITE_SCHEMA_VERSION = 8;')
    put(root, 'integrations/epri-research/src/reused/aira/index.ts', 'export const AIRALOGY_RECORD_SCHEMA_VERSION = 1')
  }
  return { current, next, put }
}

test('unchanged formats follow the actual package export paths and require no data restoration', t => {
  const { current, next } = fixture(t)
  assert.deepEqual(compareDataFormats(current, next, emptyPlan), {
    before: expected, after: expected, migrationFiles: [], migrationChanged: false, changed: false,
  })
})

test('each existing session, SQLite or research record version change requires restoration', t => {
  const { current, next, put } = fixture(t)
  for (const [field, relative, symbol, version] of [
    ['session', 'packages/core/session/lib/types/types.js', 'SESSION_FORMAT_VERSION', 4],
    ['storageSqlite', 'packages/storage/storage-sqlite/lib/index.js', 'STORAGE_SQLITE_SCHEMA_VERSION', 1],
    ['sessionQuerySqlite', 'packages/session-query/session-query-sqlite/lib/index.js', 'SESSION_QUERY_SQLITE_SCHEMA_VERSION', 8],
    ['airalogyRecord', 'integrations/epri-research/src/reused/aira/index.ts', 'AIRALOGY_RECORD_SCHEMA_VERSION', 1],
  ]) {
    const original = readFileSync(join(next, relative), 'utf8')
    put(next, relative, `export const ${symbol} = ${version + 1};`)
    const result = compareDataFormats(current, next, emptyPlan)
    assert.equal(result.changed, true)
    assert.equal(result.before[field], version)
    assert.equal(result.after[field], version + 1)
    put(next, relative, original)
  }
})

test('compiled migrations under lib/types or lib are detected across changed, added and removed files', t => {
  const { current, next } = fixture(t)
  const changed = 'packages/cloud/pe-cloud-runtime/lib/types/migrations/account-owners.js'
  const added = 'packages/cloud/pe-opensandbox/lib/migrations/allocations.js'
  const removed = 'packages/cloud/pe-cloud-runtime/lib/types/migrations/old.js'
  const result = compareDataFormats(current, next, {
    changed: [changed, 'packages/cloud/pe-cloud-runtime/lib/types/migrations/account-owners.js.map'],
    added: [added], removed: [removed],
  })
  assert.equal(result.changed, true)
  assert.equal(result.migrationChanged, true)
  assert.deepEqual(result.migrationFiles, [changed, added, removed].sort())
})

test('missing declarations or unusable package exports refuse comparison instead of assuming compatibility', t => {
  const { current, next, put } = fixture(t)
  put(next, 'integrations/epri-research/src/reused/aira/index.ts', 'export const renamed = 1')
  assert.throws(() => compareDataFormats(current, next, emptyPlan), /declaration is missing/)
  put(next, 'integrations/epri-research/src/reused/aira/index.ts', 'export const AIRALOGY_RECORD_SCHEMA_VERSION = 1')
  put(next, 'packages/core/session/package.json', { exports: { './types': { default: '../outside.js' } } })
  assert.throws(() => compareDataFormats(current, next, emptyPlan), /package export is unavailable/)
})
