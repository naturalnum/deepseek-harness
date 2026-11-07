/** Account administration in the original settings surface and account-bound transport. */
import { randomUUID } from '@deepseek-ai/dsh-util-crypto'
import type { Context } from '@deepseek-ai/cordis'
import { createSnapshotStore, type ObservableSnapshot } from '@deepseek-ai/dsh-client-store'
import type { InjectFace, PropsLocale, PropsRuntime } from '@deepseek-ai/dsh-client-ui-slots'
import type {} from '@deepseek-ai/dsh-client-ui-settings/client'
import type { PreparedCloudPage } from './prepared-page.ts'
import { ClientFailure } from './errors.ts'
import { readResponse } from './read-response.ts'
import { ACCOUNT_MANAGEMENT_NS, accountManagementDictionaries } from './account-management-locales.ts'

interface AccountRow {
  readonly id: string
  readonly email: string
  readonly displayName: string
  readonly role: 'admin' | 'user'
  readonly enabled: boolean
  readonly resourceState: string
}
interface ResourceTemplate { readonly id: string; readonly available: number }
/** Sanitized management view bound to the original native settings slot. */
export interface AccountState {
  readonly templates: readonly ResourceTemplate[]
  readonly search: string
  readonly offset: number
  readonly pageSize: number
  readonly total: number
  readonly rows: readonly AccountRow[]
  readonly pending: boolean
  readonly failed: boolean
  readonly created: boolean
}
/** Original account-bound actions and the observable projected view. */
export interface AccountFace {
  readonly hooks: { readonly accountManagement: ObservableSnapshot<AccountState> }
  submit(value: object): void
}
type Props = PropsRuntime<'settings.section'> & PropsLocale<'cloud-account-management'> & InjectFace<AccountFace>
function text(data: FormData, key: string): string { const value = data.get(key); return typeof value === 'string' ? value : '' }
function AccountManagement(props: Props) {
  const state = props.useAccountManagement(value => value), { t } = props
  const roles = <><option value="user">{t('user')}</option><option value="admin">{t('admin')}</option></>
  return <section><h1>{t('title')}</h1><p>{t('introduction')}</p>
    <form onSubmit={(event) => { event.preventDefault(); props.submit({ op: 'list', offset: 0, search: text(new FormData(event.currentTarget), 'search') }) }}>
      <label>{t('search')}<input name="search" maxLength={200}/></label><button disabled={state.pending}>{t('refresh')}</button>
    </form>
    {state.failed && <p role="alert">{t('failed')}</p>}{state.created && <p role="status">{t('created')}</p>}
    {state.pending && <p role="status">{t('pending')}</p>}
    <form onSubmit={(event) => { event.preventDefault(); const form = event.currentTarget, data = new FormData(form)
      props.submit({ op: 'create', email: text(data, 'email'), displayName: text(data, 'displayName'), password: text(data, 'password'), role: text(data, 'role'), templateId: text(data, 'templateId') }); form.reset() }}>
      <h2>{t('create')}</h2>
      <label>{t('email')}<input required name="email" type="email" maxLength={254}/></label>
      <label>{t('displayName')}<input required name="displayName" maxLength={200}/></label>
      <label>{t('password')}<input required name="password" type="password" minLength={12} maxLength={128} autoComplete="new-password"/></label>
      <label>{t('role')}<select name="role">{roles}</select></label>
      <label>{t('template')}<select name="templateId" required>{state.templates.filter(row => row.available > 0).map(row => <option key={row.id} value={row.id}>{row.id}</option>)}</select></label>
      <button disabled={state.pending || !state.templates.some(row => row.available > 0)}>{t('create')}</button>
    </form>
    {state.rows.map(row => <article key={row.id}><h2>{row.email}</h2><p>{row.enabled ? t('enabled') : row.resourceState === 'disabled' ? t('disabled') : t('loginBlocked')}</p>
      <p>{row.resourceState === 'ready' ? t('resourcesReady') : row.resourceState === 'legacy' ? t('resourcesLegacy')
        : row.resourceState === 'stop-unknown' ? t('resourcesUnknown') : t('resourcesPending')}</p>
      {!row.enabled && row.resourceState !== 'ready' && row.resourceState !== 'stop-unknown' && <form onSubmit={(event) => { event.preventDefault(); props.submit({ op: 'prepare', id: row.id, templateId: text(new FormData(event.currentTarget), 'templateId') }) }}>
        <label>{t('template')}<select name="templateId" required>{state.templates.map(item => <option key={item.id} value={item.id}>{item.id}</option>)}</select></label>
        <button disabled={state.pending || state.templates.length === 0}>{t('prepare')}</button>
      </form>}
      <form onSubmit={(event) => { event.preventDefault(); props.submit({ op: 'rename', id: row.id, displayName: text(new FormData(event.currentTarget), 'displayName') }) }}>
        <label>{t('displayName')}<input key={row.displayName} name="displayName" defaultValue={row.displayName} maxLength={200}/></label>
        <button disabled={state.pending}>{t('save')}</button>
      </form>
      <form onSubmit={(event) => { event.preventDefault(); props.submit({ op: 'role', id: row.id, role: text(new FormData(event.currentTarget), 'role') }) }}>
        <label>{t('role')}<select key={row.role} name="role" defaultValue={row.role}>{roles}</select></label><button disabled={state.pending}>{t('save')}</button>
      </form>
      <button disabled={state.pending} onClick={() => props.submit({ op: 'enabled', id: row.id,
        enabled: row.resourceState !== 'stop-unknown' && !row.enabled })}>{row.resourceState === 'stop-unknown'
          ? t('retryDisable') : row.enabled ? t('disable') : t('enable')}</button>
      <form onSubmit={(event) => { event.preventDefault(); const form = event.currentTarget
        props.submit({ op: 'password', id: row.id, password: text(new FormData(form), 'password') }); form.reset() }}>
        <label>{t('password')}<input name="password" type="password" required minLength={12} maxLength={128} autoComplete="new-password"/></label>
        <button disabled={state.pending}>{t('resetPassword')}</button>
      </form>
    </article>)}
    <button disabled={state.pending || state.offset === 0} onClick={() => props.submit({ op: 'list', search: state.search,
      offset: Math.max(0, state.offset - state.pageSize) })}>{t('previous')}</button>
    <button disabled={state.pending || state.offset + state.rows.length >= state.total} onClick={() => props.submit({ op: 'list',
      search: state.search, offset: state.offset + state.pageSize })}>{t('next')}</button>
  </section>
}

