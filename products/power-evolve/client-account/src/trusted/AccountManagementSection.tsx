/** Account management migrated from the original PowerEvolve account plugin. */
import { useCallback, useEffect, useRef, useState } from 'react'
import { ACCOUNT_MAX_MODELS_PER_USER } from '@power-evolve/contracts/account'
import type { AuthorizedModel } from '../client/account-api.ts'
import { AccountActionError, type AccountMutationIntent, type AccountMutationResult,
  type AccountRoleView, type AccountTranslate, type CreateAccountDraft,
  type ManagedAccountPageView, type ManagedAccountView } from './view.ts'

/** Trusted page actions; the component does not know HTTP routes or credentials. */
export interface AccountManagementProps {
  readonly currentUserId: string
  readonly displayName: string
  readonly models: readonly AuthorizedModel[]
  readonly initialSettings?: { readonly model: string; readonly maxTokens: number }
  readonly list: (cursor: string | undefined, signal: AbortSignal) => Promise<ManagedAccountPageView>
  readonly mutate: (intent: AccountMutationIntent, signal: AbortSignal) => Promise<AccountMutationResult>
  readonly lookup: (intent: AccountMutationIntent, signal: AbortSignal) => Promise<AccountMutationResult | null>
  readonly onPermissionLost: () => void
  readonly t: AccountTranslate
}

/** List, create and revise accounts while retaining ambiguous mutation identity.
 * @param props - authenticated management actions and display data.
 * @returns the management form and account list.
 */
