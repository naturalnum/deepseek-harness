/** Shared source ordering and incremental label limits; descriptions never grant filesystem authority. */
import { posix } from 'node:path'
import { FsError } from '@deepseek-ai/dsh-fs'
import type { Config } from './config.ts'
import type { InstructionDirectory } from './internal-types.ts'
import { jsonStringBytes } from './budget.ts'

const sourceOrder = { platform: 0, account: 1, project: 2 } as const

/**
 * Validate bounded source labels before resolving candidates or retaining the next generated directory.
 * @param directories Approved source descriptions; generated chains are consumed only within their count/byte limits.
 * @param config Explicit candidate and encoded-label limits.
 * @returns Ordered descriptions with one complete project root-to-cwd chain.
 */
export function orderInstructionDirectories<T extends Pick<InstructionDirectory, 'kind' | 'relativeName'>>(
  directories: Iterable<T>, config: Config,
): T[] {
  const ordered: T[] = []
  let labels = 0
  for (const directory of directories) {
    if (ordered.length >= config.maxFiles) throw new FsError('Too many instruction source directories.', 'FS_TOO_LARGE')
    const name = directory.relativeName
    if (jsonStringBytes(name) > config.maxSnapshotBytes) throw new FsError('Instruction source labels exceed their byte budget.', 'FS_TOO_LARGE')
    if (posix.isAbsolute(name) || name.includes('\\') || name !== '.' && name.split('/').some(part => part === '' || part === '.' || part === '..')) {
      throw new FsError('Instruction source labels must be normalized relative names.', 'FS_SANDBOX_DENIED')
    }
    labels += jsonStringBytes(posix.join(name, 'AGENTS.md'))
    if (labels > config.maxSnapshotBytes) throw new FsError('Instruction source labels exceed their byte budget.', 'FS_TOO_LARGE')
    ordered.push(directory)
  }
  ordered.sort((left, right) => sourceOrder[left.kind] - sourceOrder[right.kind]
    || (left.kind === 'project' && right.kind === 'project'
      ? (left.relativeName === '.' ? 0 : left.relativeName.split('/').length)
        - (right.relativeName === '.' ? 0 : right.relativeName.split('/').length)
      : 0))
  let previous: string | undefined
  for (const directory of ordered) {
    if (directory.kind !== 'project') continue
    const expectedParent = posix.dirname(directory.relativeName)
    if (previous === undefined ? directory.relativeName !== '.' : expectedParent !== previous || directory.relativeName === previous) {
      throw new FsError('Project instruction sources must form the complete root-to-cwd chain.', 'FS_SANDBOX_DENIED')
    }
    previous = directory.relativeName
  }
  return ordered
}
