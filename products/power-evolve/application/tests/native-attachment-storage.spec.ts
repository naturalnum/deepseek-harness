/** Physical quota measurements include failed uploads and refuse unsafe filesystem entries. */
import { link, mkdir, mkdtemp, readFile, rm, symlink, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { dirname, join } from 'node:path'
import { expect, test } from 'vitest'
import { nativeAttachmentUsage } from '../src/platform/native-attachment-storage.ts'

async function storage(run: (root: string) => Promise<void>): Promise<void> {
  const root = await mkdtemp(join(tmpdir(), 'pe-original-quota-'))
  try { await run(root) }
  finally { await rm(root, { recursive: true, force: true }) }
}

test('hard-linked originals count physical bytes once while distinct published names consume slots', async () => {
  await storage(async (root) => {
    const canonical = join(root, 'alice', 'session', 'file-objects', 'aa', 'a'.repeat(64))
    const first = join(root, 'alice', 'session', 'files', 'aa', 'a'.repeat(64), 'first.txt')
    await mkdir(dirname(canonical), { recursive: true }); await writeFile(canonical, 'four')
    await mkdir(dirname(first), { recursive: true }); await link(canonical, first)
    await link(canonical, join(dirname(first), 'second.txt'))
    const usage = await nativeAttachmentUsage(root, 'alice', 4, new AbortController().signal)
    expect(usage.bytes).toBe(4); expect(usage.files).toBe(2)
    expect([...usage.sessionSlots.get('session') ?? []].sort()).toEqual([
      `sha256:${'a'.repeat(64)}\0first.txt`, `sha256:${'a'.repeat(64)}\0second.txt`,
    ])
    expect(await nativeAttachmentUsage(root, 'bob', 4, new AbortController().signal))
      .toEqual({ bytes: 0, files: 0, sessionSlots: new Map() })
  })
})

test('an unaliased object and crash staging file both consume owner capacity', async () => {
  await storage(async (root) => {
    const canonical = join(root, 'alice', 'session', 'file-objects', 'aa', 'a'.repeat(64))
    await mkdir(dirname(canonical), { recursive: true }); await writeFile(canonical, 'four')
    const staging = join(root, 'alice', 'session', 'staging', 'interrupted')
    await mkdir(dirname(staging), { recursive: true }); await writeFile(staging, 'abc')
    const usage = await nativeAttachmentUsage(root, 'alice', 4, new AbortController().signal)
    expect(usage.bytes).toBe(7); expect(usage.files).toBe(2)
    expect(usage.sessionSlots.get('session')).toEqual(new Set([
      `sha256:${'a'.repeat(64)}\0`, 'unreferenced:staging/interrupted',
    ]))
    await expect(nativeAttachmentUsage(root, 'alice', 1, new AbortController().signal))
      .rejects.toMatchObject({ code: 'attachment_storage_limit' })
  })
})

test('symlinked originals cannot authorize new intake and cancellation interrupts measurement', async () => {
  await storage(async (root) => {
    await mkdir(join(root, 'alice', 'session'), { recursive: true })
    await symlink(root, join(root, 'alice', 'session', 'escape'))
    await expect(nativeAttachmentUsage(root, 'alice', 4, new AbortController().signal))
      .rejects.toMatchObject({ code: 'attachment_storage_unavailable' })
    await expect(nativeAttachmentUsage(root, 'bob', 4, AbortSignal.abort(new Error('upload cancelled'))))
      .rejects.toThrow('upload cancelled')
  })
})

test('a tree with excessive empty entries refuses before unbounded traversal', async () => {
  await storage(async (root) => {
    const session = join(root, 'alice', 'session'); await mkdir(session, { recursive: true })
    for (let batch = 0; batch < 42; batch++) {
      await Promise.all(Array.from({ length: 100 }, (_, index) => mkdir(join(session, `${batch}-${index}`))))
    }
    await expect(nativeAttachmentUsage(root, 'alice', 1, new AbortController().signal))
      .rejects.toMatchObject({ code: 'attachment_storage_limit' })
  })
})

test('a file occupying the owner directory refuses intake without changing its bytes', async () => {
  await storage(async (root) => {
    const occupied = join(root, 'alice')
    await writeFile(occupied, 'retained owner file')
    await expect(nativeAttachmentUsage(root, 'alice', 4, new AbortController().signal))
      .rejects.toMatchObject({ status: 503, code: 'attachment_storage_unavailable' })
    expect(await readFile(occupied, 'utf8')).toBe('retained owner file')
  })
})

test('an unusable storage root preserves the filesystem error instead of authorizing empty intake', async () => {
  await storage(async (root) => {
    const occupied = join(root, 'not-a-directory')
    await writeFile(occupied, 'retained storage root')
    await expect(nativeAttachmentUsage(occupied, 'alice', 4, new AbortController().signal))
      .rejects.toMatchObject({ code: 'ENOTDIR' })
    expect(await readFile(occupied, 'utf8')).toBe('retained storage root')
  })
})