export function AccountManagementSection(props: AccountManagementProps) {
  const { t } = props
  const [page, setPage] = useState<ManagedAccountPageView>({ items: [], nextCursor: null })
  const [loading, setLoading] = useState(true)
  const [busy, setBusy] = useState(false)
  const [problem, setProblem] = useState<Parameters<AccountTranslate>[0]>()
  const [notice, setNotice] = useState<Parameters<AccountTranslate>[0]>()
  const [secret, setSecret] = useState<{ username: string; password: string }>()
  const [unrecorded, setUnrecorded] = useState(false)
  const [pending, setPending] = useState<AccountMutationIntent>()
  const [createdCount, setCreatedCount] = useState(0)
  const pendingRef = useRef<AccountMutationIntent>()
  const write = useRef<AbortController>()
  const read = useRef<AbortController>()
  const actions = useRef(props)
  actions.current = props
  const load = useCallback(async (cursor?: string) => {
    read.current?.abort()
    const controller = new AbortController()
    read.current = controller
    setLoading(true)
    try {
      const result = await actions.current.list(cursor, controller.signal)
      if (!controller.signal.aborted) setPage(result)
    } catch (error) {
      if (controller.signal.aborted) return
      if (error instanceof AccountActionError && error.problem === 'permissionLost') {
        setSecret(undefined); setPage({ items: [], nextCursor: null }); actions.current.onPermissionLost()
      } else setProblem('managementLoadFailed')
    } finally { if (!controller.signal.aborted) setLoading(false) }
  }, [])
  useEffect(() => {
    void load()
    return () => { read.current?.abort(); write.current?.abort(); pendingRef.current = undefined }
  }, [load])

  const finish = (intent: AccountMutationIntent, result: AccountMutationResult) => {
    pendingRef.current = undefined; setPending(undefined); setUnrecorded(false)
    setProblem(undefined); setNotice('managementSaved')
    if (intent.kind === 'create') setCreatedCount(value => value + 1)
    if (result.temporaryPassword && result.account) {
      setSecret({ username: result.account.username, password: result.temporaryPassword })
    } else if (intent.kind === 'create' || intent.kind === 'reset') {
      setNotice('temporaryUnavailable')
    }
    if (intent.kind === 'remove') {
      setPage(value => ({ ...value, items: value.items.filter(account => account.userId !== intent.account.userId) }))
    } else if (result.account) {
      const updated = result.account
      setPage(value => ({ ...value, items: value.items.map(account => account.userId === updated.userId ? updated : account) }))
    }
    // A subsequent read failure cannot turn the committed gesture into a retry.
    void load()
  }
  const refuse = (error: unknown) => {
    if (error instanceof AccountActionError) {
      pendingRef.current = undefined; setPending(undefined); setUnrecorded(false)
      setProblem(error.problem)
      if (error.problem === 'permissionLost') {
        setSecret(undefined); setPage({ items: [], nextCursor: null }); props.onPermissionLost()
      } else if (error.problem === 'revisionConflict') void load()
    } else { setProblem('managementUncertain'); setUnrecorded(false) }
  }
  const run = async (intent: AccountMutationIntent, receipt = false) => {
    if (write.current) return
    const controller = new AbortController()
    write.current = controller
    pendingRef.current = intent; setPending(intent)
    setBusy(true); setProblem(undefined); setNotice(undefined)
    try {
      const result = receipt ? await props.lookup(intent, controller.signal)
        : await props.mutate(intent, controller.signal)
      if (controller.signal.aborted) return
      if (result === null) { setUnrecorded(true); setProblem('requestNotRecorded') }
      else finish(intent, result)
    } catch (error) { if (!controller.signal.aborted) refuse(error) }
    finally {
      if (write.current === controller) write.current = undefined
      if (!controller.signal.aborted) setBusy(false)
    }
  }
  const start = (intent: AccountMutationIntent) => {
    if (pendingRef.current || write.current || secret) return
    void run(intent)
  }
  const locked = busy || pending !== undefined || secret !== undefined
  return <div className="pe-account-management" data-power-evolve-account-management="">
    <header className="pe-account-management-header">
      <div><h2>{t('managementTitle')}</h2><p>{t('managementSubtitle')}</p></div>
      <div className="pe-current-account"><span>{t('currentAccount')} <strong>{props.displayName}</strong></span></div>
    </header>
    {secret && <section className="pe-users-secret" role="status">
      <strong>{t('temporaryTitle')}</strong><span>{secret.username}</span><code>{secret.password}</code>
      <p>{t('temporaryHint')}</p><button type="button" onClick={() => setSecret(undefined)}>{t('closeTemporary')}</button>
    </section>}
    {notice && <p role="status">{t(notice)}</p>}
    {problem && <div className="pe-users-error" role="alert">{t(problem)}</div>}
    {pending && <div className="pe-account-recovery">
      <button type="button" disabled={busy} onClick={() => { void run(pending, true) }}>{t('checkReceipt')}</button>
      {unrecorded && <button type="button" disabled={busy} onClick={() => { void run(pending) }}>{t('retryManagement')}</button>}
    </div>}
    <CreateAccount key={createdCount} disabled={locked || loading} models={props.models}
      {...(props.initialSettings ? { initialSettings: props.initialSettings } : {})} t={t}
      create={draft => start({ kind: 'create', requestId: crypto.randomUUID(), draft })} />
    <section className="pe-account-panel pe-account-list">
      <header><h3>{t('userList')}</h3><button type="button" disabled={busy || pending !== undefined || loading}
        onClick={() => { setProblem(undefined); void load() }}>{t('refresh')}</button></header>
      {loading && <p className="pe-account-state" role="status">{t('managementLoading')}</p>}
      {!loading && page.items.length === 0 && <div className="pe-account-state">{t('empty')}</div>}
      {page.items.map(account => <AccountRow key={`${account.userId}:${account.revision}`} account={account}
        current={account.userId === props.currentUserId} disabled={locked || loading} t={t}
        update={(displayName, role, enabled) => start({ kind: 'update', requestId: crypto.randomUUID(), account, displayName, role, enabled })}
        reset={() => start({ kind: 'reset', requestId: crypto.randomUUID(), account })}
        remove={() => { if (window.confirm(t('confirmRemove'))) start({ kind: 'remove', requestId: crypto.randomUUID(), account }) }} />)}
      {page.nextCursor && <button className="pe-users-next" type="button" disabled={locked || loading}
        onClick={() => { void load(page.nextCursor ?? undefined) }}>{t('next')}</button>}
    </section>
  </div>
}

