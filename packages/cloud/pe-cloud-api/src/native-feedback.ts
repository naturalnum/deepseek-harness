/** Account admission around the original Session and per-message feedback services. */
import { createHash } from 'node:crypto'
import { symbols, type Context } from '@deepseek-ai/cordis'
import { SessionFeedbackService } from '@deepseek-ai/dsh-command-feedback'
import type { SessionFeedbackRecordRequest, SessionFeedbackRecordResult } from '@deepseek-ai/dsh-command-feedback/types'
import MessageFeedbackService from '@deepseek-ai/dsh-message-feedback'
import type {
  MessageFeedbackDeleteRequest, MessageFeedbackDeleteResult, MessageFeedbackListRequest, MessageFeedbackListResult,
  MessageFeedbackPutRequest, MessageFeedbackPutResult,
} from '@deepseek-ai/dsh-message-feedback/types'
import type { SessionId } from '@deepseek-ai/dsh-session/types'
import { remoteMethods } from '@deepseek-ai/dsh-typert-protocol'
import type { AccountBinding } from '@deepseek-ai/dsh-pe-cloud-runtime/types'
import type { ExposurePolicy } from './exposure.ts'
import type { NativeSessionGuards } from './native.ts'
import type { ExposureInventory } from './types.ts'
import { firstScreenNativeOwner } from './native-first-screen.ts'
import { firstScreenJsonBytes } from './first-screen-json.ts'
import { CloudApiError } from './errors.ts'

/** Original feedback service plus the inventory backed by its guarded methods. */
export interface NativeFeedback<T extends SessionFeedbackService | MessageFeedbackService> {
  readonly value: T
  /** Recheck exact native installation and selected method metadata. */
  inspect(): ExposureInventory
}

type FeedbackNamespace = 'sessionFeedback' | 'messageFeedback'
type FeedbackMethod = 'record' | 'list' | 'put' | 'delete'

function unavailable(): never {
  throw new CloudApiError('cloud/account-unavailable', 'The original account feedback service is unavailable.')
}

/**
 * Supply an account-scoped acknowledgement identifier without reading or writing a Host home.
 * The domain-separated digest is display metadata, never an authentication credential.
 * @param ctx Original account Loader fiber owning the callback.
 * @param binding Exact installed account generation.
 * @param assertCurrent Original business admission check, invoked before an acknowledgement can record feedback.
 * @returns Synchronous native command identity callback; an ended owner rejects without host I/O.
 */
export function createNativeFeedbackIdentity(
  ctx: Context, binding: AccountBinding, assertCurrent: (binding: AccountBinding) => void,
): () => string {
  const installed = (): void => {
    ctx.fiber.assertActive()
    if (binding.lifetime.aborted || ctx.get('peAccount') !== binding || ctx.root.get('peAccount') !== binding) {
      throw new CloudApiError('cloud/stale-generation', 'The feedback identity belongs to an ended account generation.')
    }
  }
  return () => {
    installed()
    assertCurrent(binding)
    installed()
    return createHash('sha256').update('dsh-pe/feedback-anonymous/v1\0')
      .update(`${Buffer.byteLength(binding.accountId, 'utf8')}:`, 'ascii').update(binding.accountId, 'utf8').digest('hex')
  }
}

/** Private admission shared only by the two original feedback namespaces. */
function feedbackAdmission(
  ctx: Context, binding: AccountBinding, assertCurrent: (binding: AccountBinding) => void,
  policy: ExposurePolicy, guards: NativeSessionGuards, maximum: number, namespace: FeedbackNamespace,
) {
  const candidate = guards.firstScreen
  if (candidate === undefined || !Number.isSafeInteger(maximum) || maximum < 1) unavailable()
  const reader = candidate
  let native: SessionFeedbackService | MessageFeedbackService | undefined
  const installed = (): void => {
    ctx.fiber.assertActive()
    if (binding.lifetime.aborted || ctx.get('peAccount') !== binding || ctx.root.get('peAccount') !== binding) {
      throw new CloudApiError('cloud/stale-generation', 'The feedback service belongs to an ended account generation.')
    }
    if (policy.manifest.recipeVersion !== binding.recipeVersion) unavailable()
    if (native !== undefined) {
      const scoped = ctx.get(namespace)
      const original: unknown = scoped === undefined ? undefined : Reflect.get(scoped, symbols.original) ?? scoped
      if (original !== native) unavailable()
    }
  }
  const admit = (method: FeedbackMethod, sessionId: SessionId): void => {
    installed()
    assertCurrent(binding)
    const row = policy.requireRpc(namespace + '/' + method)
    if (row.handlerId !== 'native:' + namespace || row.guard !== 'account-session') unavailable()
    reader.assertSessionRead(sessionId)
    installed()
    assertCurrent(binding)
  }
  const prepare = async (method: FeedbackMethod, request: { readonly sessionId: SessionId }): Promise<void> => {
    admit(method, request.sessionId)
    firstScreenJsonBytes(request, reader.maxFrameBytes)
    await guards.assertSessionProject(request.sessionId)
    admit(method, request.sessionId)
  }
  installed()
  return { admit, prepare, maxCollectionItems: reader.maxCollectionItems,
    result<T>(method: FeedbackMethod, sessionId: SessionId, value: T): T {
      admit(method, sessionId)
      firstScreenJsonBytes(value, reader.maxFrameBytes)
      return value
    },
    install(value: SessionFeedbackService | MessageFeedbackService) { native = value },
    inspect(
      value: SessionFeedbackService | MessageFeedbackService, methods: readonly FeedbackMethod[], implementation: object,
    ): ExposureInventory {
      installed()
      firstScreenNativeOwner(ctx, namespace, value, maximum)
      const remote = value.typertRemote, markers = remoteMethods(value)
      if (remote.service !== value || remote.serviceKey !== namespace || remote.namespace !== namespace
        || markers.length !== methods.length || markers.length > maximum) unavailable()
      for (const method of methods) {
        const marker = markers.find(row => row.method === method)
        if (marker === undefined || (marker.exportName ?? method) !== method || (marker.mode ?? 'rpc') !== 'rpc'
          || Reflect.get(value, method) !== Reflect.get(implementation, method)) unavailable()
      }
      return { recipeVersion: binding.recipeVersion,
        rpcEndpoints: methods.filter(method => policy.manifest.rpcEndpoints.some(row => row.endpoint === namespace + '/' + method))
          .map(method => ({ endpoint: namespace + '/' + method, handlerId: 'native:' + namespace, guard: 'account-session' })),
        streamEndpoints: [], exactFetchRoutes: [] }
    },
  }
}

