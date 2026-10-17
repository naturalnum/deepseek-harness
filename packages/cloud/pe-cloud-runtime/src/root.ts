/** Root-only participant registration and local capacity; no account graph is published here. */
import { Context, Service } from '@deepseek-ai/cordis'
import { RuntimeCapacity } from './capacity.ts'
import { AccountRuntimeError } from './errors.ts'
import { RuntimeConfigSchema } from './schema.ts'
import type { AccountId, DrainCapacityReservation, DrainParticipant, MountCapacityReservation, ParticipantId, RuntimeConfig } from './types.ts'

export { AccountRuntimeError } from './errors.ts'
export type * from './types.ts'

declare module '@deepseek-ai/cordis' {
  interface Context {
    /** Root runtime registration and local capacity, not a readiness declaration. */
    peAccountRuntime: PeAccountRuntime
  }
}

/** Runtime-owned root foundation; owner acquisition, recipe sealing, and mounting are not exposed. */
export class PeAccountRuntime extends Service {
  static Config = RuntimeConfigSchema

  private readonly participants = new Map<ParticipantId, DrainParticipant>()
  private readonly capacity: RuntimeCapacity
  private closed = false

  /**
   * Install one root with explicit limits; this does not acquire a PG owner or mark an account ready.
   * @param ctx Root plugin context.
   * @param config Required deployment capacities.
   */
  constructor(ctx: Context, config: RuntimeConfig) {
    const resolved = RuntimeConfigSchema(config)
    super(ctx, 'peAccountRuntime')
    this.capacity = new RuntimeCapacity(resolved)
    ctx.effect(() => () => {
      this.closed = true
      this.capacity.close()
    }, 'pe-cloud-runtime: close local admission')
  }

  /**
   * Register a root participant in the caller's effect scope; duplicates are rejected.
   * @param participant The files/root or execution/root actual-work owner.
   * @returns An idempotent disposer; caller unload also removes the contribution.
   * @throws AccountRuntimeError for duplicates or closed registration.
   */
  registerDrainParticipant(participant: DrainParticipant): () => void | Promise<void> {
    this.assertOpen()
    if (this.participants.has(participant.id)) {
      throw new AccountRuntimeError('cloud/invalid-config', `Duplicate mandatory drain participant: ${participant.id}`)
    }
    return this.ctx.effect(() => {
      this.participants.set(participant.id, participant)
      return () => { this.participants.delete(participant.id) }
    }, 'pe-cloud-runtime: drain participant')
  }

  /**
   * Reject an incomplete root before a future recipe audit can consider its other evidence.
   * This check neither seals a recipe nor verifies storage, owner, execution, or config saving.
   * @throws AccountRuntimeError when files or execution is absent, or the root is closed.
   */
  assertRequiredParticipants(): void {
    this.assertOpen()
    for (const id of ['files', 'execution'] as const) {
      if (!this.participants.has(id)) {
        throw new AccountRuntimeError('cloud/invalid-config', `Missing mandatory drain participant: ${id}`)
      }
    }
  }

  /**
   * Reserve local factory capacity without acquiring owner metadata or creating a graph.
   * @param accountId Trusted account whose concurrent factory has already been merged by its owner.
   * @returns A reservation retained through actual mounting and graph disposal.
   */
  reserveMountCapacity(accountId: AccountId): MountCapacityReservation {
    this.assertRequiredParticipants()
    return this.capacity.reserveMount(accountId)
  }

  /**
   * Reserve bounded drain work for an existing local account reservation.
   * @param accountId Account whose actual drain will own the slot.
   * @returns A reservation released only after actual drain settlement.
   */
  reserveDrainCapacity(accountId: AccountId): DrainCapacityReservation {
    this.assertOpen()
    return this.capacity.reserveDrain(accountId)
  }

  private assertOpen(): void {
    if (this.closed) throw new AccountRuntimeError('cloud/account-unavailable', 'Runtime registration is closed')
  }
}

export default PeAccountRuntime
