/** Real POSIX intermediate-directory replacement and helper-failure checks. */
import test from 'node:test'
import assert from 'node:assert/strict'
import { createHash, randomUUID } from 'node:crypto'
import { chmod, mkdir, mkdtemp, readFile, rename, rm, symlink, unlink, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { setTimeout as delay } from 'node:timers/promises'
import { SafePosix } from '../lib/platform/safe-posix.js'

const digest = data => createHash('sha256').update(data).digest('hex')
const status = (number, code) => ({ status: number, code })

async function fixture(t) {
  const base = await mkdtemp(join(tmpdir(), 'pe-safe-posix-'))
  t.after(() => rm(base, { recursive: true, force: true }))
  const root = join(base, 'workspaces'), outside = join(base, 'outside')
  await mkdir(root)
  await mkdir(outside)
  const safe = new SafePosix(root)
  await safe.init()
  const workspaceId = randomUUID()
  await safe.ensureWorkspace(workspaceId)
  return { base, root, outside, safe, workspaceId, workspace: join(root, workspaceId) }
}

test('descriptor-relative read, list, kind and put reject an intermediate symlink',
  { timeout: 30000 }, async t => {
    const { safe, outside, workspace, workspaceId } = await fixture(t)
    const secret = Buffer.from('outside secret')
    await writeFile(join(outside, 'secret.txt'), secret)
    await symlink(outside, join(workspace, 'link'))
    for (const operation of [
      () => safe.read(workspaceId, ['link', 'secret.txt']),
      () => safe.list(workspaceId, ['link']),
      () => safe.kind(workspaceId, ['link', 'secret.txt']),
      () => safe.put(workspaceId, ['link', 'secret.txt'], Buffer.from('changed').toString('base64'),
        digest('changed'), digest(secret), false),
    ]) await assert.rejects(operation(), status(400, 'invalid_path'))
    // FileService publication reads now require binding/account transactions;
    // their real-PG coverage lives in s2-storage-bindings.test.mjs.
    assert.deepEqual(await readFile(join(outside, 'secret.txt')), secret)
    const listed = await safe.list(workspaceId, [])
    assert.equal(listed.items.some(item => item.name === 'link'), false)
  })

test('rapid real-directory to symlink replacement never reads bytes outside the workspace',
  { timeout: 60000 }, async t => {
    const { safe, outside, workspace, workspaceId } = await fixture(t)
    const live = join(workspace, 'nested'), parked = join(workspace, 'parked')
    await mkdir(live)
    await writeFile(join(live, 'note.txt'), 'inside')
    await writeFile(join(outside, 'note.txt'), 'outside')
    const replacement = Buffer.from('inside-updated')
    let running = true
    const swap = (async () => {
      while (running) {
        await rename(live, parked).catch(() => {})
        await symlink(outside, live).catch(() => {})
        await delay(1)
        await unlink(live).catch(() => {})
        await rename(parked, live).catch(() => {})
      }
    })()
    try {
      for (let i = 0; i < 80; i++) {
        try {
          const bytes = await safe.read(workspaceId, ['nested', 'note.txt'])
          if (bytes) assert(['inside', 'inside-updated'].includes(bytes.toString()))
        } catch (error) { assert(['invalid_path', 'file_not_found'].includes(error.code), error) }
        try {
          const kind = await safe.kind(workspaceId, ['nested', 'note.txt'])
          assert.equal(kind, 'file')
        } catch (error) { assert(['invalid_path', 'file_not_found'].includes(error.code), error) }
        try {
          const listed = await safe.list(workspaceId, ['nested'])
          assert(listed.missing || listed.items.every(item => item.name === 'note.txt'))
        } catch (error) { assert(['invalid_path', 'file_not_found'].includes(error.code), error) }
        if (i % 5 === 0) {
          try {
            await safe.put(workspaceId, ['nested', 'note.txt'], replacement.toString('base64'),
              digest(replacement), digest('inside'), false)
          } catch (error) {
            assert(['invalid_path', 'file_revision_conflict'].includes(error.code), error)
          }
        }
      }
    } finally { running = false; await swap }
    assert.equal((await readFile(join(outside, 'note.txt'), 'utf8')), 'outside')
  })

test('bounded binary transfer, revision recovery and helper failures', { timeout: 30000 }, async t => {
  const { base, root, safe, workspaceId } = await fixture(t)
  const bytes = Buffer.alloc(2 * 1024 * 1024, 0x7f)
  const wanted = digest(bytes)
  await safe.put(workspaceId, ['deep', 'binary.bin'], bytes.toString('base64'), wanted, null, false)
  assert.deepEqual(await safe.read(workspaceId, ['deep', 'binary.bin']), bytes)
  // The same bytes after an interrupted PG commit can be accepted once.
  await safe.put(workspaceId, ['deep', 'binary.bin'], bytes.toString('base64'), wanted, null, false)
  await assert.rejects(safe.put(workspaceId, ['deep', 'binary.bin'], bytes.toString('base64'), wanted, null, true),
    status(409, 'file_revision_conflict'))
  assert.equal(await safe.read(workspaceId, ['missing', 'file']), null)
  const invalid = new SafePosix(root, undefined, { executable: join(base, 'missing-python') })
  await assert.rejects(invalid.init(), status(503, 'workspace_unavailable'))
  const slow = join(base, 'slow-python')
  await writeFile(slow, '#!/usr/bin/env python3\nimport time\ntime.sleep(5)\n')
  await chmod(slow, 0o700)
  const timed = new SafePosix(root, undefined, { executable: slow, timeoutMs: 100 })
  await assert.rejects(timed.init(), status(503, 'workspace_unavailable'))
  const malformed = join(base, 'malformed-python')
  await writeFile(malformed, '#!/usr/bin/env python3\nprint("not JSON")\n')
  await chmod(malformed, 0o700)
  await assert.rejects(new SafePosix(root, undefined, { executable: malformed }).init(),
    status(503, 'workspace_unavailable'))
})
