/** Account plugin cards and details; mutations remain with injected account owners. */
import { useId, useState, type ReactNode } from 'react'
import clsx from 'clsx'
import {
  Button, IconChevronLeftOutlineMedium, IconRefreshOutlineRegular, Input, Pill,
  PluginArtworkDefault, PluginArtworkLoop, PluginArtworkSearch, PluginArtworkTerminal,
  StateDot, Switch, Tag, Tooltip,
} from '@deepseek-ai/dsh-client-ui-primitives'
import type { InjectFace, PropsLocale, PropsRuntime } from '@deepseek-ai/dsh-client-ui-slots'
export type {} from '@deepseek-ai/dsh-client-ui-layout/client'
import type { AccountPluginCard, PluginCategory, PluginControl, PluginManagementInjected } from './types.ts'
import { filterPlugins } from './catalog.ts'
import { PluginEditPanel } from './PluginEditPanel.tsx'
export type {} from './locales.ts'
import css from './PluginManagementPage.module.css'

/** The native main slot's owner and locale shares, plus the framework-bound account source. */
export type PluginManagementPageProps = PropsRuntime<'main'> & PropsLocale<'cloud-plugin-management'> & InjectFace<PluginManagementInjected>
type Labels = PropsLocale<'cloud-plugin-management'>
type Operations = Pick<PluginManagementInjected, 'requestPluginEnabled' | 'requestPluginSelected' | 'openPluginConfiguration'>
type CardProps = Labels & Operations & { readonly plugin: AccountPluginCard; readonly interactive: boolean }
const categories = [
  ['all', 'all'], ['execution', 'execution'], ['agents', 'agents'], ['search', 'searchCategory'],
  ['integrations', 'integrations'], ['other', 'other'],
] as const
const controlCopy = {
  'not-connected': 'notConnected', 'not-approved': 'approvalRequired', 'not-installed': 'installationRequired',
  'read-only': 'readOnly', pending: 'pending', busy: 'busy', unknown: 'unknown',
} as const

