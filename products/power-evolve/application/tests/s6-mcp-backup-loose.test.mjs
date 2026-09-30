/** Reject loose members added to an existing builtin family, using one owned temporary database. */
import test from 'node:test'
import assert from 'node:assert/strict'
import { createHash, randomBytes } from 'node:crypto'
import { execFile } from 'node:child_process'
import { promisify } from 'node:util'
import { mkdtemp, mkdir, readFile, readdir, rm, writeFile } from 'node:fs/promises'
import { homedir } from 'node:os'
import { join } from 'node:path'
import { fileURLToPath } from 'node:url'
import { Client, Pool } from 'pg'
import { backupDatabaseIdentity, requireEmptyBackupDatabase } from '../../scripts/backup-support.mjs'

const execute = promisify(execFile)
const root = fileURLToPath(new URL('../../../../', import.meta.url))

test('external restore rejects loose builtin operator family members before copying',
  { timeout: 30000, skip: process.platform === 'win32' && 'Trial backup requires POSIX permissions' }, async t => {
    const databaseUrl = (await readFile(join(process.env.PE_PRIVATE_DIR
      ?? join(homedir(), '.config/power-evolve/shared-host-s6-mcp-dev'), 'database-url'), 'utf8')).trim()
    const sourceDatabase = await backupDatabaseIdentity(Client, databaseUrl)
    const directory = await mkdtemp(join(homedir(), '.config/power-evolve/s6-mcp-backup-loose-'))
    const suffix = randomBytes(6).toString('hex'), database = `pe_mcp_backup_${suffix}_loose`
    const trial = `s6backup-${suffix}-loose`, admin = new Pool({ connectionString: databaseUrl, max: 1 })
    let target, created = false
    t.after(async () => {
      try {
        await target?.end()
        if (created) await admin.query(`DROP DATABASE "${database}"`)
      } finally {
        await admin.end()
        await rm(directory, { recursive: true, force: true })
        await rm(join(root, '.artifacts/power-evolve', trial), { recursive: true, force: true })
      }
    })
    await admin.query(`CREATE DATABASE "${database}"`); created = true
    const url = new URL(databaseUrl); url.pathname = `/${database}`
    target = new Pool({ connectionString: url.href, max: 1 })
    await requireEmptyBackupDatabase(Client, url.href)
    const { rows: [family] } = await target.query(`SELECT f.oid FROM pg_opfamily f JOIN pg_am a ON a.oid=f.opfmethod
      WHERE f.opfname='integer_ops' AND f.opfnamespace='pg_catalog'::regnamespace AND a.amname='btree'`)
    assert(Number(family.oid) < 16384)
    const bundle = join(directory, 'bundle'), sourceRoot = join(directory, 'source')
    await mkdir(join(bundle, 'config'), { recursive: true, mode: 0o700 }); await mkdir(sourceRoot, { mode: 0o700 })
    // This integrity-valid fixture exercises only preflight. The sentinel dump must never be opened by pg_restore.
    const contents = { 'config/connector-key': 'fixture-connector', 'config/model-key': 'fixture-model',
      'config/model.env': 'DEEPSEEK_API_KEY=fixture-model\n', 'config/users.json': '[]',
      'config/worker-token': 'fixture-worker', 'database.dump': 'unused preflight dump sentinel' }
    const files = []
    for (const [path, text] of Object.entries(contents)) {
      const bytes = Buffer.from(text)
      await writeFile(join(bundle, path), bytes, { mode: 0o600 })
      files.push({ path, kind: 'file', size: bytes.length, sha256: createHash('sha256').update(bytes).digest('hex'), mode: 0o600 })
    }
    await writeFile(join(bundle, 'manifest.json'), JSON.stringify({ format: 1, schema: 23,
      sourceTrial: 'loose-preflight-source', sourceSharedRoot: sourceRoot, sourceDatabase,
      configFiles: ['connector-key', 'model-key', 'model.env', 'users.json', 'worker-token'], files }), { mode: 0o600 })
    const cases = [
      { name: 'function', catalog: 'pg_amproc', familyColumn: 'amprocfamily',
        add: 'ADD FUNCTION 1 (boolean,boolean) pg_catalog.btboolcmp(boolean,boolean)', drop: 'DROP FUNCTION 1 (boolean,boolean)' },
      { name: 'operator', catalog: 'pg_amop', familyColumn: 'amopfamily',
        add: 'ADD OPERATOR 1 pg_catalog.< (boolean,boolean)', drop: 'DROP OPERATOR 1 (boolean,boolean)' },
    ]
    for (const fixture of cases) await t.test(`loose ${fixture.name} alone blocks the real restore CLI before copy`, async () => {
      await requireEmptyBackupDatabase(Client, url.href)
      const inspect = `SELECT * FROM ${fixture.catalog} WHERE ${fixture.familyColumn}=$1 AND oid>=16384 ORDER BY oid`
      assert.deepEqual((await target.query(inspect, [family.oid])).rows, [])
      await target.query(`ALTER OPERATOR FAMILY pg_catalog.integer_ops USING btree ${fixture.add}`)
      try {
        const before = (await target.query(inspect, [family.oid])).rows
        assert.equal(before.length, 1)
        const { rows: [other] } = await target.query(`SELECT
          (SELECT count(*) FROM pg_opfamily WHERE oid>=16384) AS families,
          (SELECT count(*) FROM pg_type WHERE oid>=16384) AS types,
          (SELECT count(*) FROM pg_proc WHERE oid>=16384) AS functions,
          (SELECT count(*) FROM pg_operator WHERE oid>=16384) AS operators,
          (SELECT count(*) FROM pg_class WHERE oid>=16384) AS relations`)
        assert.deepEqual(other, { families: '0', types: '0', functions: '0', operators: '0', relations: '0' })
        const privateDir = join(directory, fixture.name)
        await mkdir(privateDir, { mode: 0o700 }); await writeFile(join(privateDir, 'database-url'), url.href, { mode: 0o600 })
        await assert.rejects(execute(process.execPath, [join(root, 'products/power-evolve/scripts/backup-trial.mjs'), 'restore'],
          { cwd: root, env: { ...process.env, PE_TRIAL_DATABASE: 'external', PE_BACKUP_KEEP_STOPPED: '1',
            PE_TRIAL_NAME: trial, PE_PRIVATE_DIR: privateDir, PE_BACKUP_BUNDLE: bundle,
            PE_WORKSPACE_ROOT: join(privateDir, 'workspaces'), PE_ARTIFACT_ROOT: join(privateDir, 'artifacts'),
            PE_SKILL_LIBRARY_ROOT: join(privateDir, 'skill-library') }, timeout: 10000 }), error => {
          assert.match(error.stderr, /Restore database is not empty/u)
          assert.equal(error.stderr.includes(databaseUrl), false)
          return true
        })
        assert.deepEqual(await readdir(privateDir), ['database-url'])
        assert.equal(await readFile(join(privateDir, 'database-url'), 'utf8'), url.href)
        assert.deepEqual((await target.query(inspect, [family.oid])).rows, before)
      } finally { await target.query(`ALTER OPERATOR FAMILY pg_catalog.integer_ops USING btree ${fixture.drop}`) }
      await requireEmptyBackupDatabase(Client, url.href)
      assert.deepEqual((await target.query(inspect, [family.oid])).rows, [])
    })
  })
