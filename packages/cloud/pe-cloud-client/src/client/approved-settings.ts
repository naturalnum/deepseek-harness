/** Approved live fields over the original shared Settings mirror, schema service and serial writer. */
import type { Context } from '@deepseek-ai/cordis'
import { observeCloudDisposal } from './observe-disposal.ts'
import { SettingsFormModel, type SettingsFieldSpec, type SettingsFormScope } from '@deepseek-ai/dsh-client-ui-primitives'
import type { ConfigForms, SchemaNode, SettingsSchemaService } from '@deepseek-ai/dsh-client-ui-settings/client'
import type { BootstrapConfigurationField } from '@deepseek-ai/dsh-pe-cloud-access/types'
import type { SettingsPathOpView } from '@deepseek-ai/dsh-api-remotes/client'
import type { PreparedCloudPage } from './prepared-page.ts'
import { ClientFailure } from './errors.ts'
import { ApprovedSettingsForm, ApprovedSettingsSection, type ApprovedSettingsFace, type ApprovedSettingsState } from './ApprovedSettings.tsx'
import { APPROVED_SETTINGS_NS, approvedSettingsDictionaries } from './approved-settings-locales.ts'

type Scalar = string | number | boolean
interface Leaf { readonly field: string; readonly kind: 'string' | 'number' | 'boolean'; readonly choices?: readonly Scalar[] }
function scalar(value: unknown): value is Scalar { return typeof value === 'string' || typeof value === 'number' || typeof value === 'boolean' }
function leaf(field: string, node: SchemaNode | undefined): Leaf | undefined {
  if (node === undefined || node.meta.hidden || node.meta.disabled || node.meta.role === 'secret') return undefined
  if (node.type === 'string' || node.type === 'number' || node.type === 'boolean') return { field, kind: node.type }
  const constant: unknown = node.value
  const choices: unknown[] | undefined = node.type === 'const' ? [constant] : node.type === 'union'
    && node.list?.every(item => item.type === 'const') ? node.list.map((item): unknown => item.value) : undefined
  if (choices === undefined || choices.length === 0 || !choices.every(scalar)) return undefined
  const first = choices[0]
  const kind = typeof first
  if (kind !== 'string' && kind !== 'number' && kind !== 'boolean' || choices.some(value => typeof value !== kind)) return undefined
  return { field, kind, choices }
}
function projection(forms: ConfigForms, schema: SettingsSchemaService, fields: readonly BootstrapConfigurationField[], namespace: string) {
  const view = forms.describe().getSnapshot().view?.namespaces.find(row => row.ns === namespace)
  const names = [...new Set(fields.filter(row => row.application === 'live' && row.namespace === namespace).map(row => row.path))]
  const supported: Leaf[] = [], unsupported: string[] = []
  let root: SchemaNode | undefined
  try { if (view !== undefined) root = schema.rehydrate(view.schema) } catch (_invalidSchema) { /* No editable fields. */ }
  if (root?.meta.hidden || root?.meta.disabled || root?.meta.role === 'secret') root = undefined
  for (const name of names) {
    const node = root?.type === 'object' && root.dict !== undefined && Object.hasOwn(root.dict, name) ? root.dict[name] : undefined
    const item = view?.secrets.some(secret => secret.path[0] === name) ? undefined : leaf(name, node)
    if (item === undefined) unsupported.push(name)
    else supported.push(item)
  }
  return { view, supported, unsupported, fingerprint: JSON.stringify([view?.schema, names, supported, unsupported]) }
}
/** One original model and its retirement; the exposed face is plain state/actions.
 * @param forms Original page's shared form provider.
 * @param schema Original page's schema service.
 * @param fields Immutable bootstrap display approval, intersected again before actual dispatch.
 * @param namespace Actual Host namespace.
 * @param current Original page, transport and dependency check.
 * @returns Native staged face plus synchronous retirement; no queue or persistence owner is added.
 */
