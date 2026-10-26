/** Request-bound model key adaptation; native credentials and AccountSaves retain all writes and ordering. */
import { symbols } from '@deepseek-ai/cordis'
import type { CredentialRef } from '@deepseek-ai/dsh-credentials'
import type { ApprovedModelKeyConfiguration } from './types.ts'
import type { AccountUse } from '@deepseek-ai/dsh-pe-cloud-runtime/types'
import type { LaunchEnvironmentSnapshot, LaunchEnvironmentSource } from '@deepseek-ai/dsh-launch-environment'
import { DSH_LAUNCH_ENVIRONMENT_KEY } from '@deepseek-ai/dsh-launch-environment'
import type { AccountApiInstall } from './account-install.ts'
import type { CloudAccountApi } from './account-service.ts'
import { CloudApiError } from './errors.ts'
import { modelKeyCodecs, type ModelKeyState, type ModelKeySaved } from './model-key-json.ts'

/**
 * Install before native provider mounting; blocks this ref without reading its ambient values.
 * Root must still audit the actual adapter/ref and the exact installed snapshot before exposing the capability.
 */
export class AccountModelKeyEnvironment implements LaunchEnvironmentSnapshot {
  private readonly references: ReadonlySet<string>
  /** @param base Original account launch snapshot. @param references Finite Root selection to mask before providers mount. */
  constructor(private readonly base: LaunchEnvironmentSnapshot, references: readonly CredentialRef[]) {
    this.references = new Set(references.map(ref => ref.toUpperCase()))
    Object.freeze(this)
  }

  /**
   * Compare the mask with the exact Root-selected references after case normalization.
   * @param references Original Root selection.
   * @returns Whether this mask covers exactly that selection.
   */
  matches(references: readonly CredentialRef[]): boolean {
    const expected = new Set(references.map(ref => ref.toUpperCase()))
    return expected.size === this.references.size && [...expected].every(ref => this.references.has(ref))
  }

  get(name: string) {
    return this.references.has(name.toUpperCase()) ? undefined : this.base.get(name)
  }

  getFrom(name: string, sources: readonly LaunchEnvironmentSource[]) {
    return this.references.has(name.toUpperCase()) ? undefined : this.base.getFrom(name, sources)
  }
}

function original(value: object): object {
  const target: unknown = Reflect.get(value, symbols.original)
  return target !== null && typeof target === 'object' ? target : value
}

function safeFailure(error: unknown): CloudApiError {
  if (error instanceof CloudApiError) {
    switch (error.code) {
      case 'cloud/config-conflict':
        return new CloudApiError(error.code, 'The credential version changed; read current state before editing.')
      case 'cloud/stale-generation':
        return new CloudApiError(error.code, 'The credential generation is unavailable; check current state before continuing.')
      case 'cloud/config-busy':
      case 'cloud/capacity':
      case 'cloud/forbidden':
        return new CloudApiError(error.code, 'The credential operation is not admitted.')
      case 'cloud/account-unavailable':
      case 'cloud/invalid-config':
      case 'cloud/invalid-project-title':
      case 'cloud/model-not-allowed':
        break
    }
  }
  return new CloudApiError('cloud/account-unavailable',
    'The credential operation has no confirmed response. Check current state; do not automatically replay writes.')
}

/** Borrowed request adapter; its caller retains and releases the original AccountUse after actual settlement. */
export interface ModelKeyAccess {
  /** @param request Closed reference JSON. @returns Only native nonsecret state and the current opaque version. */
  describe(request: unknown): Promise<ModelKeyState>
  /** @param request Closed reference, value and version JSON. @returns Confirmed persistence without the secret. */
  set(request: unknown): Promise<ModelKeySaved>
  /** @param request Closed reference and version JSON. @returns Confirmed native removal without ambient fallback. */
  unset(request: unknown): Promise<ModelKeySaved>
}

/** Bind the original borrow, API and private native installation; this registers no Remote handler.
 * @param use Original runtime-issued request borrow, never reconstructed from client identities.
 * @param api Original account API owner, including business-ready and C04 exposure checks.
 * @param install Original private native installation from that API owner.
 * @param limits Trusted Root provider/ref selection and bounds, independent of request JSON.
 * @param assertRequestCurrent Optional original carrier/Peer check, repeated in the same save turn.
 * Production ingress supplies it; omission preserves trusted in-process admission only.
 * @returns A request-local adapter with no queue, persistence, retry or additional release owner.
 */
export function bindModelKeyAccess(
  use: AccountUse, api: CloudAccountApi, install: AccountApiInstall, limits: ApprovedModelKeyConfiguration,
  assertRequestCurrent?: () => void,
): ModelKeyAccess {
  const codecs = modelKeyCodecs(limits, limits.bindings.map(binding => binding.ref)), owner = use.context
  const environment = owner.get(DSH_LAUNCH_ENVIRONMENT_KEY)
  const mask = environment === undefined ? undefined : original(environment)
  const check = (method: 'describe' | 'set' | 'unset'): void => {
    assertRequestCurrent?.()
    use.assertCurrent()
    if (use.binding !== api.binding || use.binding !== install.binding) {
      throw new CloudApiError('cloud/stale-generation', 'The credential request belongs to a different account generation.')
    }
    api.assertInstalled(owner)
    install.assertInstalled(owner)
    if (environment === undefined || !(mask instanceof AccountModelKeyEnvironment)
      || !mask.matches(limits.bindings.map(binding => binding.ref))
      || original(owner.get(DSH_LAUNCH_ENVIRONMENT_KEY) ?? {}) !== original(environment)
      || original(owner.root.get(DSH_LAUNCH_ENVIRONMENT_KEY) ?? {}) !== original(environment)) {
      throw new CloudApiError('cloud/account-unavailable', 'The approved account credential environment is unavailable.')
    }
    api.requireRpc('cloudModelKey/' + method)
    use.assertCurrent()
    assertRequestCurrent?.()
  }
  const invoke = async <T>(method: 'describe' | 'set' | 'unset', operation: () => Promise<T>): Promise<T> => {
    try {
      check(method)
      const result = await operation()
      check(method)
      return result
    } catch (error) { throw safeFailure(error) }
  }
  return Object.freeze({
    describe: (request: unknown) => invoke('describe', async () => {
      const { ref } = codecs.describe.create().parse(request)
      const { credential, version } = await install.describeCredentialEdit(ref, () => { check('describe') })
      return codecs.state.create().parse({ ref, version, configured: credential.configured, writable: credential.writable,
        ...credential.source === undefined ? {} : { source: credential.source } })
    }),
    set: (request: unknown) => invoke('set', async () => {
      const { ref, value, version } = codecs.set.create().parse(request)
      const saved = await install.setCredential(ref, value, version, () => { check('set') })
      return codecs.saved.create().parse({ version: saved, persisted: true })
    }),
    unset: (request: unknown) => invoke('unset', async () => {
      const { ref, version } = codecs.unset.create().parse(request)
      const saved = await install.unsetCredential(ref, version, () => { check('unset') })
      return codecs.saved.create().parse({ version: saved, persisted: true })
    }),
  })
}
