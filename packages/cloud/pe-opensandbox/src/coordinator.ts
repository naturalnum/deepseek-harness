/** Root coordinator Service Definition; implementations retain the runtime-owned receipt types. */
import { Context, Service } from '@deepseek-ai/cordis'
import type { AccountBinding, DrainParticipant, ParticipantReceipt } from '@deepseek-ai/dsh-pe-cloud-runtime/types'
import type { Agent } from '@deepseek-ai/dsh-agent'
import type { Session, SessionId } from '@deepseek-ai/dsh-session'
import type { Workspace } from '@deepseek-ai/dsh-workspace'
import type { CloudAccountFiles } from '@deepseek-ai/dsh-pe-cloud-files'
import type { AccountExecutionPort } from './account-port.ts'

/** Lazy account-native authority; binding does not consume it and closed coordinators ignore it. */
export interface NativeAccountExecutionAuthority {
  /** Recheck the original Root seal and this account's business admission. */
  readonly assertBusinessCurrent: () => void
  /** Resolve the current native Registry's exact live Agent, without creating or resuming one. */
  readonly getAgent: (id: SessionId) => Agent | undefined
  /** Select the Workspace through the original published-Agent guards. */
  readonly projectForAgent: (agent: Agent) => Workspace
  /** Select the Workspace through the original native Session guards. */
  readonly projectForSession: (session: Session) => Workspace
  /** Resolve the original installed files owner only when a native operation needs it. */
  readonly files: () => CloudAccountFiles
}

declare module '@deepseek-ai/cordis' {
  interface Context {
    /** The single root owner of allocations, process ranges, streams and execution stop evidence. */
    peSandboxCoordinator: SandboxCoordinator
  }
}

/**
 * A concrete implementation must register as runtime's mandatory execution participant
 * and verify its own required execution capabilities or explicit closed mode before readiness. This definition
 * supplies neither an implementation nor an empty-work stopping receipt.
 */
export abstract class SandboxCoordinator extends Service implements DrainParticipant {
  // oxlint-disable-next-line typescript/prefer-as-const -- Typert requires explicit public property types.
  readonly id: 'execution' = 'execution'

  /**
   * Register the unique root service; normal Cordis ownership rejects a second implementation.
   * @param ctx - root implementation context; accounts receive a separate restricted port.
   */
  constructor(ctx: Context) {
    super(ctx, 'peSandboxCoordinator')
  }

  /** Check actual registration and declared requirements; closed mode authorizes no execution. */
  abstract assertReady(): void

  /**
   * Issue one restricted port from runtime's trusted native prepare scope.
   * @param ctx - independent account graph with its actual installed binding.
   * @param binding - exact installed runtime generation, never serialized identity.
   * @param assertCurrent - runtime-owned graph-current check, valid during mounting.
   * @param authority - optional lazy native authority, not consumed during binding; closed coordinators ignore it.
   * @returns an account-only port; issuance does not establish account readiness.
   */
  abstract bindAccount(
    ctx: Context, binding: AccountBinding, assertCurrent: () => void, authority?: NativeAccountExecutionAuthority,
  ): AccountExecutionPort

  /**
   * Stop all actual work and nonterminal allocations for this exact generation.
   * @param binding - runtime-owned account and epoch; includes idle and uncertain allocations.
   * @param deadlineAtMs - caller's finite waiting deadline, which does not release cleanup ownership.
   * @returns confirmed only after all ranges, I/O and late starts have stopped; otherwise unknown.
   */
  abstract stopEpoch(binding: AccountBinding, deadlineAtMs: number): Promise<ParticipantReceipt>
}