/**
 * Construct original Session-level feedback with the account's project and generation checks.
 * Native eager log append and its recorded-only acknowledgement remain unchanged.
 * @param ctx Original account Loader fiber.
 * @param binding Exact installed account generation.
 * @param assertCurrent Original business admission check.
 * @param policy Original reviewed account exposure.
 * @param guards Same Session/project checks and existing finite response limits.
 * @param maximum Existing native method-inventory limit.
 * @returns Guarded native Session feedback and its exact RPC inventory.
 */
export function createNativeSessionFeedback(
  ctx: Context, binding: AccountBinding, assertCurrent: (binding: AccountBinding) => void,
  policy: ExposurePolicy, guards: NativeSessionGuards, maximum: number,
): NativeFeedback<SessionFeedbackService> {
  const admission = feedbackAdmission(ctx, binding, assertCurrent, policy, guards, maximum, 'sessionFeedback')
  class AccountSessionFeedback extends SessionFeedbackService {
    override async record(request: SessionFeedbackRecordRequest): Promise<SessionFeedbackRecordResult> {
      await admission.prepare('record', request)
      admission.admit('record', request.sessionId)
      return admission.result('record', request.sessionId, await super.record(request))
    }
  }
  const value = new AccountSessionFeedback(ctx)
  admission.install(value)
  return { value, inspect: () => admission.inspect(value, ['record'], AccountSessionFeedback.prototype) }
}

/**
 * Construct native message feedback with admission inside its original serialization and append points.
 * The original native queue, persistence reads, compare-and-set, flush and handle closure remain intact.
 * @param ctx Original account Loader fiber.
 * @param binding Exact installed account generation.
 * @param assertCurrent Original business admission check.
 * @param policy Original reviewed account exposure.
 * @param guards Same Session/project checks and existing finite response limits.
 * @param maximum Existing native method-inventory limit.
 * @param config Original native feedback note-size policy.
 * @returns Guarded native message feedback and its exact RPC inventory.
 */
export function createNativeMessageFeedback(
  ctx: Context, binding: AccountBinding, assertCurrent: (binding: AccountBinding) => void,
  policy: ExposurePolicy, guards: NativeSessionGuards, maximum: number,
  config: ConstructorParameters<typeof MessageFeedbackService>[1],
): NativeFeedback<MessageFeedbackService> {
  const admission = feedbackAdmission(ctx, binding, assertCurrent, policy, guards, maximum, 'messageFeedback')
  class AccountMessageFeedback extends MessageFeedbackService {
    protected override assertSessionAccess(sessionId: SessionId, method: 'list' | 'put' | 'delete'): void {
      admission.admit(method, sessionId)
    }

    override async list(request: MessageFeedbackListRequest): Promise<MessageFeedbackListResult> {
      await admission.prepare('list', request)
      const value = await super.list(request)
      if (value.ok && value.value.items.length > admission.maxCollectionItems) {
        throw new CloudApiError('cloud/capacity', 'The account feedback list exceeds its selected collection limit.')
      }
      return admission.result('list', request.sessionId, value)
    }

    override async put(request: MessageFeedbackPutRequest): Promise<MessageFeedbackPutResult> {
      await admission.prepare('put', request)
      return admission.result('put', request.sessionId, await super.put(request))
    }

    override async delete(request: MessageFeedbackDeleteRequest): Promise<MessageFeedbackDeleteResult> {
      await admission.prepare('delete', request)
      return admission.result('delete', request.sessionId, await super.delete(request))
    }
  }
  const value = new AccountMessageFeedback(ctx, config)
  admission.install(value)
  return { value, inspect: () => admission.inspect(value, ['list', 'put', 'delete'], AccountMessageFeedback.prototype) }
}
