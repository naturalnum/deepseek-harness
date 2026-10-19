/** Package-local loading inputs; no cross-package scope or authorization protocol. */
import type { FileSystem, FsTarget } from '@deepseek-ai/dsh-fs'
import type { InstructionSource, InstructionSourceKind } from './types.ts'

/** Complete bounded source content before snapshot rendering. */
export interface InstructionContents {
  readonly sources: readonly InstructionSource[]
  readonly totalBytes: number
}

/** Approved directory and its fixed read-only capability, supplied by its owning scope adapter. */
export interface InstructionDirectory {
  readonly kind: InstructionSourceKind
  readonly relativeName: string
  readonly target: FsTarget
  readonly reader: InstructionReader
}

/** Native operations on a restricted, read-only files capability. */
export type InstructionReader = Pick<FileSystem, 'resolve' | 'stat' | 'streamText' | 'processPath'>
