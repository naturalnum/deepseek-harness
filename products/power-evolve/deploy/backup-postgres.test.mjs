import test from 'node:test'
import assert from 'node:assert/strict'
import { randomBytes } from 'node:crypto'
import { readFile } from 'node:fs/promises'
import { createRequire } from 'node:module'
import { requireEmptyBackupDatabase } from '../scripts/backup-support.mjs'

const { Client } = createRequire(new URL('../application/package.json', import.meta.url))('pg')
const configuration = process.env.PE_DEPLOYMENT_BACKUP_ADMIN_URL_FILE

test('a non-superuser restore owner can prove a fresh database empty and rejects later objects',
  { skip: !configuration && 'Set PE_DEPLOYMENT_BACKUP_ADMIN_URL_FILE for an owned temporary database', timeout: 20000 }, async t => {
    const url = (await readFile(configuration, 'utf8')).trim(), suffix = randomBytes(6).toString('hex')
    const role = `pe_backup_role_${suffix}`, database = `pe_backup_db_${suffix}`
    const password = randomBytes(32).toString('hex')
    const admin = new Client({ connectionString: url, connectionTimeoutMillis: 5000, statement_timeout: 5000, query_timeout: 6000 })
    let roleCreated = false, databaseCreated = false, owner
    await admin.connect()
    t.after(async () => {
      try {
        await owner?.end()
        if (databaseCreated) await admin.query(`DROP DATABASE "${database}"`)
        if (roleCreated) await admin.query(`DROP ROLE "${role}"`)
      } finally { await admin.end() }
    })
    await admin.query(`CREATE ROLE "${role}" LOGIN PASSWORD '${password}'`); roleCreated = true
    await admin.query(`CREATE DATABASE "${database}" OWNER "${role}"`); databaseCreated = true
    const target = new URL(url); target.username = role; target.password = password; target.pathname = '/' + database
    owner = new Client({ connectionString: target.href, connectionTimeoutMillis: 5000, query_timeout: 5000 })
    await owner.connect()
    const { rows: [privileges] } = await owner.query(`SELECT
      (SELECT rolsuper FROM pg_roles WHERE rolname=current_user) AS superuser,
      has_table_privilege(current_user,'pg_catalog.pg_user_mapping','SELECT') AS rawCatalogReadable`)
    assert.equal(privileges.superuser, false)
    assert.equal(privileges.rawcatalogreadable, false)
    await requireEmptyBackupDatabase(Client, target.href)
    await owner.query('CREATE TABLE occupied(id integer PRIMARY KEY)')
    await assert.rejects(requireEmptyBackupDatabase(Client, target.href), { message: 'Restore database is not empty' })
  })
