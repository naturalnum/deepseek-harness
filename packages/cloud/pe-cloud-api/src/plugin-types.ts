/** Catalog-approved plugin controls; native PluginInfo and ChangeResult remain the inventory and management records. */
import type { JsonValue } from '@deepseek-ai/dsh-util-values'
import type { ApprovedPluginControl } from './types.ts'
import type { Context } from '@deepseek-ai/cordis'
import type { BundleInfo, PluginInfo, ChangeResult } from '@deepseek-ai/dsh-plugin-manager/types'
import type { PeerScope } from '@deepseek-ai/dsh-typert-protocol'
import type { AccountBinding, AccountUse, OperationId } from '@deepseek-ai/dsh-pe-cloud-runtime/types'
import type { PluginEditVersion } from './save-hooks.ts'

/** Positive deployment bounds for complete profile/request/reply bytes and opaque versions. */
export interface PluginControlLimits {
  readonly maxProfileBytes: number
  readonly maxRequestBytes: number
  readonly maxReplyBytes: number
  readonly maxVersionBytes: number
}
/** Catalog identity; the approved catalog owns its native selection and exact code mapping. */
export interface PluginCurrentRequest { readonly id: string }
/** One approved ordinary field, projected from its original native Config schema. */
export interface PluginConfigurationField {
  readonly path: readonly string[]
  readonly schema: JsonValue
  readonly acceptsMissing: boolean | 'unknown'
  readonly limitations: readonly string[]
  /** Complete-leaf replacement is allowed only for ordinary fields without protected descendants. */
  readonly writable: boolean
  readonly readOnlyReason?: 'secret' | 'live' | 'protected' | 'unproven'
  /** Relative native secret positions; values and secret defaults never cross this DTO. */
  readonly secrets: readonly { readonly path: readonly string[]; readonly set: boolean }[]
  /** Raw literal value, present only when the complete field is writable and set. */
  readonly value?: JsonValue
}
/** Actual native inventory, approved ordinary fields and the original save-owner version. */
export interface PluginCurrentState {
  readonly id: string
  readonly plugin?: PluginInfo
  readonly bundle?: BundleInfo
  readonly selectionTarget: ApprovedPluginControl['selectionTarget']
  readonly operations: ApprovedPluginControl['operations']
  readonly maxImpact?: ApprovedPluginControl['maxImpact']
  readonly configuration: Readonly<{ fields: readonly PluginConfigurationField[] }>
  readonly version: PluginEditVersion
}
/** One selection or approved ordinary-field edit; module specifiers and profile filenames are never supplied. */
export type PluginOperation = Readonly<{ kind: 'enabled'; enabled: boolean }>
  | Readonly<{ kind: 'selected'; selected: boolean }>
  | Readonly<{ kind: 'configure'; path: readonly string[]; value: JsonValue }>
/** Explicit local idle request or terminal new-generation rebuild, both bound to the original read version. */
export interface PluginChangeRequest extends PluginCurrentRequest {
  readonly version: PluginEditVersion
  readonly mode: 'if-idle' | 'stop-and-apply'
  readonly operation: PluginOperation
}
/** Applied means native apply and original account re-audit succeeded; accepted rebuild requires reconnect and read. */
export type PluginChangeResult = Readonly<{ kind: 'applied'; value: PluginCurrentState; native?: ChangeResult }>
  | Readonly<{ kind: 'accepted-rebuild'; operationId: OperationId }>
/** Original verified login handoff; no Peer, root or account identity is supplied by JSON. */
export interface PluginPeerHandoff {
  readonly afterRequest: () => Promise<void>
  readonly closeAll: (deadlineAtMs: number) => Promise<void>
  readonly assertPrincipal: () => void
}
/** This callback consumes the original login registry's actual Use; it must not fabricate idle admission. */
export type ConfigurationPeerOperation<T> = (binding: AccountBinding, context: AccountUse['context'],
  assertLoginCurrent: () => void, closeObservers: () => Promise<void>, handoff: PluginPeerHandoff) => Promise<T>
/** Original login registry capability, shared structurally with the access owner. */
export interface ConfigurationPeerConsumer {
  /** @param peer Original invocation Peer.
 * @param current Original caller recheck.
 * @param consume Complete operation.
   * @param mode Terminal mode schedules and returns before closing its own native request.
   * @returns Actual local result or terminal acceptance.
   */
  withConfigurationPeer<T>(peer: PeerScope, consume: ConfigurationPeerOperation<T>,
    mode?: 'if-idle' | 'stop-and-apply'): Promise<T>
}
/** Immutable intent transferred only after the old save owner checked its original opaque edit and disk revision. */
export interface PluginRebuildIntent {
  readonly id: string
  readonly revision: string
  readonly operation: PluginOperation
}
/** Original factory callback types, reused without another configuration queue. */
export interface PluginFactoryControl {
  /** @param binding Original verified epoch.
 * @param closeObservers Actual Peer closure/join.
   * @param operation Native edit/application in the factory's actual exclusive window.
   * @returns Actual same-root, same-epoch operation and re-audit settlement.
   */
  withIdleConfiguration<T>(binding: AccountBinding, closeObservers: () => Promise<void>,
    operation: (ctx: Context, assertCurrent: () => void) => Promise<T>): Promise<T>
}

/** Native persistence result; restart-required remains distinct from replacement-graph application. */
export interface PluginRebuildPersistence {
  readonly epoch: PluginEditVersion['epoch']
  readonly id: string
  readonly revision: string
  readonly operation: PluginOperation
  readonly native?: ChangeResult
}

/** Intent verification on a distinct native graph; Factory ready CAS remains necessary for final application. */
export interface PluginRebuildVerification {
  readonly persisted: PluginRebuildPersistence
  readonly value: PluginCurrentState
}