export function createApprovedSettingsForm(
  forms: ConfigForms, schema: SettingsSchemaService,
  fields: readonly BootstrapConfigurationField[], namespace: string, current: () => void,
): { fingerprint: string; face: ApprovedSettingsFace; dispose: () => void } {
  const selected = projection(forms, schema, fields, namespace), shared = forms.get<Record<string, unknown>>(namespace)
  let active = true
  const check = (): void => {
    current()
    if (!active || forms.describe().getSnapshot().error !== null
      || selected.fingerprint !== projection(forms, schema, fields, namespace).fingerprint
      || shared.getSnapshot().status !== 'ready' || !shared.getSnapshot().writable) throw new ClientFailure('closed')
  }
  const specs: SettingsFieldSpec[] = selected.supported.map(item => ({ field: item.field,
    format: value => scalar(value) ? String(value) : '',
    parse: (text) => {
      if (text === '' && item.kind !== 'string') return { kind: 'clear' }
      const value = item.kind === 'number' ? Number(text) : item.kind === 'boolean'
        ? text === 'true' ? true : text === 'false' ? false : undefined : text
      if (!scalar(value) || typeof value === 'number' && (!Number.isFinite(value) || text.trim() === '')) return undefined
      const serialized = selected.view?.schema
      if (serialized === undefined) return undefined
      const node = schema.nodeAtPath(schema.rehydrate(serialized), [item.field])
      return node !== undefined && schema.validate(node, value) === undefined ? { kind: 'set', value } : undefined
    },
  }))
  const scope: SettingsFormScope<Record<string, unknown>> = {
    getSnapshot: () => {
      const snapshot = shared.getSnapshot()
      return { ...snapshot, writable: snapshot.writable && forms.describe().getSnapshot().error === null }
    },
    subscribe: (listener) => {
      let failed = forms.describe().getSnapshot().error !== null
      const offValue = shared.subscribe(listener)
      const offMirror = forms.describe().subscribe(() => {
        const next = forms.describe().getSnapshot().error !== null
        if (next !== failed) { failed = next; listener() }
      })
      return () => { offValue(); offMirror() }
    },
    mutate: (ops, revision) => {
      check()
      if (revision === undefined || ops.some(op => op.path.length !== 1 || !selected.supported.some(item => item.field === op.path[0]))) {
        throw new ClientFailure('closed')
      }
      const writes: SettingsPathOpView[] = ops.map((op) => {
        if (op.op === 'unset') return { op: 'unset', path: [...op.path] }
        if (!scalar(op.value)) throw new ClientFailure('closed')
        return { op: 'set', path: [...op.path], value: op.value }
      })
      return shared.mutate(writes, revision, check)
    },
  }
  const model = new SettingsFormModel(scope, specs)
  const store = model.bind<ApprovedSettingsState>(() => ({ ...model.shell(), namespace, unsupported: selected.unsupported,
    fields: selected.supported.map(item => ({ ...item, ...model.field(item.field) })) }))
  const face: ApprovedSettingsFace = { ...model.actions(), hooks: { approvedSettings: store } }
  return { fingerprint: selected.fingerprint, face, dispose: () => { active = false; model.dispose() } }
}

/** Register one approved Settings section under the immutable original Cloud page.
 * @param ctx Original Cloud Loader context.
 * @param page Original page; revocation synchronously withdraws every contribution before cleanup waits.
 */
export function installCloudApprovedSettings(ctx: Context, page: PreparedCloudPage): void {
  installApprovedSettingsFields(ctx, page.bootstrap.capabilities.configuration.fields, page.lifetime.transport.signal,
    (owner) => { page.assertAccountManagementCurrent(owner) }, page.nativeSettingsRequestTimeoutMs !== undefined)
}

/** Bind the original page's fields, cancellation and current check to native Settings contributions.
 * @param ctx Original Cloud Loader owner.
 * @param approved Original immutable bootstrap descriptors.
 * @param signal Original page transport lifetime.
 * @param assertCurrent Original page and dependency check; supplies no replacement carrier.
 * @param inGeneral Whether native preferences own their original controls and remaining fields sit under General.
 */
