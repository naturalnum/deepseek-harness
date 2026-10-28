/** Cookie-authenticated sidebar launcher composed inside the original Settings shell. */
import { useEffect, useRef, useState } from 'react'
import { IconSettingsOutlineMedium, IconUserOutlineMedium, Menu, Toast, Tooltip } from '@deepseek-ai/dsh-client-ui-primitives'
import type { InjectFace, PropsLocale, PropsRuntime } from '@deepseek-ai/dsh-client-ui-slots'
import type {} from '@deepseek-ai/dsh-client-ui-settings/client'
import type {} from './account-locales.ts'
import css from './CloudAccountMenu.module.css'

/** Fixed bootstrap display text and the original page's single sign-out action. */
export interface CloudAccountMenuInjected {
  readonly displayName: string
  readonly signOut: () => void
}
/** Native settings launcher owner props plus the account-fixed action and localized copy. */
export type CloudAccountMenuProps = PropsRuntime<'settings.launcher'> & PropsLocale<'cloud-account'> & InjectFace<CloudAccountMenuInjected>

/** Original AccountMenu's IcDsLogOutOutline16 artwork; no account-service dependency. */
function LogoutIcon() {
  return <svg aria-hidden="true" width="16" height="16" viewBox="0 0 16 16" fill="none">
    <g transform="translate(1.168 1.214)" fill="currentColor">
      <path d="M3.9961 1.40039C3.37842 1.40039 2.96028 1.40039 2.63867 1.42871C2.32631 1.45627 2.17171 1.50666 2.06641 1.56543C1.85606 1.68288 1.68189 1.85605 1.56446 2.06641C1.50569 2.17173 1.45625 2.32627 1.42871 2.63867C1.40036 2.9603 1.39942 3.37827 1.39942 3.9961L1.39942 9.5752C1.39942 10.193 1.40036 10.611 1.42871 10.9326C1.45625 11.245 1.50569 11.3996 1.56445 11.5049C1.68188 11.7153 1.85605 11.8884 2.06641 12.0059C2.17171 12.0646 2.32631 12.115 2.63867 12.1426C2.96028 12.1709 3.37842 12.1709 3.9961 12.1709V13.5713C3.4033 13.5713 2.91297 13.5721 2.51563 13.5371C2.10906 13.5013 1.73277 13.4233 1.38379 13.2285C0.946838 12.9845 0.585697 12.6235 0.341799 12.1865C0.14725 11.8377 0.0700118 11.4621 0.0341815 11.0557C-0.000847399 10.6583 1.58129e-06 10.1681 1.85029e-06 9.5752L2.09416e-06 3.9961C1.83027e-06 3.40325 -0.000846367 2.91297 0.0341818 2.51563C0.0700164 2.10924 0.147239 1.73362 0.341799 1.38477C0.585703 0.947758 0.946825 0.586744 1.38379 0.342775C1.73277 0.148001 2.10906 0.0700381 2.51563 0.0341813C2.91297 -0.000823893 3.40331 1.37805e-06 3.9961 1.71712e-06L3.9961 1.40039Z" />
      <path d="M13.6426 6.51953C13.6705 6.6957 13.6705 6.8756 13.6426 7.05176C13.5902 7.38188 13.4302 7.64112 13.2539 7.86035C13.0857 8.06937 12.8546 8.29971 12.6006 8.55371L9.3086 11.8447L8.31836 10.8545L11.6104 7.56348C11.637 7.53681 11.6628 7.51104 11.6875 7.48633H3.74317V6.08594H11.6885C11.6635 6.06088 11.6374 6.03487 11.6104 6.00781L8.31836 2.7168L9.3086 1.72656L12.6006 5.01758C12.8547 5.27169 13.0857 5.50185 13.2539 5.71094C13.4303 5.93018 13.5902 6.18939 13.6426 6.51953Z" />
    </g>
  </svg>
}

/**
 * Render a bottom account row and an upward, body-portaled native menu.
 * @param props Existing Settings navigation, sidebar geometry and account-fixed callbacks.
 * @returns Avatar/name launcher; Settings remains owned by the original shell.
 */
export function CloudAccountMenu({ wide, settingsOpen, settingsShortcut, openSettings, displayName, signOut, t }: CloudAccountMenuProps) {
  const [open, setOpen] = useState(false), [submitted, setSubmitted] = useState(false), [failed, setFailed] = useState(false)
  const trigger = useRef<HTMLButtonElement>(null)
  useEffect(() => { if (settingsOpen) setOpen(false) }, [settingsOpen])
  const label = t('menu', { name: displayName })
  return <div className={css.root}>
    {failed && <Toast text={t('unavailable')} onDone={() => { setFailed(false) }} />}
    <Menu open={open && !settingsOpen} side="top" portal autoFocus className={css.anchor} listClassName={css.menu}
      anchor={<Tooltip label={label} disabled={wide || open} portal><button ref={trigger} type="button" className={css.trigger} data-collapsed={!wide} aria-label={label}
        disabled={submitted} aria-haspopup="menu" aria-expanded={open && !settingsOpen}
        onClick={() => { setOpen(value => !value) }}>
        <span className={css.avatar} aria-hidden="true"><IconUserOutlineMedium size={16} /></span>
        {wide && <span className={css.label}>{displayName}</span>}
      </button></Tooltip>}
      items={[
        { id: 'settings', label: t('settings'), icon: <IconSettingsOutlineMedium size={16} />,
          ...(settingsShortcut === undefined ? {} : { shortcut: settingsShortcut }) },
        { id: 'signout', label: t('signOut'), icon: <LogoutIcon />, disabled: submitted },
      ]}
      onClose={() => { setOpen(false) }}
      onSelect={(id) => {
        setOpen(false)
        trigger.current?.focus()
        if (id === 'settings') openSettings()
        else if (id === 'signout' && !submitted) {
          setSubmitted(true)
          try { signOut() }
          catch (_unavailable: unknown) { setFailed(true) }
        }
      }} />
  </div>
}