function CreateAccount({ disabled, models, initialSettings, t, create }: {
  disabled: boolean; models: readonly AuthorizedModel[]; t: AccountTranslate; create: (draft: CreateAccountDraft) => void
  initialSettings?: { readonly model: string; readonly maxTokens: number }
}) {
  const [username, setUsername] = useState('')
  const [displayName, setDisplayName] = useState('')
  const [role, setRole] = useState<AccountRoleView>('user')
  const [model, setModel] = useState(initialSettings?.model ?? models[0]?.id ?? '')
  const [tokens, setTokens] = useState(String(initialSettings?.maxTokens ?? Math.min(models[0]?.maxTokens ?? 512, 512)))
  const [modelIds, setModelIds] = useState<readonly string[]>(model ? [model] : [])
  const selected = models.find(item => item.id === model)
  const valid = /^[a-z][a-z0-9._-]{2,63}$/u.test(username) && displayName.trim().length > 0
    && selected !== undefined && modelIds.includes(model) && /^[1-9]\d*$/u.test(tokens)
    && Number(tokens) <= Math.min(selected.maxTokens, 8192)
  return <section className="pe-account-panel pe-create-account">
    <header><h3>{t('createUserTitle')}</h3><button className="pe-account-primary" type="submit" form="pe-create-account-form"
      disabled={disabled || !valid}>{t('add')}</button></header>
    <form id="pe-create-account-form" onSubmit={event => {
      event.preventDefault()
      if (!disabled && valid) create({ username, displayName: displayName.trim(), role, model, maxTokens: Number(tokens),
        modelGrants: models.filter(item => modelIds.includes(item.id)).map(item => ({ id: item.id, maxTokens: item.maxTokens })) })
    }}>
      <label>{t('username')}<input value={username} maxLength={64} placeholder={t('usernamePlaceholder')}
        autoComplete="off" disabled={disabled} onChange={event => setUsername(event.target.value)} /></label>
      <label>{t('displayName')}<input value={displayName} maxLength={200} placeholder={t('displayName')}
        disabled={disabled} onChange={event => setDisplayName(event.target.value)} /></label>
      <label>{t('role')}<select value={role} disabled={disabled}
        onChange={event => setRole(event.target.value === 'admin' ? 'admin' : 'user')}>
        <option value="user">{t('user')}</option><option value="admin">{t('admin')}</option>
      </select></label>
      <div className="pe-generated-password"><span>{t('initialPassword')}</span><strong>{t('generatedPassword')}</strong>
        <small>{t('generatedPasswordHint')}</small></div>
      <fieldset disabled={disabled}><legend>{t('authorizedModels')}</legend>
        {models.map(item => <label key={item.id} className="pe-model-choice">
          <input type="checkbox" checked={modelIds.includes(item.id)}
            disabled={!modelIds.includes(item.id) && modelIds.length >= ACCOUNT_MAX_MODELS_PER_USER} onChange={event => {
            setModelIds(previous => event.target.checked ? [...previous, item.id] : previous.filter(id => id !== item.id))
          }} />{item.label}
        </label>)}
      </fieldset>
      <label>{t('model')}<select value={model} disabled={disabled} onChange={event => setModel(event.target.value)}>
        {models.map(item => <option key={item.id} value={item.id} disabled={!modelIds.includes(item.id)}>{item.label}</option>)}
      </select></label>
      <label>{t('maxTokens')}<input type="number" min={1} max={selected?.maxTokens ?? 8192} step={1}
        value={tokens} disabled={disabled} onChange={event => setTokens(event.target.value)} /></label>
      {models.length === 0 && <p>{t('noModels')}</p>}
    </form>
  </section>
}

function AccountRow({ account, current, disabled, t, update, reset, remove }: {
  account: ManagedAccountView; current: boolean; disabled: boolean; t: AccountTranslate
  update: (displayName: string, role: AccountRoleView, enabled: boolean) => void; reset: () => void; remove: () => void
}) {
  const [displayName, setDisplayName] = useState(account.displayName)
  return <article className="pe-account-row" data-user-id={account.userId} data-current={current || undefined}>
    <div className="pe-account-identity"><div><strong>{account.displayName}</strong>
      <span className="pe-user-badge">{t(account.role === 'admin' ? 'admin' : 'user')}</span>
      <span className="pe-user-status">{t(account.enabled ? 'active' : 'disabled')}</span></div>
      <small>@{account.username} · {t('created')} {new Intl.DateTimeFormat(undefined, { dateStyle: 'medium' }).format(new Date(account.createdAt))}</small>
      {account.passwordChangeRequired && <small>{t('passwordChangeRequired')}</small>}
      <label className="pe-account-edit-name"><span className="pe-visually-hidden">{t('displayName')} {account.username}</span>
        <input value={displayName} maxLength={200} disabled={disabled} onChange={event => setDisplayName(event.target.value)} />
        <button type="button" disabled={disabled || !displayName.trim() || displayName.trim() === account.displayName}
          onClick={() => update(displayName.trim(), account.role, account.enabled)}>{t('saveDisplayName')}</button>
      </label>
    </div>
    <label className="pe-row-role"><span className="pe-visually-hidden">{t('role')}</span><select value={account.role}
      aria-label={`${t('setRole')} ${account.username}`} disabled={disabled || current}
      onChange={event => update(account.displayName, event.target.value === 'admin' ? 'admin' : 'user', account.enabled)}>
      <option value="user">{t('user')}</option><option value="admin">{t('admin')}</option>
    </select></label>
    <div className="pe-row-status"><span>{t(account.enabled ? 'active' : 'disabled')}</span>
      <button type="button" className="pe-account-switch" role="switch" aria-checked={account.enabled}
        aria-label={`${t(account.enabled ? 'disable' : 'enable')} ${account.username}`}
        data-checked={account.enabled || undefined} disabled={disabled || current}
        onClick={() => update(account.displayName, account.role, !account.enabled)}><span /></button>
    </div>
    <button type="button" disabled={disabled || current} onClick={reset}>{t('reset')}</button>
    <button type="button" className="pe-user-danger" disabled={disabled || current}
      aria-label={`${t('remove')} ${account.username}`} onClick={remove}>{t('remove')}</button>
  </article>
}
