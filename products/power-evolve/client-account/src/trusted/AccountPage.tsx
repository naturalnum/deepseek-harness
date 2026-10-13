/** Platform-origin account login, password change and management composition. */
import { useEffect, useRef, useState } from 'react'
import type { AuthorizedModel } from '../client/account-api.ts'
import { AccountManagementSection, type AccountManagementProps } from './AccountManagementSection.tsx'
import { PasswordChange, type PasswordChangeIntent } from './PasswordChange.tsx'
import { AccountActionError, type AccountTranslate, type ManagedAccountView } from './view.ts'

/** Personal state read with the account audience, never through the Host. */
export interface TrustedAccountSessionView {
  readonly account: ManagedAccountView
  readonly canManage: boolean
  readonly models: readonly AuthorizedModel[]
  readonly initialSettings?: { readonly model: string; readonly maxTokens: number }
  readonly minPasswordBytes: number
  readonly maxPasswordBytes: number
  readonly productLoginUrl: string
}

/** The trusted HTTP adapter owns its in-memory bearer and shared protocol parsing. */
export interface TrustedAccountPageClient {
  readonly state: (signal: AbortSignal) => Promise<TrustedAccountSessionView>
  readonly login: (username: string, password: string, signal: AbortSignal) => Promise<TrustedAccountSessionView>
  readonly logout: (signal: AbortSignal) => Promise<void>
  readonly forget: () => void
  readonly list: AccountManagementProps['list']
  readonly mutate: AccountManagementProps['mutate']
  readonly lookup: AccountManagementProps['lookup']
  readonly changePassword: (intent: PasswordChangeIntent, signal: AbortSignal) => Promise<void>
}

/** Render only account actions available to the current trusted-page identity.
 * @param props - protocol adapter, initial hash selection and localized copy.
 * @returns the trusted account page.
 */
