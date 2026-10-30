/** Original account page owns qualified plugin facts and one explicitly opened edit. */
import type { Context } from '@deepseek-ai/cordis'
import { brandString } from '@deepseek-ai/dsh-brand'
import { createSnapshotStore } from '@deepseek-ai/dsh-client-store'
import type { PreparedCloudPage } from '../../prepared-page.ts'
import { ClientFailure } from '../../errors.ts'
import type { ManagementNotice } from '../ManagementActionToast.tsx'
import type { AccountPluginText } from './account-projection.ts'
import { pluginCardFromCurrent } from './current-card.ts'
import { preparePagePluginEdit, readPagePluginState } from './page-plugin-edit.ts'
import type { PreparedAccountPluginEdit, AccountPluginEditOutcome, AccountPluginEditState } from './plugin-edit.ts'
import { pluginFieldDraft, pluginFieldPolicy, pluginLiteralDraft, samePluginPath, validPluginDraft } from './plugin-schema.ts'
import type { AccountPluginCard, AccountPluginCatalog, AccountPluginEditor, AccountPluginId, AccountPluginMode,
  PluginManagementInjected } from './types.ts'

type Display = {
  readonly id: string
  readonly plugin?: Pick<NonNullable<AccountPluginEditState['plugin']>, 'meta' | 'moduleName'>
  readonly bundle?: Pick<NonNullable<AccountPluginEditState['bundle']>, 'meta' | 'name' | 'description'>
}
type Report = (action: ManagementNotice['action'], outcome: ManagementNotice['outcome']) => void
type Active = { readonly controller: AbortController; readonly kind: 'refresh' | 'edit'; prepared: PreparedAccountPluginEdit | undefined }

/**
 * Bind approved current/change to the original page source without installing or removing a package.
 * @param owner Original dependency scope holding the actual generated namespace.
 * @param page Original immutable page and captured Connection.
 * @param text Resolve each plugin's published metadata in the current locale, without account reads.
 * @param report Existing common management Toast callback.
 * @returns The one catalog injection and synchronous revocation before native cleanup waits.
 */
