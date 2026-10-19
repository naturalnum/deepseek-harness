/** Session Loader entry consumes a graph-prepared source owner without granting filesystem authority. */
import { Service, type Context } from '@deepseek-ai/cordis'
import type { Agent } from '@deepseek-ai/dsh-agent'
import type { AccountBinding } from '@deepseek-ai/dsh-pe-cloud-runtime/types'
import type { WorkspaceId } from '@deepseek-ai/dsh-workspace'
import type { InstructionReadReaders } from '@deepseek-ai/dsh-pe-cloud-files'
import { validateLimits } from './config.ts'
import type { Config } from './types.ts'
import { InstructionConfigurationError } from './error.ts'
import { installInstructionInjection } from './injection.ts'
import { prepareInstructionSnapshot } from './snapshot.ts'
import type { InstructionDirectory } from './internal-types.ts'

export { Config } from './config.ts'

/** Trusted graph preparation; no identity, path or source can be selected through Loader JSON. */
export interface AccountInstructionPreparation {
  readonly binding: AccountBinding
  /**
   * Require the exact installed account graph, including before business publication.
   * @param owner Scope consuming the original prepared adapter.
   * @returns No value; rejects a closed, foreign or replaced graph.
   */
  assertInstalled(owner: Context): void
  /**
   * Require the original active Agent and its approved Workspace, model and Preset.
   * @param agent Actual native Agent whose sources are about to be consumed.
   * @returns No value; rejects missing, stale or unapproved native ownership.
   */
  assertCurrent(agent: Agent): void
  /**
   * Reserve complete source, construction and handoff storage on the original files lane.
   * @param agent Exact active Agent whose native project determines the allowed sources.
   * @param reservedBytes Complete snapshot storage, before any source content is read.
   * @param build Receives only owner-issued independent readers and the actual native Workspace id.
   * @param signal Turn/generation/plugin cancellation; actual I/O remains owned until settlement.
   * @returns The built result with a non-throwing release; source I/O and FD closure have actually settled.
   */
  withSources<T>(
    agent: Agent, reservedBytes: number,
    build: (workspaceId: WorkspaceId, readers: InstructionReadReaders, signal: AbortSignal) => Promise<T>,
    signal: AbortSignal,
  ): Promise<{ readonly value: T; release(): void }>
}

declare module '@deepseek-ai/cordis' {
  interface Context {
    /** Prepared graph owner; its presence neither opens model admission nor authorizes a source. */
    peAccountInstructions: AccountInstructionSources
  }
}

/** Account-owned adapter between trusted source reservations and native Session instruction injection. */
export class AccountInstructionSources extends Service {
  private readonly preparation: { readonly ctx: Context; readonly input: AccountInstructionPreparation; readonly identity: symbol }

  /**
   * Prepare the account's sole source adapter before its Session Presets activate, without starting source I/O.
   * @param ctx Independent account preparation scope, never the shared Root or an HTTP borrow.
   * @param input Actual files-owned source reservation and shared native Agent admission checks.
   * @throws InstructionConfigurationError for missing, stale or duplicate graph ownership.
   */
  constructor(ctx: Context, input: AccountInstructionPreparation) {
    input.assertInstalled(ctx)
    if (ctx.get('peAccountInstructions') !== undefined || ctx.root.get('peAccountInstructions') !== undefined
      || input.binding.lifetime.aborted || ctx.get('peAccount') !== input.binding || ctx.root.get('peAccount') !== input.binding) {
      throw new InstructionConfigurationError('Instruction preparation requires its unique installed account graph.')
    }
    super(ctx, 'peAccountInstructions')
    this.preparation = { ctx, input, identity: Symbol('account-instruction-sources') }
  }

  /**
   * Install scoped turn injection using this graph's original source adapter.
   * @param owner Actual Session plugin scope in the prepared account graph.
   * @param config Validated finite snapshot limits.
   * @returns No value; source I/O starts only when a real turn enters.
   */
  install(owner: Context, config: Config): void {
    const { input } = this.preparation
    this.assertInstalled(owner)
    installInstructionInjection(owner, input.binding.lifetime, (agent) => {
      this.assertInstalled(owner)
      input.assertCurrent(agent)
    }, async (agent, signal) => {
      this.assertInstalled(owner)
      input.assertCurrent(agent)
      const held = await input.withSources(agent, config.maxResidentBytes, async (workspaceId, readers, control) => {
        const identity = { accountId: input.binding.accountId, epoch: input.binding.epoch, workspaceId }
        const directories: InstructionDirectory[] = []
        if (readers.account !== undefined) directories.push({ kind: 'account', relativeName: '.', reader: readers.account,
          target: await readers.account.resolve('.', { signal: control }) })
        directories.push({ kind: 'project', relativeName: '.', reader: readers.project,
          target: await readers.project.resolve('.', { signal: control }) })
        return prepareInstructionSnapshot(directories, identity, config, control)
      }, signal)
      try {
        signal.throwIfAborted()
        this.assertInstalled(owner)
        input.assertCurrent(agent)
        return { message: held.value, release: () => { held.release() } }
      } catch (error) { held.release(); throw error }
    })
  }

  private assertInstalled(owner: Context): void {
    const { ctx, input, identity } = this.preparation
    input.assertInstalled(owner)
    owner.fiber.assertActive()
    ctx.fiber.assertActive()
    const local = owner.get('peAccountInstructions'), root = owner.root.get('peAccountInstructions')
    if (owner.root !== ctx.root || input.binding.lifetime.aborted
      || owner.get('peAccount') !== input.binding || owner.root.get('peAccount') !== input.binding
      || !(local instanceof AccountInstructionSources) || !(root instanceof AccountInstructionSources)
      || local.preparation.identity !== identity || root.preparation.identity !== identity) {
      throw new InstructionConfigurationError('The instruction source owner belongs to a withdrawn or different account graph.')
    }
  }
}

/** Loader name for the bounded account instruction behavior. */
export const name = 'pe-account-instructions'
/** Missing preparation must fail activation explicitly instead of waiting on an optional provider. */
export const inject: string[] = []

/**
 * Install native turn injection only through the original prepared source owner.
 * @param ctx - Session plugin owner in the prepared account graph.
 * @param config - explicit finite instruction budgets.
 * @returns No value; native scoped listeners are installed without reading a source.
 * @throws InstructionConfigurationError; file instructions cannot be enabled without owner adapters.
 */
export function apply(ctx: Context, config: Config): void {
  validateLimits(config)
  const owner = ctx.get('peAccountInstructions')
  if (!(owner instanceof AccountInstructionSources)) {
    throw new InstructionConfigurationError('pe-account-instructions: the audited account/project and read-only files adapters are not connected; keep file instructions disabled.')
  }
  owner.install(ctx, config)
}
