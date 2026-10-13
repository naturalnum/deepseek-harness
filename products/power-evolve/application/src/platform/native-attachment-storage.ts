/** Physical intake accounting includes immutable objects left by aborted database transactions. */
import { lstat, opendir } from 'node:fs/promises'
import { join } from 'node:path'
import { PlatformError } from '../contracts.ts'

/** One owner's measured files; inode deduplication matches the maintained backend's hard links. */
export interface NativeAttachmentUsage {
  readonly bytes: number
  readonly files: number
  readonly sessionSlots: ReadonlyMap<string, ReadonlySet<string>>
}

/** Count all physical bytes and published references before another upload is admitted.
 * Unreferenced immutable objects and crash staging files consume capacity rather than disappearing from quota.
 * @param root Private original-file root, disjoint from every writable mount.
 * @param owner Server-owned user identity.
 * @param maxFiles Maximum owner-wide physical intake slots and corresponding bounded walk budget.
 * @param signal Upload lifetime; cancelled scans never authorize intake.
 * @returns Physical byte usage and per-storage-Session reference slots; unsafe or excessive trees refuse.
 */
export async function nativeAttachmentUsage(root: string, owner: string, maxFiles: number,
  signal: AbortSignal): Promise<NativeAttachmentUsage> {
  const inodes = new Set<string>()
  const sessionSlots = new Map<string, Set<string>>()
  let bytes = 0, files = 0, entries = 0
  const budget = maxFiles * 8 + 4096
  const base = join(root, owner)
  const visit = async (path: string, parts: readonly string[]): Promise<void> => {
    signal.throwIfAborted()
    if (++entries > budget) throw new PlatformError(429, 'attachment_storage_limit')
    let stat
    try { stat = await lstat(path) }
    catch (error) {
      if (parts.length === 0 && error instanceof Error && 'code' in error && error.code === 'ENOENT') return
      throw error
    }
    if (stat.isSymbolicLink() || !stat.isDirectory() && !stat.isFile()) {
      throw new PlatformError(503, 'attachment_storage_unavailable')
    }
    if (stat.isDirectory()) {
      const children = await opendir(path)
      for await (const child of children) await visit(join(path, child.name), [...parts, child.name])
      return
    }
    const inode = `${stat.dev}:${stat.ino}`
    if (!inodes.has(inode)) { inodes.add(inode); bytes += stat.size }
    const session = parts[0]
    if (session === undefined) throw new PlatformError(503, 'attachment_storage_unavailable')
    let slots = sessionSlots.get(session)
    if (!slots) sessionSlots.set(session, slots = new Set())
    // file-store's public root contract: files/<prefix>/<digest>/<safe-name> and file-objects/<prefix>/<digest>.
    if (parts[1] === 'files' && parts.length === 5) slots.add(`sha256:${parts[3]}\0${parts[4]}`)
    else if (parts[1] === 'file-objects' && parts.length === 4) slots.add(`sha256:${parts[3]}\0`)
    else slots.add(`unreferenced:${parts.slice(1).join('/')}`)
  }
  await visit(base, [])
  for (const slots of sessionSlots.values()) {
    const aliased = new Set([...slots].filter(key => !key.endsWith('\0')).map(key => key.split('\0')[0]))
    for (const key of [...slots]) if (key.endsWith('\0') && aliased.has(key.slice(0, -1))) slots.delete(key)
    files += slots.size
  }
  if (files > maxFiles) throw new PlatformError(429, 'attachment_storage_limit')
  return { bytes, files, sessionSlots }
}
