import type { CSSProperties, ReactNode } from 'react'
import type { Context } from '@deepseek-ai/cordis'
import type {} from '@deepseek-ai/dsh-client-locale/client'
import type {} from '@deepseek-ai/dsh-client-ui-renderer/client'
import type {} from '@deepseek-ai/dsh-client-ui-settings/client'
import type { PropsLocale, PropsRuntime } from '@deepseek-ai/dsh-client-ui-slots'
import { POWER_EVOLVE_MARK } from './branding.tsx'

/** Public upstream project represented by the About surface. */
export const DSH_PROJECT_URL = 'https://github.com/deepseek-ai/deepseek-harness'

/** Product and validated DSH runtime versions shown in the packaged About page. */
export const POWER_EVOLVE_VERSION = '0.1.0'
export const DSH_RUNTIME_VERSION = '0.1.7-rc.2'

/** Simplified Chinese About copy and locale-key source of truth. */
export const zh = {
  nav: '关于',
  tagline: '桌面与云端贯通的 Agent 工作空间',
  description: 'PowerEvolve 让会话、工作区和获授权的执行环境在云端与桌面间协作。',
  foundation: '本产品基于 DeepSeek Harness（DSH）的 Agent Runtime、Web Client 和插件体系构建。',
  productVersion: 'PowerEvolve',
  runtimeVersion: 'DSH Runtime',
  projectLink: '了解 DeepSeek Harness',
} satisfies Record<string, string>

/** About locale keys shared by every dictionary. */
export type PowerEvolveAboutLocaleKey = keyof typeof zh

/** English About copy checked against the Chinese key set. */
export const en = {
  nav: 'About',
  tagline: 'An Agent workspace across desktop and cloud',
  description: 'PowerEvolve connects conversations, workspaces, and authorized execution across cloud and desktop.',
  foundation: 'Built on the Agent Runtime, Web Client, and plugin system of DeepSeek Harness (DSH).',
  productVersion: 'PowerEvolve',
  runtimeVersion: 'DSH Runtime',
  projectLink: 'Learn about DeepSeek Harness',
} satisfies Record<PowerEvolveAboutLocaleKey, string>

declare module '@deepseek-ai/dsh-client-ui-slots' {
  interface LocaleNamespaceMap {
    /** PowerEvolve product and DSH foundation copy. */
    'powerEvolve.about': PowerEvolveAboutLocaleKey
  }
}

/** Dictionary namespace owned by the PowerEvolve About section. */
export const ABOUT_LOCALE_NAMESPACE = 'powerEvolve.about'

/** Full props assembled by the settings section outlet. */
export type AboutSectionProps = PropsRuntime<'settings.section'> & PropsLocale<'powerEvolve.about'>

const pageStyle: CSSProperties = {
  display: 'flex',
  flexDirection: 'column',
  gap: 24,
  maxWidth: 560,
  padding: '18px 4px',
  color: 'var(--dsw-alias-label-primary)',
}

const identityStyle: CSSProperties = {
  display: 'flex',
  alignItems: 'center',
  gap: 16,
}

const markStyle: CSSProperties = {
  flex: 'none',
  width: 52,
  height: 52,
  borderRadius: 14,
  background: `${POWER_EVOLVE_MARK} center / contain no-repeat`,
}

const titleStyle: CSSProperties = {
  margin: 0,
  fontSize: 22,
  lineHeight: '30px',
  fontWeight: 600,
}

const mutedStyle: CSSProperties = {
  margin: '4px 0 0',
  color: 'var(--dsw-alias-label-secondary)',
  fontSize: 14,
  lineHeight: '22px',
}

const cardStyle: CSSProperties = {
  display: 'flex',
  flexDirection: 'column',
  gap: 12,
  padding: 20,
  border: '1px solid var(--dsw-alias-border-l2)',
  borderRadius: 16,
  background: 'var(--dsw-alias-bg-layer-1)',
  fontSize: 14,
  lineHeight: '22px',
}

const paragraphStyle: CSSProperties = { margin: 0 }

const versionsStyle: CSSProperties = {
  display: 'flex',
  flexDirection: 'column',
  gap: 8,
  marginTop: 4,
  padding: '12px 14px',
  borderRadius: 12,
  background: 'var(--dsw-alias-bg-layer-2)',
}

const versionRowStyle: CSSProperties = {
  display: 'flex',
  alignItems: 'center',
  justifyContent: 'space-between',
  gap: 16,
}

const versionValueStyle: CSSProperties = {
  fontFamily: 'ui-monospace, SFMono-Regular, Menlo, Monaco, Consolas, monospace',
  fontSize: 13,
  fontWeight: 600,
  fontVariantNumeric: 'tabular-nums',
}

const linkStyle: CSSProperties = {
  alignSelf: 'flex-start',
  color: 'var(--dsw-alias-brand-primary)',
  fontWeight: 500,
  textDecoration: 'none',
}

/** Render the PowerEvolve product identity and its DSH foundation. */
export function AboutSection({ t }: AboutSectionProps): ReactNode {
  return (
    <section style={pageStyle} data-power-evolve-about>
      <header style={identityStyle}>
        <span style={markStyle} aria-hidden="true" />
        <div>
          <h2 style={titleStyle}>PowerEvolve</h2>
          <p style={mutedStyle}>{t('tagline')}</p>
        </div>
      </header>
      <div style={cardStyle}>
        <p style={paragraphStyle}>{t('description')}</p>
        <p style={paragraphStyle}>{t('foundation')}</p>
        <div style={versionsStyle}>
          <div style={versionRowStyle}>
            <span>{t('productVersion')}</span>
            <strong style={versionValueStyle}>v{POWER_EVOLVE_VERSION}</strong>
          </div>
          <div style={versionRowStyle}>
            <span>{t('runtimeVersion')}</span>
            <strong style={versionValueStyle}>v{DSH_RUNTIME_VERSION}</strong>
          </div>
        </div>
        <a style={linkStyle} href={DSH_PROJECT_URL} target="_blank" rel="noreferrer">
          {t('projectLink')}
        </a>
      </div>
    </section>
  )
}

/** Contribute the localized About page through DSH's public Settings slot. */
export function registerPowerEvolveAbout(ctx: Context): void {
  ctx.effect(
    () => ctx.locale.register(ABOUT_LOCALE_NAMESPACE, { zh, en }),
    '@power-evolve/client-brand: About dictionaries',
  )
  const t = ctx.locale.bind(ABOUT_LOCALE_NAMESPACE)
  ctx.slots.inject('settings.section', () => ctx.slots.register({
    name: 'settings.section',
    id: 'power-evolve-about',
    order: 1000,
    label: () => t('nav'),
    locale: ABOUT_LOCALE_NAMESPACE,
  }, AboutSection))
}
