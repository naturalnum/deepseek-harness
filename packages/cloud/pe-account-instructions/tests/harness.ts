/** Bounded in-memory native reader; this fixture is not a Linux/files authorization provider. */
import { posix } from 'node:path'
import { FsError, FsTargetKey, FsVersion } from '@deepseek-ai/dsh-fs'
import type { FsInfo, FsTarget } from '@deepseek-ai/dsh-fs'
import type { Config, InstructionSnapshot } from '../src/types.ts'
import type { InstructionDirectory, InstructionReader } from '../src/internal-types.ts'
import { WorkspaceId } from '@deepseek-ai/dsh-workspace'

export const identity: Pick<InstructionSnapshot, 'accountId' | 'workspaceId' | 'epoch'> = {
  accountId: 'fixture-account' as InstructionSnapshot['accountId'],
  workspaceId: WorkspaceId('fixture-workspace'),
  epoch: '1' as InstructionSnapshot['epoch'],
}

export interface Source {
  chunks: string[]
  size?: number
  type?: FsInfo['type']
  error?: FsError
}

export class Reader implements InstructionReader {
  private readonly targets = new WeakSet<FsTarget>()
  readonly probes: string[] = []
  readonly reads: string[] = []
  readonly closed: string[] = []
  readonly yielded: string[] = []
  readonly files = new Map<string, Source>()

  constructor(private readonly root = '/approved') {}

  async resolve(path: string, options?: { cwd?: string; signal?: AbortSignal }): Promise<FsTarget> {
    options?.signal?.throwIfAborted()
    const absolute = posix.resolve(options?.cwd ?? this.root, path)
    this.probes.push(absolute)
    const failure = this.files.get(absolute)?.error
    if (failure !== undefined) throw failure
    return this.target(absolute)
  }
  target(path: string): FsTarget {
    const file = { targetKey: FsTargetKey(path), displayPath: path }
    this.targets.add(file)
    return file
  }
  private assertOwnTarget(file: FsTarget): void {
    if (!this.targets.has(file)) throw new FsError('Target belongs to another reader.', 'FS_SANDBOX_DENIED')
  }
  processPath(file: FsTarget): string {
    this.assertOwnTarget(file)
    return file.displayPath
  }
  async stat(file: FsTarget): Promise<FsInfo | undefined> {
    this.assertOwnTarget(file)
    const source = this.files.get(file.displayPath)
    if (source === undefined) return undefined
    return {
      version: FsVersion('test-version'),
      type: source.type ?? 'file',
      ...source.size === undefined ? {} : { size: source.size },
    }
  }
  async streamText(file: FsTarget): Promise<AsyncIterable<string>> {
    this.assertOwnTarget(file)
    const source = this.files.get(file.displayPath)
    if (source === undefined) throw new FsError('missing', 'FS_NOT_FOUND')
    this.reads.push(file.displayPath)
    const { yielded, closed } = this
    return (async function* () {
      try {
        for (const chunk of source.chunks) {
          yielded.push(chunk)
          yield chunk
        }
      } finally {
        closed.push(file.displayPath)
      }
    })()
  }
}

export const limits: Config = budget(30, 60)
export function budget(maxFileBytes: number, maxTotalBytes: number, maxFiles = 8): Config {
  const caps = { maxFiles, maxFileBytes, maxTotalBytes, maxSnapshotBytes: 8192 }
  return { ...caps, maxResidentBytes: 1_000_000 }
}
export const signal = (): AbortSignal => new AbortController().signal
export function directory(reader: Reader, kind: InstructionDirectory['kind'], path: string, label: string): InstructionDirectory {
  return { reader, kind, relativeName: label, target: reader.target(path) }
}
