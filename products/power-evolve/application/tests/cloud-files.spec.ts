/** Real PG, POSIX helper processes and native file DTOs; no provider or file service substitutes. */
import { randomUUID } from 'node:crypto'
import { mkdir, readFile, readdir, rename, rm, stat, symlink, writeFile } from 'node:fs/promises'
import { join } from 'node:path'
import { expect, test } from 'vitest'
import { requestId, workspaceId } from '../src/contracts.ts'
import { NativeWorkspaceRead } from '../src/platform/native-workspace-read.ts'
import { TaskStore } from '../src/platform/tasks.ts'
import { FileDownloadService } from '../src/platform/file-downloads.ts'
import { fileDownloadContentRequest, fileDownloadPrepareRequest } from '@power-evolve/contracts/file-download'
import { cloudFixture } from './cloud-fixture.ts'

const immutableStorageSql = "SELECT jsonb_build_object('workspace',to_jsonb(w)-'binding_state'-'binding_updated_at',"
  + "'binding',to_jsonb(b),'space',to_jsonb(s)-'root_state'-'updated_at') AS value "
  + 'FROM pe_workspaces w JOIN pe_workspace_bindings b ON b.workspace_id=w.id '
  + 'JOIN pe_storage_spaces s ON s.id=b.space_id WHERE w.id=$1'
const storageSnapshotSql = "SELECT jsonb_build_object('workspaces',(SELECT jsonb_agg(to_jsonb(w) ORDER BY w.id) FROM pe_workspaces w),"
  + "'bindings',(SELECT jsonb_agg(to_jsonb(b) ORDER BY b.workspace_id) FROM pe_workspace_bindings b),"
  + "'spaces',(SELECT jsonb_agg(to_jsonb(s) ORDER BY s.id) FROM pe_storage_spaces s)) AS value"

test('workspace creation is durable, retryable and isolated from another account', () => cloudFixture(async ({ pool, files, alice, bob }) => {
  const workspaces = new NativeWorkspaceRead(pool, files, 8, 256)
  const id = requestId.parse(randomUUID())
  const created = await workspaces.create(alice.user, id, 'Reports', alice.token)
  expect(await workspaces.create(alice.user, id, 'Reports', alice.token)).toEqual(created)
  await expect(workspaces.create(alice.user, id, 'Changed', alice.token)).rejects.toMatchObject({ status: 409 })
  expect((await workspaces.list(alice.user)).items).toHaveLength(2)
  expect((await workspaces.list(bob.user)).items).toHaveLength(1)
  await expect(files.workspaceForId(bob.user.userId, created.workspaceId)).rejects.toMatchObject({ status: 404 })
  const path = (await files.workspaceForId(alice.user.userId, created.workspaceId)).path
  await rm(path, { recursive: true })
  await expect(files.workspaceForId(alice.user.userId, created.workspaceId)).rejects.toMatchObject({ status: 503 })
  await expect(readFile(join(path, 'anything'))).rejects.toMatchObject({ code: 'ENOENT' })
}))

test('an upload creates complete bytes and never overwrites a different existing file', () => cloudFixture(async ({ files, alice }) => {
  const id = randomUUID(), data = Buffer.from('original').toString('base64')
  const receipt = await files.put(alice.user, id, 'reports/note.txt', data)
  expect(await files.put(alice.user, id, 'reports/note.txt', data)).toEqual(receipt)
  await expect(files.put(alice.user, id, 'reports/other.txt', data)).rejects.toMatchObject({ status: 409, code: 'request_id_conflict' })
  await expect(files.put(alice.user, randomUUID(), 'reports/note.txt', Buffer.from('replacement').toString('base64')))
    .rejects.toMatchObject({ status: 409, code: 'file_exists' })
  expect(Buffer.from((await files.read(alice.user, 'reports/note.txt')).data, 'base64').toString()).toBe('original')
  const bytes = Buffer.alloc(3 * 1024 * 1024, 65)
  await files.put(alice.user, randomUUID(), 'reports/large.txt', bytes.toString('base64'))
  expect((await files.read(alice.user, 'reports/large.txt')).size).toBe(bytes.length)
}))

