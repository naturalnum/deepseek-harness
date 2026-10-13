/** Display data and actions shared by the trusted account components. */
import type { AccountLocaleKey } from '../client/locales.ts'

/** A locale dictionary lookup owned by the account package. */
export type AccountTranslate = (key: AccountLocaleKey) => string

/** Role labels shown in the account editor; authority remains on the Platform. */
export type AccountRoleView = 'user' | 'admin'

/** Account metadata permitted in the management list. */
export interface ManagedAccountView {
  readonly userId: string
  readonly username: string
  readonly displayName: string
  readonly role: AccountRoleView
  readonly enabled: boolean
  readonly revision: number
  readonly passwordChangeRequired: boolean
  readonly createdAt: string
}

/** One page of permitted account metadata. */
export interface ManagedAccountPageView {
  readonly items: readonly ManagedAccountView[]
  readonly nextCursor: string | null
}

/** A creation draft; it contains no initial password. */
export interface CreateAccountDraft {
  readonly username: string
  readonly displayName: string
  readonly role: AccountRoleView
  readonly model: string
  readonly maxTokens: number
  readonly modelGrants: readonly { readonly id: string; readonly maxTokens: number }[]
}

/** An immutable gesture retained until its receipt or definitive refusal. */
export type AccountMutationIntent =
  | { readonly kind: 'create'; readonly requestId: string; readonly draft: CreateAccountDraft }
  | {
    readonly kind: 'update'
    readonly requestId: string
    readonly account: ManagedAccountView
    readonly displayName: string
    readonly role: AccountRoleView
    readonly enabled: boolean
  }
  | { readonly kind: 'reset' | 'remove'; readonly requestId: string; readonly account: ManagedAccountView }

/** Result of a management gesture or a receipt lookup; secrets are never replayed by lookup. */
export interface AccountMutationResult {
  readonly account?: ManagedAccountView
  readonly temporaryPassword?: string
}

/** Component-level problems mapped from the shared protocol by the trusted HTTP client. */
export class AccountActionError extends Error {
  readonly problem: 'revisionConflict' | 'permissionLost' | 'lastAdmin' | 'accountNotEmpty' | 'invalidAccount' | 'passwordRejected'

  /** Preserve the component problem alongside the ordinary Error message.
   * @param problem Mapped account protocol failure.
   */
  constructor(problem: AccountActionError['problem']) {
    super(problem)
    this.problem = problem
  }
}
