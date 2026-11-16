/** Published skill resources copied into ordinary quota-bound Workspace data; no private directory is exported. */
import { posix } from 'node:path'
import type { SkillBundleSource, SkillBundleFile } from './skill-bundles.ts'
import type { SkillVersionSource } from './skill-versions.ts'
import type { TextProjectBackend } from './text-project.ts'
import type { ResidentResult } from './work-queue.ts'
import type { WorkspaceUploadSource, WorkspaceUploadResult } from './stage-bridge.ts'
import { FilesFailure } from './error.ts'
import { FdMutationFailure } from './worker-client.ts'

/** Original registered project, live source snapshot and existing bounded publication operations. */
export interface WorkspaceSkillWork {
  readonly source: SkillBundleSource | SkillVersionSource
  readonly content: Pick<TextProjectBackend, 'lstat' | 'assertCurrent'>
  readonly chunkBytes: number
  readonly signal: AbortSignal
  assertCurrent(): void
  createDirectory(parent: string, name: string): Promise<string>
  publish(source: WorkspaceUploadSource): Promise<ResidentResult<readonly WorkspaceUploadResult[]>>
}

function incomplete(cause?: unknown): never {
  throw new FilesFailure('files/prerequisite-missing',
    'The Workspace skill copy is incomplete or changed. Its existing files have been preserved.',
    cause === undefined ? undefined : { cause })
}

/**
 * Copy one admitted version without adding a protected skill-project association.
 * Existing complete copies remain writable and are reused without replacing user changes.
 * @param work Same account's original project, source borrow and storage operations.
 * @returns Workspace-relative directory after every member is present and publication has closed.
 */
export async function materializeWorkspaceSkill(work: WorkspaceSkillWork): Promise<string> {
  const { source, content, signal } = work
  const current = (): void => { work.assertCurrent(); signal.throwIfAborted(); content.assertCurrent() }
  const stat = async (path: string) => {
    current()
    const held = await content.lstat(path, signal)
    try { current(); return held.value } finally { held.release() }
  }
  const files: readonly SkillBundleFile[] = 'files' in source ? source.files : [
    { relativePath: 'SKILL.md', bytes: source.version.skillBytes, sha256: source.version.skillSha256 },
    { relativePath: 'resource.bin', bytes: source.version.resourceBytes, sha256: source.version.resourceSha256 },
  ]
  const directories = 'directories' in source ? source.directories : []
  const container = '.skills', preferred = `${container}/${source.version.id}`
  const complete = async (base: string): Promise<void> => {
    for (const name of directories) if ((await stat(`${base}/${name}`))?.type !== 'directory') incomplete()
    for (const file of files) if ((await stat(`${base}/${file.relativePath}`))?.type !== 'file') incomplete()
  }
  current()
  const original = await stat(preferred)
  if (original !== undefined) {
    if (original.type !== 'directory') incomplete()
    await complete(preferred)
    return preferred
  }
  const parent = await stat(container)
  if (parent === undefined) {
    const created = await work.createDirectory('.', container)
    current()
    if (posix.normalize(created) !== container) incomplete()
  } else if (parent.type !== 'directory') incomplete()
  const base = posix.normalize(await work.createDirectory(container, source.version.id))
  current()
  // Collision handling belongs to the existing storage publisher. The actual returned directory owns this copy.
  if (posix.dirname(base) !== container || base === container) incomplete()
  try {
    for (const directory of [...directories].sort((a, b) => a.split('/').length - b.split('/').length)) {
      const created = await work.createDirectory(posix.join(base, posix.dirname(directory)), posix.basename(directory))
      current()
      if (posix.normalize(created) !== `${base}/${directory}`) incomplete()
    }
    // A failed resource publication cannot leave a newly advertised instruction file.
    const ordered = [...files.filter(file => file.relativePath !== 'SKILL.md'), ...files.filter(file => file.relativePath === 'SKILL.md')]
    for (const file of ordered) {
      current()
      const bytes = 'files' in source ? await source.readBytes(file.relativePath, signal)
        : await source.readBytes(file.relativePath === 'SKILL.md' ? 'SKILL.md' : 'resource.bin', signal)
      current()
      const held = await work.publish({
        claim: { name: posix.basename(file.relativePath), bytes: file.bytes, sha256: file.sha256 },
        workspaceDirectory: posix.join(base, posix.dirname(file.relativePath)),
        // oxlint-disable-next-line typescript/require-await -- Staging requires an AsyncIterable over this retained in-memory snapshot.
        open: async function* (control) {
          for (let offset = 0; offset < bytes.byteLength; offset += work.chunkBytes) {
            current(); control.throwIfAborted()
            yield Uint8Array.from(bytes.subarray(offset, offset + work.chunkBytes))
          }
        },
      })
      try {
        current()
        const [published] = held.value
        if (held.value.length !== 1 || published === undefined
          || posix.normalize(published.relativePath) !== `${base}/${file.relativePath}`) incomplete()
      } finally { held.release() }
    }
    await complete(base)
    return base
  } catch (cause) {
    // The original pool retains unconfirmed native work. Already published project files are never deleted or replayed here.
    if (cause instanceof FdMutationFailure && cause.outcome === 'unknown') throw cause
    incomplete(cause)
  }
}