test('descriptor reads reject symlinks and upload traversal without exposing another root', () => cloudFixture(async ({ files, root, alice, bob }) => {
  const a = await files.workspaceForUser(alice.user.userId), b = await files.workspaceForUser(bob.user.userId)
  await writeFile(join(b.path, 'secret.txt'), 'private')
  await symlink(join(b.path, 'secret.txt'), join(a.path, 'link.txt'))
  await expect(files.read(alice.user, 'link.txt')).rejects.toMatchObject({ status: 400 })
  await expect(files.put(alice.user, randomUUID(), '../escape', 'eA==')).rejects.toMatchObject({ status: 400 })
  await expect(files.put(alice.user, randomUUID(), 'link.txt', 'eA==')).rejects.toMatchObject({ status: 400 })
  expect(await readFile(join(b.path, 'secret.txt'), 'utf8')).toBe('private')
  await expect(readFile(join(root, 'escape'))).rejects.toMatchObject({ code: 'ENOENT' })
}))

test('one owned Session downloads original bytes while batch and foreign scopes are refused', () => cloudFixture(async ({ pool, files, alice, bob }) => {
  const tasks = new TaskStore(pool, { maxEventBytes: 524_288, leaseMs: 30_000, maxPendingPerUser: 8, maxActivePerUser: 1 })
  const home = await files.workspaceForUser(alice.user.userId)
  const session = await tasks.create(alice.user, requestId.parse(randomUUID()), alice.token, workspaceId.parse(home.id))
  await files.put(alice.user, randomUUID(), 'report.zip', Buffer.from('generated-report-zip').toString('base64'))
  const downloads = new FileDownloadService(pool, files, { maxFiles: 1, maxTotalBytes: 32 * 1024 * 1024,
    maxConcurrentTransfers: 4, maxUserConcurrentTransfers: 2, transferTimeoutMs: 10_000 })
  const request = fileDownloadPrepareRequest.parse({ sessionId: session.sessionId, paths: ['report.zip'] })
  expect(fileDownloadPrepareRequest.safeParse({ ...request, paths: ['report.zip', 'other'] }).success).toBe(false)
  const prepared = await downloads.prepare(alice.user, request, new AbortController().signal)
  expect(prepared.fileName).toBe('report.zip')
  expect(prepared.fileCount).toBe(1)
  const transfer = await downloads.open(alice.user,
    fileDownloadContentRequest.parse({ ...request, revision: prepared.revision }), new AbortController().signal)
  expect(await new Response(transfer.body).text()).toBe('generated-report-zip')
  await expect(downloads.prepare(bob.user, request, new AbortController().signal)).rejects.toMatchObject({ status: 404 })
}))

