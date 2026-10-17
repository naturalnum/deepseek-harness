/** Instruction content produced from already-authorized directories. */
import type { AccountBinding } from '@deepseek-ai/dsh-pe-cloud-runtime/types'
import type { WorkspaceId } from '@deepseek-ai/dsh-workspace'
import type { UserMessage } from '@deepseek-ai/dsh-llm'

export type { Config } from './config.ts'

/** Original source category, ordered from platform through project. */
export type InstructionSourceKind = 'platform' | 'account' | 'project'

/** One complete source; hash identifies the text actually read. */
export interface InstructionSource {
  readonly kind: InstructionSourceKind
  readonly relativeName: string
  readonly hash: string
  readonly text: string
}

/** C-09 data only; possession does not confer file or project authority. */
export interface InstructionSnapshot {
  readonly accountId: AccountBinding['accountId']
  readonly workspaceId: WorkspaceId
  readonly epoch: AccountBinding['epoch']
  readonly sources: readonly InstructionSource[]
  readonly text: string
  /** UTF-8 bytes of the complete model-visible text, including source labels and framing. */
  readonly totalBytes: number
}

/** Native producer attribution; metadata is retained in the native Session log. */
export interface InstructionMessageSource {
  readonly kind: 'pe-account-instructions'
  readonly form: 'instructions'
  readonly snapshot: InstructionSnapshot
}

/** Complete native user-role context; its producer is distinct from direct user input. */
export type InstructionMessage = UserMessage & { readonly source: InstructionMessageSource }

declare module '@deepseek-ai/dsh-llm' {
  interface MessageSourceMap {
    'pe-account-instructions': InstructionMessageSource
  }
}
