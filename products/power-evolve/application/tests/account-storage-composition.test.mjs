/** Account deletion against real isolated PostgreSQL and descriptor-relative POSIX storage. */
import assert from 'node:assert/strict'
import { randomBytes, randomUUID } from 'node:crypto'
import { execFile } from 'node:child_process'
import { mkdir, mkdtemp, readFile, rm, symlink, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { setTimeout as pause } from 'node:timers/promises'
import test from 'node:test'
import { promisify } from 'node:util'
import { Pool } from 'pg'
import { accountCreateRequest, accountTargetMutationRequest, accountChangePasswordRequest } from '../lib/account-contracts.js'
import { bootstrapAccount } from '../lib/platform/account-bootstrap.js'
import { requireActiveAccount } from '../lib/platform/account-authority.js'
import { accountBootstrapConfig, accountManagementConfig } from '../lib/platform/account-config.js'
import { AccountService } from '../lib/platform/accounts.js'
import { initializeDatabase, transaction } from '../lib/platform/database.js'
import { FileService } from '../lib/platform/files.js'
import { IdentityService } from '../lib/platform/identity.js'
import { SafePosix } from '../lib/platform/safe-posix.js'

const privateDir = process.env.PE_ACCOUNT_TEST_PRIVATE_DIR
const pgTest = { skip: !privateDir, timeout: 30000 }
const password = 'admin-storage-fixture-password'
const management = accountManagementConfig.parse({ maxUsers: 40,
  models: [{ id: 'fixture', label: 'Fixture', maxTokens: 256 }], initialSettings: { model: 'fixture', maxTokens: 64 } })

async function fixture(t) {
  const source = new URL((await readFile(join(privateDir, 'database-url'), 'utf8')).trim())
  const database = `pe_account_storage_${randomBytes(10).toString('hex')}`
  const adminUrl = new URL(source); adminUrl.pathname = '/postgres'
  const admin = new Pool({ connectionString: adminUrl.href, max: 1 })
  const root = await mkdtemp(join(tmpdir(), 'pe-account-storage-'))
  let pool, created = false
  t.after(async () => {
    await pool?.end()
    try { if (created) await admin.query(`DROP DATABASE "${database}"`) }
    finally { await admin.end(); await rm(root, { recursive: true, force: true }) }
  })
  await admin.query(`CREATE DATABASE "${database}"`); created = true
  const url = new URL(source); url.pathname = `/${database}`
  pool = new Pool({ connectionString: url.href, max: 8 })
  await initializeDatabase(pool)
  await bootstrapAccount(pool, accountBootstrapConfig.parse({ mode: 'create', userId: randomUUID(),
    username: 'admin', displayName: 'Administrator', password }), management)
  const identities = new IdentityService(pool, 60000)
  const files = new FileService(pool, root)
  await files.init()
  const revoked = []
  const accounts = new AccountService(pool, identities, { platformOrigin: 'https://platform.example.test',
    workspaceRoot: root, management, revokeExecutions: async (_client, userId) => { revoked.push(userId) } })
  const administrator = await accounts.login('admin', password)
  const owner = async () => {
    const username = `fixture-${randomUUID()}`
    const value = await accounts.create(administrator.token, accountCreateRequest.parse({ requestId: randomUUID(),
      username, displayName: 'Storage owner', role: 'USER', settings: management.initialSettings,
      models: [{ id: 'fixture', maxTokens: 128 }] }))
    const login = await accounts.login(username, value.temporaryPassword)
    const ownerPassword = 'storage-owner-fixture-password'
    const changed = await accounts.changePassword(login.token, accountChangePasswordRequest.parse({
      requestId: randomUUID(), currentPassword: value.temporaryPassword, newPassword: ownerPassword }))
    const credential = await identities.login(username, ownerPassword)
    return { userId: value.receipt.account.userId, username, revision: changed.receipt.account.revision, token: credential.token }
  }
  const remove = user => accounts.remove(administrator.token, accountTargetMutationRequest.parse({
    requestId: randomUUID(), userId: user.userId, expectedRevision: user.revision }))
  const retained = async user => {
    assert.deepEqual((await pool.query('SELECT enabled,deleted_at FROM pe_users WHERE id=$1', [user.userId])).rows[0],
      { enabled: true, deleted_at: null })
    assert.equal(revoked.includes(user.userId), false)
  }
  return { pool, root, files, accounts, owner, remove, retained }
}

async function space(f, user, rootKey = randomUUID()) {
  const spaceId = randomUUID()
  await f.pool.query(`INSERT INTO pe_storage_spaces(id,user_id,root_key,title,is_default,root_state)
    VALUES($1,$2,$3,'Storage fixture',false,'ready')`, [spaceId, user.userId, rootKey])
  return { spaceId, rootKey, path: join(f.root, rootKey) }
}

async function boundDefault(f, user, relativePath = '') {
  const workspaceId = await f.files.defaultWorkspaceId(user.userId)
  const storage = await space(f, user)
  await f.pool.query(`INSERT INTO pe_workspace_bindings(workspace_id,user_id,space_id,root_relative_path)
    VALUES($1,$2,$3,$4)`, [workspaceId, user.userId, storage.spaceId, relativePath])
  await f.pool.query("UPDATE pe_workspaces SET binding_state='ready' WHERE id=$1", [workspaceId])
  const path = join(storage.path, relativePath)
  await mkdir(path, { recursive: true })
  return { ...storage, workspaceId, path, relativePath }
}

async function rejectsDeletion(f, user, code = 'account_not_empty') {
  await assert.rejects(f.remove(user), { status: 409, code })
  await f.retained(user)
}

test('descriptor emptiness counts links, special entries and unrelated directories without following them', async t => {
  const root = await mkdtemp(join(tmpdir(), 'pe-storage-empty-'))
  t.after(() => rm(root, { recursive: true, force: true }))
  const safe = new SafePosix(root)
  await safe.init()
  assert.equal(await safe.isEmpty(randomUUID()), true)
  const rootKey = randomUUID(), path = join(root, rootKey)
  await safe.ensureWorkspace(rootKey)
  await mkdir(join(path, 'default', 'tree'), { recursive: true })
  assert.equal(await safe.isEmpty(rootKey, ['default', 'tree']), true)
  assert.equal(await safe.isEmpty(rootKey), false)
  await symlink('/nonexistent-account-storage-fixture', join(path, 'default', 'tree', 'link'))
  assert.equal(await safe.isEmpty(rootKey, ['default', 'tree']), false)
  await rm(join(path, 'default', 'tree', 'link'))
  await promisify(execFile)('mkfifo', [join(path, 'default', 'tree', 'pipe')])
  assert.equal(await safe.isEmpty(rootKey, ['default', 'tree']), false)
  await rm(join(path, 'default', 'tree', 'pipe'))
  await rm(join(path, 'default', 'tree'), { recursive: true })
  await symlink(root, join(path, 'default', 'tree'))
  assert.equal(await safe.isEmpty(rootKey, ['default', 'tree']), false)
  await assert.rejects(safe.isEmpty(rootKey, ['..']), { status: 400, code: 'invalid_path' })
  await assert.rejects(safe.isEmpty('../outside'), { status: 400, code: 'invalid_path' })
  const linkedRoot = randomUUID()
  await symlink(root, join(root, linkedRoot))
  await assert.rejects(safe.isEmpty(linkedRoot), { status: 503, code: 'workspace_unavailable' })
})

test('account deletion inspects every owned storage root independently of Workspace identity', pgTest, async t => {
  const f = await fixture(t)
  await t.test('rebound default files with no legacy Workspace directory prevent deletion', async () => {
    const user = await f.owner(), binding = await boundDefault(f, user, 'restored/tree')
    const marker = join(binding.path, 'marker.txt')
    await writeFile(marker, 'private bytes without a mutation receipt')
    await rejectsDeletion(f, user)
    assert.equal(await readFile(marker, 'utf8'), 'private bytes without a mutation receipt')
  })
  await t.test('unbound personal storage files prevent deletion without any Workspace', async () => {
    const user = await f.owner()
    const personal = (await f.files.bindings.spaces(user)).items.find(value => value.isDefault)
    const row = (await f.pool.query('SELECT root_key FROM pe_storage_spaces WHERE id=$1', [personal.spaceId])).rows[0]
    await writeFile(join(f.root, row.root_key, 'unbound.txt'), 'personal content')
    await rejectsDeletion(f, user)
  })
  await t.test('an empty bound root cannot hide content in another owned root', async () => {
    const user = await f.owner()
    await boundDefault(f, user)
    const extra = await space(f, user)
    await mkdir(extra.path)
    await writeFile(join(extra.path, 'extra.txt'), 'unbound registered root')
    await rejectsDeletion(f, user)
  })
  await t.test('sibling directories outside an empty default binding remain content', async () => {
    const user = await f.owner(), binding = await boundDefault(f, user, 'default/tree')
    await mkdir(join(f.root, binding.rootKey, 'unbound'))
    await rejectsDeletion(f, user)
  })
  await t.test('symbolic links are content even when ordinary file listing omits them', async () => {
    const user = await f.owner(), binding = await boundDefault(f, user, 'default/tree')
    await symlink('/nonexistent-account-storage-fixture', join(binding.path, 'link'))
    await rejectsDeletion(f, user)
  })
  await t.test('an owned root replaced with a link refuses deletion', async () => {
    const user = await f.owner(), binding = await boundDefault(f, user)
    await rm(binding.path, { recursive: true })
    await symlink(f.root, binding.path)
    await rejectsDeletion(f, user)
  })
})

test('generic STDIO configuration and management receipts block account deletion before any Session exists', pgTest, async t => {
  const f = await fixture(t), digest = 'a'.repeat(64)
  for (const kind of ['configuration', 'receipt']) {
    const user = await f.owner()
    assert.equal((await f.pool.query('SELECT count(*)::integer AS n FROM pe_sessions WHERE user_id=$1',
      [user.userId])).rows[0].n, 0)
    if (kind === 'configuration') {
      const id = randomUUID()
      await transaction(f.pool, async client => {
        await client.query('INSERT INTO pe_stdio_v2_connections(id,user_id,revision) VALUES($1,$2,1)', [id,user.userId])
        await client.query(`INSERT INTO pe_stdio_v2_configurations(connection_id,user_id,revision,configuration,config_digest)
          VALUES($1,$2,1,'{"invocation":{"program":"node","argv":["fixture.mjs"],"cwd":"."}}',$3)`,
        [id,user.userId,digest])
      })
    } else {
      await f.pool.query(`INSERT INTO pe_stdio_v2_management_requests(user_id,request_id,purpose,request,request_digest,receipt)
        VALUES($1,$2,'delete','{}',$3,'{}')`, [user.userId,randomUUID(),digest])
    }
    await rejectsDeletion(f, user)
  }
})

test('account deletion permits empty selector metadata and empty default storage scaffolding', pgTest, async t => {
  const f = await fixture(t)
  await t.test('opening the storage selector alone still permits deletion', async () => {
    const user = await f.owner()
    await f.files.bindings.spaces(user)
    assert.ok((await f.remove(user)).receipt.account.deletedAt)
    assert.equal((await f.pool.query('SELECT count(*)::integer AS n FROM pe_storage_spaces WHERE user_id=$1', [user.userId])).rows[0].n, 1)
  })
  await t.test('empty default binding and its ancestor directories permit deletion', async () => {
    const user = await f.owner()
    await boundDefault(f, user, 'default/tree')
    await f.files.bindings.spaces(user)
    assert.ok((await f.remove(user)).receipt.account.deletedAt)
  })
  await t.test('legacy default metadata without a binding still inspects its original physical root', async () => {
    const user = await f.owner(), workspaceId = await f.files.defaultWorkspaceId(user.userId)
    await mkdir(join(f.root, workspaceId))
    await writeFile(join(f.root, workspaceId, 'legacy.txt'), 'legacy bytes')
    await rejectsDeletion(f, user)
    await rm(join(f.root, workspaceId, 'legacy.txt'))
    assert.ok((await f.remove(user)).receipt.account.deletedAt)
  })
  await t.test('initialized legacy default and missing roots remain compatible', async () => {
    const user = await f.owner()
    await f.files.workspaceForUser(user.userId)
    const missing = await space(f, user)
    assert.ok(missing.rootKey)
    assert.ok((await f.remove(user)).receipt.account.deletedAt)
  })
  await t.test('another owner storage does not block empty account deletion or lose bytes', async () => {
    const user = await f.owner(), other = await f.owner(), binding = await boundDefault(f, other)
    await writeFile(join(binding.path, 'other.txt'), 'other private storage')
    await f.files.bindings.spaces(user)
    assert.ok((await f.remove(user)).receipt.account.deletedAt)
    await f.retained(other)
    assert.equal(await readFile(join(binding.path, 'other.txt'), 'utf8'), 'other private storage')
  })
})

test('storage intent, recovery and completed business receipts retain account lifecycle semantics', pgTest, async t => {
  const f = await fixture(t)
  await t.test('an early Office cancellation retains its receipt even without a Session or file', async () => {
    const user = await f.owner()
    await f.pool.query(`INSERT INTO pe_office_preview_jobs(id,user_id,request_id,generation,state,cancel_requested,completed_at)
      VALUES($1,$2,$3,$4,'cancelled',true,now())`, [randomUUID(), user.userId, randomUUID(), 'a'.repeat(64)])
    await rejectsDeletion(f, user)
  })
  await t.test('a completed recovery receipt prevents deletion when storage remains empty', async () => {
    const user = await f.owner(), binding = await boundDefault(f, user)
    await f.files.bindings.restore(user, { requestId: randomUUID(), workspaceId: binding.workspaceId,
      spaceId: binding.spaceId, rootRelativePath: '', expectedGeneration: 1 }, user.token)
    await f.files.bindings.poll(async claim => claim.stopTarget, new AbortController().signal,
      { ownerId: randomUUID(), leaseMs: 3000 })
    assert.equal((await f.pool.query('SELECT state FROM pe_workspace_binding_requests WHERE user_id=$1', [user.userId])).rows[0].state, 'completed')
    await rejectsDeletion(f, user)
  })
  await t.test('accepted mkdir blocks deletion before filesystem creation', async () => {
    const user = await f.owner(), storage = await space(f, user)
    await f.pool.query(`INSERT INTO pe_storage_directory_requests(user_id,request_id,space_id,parent_path,name,state)
      VALUES($1,$2,$3,'','pending','accepted')`, [user.userId, randomUUID(), storage.spaceId])
    await rejectsDeletion(f, user, 'account_execution_active')
  })
  for (const state of ['accepted', 'stopping', 'blocked']) {
    await t.test(`${state} recovery blocks deletion even with no Pod`, async () => {
      const user = await f.owner(), binding = await boundDefault(f, user)
      const receipt = await f.files.bindings.restore(user, { requestId: randomUUID(), workspaceId: binding.workspaceId,
        spaceId: binding.spaceId, rootRelativePath: '', expectedGeneration: 1 }, user.token)
      if (state !== 'accepted') await f.pool.query(`UPDATE pe_workspace_binding_requests SET state=$3,error_code=$4
        WHERE user_id=$1 AND request_id=$2`, [user.userId, receipt.requestId, state,
        state === 'blocked' ? 'workspace_stop_unconfirmed' : null])
      if (state === 'blocked') await f.pool.query("UPDATE pe_workspaces SET binding_state='blocked' WHERE id=$1", [binding.workspaceId])
      await rejectsDeletion(f, user, 'account_execution_active')
    })
  }
  await t.test('a blocked binding still fences deletion when its recovery receipt is absent', async () => {
    const user = await f.owner(), workspaceId = await f.files.defaultWorkspaceId(user.userId)
    await f.pool.query("UPDATE pe_workspaces SET binding_state='blocked' WHERE id=$1", [workspaceId])
    await rejectsDeletion(f, user, 'account_execution_active')
  })
  await t.test('a retained completed mkdir receipt prevents deletion after its empty directory disappears', async () => {
    const user = await f.owner(), storage = await space(f, user)
    await mkdir(storage.path)
    await f.files.bindings.createDirectory(user, { requestId: randomUUID(), spaceId: storage.spaceId, parentPath: '', name: 'completed' }, user.token)
    await rm(join(storage.path, 'completed'), { recursive: true })
    await rejectsDeletion(f, user)
  })
})

test('account deletion waits for an owner-locked storage acceptance and sees its committed intent', pgTest, async t => {
  const f = await fixture(t), user = await f.owner(), storage = await space(f, user)
  const client = await f.pool.connect()
  let removal
  try {
    await client.query('BEGIN')
    await requireActiveAccount(client, user.userId, 'update')
    await client.query(`INSERT INTO pe_storage_directory_requests(user_id,request_id,space_id,parent_path,name,state)
      VALUES($1,$2,$3,'','contending','accepted')`, [user.userId, randomUUID(), storage.spaceId])
    removal = f.remove(user).then(value => ({ value }), error => ({ error }))
    let waiting = false
    for (let attempt = 0; attempt < 100; attempt++) {
      waiting = !!(await f.pool.query("SELECT 1 FROM pg_stat_activity WHERE datname=current_database() AND wait_event_type='Lock'")).rowCount
      if (waiting) break
      await pause(10)
    }
    assert.equal(waiting, true, 'Deletion must wait for the owner update lock')
    await client.query('COMMIT')
    const result = await removal
    assert.equal(result.error?.status, 409)
    assert.equal(result.error?.code, 'account_execution_active')
    await f.retained(user)
  } finally {
    await client.query('ROLLBACK')
    client.release()
    await removal
  }
})
