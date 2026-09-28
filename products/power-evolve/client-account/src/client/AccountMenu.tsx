import { useEffect, useState, type CSSProperties } from 'react'
import { Menu, type MenuEntry } from '@deepseek-ai/dsh-client-ui-primitives'
import type { PropsLocale, PropsRuntime } from '@deepseek-ai/dsh-client-ui-slots'
import { AccountHttpError, type AccountHttpClient } from './account-api.ts'
import { initials } from './identity.ts'

export type AccountMenuProps = PropsRuntime<'settings.launcher'> & PropsLocale<'powerEvolve.account'> & {
  readonly client: AccountHttpClient
  readonly navigate: (url: string) => void
}

const triggerStyle: CSSProperties = {
  width: '100%', minHeight: 48, display: 'flex', alignItems: 'center', gap: 10, padding: '6px 8px',
  border: 0, borderRadius: 10, color: 'var(--dsw-alias-label-primary)',
  background: 'transparent', textAlign: 'left', cursor: 'pointer',
}
const avatarStyle: CSSProperties = {
  width: 32, height: 32, flex: 'none', display: 'grid', placeItems: 'center', borderRadius: 10,
  background: 'var(--dsw-alias-bg-layer-2)', color: 'var(--dsw-alias-label-primary)',
  fontSize: 12, fontWeight: 650,
}
const nameStyle: CSSProperties = { overflow: 'hidden', textOverflow: 'ellipsis', whiteSpace: 'nowrap', fontSize: 13, fontWeight: 600 }

/** One account-owned launcher in the native Settings sidebar seat. */
export function AccountMenu({ client, navigate, wide, settingsOpen, settingsShortcut, openSettings, t }: AccountMenuProps) {
  const [username, setUsername] = useState<string>()
  const [open, setOpen] = useState(false)
  const [signingOut, setSigningOut] = useState(false)
  const [failure, setFailure] = useState(false)

  useEffect(() => {
    const controller = new AbortController()
    void client.me(controller.signal).then(value => {
      if (!controller.signal.aborted) setUsername(value.username)
    }).catch(() => undefined)
    return () => controller.abort()
  }, [client, settingsOpen])

  const signOut = async () => {
    setSigningOut(true); setFailure(false)
    try {
      const loginUrl = await client.loginUrl()
      await client.logout()
      navigate(loginUrl)
    } catch (error) {
      setSigningOut(false); setFailure(true)
      if (error instanceof AccountHttpError && error.status === 401) setUsername(undefined)
    }
  }
  const items: MenuEntry[] = [
    { type: 'label', id: 'identity', text: username ?? t('accountUnavailable') },
    { type: 'separator', id: 'account-actions' },
    { id: 'settings', label: t('settings'), ...(settingsShortcut === undefined ? {} : { shortcut: settingsShortcut }) },
    { id: 'sign-out', label: signingOut ? t('signingOut') : t('signOut'), disabled: signingOut, danger: true },
  ]
  return <div style={{ width: '100%' }} data-power-evolve-account-launcher="">
    <Menu open={open} side="top" portal items={items} onClose={() => setOpen(false)}
      onSelect={id => {
        if (id === 'settings') { setOpen(false); openSettings() }
        else if (id === 'sign-out' && !signingOut) { setOpen(false); void signOut() }
      }}
      anchor={<button type="button" style={triggerStyle} aria-haspopup="menu" aria-expanded={open}
        aria-label={wide ? undefined : username ?? t('account')}
        onClick={() => { setFailure(false); setOpen(value => !value) }}>
        <span style={avatarStyle} aria-hidden="true">{initials(username ?? '')}</span>
        {wide && <span style={nameStyle}>{username ?? t('account')}</span>}
      </button>} />
    {failure && <div role="alert" style={{ color: 'var(--dsw-alias-state-error-primary)', fontSize: 12 }}>{t('signOutFailed')}</div>}
  </div>
}
