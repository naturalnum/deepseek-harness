/** Account admission around the original human-command registry and executor. */
import { symbols, type Context } from '@deepseek-ai/cordis'
import CommandRuntime, { type CommandDescriptor, type CommandExecution, type CommandSubmitAttachment } from '@deepseek-ai/dsh-commands'
import { remoteMethods } from '@deepseek-ai/dsh-typert-protocol'
import type { Agent } from '@deepseek-ai/dsh-agent'
import type { AccountBinding } from '@deepseek-ai/dsh-pe-cloud-runtime/types'
import type { ExposurePolicy } from './exposure.ts'
import type { NativeSessionGuards } from './native.ts'
import type { ExposureInventory } from './types.ts'
import { firstScreenNativeOwner } from './native-first-screen.ts'
import { firstScreenJsonBytes } from './first-screen-json.ts'
import { CloudApiError } from './errors.ts'
import { brandString } from '@deepseek-ai/dsh-brand'
import type { FileUploadReceiptId } from '@deepseek-ai/dsh-client-file-upload/types'

/** Original registry plus its actual guarded Remote inventory. */
export interface NativeCommands {
  readonly value: CommandRuntime
  /** Check exact installation and native Remote implementations without publishing readiness. */
  inspect(): ExposureInventory
}

const METHODS = ['list', 'execute'] as const

function unavailable(): never {
  throw new CloudApiError('cloud/account-unavailable', 'The account command registry is unavailable.')
}

/**
 * Construct the native registry with the same account and active-project checks as Session operations.
 * Registry contributions, command parsing, lifecycle events, cancellation and execution remain native.
 * @param ctx Original account Loader fiber; never the shared Root graph.
 * @param binding Exact installed generation.
 * @param assertCurrent Original business admission check.
 * @param policy Account exposure whose declarations are audited before dispatch.
 * @param guards Shared Session/project guards and explicit collection/frame limits.
 * @param maximum Existing native inventory limit.
 * @returns One graph-owned registry and its bounded inventory reader.
 */
export function createNativeCommands(
  ctx: Context, binding: AccountBinding, assertCurrent: (binding: AccountBinding) => void,
  policy: ExposurePolicy, guards: NativeSessionGuards, maximum: number,
): NativeCommands {
  const candidate = guards.firstScreen
  if (candidate === undefined || !Number.isSafeInteger(maximum) || maximum < 1) unavailable()
  const reader = candidate
  const captured: { native?: CommandRuntime } = {}
  const installed = (): void => {
    ctx.fiber.assertActive()
    if (binding.lifetime.aborted || ctx.get('peAccount') !== binding || ctx.root.get('peAccount') !== binding) {
      throw new CloudApiError('cloud/stale-generation', 'The command registry belongs to an ended account generation.')
    }
    if (policy.manifest.recipeVersion !== binding.recipeVersion) unavailable()
    if (captured.native !== undefined) {
      const current = ctx.get('commands'), target: unknown = current === undefined ? undefined : Reflect.get(current, symbols.original) ?? current
      if (target !== captured.native) unavailable()
    }
  }
  const admit = (method: typeof METHODS[number], agent: Agent): void => {
    installed()
    assertCurrent(binding)
    const row = policy.requireRpc('commands/' + method)
    if (row.handlerId !== 'native:commands' || row.guard !== 'account-session') unavailable()
    agent.ctx.fiber.assertActive()
    if (agent.ctx.get('peAccount') !== binding || agent.ctx.root !== ctx.root || ctx.get('agents')?.get(agent.id) !== agent) {
      throw new CloudApiError('cloud/forbidden', 'Commands require the original Agent in this account.')
    }
    guards.assertActiveScope(agent)
    installed()
    assertCurrent(binding)
  }
  installed()
  class AccountCommands extends CommandRuntime {
    protected override assertCommandInvocation(agent: Agent): void { admit('execute', agent) }

    override list(agent: Agent): readonly CommandDescriptor[] {
      admit('list', agent)
      const result = super.list(agent)
      if (result.length > reader.maxCollectionItems) {
        throw new CloudApiError('cloud/capacity', 'The account command catalog exceeds its collection limit.')
      }
      firstScreenJsonBytes(result, reader.maxFrameBytes)
      admit('list', agent)
      return result
    }

    override async execute(
      agent: Agent, line: string, submittedAttachments: readonly CommandSubmitAttachment[], signal: AbortSignal,
    ): Promise<CommandExecution | undefined> {
      const control = AbortSignal.any([signal, binding.lifetime])
      control.throwIfAborted()
      admit('execute', agent)
      if (submittedAttachments.some(attachment => attachment.type === 'image')) {
        throw new CloudApiError('cloud/forbidden', 'Inline encoded image intake is unavailable in this account recipe.')
      }
      const receipts = submittedAttachments.flatMap(attachment => attachment.type === 'file'
        ? [brandString<FileUploadReceiptId>(attachment.receiptId)] : [])
      if (receipts.length > 0) {
        if (guards.preparePromptFiles === undefined) unavailable()
        await guards.preparePromptFiles(agent, receipts, control)
        control.throwIfAborted()
        admit('execute', agent)
      }
      const result = await super.execute(agent, line, submittedAttachments, control)
      control.throwIfAborted()
      admit('execute', agent)
      if (result !== undefined) firstScreenJsonBytes(result, reader.maxFrameBytes)
      return result
    }
  }
  const value = new AccountCommands(ctx)
  captured.native = value
  return { value, inspect() {
    installed()
    const current = ctx.get('commands'), target: unknown = current === undefined ? undefined : Reflect.get(current, symbols.original) ?? current
    if (target !== value) unavailable()
    firstScreenNativeOwner(ctx, 'commands', value, maximum)
    const remote = value.typertRemote, markers = remoteMethods(value)
    if (remote.service !== value || remote.serviceKey !== 'commands' || remote.namespace !== 'commands'
      || markers.length !== METHODS.length || markers.length > maximum) unavailable()
    for (const method of METHODS) {
      const marker = markers.find(row => row.method === method)
      if (marker === undefined || (marker.exportName ?? method) !== method || (marker.mode ?? 'rpc') !== 'rpc'
        || Reflect.get(value, method) !== Reflect.get(AccountCommands.prototype, method)) unavailable()
    }
    return { recipeVersion: binding.recipeVersion,
      rpcEndpoints: METHODS.filter(method => policy.manifest.rpcEndpoints.some(row => row.endpoint === 'commands/' + method))
        .map(method => ({ endpoint: 'commands/' + method, handlerId: 'native:commands', guard: 'account-session' })),
      streamEndpoints: [], exactFetchRoutes: [] }
  } }
}