function Artwork({ category }: { readonly category: PluginCategory }): ReactNode {
  if (category === 'execution') return <PluginArtworkTerminal size={36}/>
  if (category === 'agents') return <PluginArtworkLoop size={36}/>
  if (category === 'search') return <PluginArtworkSearch size={36}/>
  return <PluginArtworkDefault size={36}/>
}
function controlReason(plugin: AccountPluginCard, control: PluginControl, callback: boolean, interactive: boolean, t: Labels['t']): string | undefined {
  if (!interactive) return t('knownStateRequired')
  if (!callback) return t('notConnected')
  if (!plugin.approved) return t('approvalRequired')
  if (plugin.selectionTarget?.kind !== 'bundle' && plugin.installed !== true) {
    return t(plugin.installed === null ? 'knownStateRequired' : 'installationRequired')
  }
  if (plugin.selectionTarget?.kind === 'bundle' && control === 'not-installed') return t('bundleUnavailable')
  return control === 'available' ? undefined : t(controlCopy[control])
}
function EnableControl({ plugin, interactive, requestPluginEnabled, requestPluginSelected, t }: CardProps): ReactNode {
  const bundle = plugin.selectionTarget?.kind === 'bundle'
  const request = bundle ? requestPluginSelected : requestPluginEnabled
  const reason = controlReason(plugin, plugin.toggle, request !== undefined, interactive, t)
    ?? (bundle ? plugin.selected == null || plugin.availability === undefined ? t('knownStateRequired') : undefined
      : plugin.enabled === null ? t('knownStateRequired') : undefined)
  return <Switch checked={bundle ? plugin.selected === true : plugin.enabled === true}
    label={t(bundle ? 'selectToggle' : 'enableToggle', { name: plugin.title })}
    disabled={reason !== undefined} title={reason} onChange={(value) => {
      if (reason === undefined) request?.(plugin.id, value)
    }}/>
}
function ConfigurationControl({ plugin, interactive, openPluginConfiguration, t }: CardProps): ReactNode {
  const reason = controlReason(plugin, plugin.configuration, openPluginConfiguration !== undefined, interactive, t)
  return <Tooltip label={reason ?? t('configurePlugin', { name: plugin.title })} portal>
    <span><Button variant="outline" size="sm" disabled={reason !== undefined}
      aria-label={t('configurePlugin', { name: plugin.title })} onClick={() => {
        if (reason === undefined) openPluginConfiguration?.(plugin.id)
      }}>{t('configure')}</Button></span>
  </Tooltip>
}
function Status({ plugin, t }: Pick<CardProps, 'plugin' | 't'>): ReactNode {
  const key = plugin.selectionTarget?.kind === 'bundle'
    ? plugin.availability === 'missing' ? 'filesMissing' : plugin.selected == null ? 'stateUnknown' : plugin.selected ? 'selected' : 'notSelected'
    : plugin.installed === false ? 'notInstalled' : plugin.installed === null || plugin.enabled === null ? 'stateUnknown'
      : plugin.enabled ? 'enabled' : 'disabled'
  return <span className={css.status}><StateDot state={key === 'enabled' || key === 'selected' ? 'done' : 'idle'}/>{t(key)}</span>
}
function PluginCard(props: CardProps & { readonly onOpen: () => void }): ReactNode {
  const { plugin, t } = props, descriptionId = useId()
  return <li className={css.card}>
    <div className={css.cardHead}>
      <span className={css.cardIcon} aria-hidden="true"><Artwork category={plugin.category}/></span>
      <div className={css.cardMain}>
        <button type="button" className={css.cardOpen} aria-label={t('openDetail', { name: plugin.title })}
          aria-describedby={descriptionId} onClick={props.onOpen}>{plugin.title}</button>
        <span className={css.cardDesc} id={descriptionId}>{plugin.description}</span>
      </div>
      <div className={css.cardEnd}><EnableControl {...props}/></div>
    </div>
    <div className={css.cardFoot}><Status plugin={plugin} t={t}/><Tag tone={plugin.approved ? 'quiet' : 'warning'}>
      {t(plugin.approved ? 'approved' : 'notApproved')}</Tag></div>
  </li>
}
function PluginDetail(props: CardProps & { readonly onBack: () => void }): ReactNode {
  const { plugin, t } = props
  const bundle = plugin.selectionTarget?.kind === 'bundle'
  const configurationReason = controlReason(plugin, plugin.configuration, props.openPluginConfiguration !== undefined, props.interactive, t)
  return <>
    <div className={css.detailTop} data-window-drag>
      <Button size="sm" icon={<IconChevronLeftOutlineMedium size={14}/>} onClick={props.onBack}>{t('back')}</Button>
    </div>
    <article className={css.detail}>
      <header className={css.detailHead}>
        <span className={css.cardIcon} aria-hidden="true"><Artwork category={plugin.category}/></span>
        <div className={css.cardMain}><h1 className={css.pageTitle}>{plugin.title}</h1><Status plugin={plugin} t={t}/></div>
        <EnableControl {...props}/>
      </header>
      <p className={css.description}>{plugin.description}</p>
      <dl className={css.facts}>
        <div><dt>{t('packageName')}</dt><dd><code>{plugin.packageName}</code></dd></div>
        {bundle ? <div><dt>{t('availability')}</dt><dd>{t(plugin.availability === 'installation' ? 'filesInstallation'
          : plugin.availability === 'profile' ? 'filesProfile' : plugin.availability === 'missing' ? 'filesMissing' : 'unknownValue')}</dd></div>
          : <div><dt>{t('moduleName')}</dt><dd><code>{plugin.moduleName ?? t('unknownValue')}</code></dd></div>}
        <div><dt>{t('version')}</dt><dd>{plugin.version ?? t('unknownValue')}</dd></div>
        <div><dt>{t('approval')}</dt><dd>{t(plugin.approved ? 'approved' : 'notApproved')}</dd></div>
        <div><dt>{t(bundle ? 'profileDependency' : 'installation')}</dt><dd>{t(plugin.installed === null ? 'unknownValue'
          : bundle ? plugin.installed ? 'dependencyDeclared' : 'dependencyNotDeclared' : plugin.installed ? 'installed' : 'notInstalled')}</dd></div>
        {bundle ? <div><dt>{t('selection')}</dt>
          <dd>{t(plugin.selected == null ? 'unknownValue' : plugin.selected ? 'selected' : 'notSelected')}</dd></div>
          : <div><dt>{t('activation')}</dt><dd>{t(plugin.enabled === null ? 'unknownValue' : plugin.enabled ? 'enabled' : 'disabled')}</dd></div>}
      </dl>
      <section className={css.configuration}><h2 className={css.groupTitle}>{t('configuration')}</h2>
        <ConfigurationControl {...props}/>
        {configurationReason === undefined ? null : <p className={css.reason}>{configurationReason}</p>}
      </section>
    </article>
  </>
}
function Loading({ t }: Labels): ReactNode {
  return <div className={css.cards} role="status" aria-label={t('loading')}>
    {['a', 'b', 'c', 'd'].map(id => <div key={id} className={clsx(css.card, css.skeleton)} aria-hidden="true"/>)}</div>
}

/**
 * Render native-style plugin search, filters, cards and details from an injected account projection.
 * @param props Native main shares and current-account callbacks; no read or write starts on mount.
 * @returns The account page, with closed controls whenever data or an authorized callback is unavailable.
 */