test.each(['provisioning', 'ready'] as const)('provisioning resumes an existing %s storage binding without replacing imported bytes', rootState => cloudFixture(async ({ pool, root, files, alice }) => {
  const id = randomUUID(), space = randomUUID(), rootKey = randomUUID(), relative = 'imported/reports'
  await pool.query("INSERT INTO pe_workspaces(id,user_id,title,is_default,binding_state,binding_generation) VALUES($1,$2,'Imported',false,'provisioning',7)", [id, alice.user.userId])
  await pool.query('INSERT INTO pe_storage_spaces(id,user_id,root_key,title,root_state) VALUES($1,$2,$3,$4,$5)',
    [space, alice.user.userId, rootKey, 'Existing storage', rootState])
  await pool.query('INSERT INTO pe_workspace_bindings(workspace_id,user_id,space_id,root_relative_path) VALUES($1,$2,$3,$4)',
    [id, alice.user.userId, space, relative])
  const directory = join(root, rootKey, relative), file = join(directory, 'retained.txt')
  await mkdir(directory, { recursive: true, mode: 0o700 })
  await writeFile(file, 'original imported bytes', { mode: 0o600 })
  const identity = await stat(file), entries = await readdir(root)
  const immutable = await pool.query<{ value: unknown }>(immutableStorageSql, [id])
  const storageBefore = await pool.query<{ value: unknown }>('SELECT to_jsonb(s) AS value FROM pe_storage_spaces s WHERE id=$1', [space])
  expect(await files.storage.resolve(alice.user.userId, id)).toEqual({ workspaceId: id, spaceId: space,
    rootKey, rootRelativePath: relative, generation: 7 })
  expect((await pool.query<{ value: unknown }>(immutableStorageSql, [id])).rows).toEqual(immutable.rows)
  expect((await pool.query<{ binding_state: string; root_state: string }>(
    'SELECT w.binding_state,s.root_state FROM pe_workspaces w JOIN pe_workspace_bindings b ON b.workspace_id=w.id '
      + 'JOIN pe_storage_spaces s ON s.id=b.space_id WHERE w.id=$1', [id])).rows)
    .toEqual([{ binding_state: 'ready', root_state: 'ready' }])
  if (rootState === 'ready') {
    expect((await pool.query<{ value: unknown }>('SELECT to_jsonb(s) AS value FROM pe_storage_spaces s WHERE id=$1', [space])).rows)
      .toEqual(storageBefore.rows)
  }
  expect(await readdir(root)).toEqual(entries)
  expect(await readFile(file, 'utf8')).toBe('original imported bytes')
  expect(await stat(file)).toMatchObject({ dev: identity.dev, ino: identity.ino,
    mode: identity.mode, uid: identity.uid, gid: identity.gid })
}))

test.each(['provisioning', 'missing'] as const)('a ready workspace refuses %s storage without changing PG or retained bytes', unavailable => cloudFixture(async ({ pool, root, files, alice }) => {
  const id = randomUUID(), space = randomUUID(), rootKey = randomUUID(), relative = 'imported/reports'
  await pool.query("INSERT INTO pe_workspaces(id,user_id,title,is_default,binding_state) VALUES($1,$2,'Imported',false,'ready')", [id, alice.user.userId])
  await pool.query('INSERT INTO pe_storage_spaces(id,user_id,root_key,title,root_state) VALUES($1,$2,$3,$4,$5)',
    [space, alice.user.userId, rootKey, 'Existing storage', unavailable === 'provisioning' ? 'provisioning' : 'ready'])
  await pool.query('INSERT INTO pe_workspace_bindings(workspace_id,user_id,space_id,root_relative_path) VALUES($1,$2,$3,$4)',
    [id, alice.user.userId, space, relative])
  const directory = join(root, rootKey, relative), retained = join(root, rootKey, 'retained')
  await mkdir(directory, { recursive: true, mode: 0o700 })
  await writeFile(join(directory, 'retained.txt'), 'original imported bytes', { mode: 0o600 })
  await writeFile(join(root, rootKey, 'outside.txt'), 'unrelated root bytes', { mode: 0o600 })
  if (unavailable === 'missing') await rename(directory, retained)
  const preserved = unavailable === 'missing' ? retained : directory
  const identity = await stat(join(preserved, 'retained.txt')), entries = await readdir(root)
  const snapshot = await pool.query<{ value: unknown }>(storageSnapshotSql)
  await expect(files.storage.resolve(alice.user.userId, id)).rejects.toMatchObject({ status: 503, code: 'workspace_unavailable' })
  expect((await pool.query<{ value: unknown }>(storageSnapshotSql)).rows).toEqual(snapshot.rows)
  expect(await readdir(root)).toEqual(entries)
  if (unavailable === 'missing') await expect(stat(directory)).rejects.toMatchObject({ code: 'ENOENT' })
  expect(await readFile(join(preserved, 'retained.txt'), 'utf8')).toBe('original imported bytes')
  expect(await readFile(join(root, rootKey, 'outside.txt'), 'utf8')).toBe('unrelated root bytes')
  expect(await stat(join(preserved, 'retained.txt'))).toMatchObject({ dev: identity.dev, ino: identity.ino,
    mode: identity.mode, uid: identity.uid, gid: identity.gid })
}))