export function AccountPage({ client, initialView, t }: {
  readonly client: TrustedAccountPageClient
  readonly initialView: 'password' | 'admin'
  readonly t: AccountTranslate
}) {
  const [session, setSession] = useState<TrustedAccountSessionView>()
  const [loading, setLoading] = useState(true)
  const [view, setView] = useState(initialView)
  const [notice, setNotice] = useState<'passwordChanged' | 'permissionLost' | 'signOutFailed' | 'trustedLoadFailed'>()
  const request = useRef<AbortController>()
  // This latch owns gestures synchronously, before React commits the disabled button.
  const logoutRequest = useRef<AbortController>()
  const expire = (nextNotice?: typeof notice) => {
    request.current?.abort(); logoutRequest.current?.abort()
    client.forget(); setSession(undefined); setLoading(false); setNotice(nextNotice)
  }
  const load = async () => {
    request.current?.abort()
    const controller = new AbortController()
    request.current = controller; setLoading(true)
    try {
      const value = await client.state(controller.signal)
      if (!controller.signal.aborted) { setSession(value); setNotice(undefined) }
    } catch (error) {
      if (controller.signal.aborted) return
      if (error instanceof AccountActionError && error.problem === 'permissionLost') expire(undefined)
      else setNotice('trustedLoadFailed')
    } finally { if (!controller.signal.aborted) setLoading(false) }
  }
  useEffect(() => {
    void load()
    return () => {
      request.current?.abort(); logoutRequest.current?.abort(); logoutRequest.current = undefined
      client.forget()
    }
  }, [client])
  const logout = async () => {
    if (logoutRequest.current) return
    const controller = new AbortController(); logoutRequest.current = controller
    setLoading(true)
    try {
      await client.logout(controller.signal)
      if (!controller.signal.aborted) expire(undefined)
    } catch (error) {
      if (controller.signal.aborted) return
      if (error instanceof AccountActionError && error.problem === 'permissionLost') expire('permissionLost')
      else setNotice('signOutFailed')
    } finally {
      if (logoutRequest.current === controller) logoutRequest.current = undefined
      if (!controller.signal.aborted) setLoading(false)
    }
  }
  const select = (next: 'password' | 'admin') => {
    setView(next); window.history.replaceState(null, '', `#${next}`)
  }
  const required = session?.account.passwordChangeRequired === true
  return <main className="pe-trusted-account pe-account-management">
    <header><strong>PowerEvolve</strong>
      {session && <>
        <span>{session.account.displayName}</span>
        <nav aria-label={t('account')}>
          <button type="button" onClick={() =>{  select('password') }}>{t('changePassword')}</button>
          {!required && session.canManage && <button type="button" onClick={() =>{  select('admin') }}>{t('managementNav')}</button>}
        </nav>
        {!required && <a href={session.productLoginUrl}>{t('returnToProduct')}</a>}
        <button type="button" disabled={loading} onClick={() => { void logout() }}>{t('signOut')}</button>
      </>}
    </header>
    {notice && <p role={notice === 'passwordChanged' ? 'status' : 'alert'} className="pe-users-error">{t(notice)}</p>}
    {loading && <p role="status">{t('accountUnavailable')}</p>}
    {!loading && !session && <AccountLogin t={t} login={async (username, password, signal) => {
      const value = await client.login(username, password, signal)
      if (!signal.aborted) { setSession(value); setNotice(undefined) }
    }} />}
    {notice === 'trustedLoadFailed' && <button type="button" disabled={loading} onClick={() => { void load() }}>{t('refresh')}</button>}
    {!loading && session && (required || view === 'password' || !session.canManage)
      && <PasswordChange required={required} minBytes={session.minPasswordBytes} maxBytes={session.maxPasswordBytes}
        change={client.changePassword} onChanged={() =>{  expire('passwordChanged') }} onExpired={() =>{  expire('permissionLost') }} t={t} />}
    {!loading && session && !required && session.canManage && view === 'admin'
      && <AccountManagementSection currentUserId={session.account.userId} displayName={session.account.displayName}
        models={session.models} {...(session.initialSettings ? { initialSettings: session.initialSettings } : {})}
        list={client.list} mutate={client.mutate} lookup={client.lookup}
        onPermissionLost={() =>{  expire('permissionLost') }} t={t} />}
  </main>
}

function AccountLogin({ login, t }: {
  login: (username: string, password: string, signal: AbortSignal) => Promise<void>
  t: AccountTranslate
}) {
  const [username, setUsername] = useState('')
  const [password, setPassword] = useState('')
  const [busy, setBusy] = useState(false)
  const [failed, setFailed] = useState(false)
  const request = useRef<AbortController>()
  useEffect(() => () => request.current?.abort(), [])
  const submit = async () => {
    if (request.current) return
    const controller = new AbortController(); request.current = controller
    setBusy(true); setFailed(false)
    try { await login(username, password, controller.signal) }
    catch {
      if (!controller.signal.aborted) { setPassword(''); setFailed(true) }
    } finally {
      request.current = undefined
      if (!controller.signal.aborted) setBusy(false)
    }
  }
  return <section className="pe-account-panel pe-account-login">
    <header><h2>{t('accountLogin')}</h2></header>
    <form onSubmit={(event) => { event.preventDefault(); void submit() }}>
      <p>{t('accountLoginHint')}</p>
      <label>{t('username')}<input autoComplete="username" required maxLength={80} value={username} disabled={busy}
        onChange={(event) =>{  setUsername(event.target.value) }} /></label>
      <label>{t('password')}<input type="password" autoComplete="current-password" required maxLength={256} value={password} disabled={busy}
        onChange={(event) =>{  setPassword(event.target.value) }} /></label>
      {failed && <p role="alert" className="pe-users-error">{t('loginFailed')}</p>}
      <button type="submit" disabled={busy}>{t(busy ? 'loggingIn' : 'login')}</button>
    </form>
  </section>
}
