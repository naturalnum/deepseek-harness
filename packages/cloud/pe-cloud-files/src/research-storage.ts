/** Fixed-purpose private research storage issued by the original preallocated account lease. */
import type { AccountBinding } from '@deepseek-ai/dsh-pe-cloud-runtime/types'

/** Trusted Host-only directory grant; neither the path nor a serialized identity authorizes its use. */
export interface AccountResearchStorage {
  readonly binding: AccountBinding
  /** Fixed child of this account's verified private domain, never selected by a model or browser. */
  readonly directory: string
  /** Recheck the original storage lease and installed generation before each real store operation. */
  assertCurrent(): void
}