export function PluginManagementPage(props: PluginManagementPageProps): ReactNode {
  const { t } = props
  const catalog = props.useAccountPluginCatalog(value => value)
  const [query, setQuery] = useState(''), [category, setCategory] = useState<PluginCategory | 'all'>('all')
  const [installedOnly, setInstalledOnly] = useState(false), [selected, setSelected] = useState<AccountPluginCard['id'] | null>(null)
  const readable = catalog.phase === 'ready' || catalog.phase === 'error'
  const interactive = catalog.phase === 'ready' && !catalog.refreshing && catalog.editor === undefined
  const open = readable ? catalog.plugins.find(plugin => plugin.id === selected) : undefined
  const filtered = readable ? filterPlugins(catalog.plugins, query, category, installedOnly) : []
  const installed = filtered.filter(plugin => plugin.installed === true), available = filtered.filter(plugin => plugin.installed !== true)
  const cardProps = { t, interactive,
    ...props.requestPluginEnabled === undefined ? {} : { requestPluginEnabled: props.requestPluginEnabled },
    ...props.requestPluginSelected === undefined ? {} : { requestPluginSelected: props.requestPluginSelected },
    ...props.openPluginConfiguration === undefined ? {} : { openPluginConfiguration: props.openPluginConfiguration } }
  return <section className={css.page} aria-label={t('title')} aria-busy={catalog.phase === 'loading' || catalog.refreshing}>
    {open === undefined ? <>
      <header className={css.pageHead} data-window-drag>
        <div className={css.cardMain}><h1 className={css.pageTitle}>{t('title')}</h1><p className={css.intro}>{t('intro')}</p></div>
        {catalog.phase === 'unavailable' ? null : <div className={css.toolbar}>
          <Tooltip label={t('refresh')} portal><Button size="sm" aria-label={t('refresh')}
            disabled={props.refreshPluginCatalog === undefined || catalog.phase === 'loading' || catalog.refreshing || catalog.editor !== undefined}
            onClick={props.refreshPluginCatalog} icon={<IconRefreshOutlineRegular size={16}/>}/></Tooltip>
          <Tooltip label={t(catalog.plugins.some(plugin => plugin.installable === true && plugin.selectionTarget?.kind !== 'bundle') ? 'installNotConnected' : 'addClosed')} portal><span><Button size="sm" variant="primary" disabled>{t('add')}</Button></span></Tooltip>
        </div>}
      </header>
      {readable ? <div className={css.controls}>
        <Input type="search" value={query} aria-label={t('search')} placeholder={t('search')}
          onChange={(event) => { setQuery(event.target.value) }}/>
        <div className={css.filterBar}>
          <div className={css.categories} role="group" aria-label={t('categories')}>
            {categories.map(([value, key]) => <Pill key={value} active={category === value}
              onClick={() => { setCategory(value) }}>{t(key)}</Pill>)}
          </div>
          <label className={css.installedFilter}>{t('installedOnly')}<Switch checked={installedOnly}
            label={t('installedOnly')} onChange={setInstalledOnly}/></label>
        </div>
      </div> : null}
    </> : <PluginDetail {...cardProps} plugin={open} onBack={() => { setSelected(null) }}/>}
    {catalog.editor === undefined ? null : <PluginEditPanel editor={catalog.editor} t={t}/>}
    {catalog.phase === 'error' ? <div className={css.notice} role="alert"><p>{t('error')}</p>
      <Button size="sm" disabled={props.refreshPluginCatalog === undefined || catalog.refreshing} onClick={props.refreshPluginCatalog}>{t('refresh')}</Button></div> : null}
    {open === undefined ? <>
      {catalog.phase === 'loading' ? <Loading t={t}/> : null}
      {catalog.phase === 'unread' ? <p className={css.empty} role="status">{t('unread')}</p> : null}
      {catalog.phase === 'unavailable' ? <p className={css.empty} role="status">{t('unavailable')}</p> : null}
      {readable && filtered.length === 0 ? <p className={css.empty}>{t(query || category !== 'all' || installedOnly ? 'searchEmpty' : 'empty')}</p> : null}
      {readable ? ([['available', available], ['installed', installed]] as const).map(([key, plugins]) => plugins.length === 0 ? null
        : <section className={css.group} key={key} aria-label={t(key)}>
          <div className={css.groupHead}><h2 className={css.groupTitle}>{t(key)}</h2><span className={css.count}>{t('count', { count: plugins.length })}</span></div>
          <ul className={css.cards}>{plugins.map(plugin => <PluginCard key={plugin.id} {...cardProps} plugin={plugin}
            onOpen={() => { setSelected(plugin.id) }}/>)}</ul>
        </section>) : null}
    </> : null}
  </section>
}
