/** Native Settings launcher for personal and trusted account actions. */
import { useEffect, useRef, useState, type CSSProperties } from 'react'
import { Menu, MenuItemButton, type MenuEntry } from '@deepseek-ai/dsh-client-ui-primitives'
import type { PropsLocale, PropsRuntime } from '@deepseek-ai/dsh-client-ui-slots'
import { AccountHttpError, type AccountHttpClient } from './account-api.ts'
import { initials } from './identity.ts'
import { accountDestination, type AccountNavigation } from './navigation.ts'

/** Native seat props and readonly navigation supplied by the product adapter. */
export type AccountMenuProps = PropsRuntime<'settings.launcher'> & PropsLocale<'powerEvolve.account'> & {
  readonly client: AccountHttpClient
  readonly navigate: (url: string) => void
  readonly loadNavigation: (signal: AbortSignal) => Promise<AccountNavigation>
}

const triggerStyle: CSSProperties = {
  width: '100%', minHeight: 48, display: 'flex', alignItems: 'center', gap: 10, padding: '6px 8px',
  border: 0, borderRadius: 10, color: 'var(--dsw-alias-label-primary)',
  background: 'transparent', textAlign: 'left', cursor: 'pointer',
}
const avatarStyle: CSSProperties = {
  width: 32, height: 32, flex: 'none', display: 'grid', placeItems: 'center', borderRadius: 10,
  background: 'var(--dsw-alias-bg-layer-2)', color: 'var(--dsw-alias-label-primary)',
  fontSize: 12, fontWeight: 500,
}
const nameStyle: CSSProperties = { overflow: 'hidden', textOverflow: 'ellipsis', whiteSpace: 'nowrap', fontSize: 13, fontWeight: 500 }

/** One account-owned launcher in the native Settings sidebar seat.
 * @param props - native seat actions, product client and localized copy.
 * @returns the account menu trigger and its actions.
 */
export function AccountMenu({ client, navigate, loadNavigation, wide, settingsOpen, settingsShortcut, openSettings, t }: AccountMenuProps) {
  const [username, setUsername] = useState<string>()
  const [open, setOpen] = useState(false)
  const [signingOut, setSigningOut] = useState(false)
  const [failure, setFailure] = useState(false)
  const [navigation, setNavigation] = useState<AccountNavigation>()
  const logoutRequest = useRef<AbortController>()

  useEffect(() => {
    setUsername(undefined); setNavigation(undefined); setSigningOut(false); setFailure(false); setOpen(false)
    return () => { logoutRequest.current?.abort(); logoutRequest.current = undefined }
  }, [client])

  useEffect(() => {
    const controller = new AbortController()
    void client.me(controller.signal).then((value) => {
      if (!controller.signal.aborted) setUsername(value.username)
    }).catch(() => undefined)
    return () =>{  controller.abort() }
  }, [client, settingsOpen])

  useEffect(() => {
    const controller = new AbortController()
    setNavigation(undefined)
    void loadNavigation(controller.signal).then((value) => {
      if (!controller.signal.aborted) setNavigation(value)
    }).catch(() => { if (!controller.signal.aborted) setNavigation(undefined) })
    return () =>{  controller.abort() }
  }, [loadNavigation, settingsOpen])

  const signOut = async () => {
    if (logoutRequest.current) return
    const controller = new AbortController()
    logoutRequest.current = controller
    const cancelled = () => controller.signal.aborted
    setSigningOut(true); setFailure(false)
    try {
      const loginUrl = await client.loginUrl(controller.signal)
      if (cancelled()) return
      await client.logout(controller.signal)
      if (!cancelled()) navigate(loginUrl)
    } catch (error) {
      if (controller.signal.aborted) return
      setSigningOut(false); setFailure(true)
      if (error instanceof AccountHttpError && error.status === 401) setUsername(undefined)
    } finally { if (logoutRequest.current === controller) logoutRequest.current = undefined }
  }
  const closeMenu = () => { setOpen(false) }
  const changePassword = navigation === undefined ? undefined : () => {
    closeMenu()
    try { navigate(accountDestination(navigation.accountUrl, 'password')) }
    catch { setNavigation(undefined) }
  }
  const items: MenuEntry[] = [
    { type: 'label', id: 'identity', text: navigation?.displayName ?? username ?? t('accountUnavailable') },
    { type: 'separator', id: 'account-actions' },
  ]
  return <div style={{ width: '100%' }} data-power-evolve-account-launcher="">
    <Menu open={open} side="top" portal items={items} onClose={closeMenu}
      anchor={<button type="button" style={triggerStyle} aria-haspopup="menu" aria-expanded={open}
        aria-label={wide ? undefined : navigation?.displayName ?? username ?? t('account')}
        onClick={() => { setFailure(false); setOpen(value => !value) }}>
        <span style={avatarStyle} aria-hidden="true">{initials(navigation?.displayName ?? username ?? '')}</span>
        {wide && <span style={{ minWidth: 0, display: 'grid' }}>
          <span style={nameStyle}>{navigation?.displayName ?? username ?? t('account')}</span>
          {navigation && <span style={{ fontSize: 12, color: 'var(--dsw-alias-label-secondary)' }}>{t(navigation.role === 'ADMIN' ? 'admin' : 'user')}</span>}
        </span>}
      </button>}>
      <MenuItemButton {...(settingsShortcut === undefined ? {} : { shortcut: settingsShortcut })}
        onSelect={() => { closeMenu(); openSettings() }}>{t('settings')}</MenuItemButton>
      <MenuItemButton disabled={changePassword === undefined} onSelect={changePassword ?? closeMenu}>
        {t('changePassword')}
      </MenuItemButton>
      <MenuItemButton disabled={signingOut} danger onSelect={() => { closeMenu(); void signOut() }}>
        {signingOut ? t('signingOut') : t('signOut')}
      </MenuItemButton>
    </Menu>
    {failure && <div role="alert" style={{ color: 'var(--dsw-alias-state-error-primary)', fontSize: 12 }}>{t('signOutFailed')}</div>}
  </div>
}