export function installApprovedSettingsFields(ctx: Context, approved: readonly BootstrapConfigurationField[],
  signal: AbortSignal, assertCurrent: (owner: Context) => void, inGeneral = false): void {
  const nativePreferences: Readonly<Record<string, readonly string[]>> = {
    locale: ['preference'], 'ui-settings': ['enabled'],
    'ui-theme': ['preference', 'fontSize', 'codeFontSize', 'terminalFontSize', 'textFontFamily', 'codeFontFamily', 'terminalFontFamily'],
    'ui-chat': ['transcriptView', 'collapseTiming', 'performanceUsage', 'linkOpening'],
  }
  const fields = approved.filter(field => field.application === 'live'
    && (!inGeneral || nativePreferences[field.namespace]?.includes(field.path) !== true))
  const isAborted = (): boolean => signal.aborted
  if (fields.length === 0 || isAborted()) return
  let stopped = false, withdraw: (() => void) | undefined
  const dependency = ctx.inject(['slots', 'locale', 'configForms', 'settingsSchema'], (owner) => {
    const current = (): void => {
      if (stopped) throw new ClientFailure('closed')
      assertCurrent(owner); signal.throwIfAborted()
    }
    current()
    const forms = owner.configForms, schema = owner.settingsSchema
    const records = new Map<string, { fingerprint: string; dispose: () => void }>()
    const removeCopy = owner.locale.register(APPROVED_SETTINGS_NS, approvedSettingsDictionaries)
    const sync = (): void => {
      current()
      const views = forms.describe().getSnapshot().view?.namespaces ?? []
      const served = new Set(views.map(view => view.ns))
      for (const [name, record] of records) {
        if (!served.has(name) || record.fingerprint !== projection(forms, schema, fields, name).fingerprint) {
          records.delete(name); record.dispose()
        }
      }
      for (const name of new Set(fields.map(field => field.namespace))) {
        if (!served.has(name) || records.has(name)) continue
        const record = createApprovedSettingsForm(forms, schema, fields, name, current)
        const remove = owner.slots.inject('settings.approved.namespace', () => owner.slots.register({
          name: 'settings.approved.namespace', id: name, locale: APPROVED_SETTINGS_NS, inject: () => record.face,
        }, ApprovedSettingsForm))
        records.set(name, { fingerprint: record.fingerprint, dispose: () => { record.dispose(); remove() } })
      }
    }
    const removeSection = forms.whileServed([...new Set(fields.map(field => field.namespace))], () => {
      if (inGeneral) return owner.slots.inject('settings.general.item', () => owner.slots.register({
        name: 'settings.general.item', id: 'cloud-approved-configuration', order: 80, locale: APPROVED_SETTINGS_NS,
        inject: () => ({ general: true }),
        children: { 'settings.approved.namespace': { kind: 'list', scope: 'root' } },
      }, ApprovedSettingsSection))
      return owner.slots.inject('settings.section', () => owner.slots.register({
        name: 'settings.section', id: 'cloud-approved-configuration', locale: APPROVED_SETTINGS_NS,
        label: () => owner.locale.bind(APPROVED_SETTINGS_NS)('title'),
        children: { 'settings.approved.namespace': { kind: 'list', scope: 'root' } },
      }, ApprovedSettingsSection))
    })
    const unsubscribe = forms.describe().subscribe(sync)
    const retire = (): void => {
      unsubscribe(); for (const record of records.values()) record.dispose()
      records.clear(); removeSection(); removeCopy()
    }
    withdraw = retire
    owner.effect(() => retire, 'pe-cloud-client: approved configuration section')
    sync()
  })
  const stop = (): void => {
    if (stopped) return
    stopped = true; withdraw?.(); withdraw = undefined
    void observeCloudDisposal(dependency.dispose).catch(() => { console.error('Cloud configuration withdrawal unconfirmed.') })
  }
  signal.addEventListener('abort', stop, { once: true })
  ctx.effect(() => async () => { stop(); signal.removeEventListener('abort', stop); await dependency.dispose() },
    'pe-cloud-client: retire approved configuration')
  if (isAborted()) stop()
}
