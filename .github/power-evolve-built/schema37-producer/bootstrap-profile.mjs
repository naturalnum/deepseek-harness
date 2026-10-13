/** Initialize the fixed original Schema37 and two fixture accounts; no model or production service starts. */
import assert from 'node:assert/strict'
import { randomUUID } from 'node:crypto'
import { chown, readFile, writeFile } from 'node:fs/promises'
import { createRequire } from 'node:module'
import { pathToFileURL } from 'node:url'

export const name = 'ci-schema37-bootstrap'

/** Create the original fixture database state under its already-owned ordinary database role.
 * @param ctx Current official launcher exit and readiness services.
 * @param config Current-job protected input filename.
 */
export async function apply(ctx, config) {
  try {
    const p = JSON.parse(await readFile(config.parameterFile, 'utf8'))
    const inputsLock = JSON.parse(await readFile(new URL('./runtime-inputs.lock.json', import.meta.url), 'utf8'))
    assert.match(inputsLock.sourceCommit, /^[a-f0-9]{40}$/u)
    assert.equal(p.sourceCommit, inputsLock.sourceCommit)
    assert.equal(p.sourceRoot, '/opt/pe-ci-original')
    const load = file => import(pathToFileURL(p.sourceRoot + '/products/power-evolve/application/src/platform/' + file).href)
    const [{ initializeDatabase }, { seedNewUser }, { hashPassword }, { FileService }] = await Promise.all([
      load('database.ts'), load('account-settings.ts'), load('identity.ts'), load('files.ts'),
    ])
    const { Pool } = createRequire('/opt/power-evolve/products/power-evolve/application/package.json')('pg')
    const pool = new Pool({ connectionString: p.sourceUrl, max: 1 })
    try {
      assert.deepEqual((await pool.query('SELECT rolsuper,rolcreatedb,rolcreaterole,rolreplication,rolbypassrls FROM pg_roles WHERE rolname=current_user')).rows,
        [{ rolsuper: false, rolcreatedb: false, rolcreaterole: false, rolreplication: false, rolbypassrls: false }])
      await initializeDatabase(pool)
      assert.deepEqual((await pool.query('SELECT version FROM pe_schema')).rows, [{ version: 37 }])
      const files = new FileService(pool, p.dataRoot + '/workspaces', { uid: 1000, gid: 1000 })
      await files.init()
      const actors = {}
      for (const kind of ['stdio', 'resolution']) {
        const username = 'ci-' + kind + '-' + randomUUID()
        await seedNewUser(pool, username, await hashPassword(p.password), { model: 'compatibility-fixture-no-model', maxTokens: 64, revision: 1 })
        const userId = (await pool.query('SELECT id FROM pe_users WHERE username=$1', [username])).rows[0].id
        const workspaceId = await files.defaultWorkspaceId(userId)
        actors[kind] = { userId, workspaceId, username }
      }
      await writeFile(p.actorFile, JSON.stringify(actors) + '\n', { flag: 'wx', mode: 0o600 })
      await chown(p.actorFile, p.hostUid, p.hostGid)
    } finally { await pool.end() }
  } catch (error) { ctx.appExit(1); throw error }
  ctx.effect(() => ctx.appReady.onReady(() => ctx.appExit(0)))
}
