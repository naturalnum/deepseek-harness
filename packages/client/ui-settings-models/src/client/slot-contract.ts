/**
 * Models-page extension slots — the two seats through which a plugin
 * distributed outside this repository adds UI to the Models settings section
 * without editing it.
 *
 * `settings.models.provider-card` is keyed by the row's owning settings
 * namespace (`ProviderDirectoryEntry.settingsNs`): an adapter family's
 * companion plugin registers one entry under the family's namespace and
 * receives every card of that family — shipped, added, and hand-declared rows
 * alike — while the section never learns what the namespace means. Keying on
 * the namespace follows `settings.plugin.item`, and the key domain stays the
 * open string space because hand-declared route ids are user-chosen at
 * runtime.
 *
 * TYPE HOME RATIONALE: the Models section declares these slots at runtime,
 * and a plugin registering an extension already depends on this package for
 * the declaration. The types therefore live with their declarer.
 */

import type {} from '@deepseek-ai/dsh-client-ui-slots'
import type { ProviderDirectoryEntry } from './store.ts'
import type { ProviderEditorProps } from './ProviderEditor.tsx'
import type { ModelsCredentialEditing } from './operations.ts'

declare module '@deepseek-ai/dsh-client-ui-slots' {
  interface SlotFactoryMap {
    /** Original provider editor; the Native registration owns operations, schema and locale. */
    'settings.models.provider-editor': {
      scope: 'root'
      props: ModelsProviderEditorInput
      inject: Pick<ProviderEditorProps, 'operations' | 'schema'>
      locale: 'settings.models'
    }
  }
  interface SlotMap {
    /** Optional key-only row contribution; omission keeps the original Native row. */
    'settings.models.provider.credentials': {
      kind: 'single'
      scope: 'root'
      owner: ModelsCredentialActionsOwnerProps
    }

    /**
     * One provider card's adapter extension area, dispatched with
     * `entryKey = settingsNs` on every card that renders a directory row: a
     * saved row's card (its first-run setup posture included) and the
     * add-provider draft card. The hand-declared draft card has no directory
     * row yet, so it dispatches nothing until saved. Without a registrant the
     * area renders nothing.
     */
    'settings.models.provider-card': { kind: 'keyed'; scope: 'root'; owner: ProviderCardExtrasOwnerProps }
    /** Optional account login choice before the credential editor. */
    'settings.models.sign-in': { kind: 'single'; scope: 'root'; owner: { complete: () => void; useApiKey: () => void } }
    /**
     * Ordered extension area after the provider rows and the add controls.
     * Without a registrant the area renders nothing.
     */
    'settings.models.footer': { kind: 'list'; scope: 'root'; owner: ModelsFooterOwnerProps }
  }
}

/** Owner share of one provider-card extension occurrence. */
export interface ProviderCardExtrasOwnerProps {
  /** The card's directory row (route id, display name, settings address, live state). */
  provider: ProviderDirectoryEntry
  /** Whether any layer configures this provider (its profile resolves); `false` while the add-provider draft edits a dormant row. */
  configured: boolean
  /** Whether the row's referenced api-key credential is confirmed configured (the page's credential join). */
  keyConfigured: boolean
}

/** Owner share of the footer area (the section supplies nothing). */
export interface ModelsFooterOwnerProps {
  /** Marker field: footer owner props are intentionally empty. */
  children?: never
}


/** JSON and callbacks accepted by the original Native provider-editor Factory. */
export type ModelsProviderEditorInput = Omit<ProviderEditorProps, 'operations' | 'schema' | 't'>

/** Original row data and captured page callbacks; no service or component crosses this boundary. */
export interface ModelsCredentialActionsOwnerProps extends Pick<ProviderEditorProps,
  'provider' | 'displayName' | 'namespace' | 'settingsPath'> {
  /** Exact reference reported by the original metadata join. */
  readonly reference: string
  /** Redacted configured fact; only controls whether removal is offered. */
  readonly configured: boolean
  /** Changing the original page scope retires the mounted intent. */
  readonly scope: string
  /** Currentness belongs to the original page. */
  readonly isCurrent: ModelsCredentialEditing['isCurrent']
  /** Prepare one exact-reference intent using the original page callback. */
  readonly prepare: ModelsCredentialEditing['prepare']
  /** Refresh the original metadata only after confirmed current-scope persistence. */
  readonly onSaved: () => void
}