function rows(input: unknown): readonly AccountRow[] | undefined {
  if (input === null || typeof input !== 'object') return undefined
  const values: unknown = Reflect.get(input, 'accounts')
  if (!Array.isArray(values)) return undefined
  const result: AccountRow[] = []
  for (const value of values) {
    if (value === null || typeof value !== 'object') throw new TypeError('Invalid account response')
    const id: unknown = Reflect.get(value, 'id'), email: unknown = Reflect.get(value, 'email'), displayName: unknown = Reflect.get(value, 'displayName')
    const role: unknown = Reflect.get(value, 'role'), enabled: unknown = Reflect.get(value, 'enabled')
    if (typeof id !== 'string' || typeof email !== 'string' || typeof displayName !== 'string'
      || role !== 'admin' && role !== 'user' || typeof enabled !== 'boolean') throw new TypeError('Invalid account response')
    const resourceState: unknown = Reflect.get(value, 'resourceState')
    result.push({ id, email, displayName, role, enabled, resourceState: typeof resourceState === 'string' ? resourceState : 'not-provisioned' })
  }
  return result
}

/** Register the admin-only menu on the original page; server checks remain authoritative.
 * @param ctx Original Cloud client Loader.
 * @param page Existing authenticated page and its captured transport.
 */
export function installCloudAccountManagement(ctx: Context, page: PreparedCloudPage): void {
  if (page.bootstrap.account.role !== 'admin' || page.bootstrap.capabilities.accountAdministration?.state !== 'available') return
  const signal = page.lifetime.transport.signal, fetch = page.lifetime.transport.hooks.fetch
  if (fetch === undefined || signal.aborted) return
  const dependency = ctx.inject(['slots', 'locale'], (owner) => {
    const retired = new AbortController(), signal = AbortSignal.any([page.lifetime.transport.signal, retired.signal])
    let actual: Promise<void> | undefined, cleanupFailure: unknown
    owner.effect(() => async () => { retired.abort(); await actual; if (cleanupFailure !== undefined) throw cleanupFailure })
    const current = (): void => { page.assertAccountManagementCurrent(owner); signal.throwIfAborted() }
    const state = createSnapshotStore<AccountState>({ rows: [], templates: [], search: '', offset: 0, pageSize: 0, total: 0,
      pending: false, failed: false, created: false })
    const send = async (value: object): Promise<unknown> => {
      current()
      const response = await fetch('cloud/admin/accounts', { method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify(value), signal })
      const bytes = await readResponse(response, page.accountAdministrationMaxResponseBytes, signal)
      current()
      if (!response.ok) throw new Error('Account administration refused')
      return JSON.parse(new TextDecoder('utf-8', { fatal: true }).decode(bytes))
    }
    const face: AccountFace = { hooks: { accountManagement: state }, submit(value) {
      current(); if (state.getSnapshot().pending) return
      if (Reflect.get(value, 'op') === 'create' || Reflect.get(value, 'op') === 'prepare') value = { ...value, requestId: randomUUID() }
      state.set({ ...state.getSnapshot(), pending: true, failed: false, created: false })
      actual = (async () => {
        try {
          let result: unknown, operationFailed = false
          try { result = await send(value) }
          catch (error) {
            if (error instanceof ClientFailure && error.code === 'close-unconfirmed') cleanupFailure = error
            if (Reflect.get(value, 'op') === 'list') throw error
            operationFailed = true
            result = await send({ op: 'list', search: state.getSnapshot().search, offset: state.getSnapshot().offset })
          }
          const listing = rows(result)
          const response = listing === undefined ? await send({ op: 'list', search: state.getSnapshot().search, offset: state.getSnapshot().offset }) : result
          const refreshed = listing ?? rows(response)
          if (response === null || typeof response !== 'object' || refreshed === undefined) throw new TypeError('Invalid account listing')
          const rawTemplates: unknown = Reflect.get(response, 'templates'), offset: unknown = Reflect.get(response, 'offset')
          const pageSize: unknown = Reflect.get(response, 'limit'), total: unknown = Reflect.get(response, 'total')
          if (!Array.isArray(rawTemplates) || typeof offset !== 'number' || typeof pageSize !== 'number' || typeof total !== 'number') throw new TypeError('Invalid account listing')
          const templates: ResourceTemplate[] = rawTemplates.map((row: unknown) => {
            if (row === null || typeof row !== 'object') throw new TypeError('Invalid resource template')
            const id: unknown = Reflect.get(row, 'id'), available: unknown = Reflect.get(row, 'available')
            if (typeof id !== 'string' || typeof available !== 'number') throw new TypeError('Invalid resource template')
            return { id, available }
          })
          const resourceState: unknown = result !== null && typeof result === 'object' ? Reflect.get(result, 'resourceState') : undefined
          const resourceFailed = operationFailed || Reflect.get(value, 'op') === 'create' && resourceState !== 'ready'
          current(); state.set({ rows: refreshed, templates, offset, pageSize, total,
            search: Reflect.get(value, 'op') === 'list' && typeof Reflect.get(value, 'search') === 'string' ? String(Reflect.get(value, 'search')) : state.getSnapshot().search,
            pending: false, failed: resourceFailed, created: Reflect.get(value, 'op') === 'create' && !resourceFailed })
        } catch (error) {
          if (error instanceof ClientFailure && error.code === 'close-unconfirmed') cleanupFailure = error
          if (!signal.aborted) state.set({ ...state.getSnapshot(), rows: [], templates: [], total: 0, pending: false, failed: true })
        }
      })()
    } }
    owner.effect(() => owner.locale.register(ACCOUNT_MANAGEMENT_NS, accountManagementDictionaries))
    let opened = false
    owner.effect(() => owner.slots.inject('settings.section', () => owner.slots.register({ name: 'settings.section',
      id: 'cloud-account-management', locale: ACCOUNT_MANAGEMENT_NS, label: () => owner.locale.bind(ACCOUNT_MANAGEMENT_NS)('title'),
      inject: () => {
        if (!opened) {
          opened = true
          queueMicrotask(() => {
            if (signal.aborted) return
            try { face.submit({ op: 'list', search: '', offset: 0 }) }
            catch (_closedPage) { /* The retired owner cannot start another request. */ }
          })
        }
        return face
      },
    }, AccountManagement)))
  })
  const stop = (): void => { void dependency.dispose().catch(() => { console.error('Account management cleanup unconfirmed.') }) }
  signal.addEventListener('abort', stop, { once: true })
  ctx.effect(() => async () => { signal.removeEventListener('abort', stop); await dependency.dispose() })
}
