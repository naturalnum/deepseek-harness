/** Bounded selection and reading; authorization and I/O ownership remain with files. */
import { createHash } from 'node:crypto'
import { posix } from 'node:path'
import { FsError } from '@deepseek-ai/dsh-fs'
import type { FsInfo, FsTarget } from '@deepseek-ai/dsh-fs'
import { validateLimits } from './config.ts'
import type { Config, InstructionSource } from './types.ts'
import type { InstructionContents, InstructionDirectory, InstructionReader } from './internal-types.ts'
import { jsonStringBytes } from './budget.ts'

const sourceOrder = { platform: 0, account: 1, project: 2 } as const

function orderedDirectories(directories: readonly InstructionDirectory[], config: Config): InstructionDirectory[] {
  if (directories.length > config.maxFiles) throw new FsError('Too many instruction source directories.', 'FS_TOO_LARGE')
  let labels = 0
  for (const directory of directories) {
    const name = directory.relativeName
    if (jsonStringBytes(name) > config.maxSnapshotBytes) throw new FsError('Instruction source labels exceed their byte budget.', 'FS_TOO_LARGE')
    if (posix.isAbsolute(name) || name.includes('\\') || name !== '.' && name.split('/').some(part => part === '' || part === '.' || part === '..')) {
      throw new FsError('Instruction source labels must be normalized relative names.', 'FS_SANDBOX_DENIED')
    }
    labels += jsonStringBytes(posix.join(name, 'AGENTS.md'))
    if (labels > config.maxSnapshotBytes) throw new FsError('Instruction source labels exceed their byte budget.', 'FS_TOO_LARGE')
  }
  const ordered = [...directories].sort((left, right) => sourceOrder[left.kind] - sourceOrder[right.kind]
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

async function candidate(
  reader: InstructionReader,
  directory: InstructionDirectory,
  name: string,
  signal: AbortSignal,
): Promise<{ target: FsTarget; info: FsInfo } | undefined> {
  let target: FsTarget
  try {
    target = await reader.resolve(name, { cwd: reader.processPath(directory.target), signal })
  } catch (error) {
    signal.throwIfAborted()
    if (error instanceof FsError && error.code === 'FS_NOT_FOUND') return undefined
    throw error
  }
  const info = await reader.stat(target, signal)
  signal.throwIfAborted()
  if (info === undefined) return undefined
  if (info.type !== 'file') throw new FsError('Instruction source must be a regular file.', 'FS_NOT_REGULAR_FILE')
  return { target, info }
}

/**
 * Select AGENTS.md, or CLAUDE.md only when AGENTS.md is absent, in each directory.
 * The caller supplies directories already restricted to the approved source roots
 * and project root-to-cwd chain, and a files-owned read-only reader that enforces
 * account/epoch validity, FD safety, stream credit and aggregate I/O reservations.
 * This function never discovers a project, performs direct host I/O, or creates a sandbox.
 * @param reader - restricted native operations; an unrestricted provider is invalid.
 * @param directories - approved sources, with project ancestors ordered root to cwd.
 * @param config - explicit source limits, including the candidate-directory count.
 * @param signal - cancellation inherited from the real turn and account lifetime.
 * @returns immutable complete contents; empty sources mean confirmed optional absence.
 * @throws the original provider or cancellation error, or FS_TOO_LARGE; no partial result is returned.
 */
export async function loadInstructionContents(
  reader: InstructionReader,
  directories: readonly InstructionDirectory[],
  config: Config,
  signal: AbortSignal,
): Promise<InstructionContents> {
  validateLimits(config)
  signal.throwIfAborted()
  const ordered = orderedDirectories(directories, config)
  const sources: InstructionSource[] = []
  let totalBytes = 0
  for (const directory of ordered) {
    signal.throwIfAborted()
    let selected = await candidate(reader, directory, 'AGENTS.md', signal)
    let name = 'AGENTS.md'
    if (selected === undefined) {
      name = 'CLAUDE.md'
      selected = await candidate(reader, directory, name, signal)
    }
    if (selected === undefined) continue
    const limit = Math.min(config.maxFileBytes, config.maxTotalBytes - totalBytes)
    if (selected.info.size !== undefined && selected.info.size > limit) {
      throw new FsError('Instruction source exceeds its byte budget.', 'FS_TOO_LARGE')
    }
    const chunks = await reader.streamText(selected.target, signal)
    const parts: string[] = []
    let bytes = 0
    for await (const chunk of chunks) {
      signal.throwIfAborted()
      bytes += Buffer.byteLength(chunk, 'utf8')
      if (bytes > limit) throw new FsError('Instruction source exceeds its byte budget.', 'FS_TOO_LARGE')
      parts.push(chunk)
    }
    signal.throwIfAborted()
    const text = parts.join('')
    totalBytes += Buffer.byteLength(text, 'utf8')
    sources.push(Object.freeze({
      kind: directory.kind,
      relativeName: posix.join(directory.relativeName, name),
      hash: createHash('sha256').update(text, 'utf8').digest('hex'),
      text,
    }))
  }
  return Object.freeze({ sources: Object.freeze(sources), totalBytes })
}
