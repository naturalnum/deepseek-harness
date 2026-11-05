/** Admission issued to a reviewed account feature by the existing API owner. */
import type { Agent } from '@deepseek-ai/dsh-agent'
import type { SessionId } from '@deepseek-ai/dsh-session/types'
import type { SkillBundleInput } from '@deepseek-ai/dsh-pe-cloud-files'
import type { SkillViewOptions } from '@deepseek-ai/dsh-skill'
import type { FileSystemSkillResources } from '@deepseek-ai/dsh-skill-filesystem'

/** Reuses the original account, Session and active-Agent checks; supplies no identity from JSON. */
export interface AccountFeatureAdmission {
  /** Require this registration and the account's current business publication. */
  assertCurrent(): void
  /** Require an original Agent in this account and its approved project.
   * @param agent Original native Agent supplied by a tool execution.
   */
  assertAgent(agent: Agent): void
  /** Resolve an existing approved Session through the native Controller.
   * @param sessionId Existing Session identity, never authority by itself.
   * @param signal Caller cancellation, combined with the account lifetime.
   * @returns Original Agent, after Session/project and generation checks.
   */
  resolveAgent(sessionId: SessionId, signal: AbortSignal): Promise<Agent>
  /** Copy a reviewed bundled skill through the existing files owner and native project projection.
   * @param input Complete immutable public skill files; never a model-supplied host path.
   * @param options Native skill caller containing its original Agent scope.
   * @returns Complete project-relative resource guidance after quota-controlled publication.
   */
  materializeSkill(input: SkillBundleInput, options: SkillViewOptions): Promise<FileSystemSkillResources>
}