export function createPagePluginCatalog(owner: Context, page: PreparedCloudPage, text: (state: Display) => AccountPluginText,
  report: Report): { readonly injected: PluginManagementInjected; readonly dispose: () => void } {
  const approved = page.bootstrap.capabilities.configuration.plugins
  const catalog = createSnapshotStore<AccountPluginCatalog>(Object.freeze({ phase: 'unread', plugins: Object.freeze([]), refreshing: false }))
  // Only native display metadata is retained for locale changes; configuration and edit versions stay with their original interaction.
  const facts = new Map<string, Display>()
  const display = (state: AccountPluginEditState): Display => ({ id: state.id,
    ...state.plugin === undefined ? {} : { plugin: { moduleName: state.plugin.moduleName,
      ...state.plugin.meta === undefined ? {} : { meta: state.plugin.meta } } },
    ...state.bundle === undefined ? {} : { bundle: { name: state.bundle.name,
      ...state.bundle.meta === undefined ? {} : { meta: state.bundle.meta },
      ...state.bundle.description === undefined ? {} : { description: state.bundle.description } } } })
  let current = true, active: Active | undefined
  const check = (): void => { if (!current) throw new ClientFailure('closed'); page.assertAccountManagementCurrent(owner) }
  const controls = { toggle: 'available', configuration: 'available' } as const
  const card = (state: AccountPluginEditState): AccountPluginCard => {
    const approval = approved.find(item => item.id === state.id)
    if (approval === undefined) throw new ClientFailure('closed')
    return Object.freeze(pluginCardFromCurrent(state, text(state), controls, approval))
  }
  const replace = (rows: readonly AccountPluginCard[], state: AccountPluginEditState): readonly AccountPluginCard[] => {
    facts.set(state.id, display(state))
    return Object.freeze(rows.map(row => row.id === state.id ? card(state) : row))
  }
  const updateEditor = (patch: Partial<AccountPluginEditor>): void => {
    check()
    const before = catalog.getSnapshot()
    if (before.editor === undefined) throw new ClientFailure('closed')
    catalog.set(Object.freeze({ ...before, editor: Object.freeze({ ...before.editor, ...patch }) }))
  }
  const close = (): void => {
    check()
    const before = catalog.getSnapshot()
    if (before.editor === undefined || before.editor.phase === 'submitting') return
    active?.controller.abort(); active = undefined
    const { editor: _editor, ...rest } = before
    catalog.set(Object.freeze(rest))
  }
  const chooseField = (path: readonly string[]): void => {
    check()
    const editor = catalog.getSnapshot().editor
    const field = editor?.fields?.find(field => samePluginPath(field.path, path))
    if (editor?.phase !== 'editing' || editor.action !== 'configure' || field === undefined) throw new ClientFailure('closed')
    const valueText = pluginFieldDraft(field)
    updateEditor({ path: field.path, valueText, invalid: pluginFieldPolicy(field).writable && !validPluginDraft(valueText) })
  }
  const editValue = (valueText: string): void => {
    check()
    const editor = catalog.getSnapshot().editor
    if (editor?.phase !== 'editing' || editor.action !== 'configure' || editor.path === undefined) throw new ClientFailure('closed')
    const field = editor.fields?.find(item => samePluginPath(item.path, editor.path ?? []))
    if (field === undefined || !pluginFieldPolicy(field).writable) throw new ClientFailure('closed')
    updateEditor({ valueText, invalid: !validPluginDraft(valueText) })
  }
  const submit = (mode: AccountPluginMode): void => {
    check()
    const operation = active, editor = catalog.getSnapshot().editor, prepared = operation?.prepared
    if (operation?.kind !== 'edit' || prepared === undefined || editor?.phase !== 'editing') return
    if (editor.action === 'configure' && !editor.fields?.some(field => samePluginPath(field.path, editor.path ?? [])
      && pluginFieldPolicy(field).writable)) return
    const change = editor.action === 'configure' && editor.path !== undefined && editor.valueText !== undefined && editor.invalid === false
      ? { kind: 'configure' as const, path: editor.path, value: pluginLiteralDraft(JSON.parse(editor.valueText)) }
      : editor.action === 'enabled' && editor.enabled !== undefined ? { kind: 'enabled' as const, enabled: editor.enabled }
        : editor.action === 'selected' && editor.selected !== undefined ? { kind: 'selected' as const, selected: editor.selected } : undefined
    if (change === undefined) return
    operation.prepared = undefined
    updateEditor({ phase: 'submitting' })
    const action = change.kind === 'configure' ? 'plugin-configure' : 'plugin-toggle'
    void (async () => {
      let result: AccountPluginEditOutcome
      try { result = await prepared.submit(change, mode, operation.controller.signal) }
      catch { result = { kind: 'unknown' } }
      if (!current || active !== operation) return
      try {
        check()
        const before = catalog.getSnapshot()
        const plugins = result.kind === 'applied' ? replace(before.plugins, result.state)
          : Object.freeze(before.plugins.map(plugin => plugin.id !== prepared.state.id ? plugin : Object.freeze({ ...plugin,
            toggle: result.kind === 'busy' ? 'busy' as const : 'unknown' as const,
            configuration: result.kind === 'busy' ? 'busy' as const : 'unknown' as const })))
        catalog.set(Object.freeze({ ...before, phase: 'ready', plugins,
          ...before.editor === undefined ? {} : { editor: Object.freeze({ ...before.editor, phase: 'result' as const, outcome: result.kind }) } }))
        report(action, result.kind === 'applied' ? 'confirmed' : result.kind)
      } catch (_withdrawn) { /* The original page already revoked this interaction. */ }
    })()
  }
  const open = (id: AccountPluginId, action: AccountPluginEditor['action'], value?: boolean): void => {
    check()
    const before = catalog.getSnapshot(), row = before.plugins.find(plugin => plugin.id === id)
    if (active !== undefined || before.editor !== undefined || before.phase !== 'ready'
      || row?.approved !== true
      || (action === 'configure' ? row.configuration : row.toggle) !== 'available'
      || action !== 'selected' && row.installed !== true
      || action === 'selected' && (row.selectionTarget?.kind !== 'bundle' || row.selected == null || value === undefined)
      || action === 'enabled' && (row.selectionTarget?.kind === 'bundle' || row.enabled === null || value === undefined)) return
    const operation: Active = { controller: new AbortController(), kind: 'edit', prepared: undefined }; active = operation
    const editor: AccountPluginEditor = Object.freeze({ phase: 'opening', action,
      ...action === 'enabled' && value !== undefined ? { enabled: value } : {},
      ...action === 'selected' && value !== undefined ? { selected: value } : {},
      chooseField: (path: readonly string[]) => { if (active !== operation) throw new ClientFailure('closed'); chooseField(path) },
      editValue: (text: string) => { if (active !== operation) throw new ClientFailure('closed'); editValue(text) },
      submit: (mode: AccountPluginMode) => { if (active !== operation) throw new ClientFailure('closed'); submit(mode) },
      close: () => { if (active === operation) close() } })
    catalog.set(Object.freeze({ ...before, editor }))
    void (async () => {
      try {
        const prepared = await preparePagePluginEdit(owner, page, id, operation.controller.signal)
        operation.controller.signal.throwIfAborted(); check()
        if (active !== operation) return
        const refreshed = card(prepared.state)
        if ((action === 'configure' ? refreshed.configuration : refreshed.toggle) !== 'available'
          || action === 'selected' && refreshed.selectionTarget?.kind !== 'bundle'
          || action === 'enabled' && refreshed.selectionTarget?.kind !== 'entry') throw new ClientFailure('closed')
        operation.prepared = prepared
        const fields = prepared.state.configuration.fields, field = fields[0]
        const valueText = field === undefined ? '' : pluginFieldDraft(field)
        const before = catalog.getSnapshot()
        catalog.set(Object.freeze({ ...before, plugins: replace(before.plugins, prepared.state),
          editor: Object.freeze({ ...editor, phase: 'editing',
            ...action !== 'configure' ? {} : { fields, ...field === undefined ? {} : { path: field.path }, valueText,
              invalid: field === undefined || pluginFieldPolicy(field).writable && !validPluginDraft(valueText) } }) }))
      } catch (_unavailable) {
        if (!current || active !== operation) return
        try {
          check()
          const before = catalog.getSnapshot()
          catalog.set(Object.freeze({ ...before, plugins: Object.freeze(before.plugins.map(plugin => plugin.id !== id ? plugin
            : Object.freeze({ ...plugin, toggle: 'unknown' as const, configuration: 'unknown' as const }))) }))
          updateEditor({ phase: 'result', outcome: 'unavailable' })
          report(action === 'configure' ? 'plugin-configure' : 'plugin-toggle', 'unavailable')
        } catch (_withdrawn) { /* The original page already revoked this interaction. */ }
      }
    })()
  }
  const refresh = (): void => {
    try { check() } catch (_closed) { return }
    if (active !== undefined || catalog.getSnapshot().editor !== undefined) return
    const operation: Active = { controller: new AbortController(), kind: 'refresh', prepared: undefined }; active = operation
    const signal = AbortSignal.any([operation.controller.signal, page.lifetime.transport.signal]), before = catalog.getSnapshot()
    catalog.set(Object.freeze({ ...before, phase: before.plugins.length ? 'ready' : 'loading', refreshing: true }))
    void (async () => {
      try {
        const rows: AccountPluginCard[] = []
        const observed: AccountPluginEditState[] = []
        for (const approval of approved) {
          const state = await readPagePluginState(owner, page, brandString<AccountPluginId>(approval.id), signal)
          signal.throwIfAborted(); check(); rows.push(card(state)); observed.push(state)
        }
        for (const state of observed) facts.set(state.id, display(state))
        catalog.set(Object.freeze({ phase: 'ready', plugins: Object.freeze(rows), refreshing: false }))
        report('plugin-refresh', 'confirmed')
      } catch (error) {
        if (current && !signal.aborted) {
          try {
            check()
            if (error instanceof ClientFailure && error.code === 'plugin-management-unavailable') {
              catalog.set(Object.freeze({ phase: 'unavailable', plugins: Object.freeze([]), refreshing: false }))
            } else {
              catalog.set(Object.freeze({ phase: 'error', plugins: catalog.getSnapshot().plugins, refreshing: false }))
              report('plugin-refresh', 'unavailable')
            }
          } catch (_closed) { /* The original owner already retired this read. */ }
        }
      } finally { if (active === operation) active = undefined }
    })()
  }
  owner.effect(() => owner.locale.subscribe(() => {
    if (!current) return
    const before = catalog.getSnapshot()
    catalog.set(Object.freeze({ ...before, plugins: Object.freeze(before.plugins.map((plugin) => {
      const state = facts.get(plugin.id)
      return state === undefined ? plugin : Object.freeze({ ...plugin, ...text(state) })
    })) }))
  }), 'pe-cloud-client: plugin display language')
  return { injected: { hooks: { accountPluginCatalog: catalog }, refreshPluginCatalog: refresh,
    requestPluginEnabled: (id, enabled) => { open(id, 'enabled', enabled) },
    requestPluginSelected: (id, selected) => { open(id, 'selected', selected) }, openPluginConfiguration: (id) => { open(id, 'configure') } },
  dispose: () => {
    if (!current) return
    current = false; active?.controller.abort(); active = undefined; facts.clear()
    catalog.set(Object.freeze({ ...catalog.getSnapshot(), phase: 'unavailable', refreshing: false }))
  } }
}
