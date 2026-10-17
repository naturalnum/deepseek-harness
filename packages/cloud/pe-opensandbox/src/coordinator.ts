/** Root coordinator Service Definition; implementations retain the runtime-owned receipt types. */
import { Context, Service } from '@deepseek-ai/cordis'
import type { AccountBinding, DrainParticipant, ParticipantReceipt } from '@deepseek-ai/dsh-pe-cloud-runtime/types'

declare module '@deepseek-ai/cordis' {
  interface Context {
    /** The single root owner of allocations, process ranges, streams and execution stop evidence. */
    peSandboxCoordinator: SandboxCoordinator
  }
}

/**
 * A concrete implementation must register as runtime's mandatory execution participant
 * and verify its own required execution capabilities before readiness. This definition
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

  /** Throw unless the recipe's required channel, isolation and lifecycle evidence is verified. */
  abstract assertReady(): void

  /**
   * Stop all actual work and nonterminal allocations for this exact generation.
   * @param binding - runtime-owned account and epoch; includes idle and uncertain allocations.
   * @param deadlineAtMs - caller's finite waiting deadline, which does not release cleanup ownership.
   * @returns confirmed only after all ranges, I/O and late starts have stopped; otherwise unknown.
   */
  abstract stopEpoch(binding: AccountBinding, deadlineAtMs: number): Promise<ParticipantReceipt>
}
