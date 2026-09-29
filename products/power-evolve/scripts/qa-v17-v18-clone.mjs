/** Verify a restored V17 snapshot migrates to V18 without touching its source. */
import assert from 'node:assert/strict'
import { createHash } from 'node:crypto'
import { createRequire } from 'node:module'
import { readFile } from 'node:fs/promises'
import { initializeDatabase } from '../application/src/platform/database.ts'

const { Client, Pool } = createRequire(new URL('../application/package.json', import.meta.url))('pg')
const sourceFile = process.env.PE_V17_SOURCE_URL_FILE
const cloneBaseFile = process.env.PE_V18_CLONE_URL_FILE
const cloneName = process.env.PE_V18_CLONE_DATABASE
if (!sourceFile || !cloneBaseFile || !/^pe_s6_v17_clone_[a-z0-9]+$/u.test(cloneName ?? '')) {
  throw new Error('Set PE_V17_SOURCE_URL_FILE, PE_V18_CLONE_URL_FILE and PE_V18_CLONE_DATABASE')
}
const sourceUrl = new URL((await readFile(sourceFile, 'utf8')).trim())
const cloneUrl = new URL((await readFile(cloneBaseFile, 'utf8')).trim())
cloneUrl.pathname = `/${cloneName}`
assert.notEqual(`${sourceUrl.hostname}:${sourceUrl.port}/${sourceUrl.pathname}`,
  `${cloneUrl.hostname}:${cloneUrl.port}/${cloneUrl.pathname}`)
const source = new Client({ connectionString: sourceUrl.href })
const clone = new Pool({ connectionString: cloneUrl.href, max: 4 })
const tables = ['pe_users', 'pe_sessions', 'pe_operations', 'pe_ssh_connections',
  'pe_ssh_calls', 'pe_stdio_mcp_connections', 'pe_stdio_mcp_calls']
async function version(db) {
  const result = await db.query('SELECT version FROM pe_schema')
  assert.equal(result.rows.length, 1)
  return result.rows[0].version
}
async function snapshot(db) {
  const result = new Map()
  for (const table of tables) {
    const rows = await db.query(`SELECT to_jsonb(t) - 'source_ssh_execute_action_id'
      - 'ssh_selection' AS record
      FROM ${table} t ORDER BY id`)
    const contents = JSON.stringify(rows.rows.map(row => row.record))
    result.set(table, { count: rows.rows.length,
      sha256: createHash('sha256').update(contents).digest('hex') })
  }
  return result
}
try {
  await source.connect()
  await source.query('SET default_transaction_read_only = on')
  assert.equal(await version(source), 17)
  assert.equal(await version(clone), 17)
  const sourceBefore = await snapshot(source)
  const cloneBefore = await snapshot(clone)
  assert.deepEqual(cloneBefore, sourceBefore)
  assert.equal((await source.query("SELECT to_regclass('public.pe_ssh_execute_actions') AS name")).rows[0].name, null)
  await initializeDatabase(clone)
  assert.equal(await version(clone), 18)
  assert.deepEqual(await snapshot(clone), sourceBefore)
  assert.ok((await clone.query("SELECT to_regclass('public.pe_ssh_execute_actions') AS name")).rows[0].name)
  assert.equal(await version(source), 17)
  assert.deepEqual(await snapshot(source), sourceBefore)
  assert.equal((await source.query("SELECT to_regclass('public.pe_ssh_execute_actions') AS name")).rows[0].name, null)
  for (const [table, value] of sourceBefore) console.log(`${table}: ${value.count} rows readable and unchanged`)
  console.log('V17 source stayed V17; isolated clone migrated to V18 with all preexisting row fields stable')
} finally {
  await source.end()
  await clone.end()
}
