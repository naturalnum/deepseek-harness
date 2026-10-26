/** User management-page presentation on the current account source; no registration, transport or backend adapter. */
import { useState, type ReactNode } from 'react'
import { IconPlusOutlineRegular, IconSearchOutlineRegular, IconSkillOutlineRegular, Switch } from '@deepseek-ai/dsh-client-ui-primitives'
import type { InjectFace, PropsLocale, PropsRuntime, TranslateNS } from '@deepseek-ai/dsh-client-ui-slots'
import type { SkillCard, SkillCategory, SkillManagementActions, SkillsPageInjected } from './types.ts'
import { ManagedSkillEditor } from './ManagedSkillEditor.tsx'
import { SampleSkillEditor } from './SampleSkillEditor.tsx'
import { SkillDetailDialog } from './SkillDetailDialog.tsx'
import { SkillInstallPanel } from './SkillInstallPanel.tsx'
import { SkillImportPanel } from './SkillImportPanel.tsx'
import { useSkillAction } from './use-skill-action.ts'
export type {} from './locales.ts'
export type {} from '@deepseek-ai/dsh-client-ui-layout/client'
import css from './SkillsPage.module.css'

/** Original main-slot shares and a renderer-bound, account-scoped display source. */
export type SkillsPageProps = PropsRuntime<'main'> & PropsLocale<'cloud-skill-management'> & InjectFace<SkillsPageInjected>
const categories: readonly SkillCategory[] = ['writing-office', 'data-analysis', 'research-knowledge', 'development-tools', 'imported', 'other']

/** Reset view-only drafts when the original account scope is replaced.
 * @param props Original slot shares and injected current-account callbacks.
 * @returns The migrated cards, filters and dialogs without a new application entry.
 */
export function SkillsPage(props: SkillsPageProps): ReactNode {
  return <SkillsPageBody key={props.scope} {...props}/>
}
function SkillsPageBody(props: SkillsPageProps): ReactNode {
  const { t } = props, view = props.useSkillManagement(value => value)
  const [search, setSearch] = useState(''), [category, setCategory] = useState<SkillCategory | ''>('')
  const [installedOnly, setInstalledOnly] = useState(false), [selectedId, setSelectedId] = useState<string>()
  const [dialog, setDialog] = useState<'install' | 'import'>(), refresh = useSkillAction('read')
  const query = search.trim().toLocaleLowerCase()
  const visible = view.items.filter(item => (!installedOnly || item.installed) && (!category || item.category === category)
    && (!query || [item.name, item.description, item.id].some(value => value.toLocaleLowerCase().includes(query))))
  const recommended = view.items.filter(item => item.recommended).slice(0, 3)
  const selected = view.items.find(item => item.id === selectedId)
  const ready = view.phase === 'ready', managed = view.managed
  const openManaged = (id: string | undefined): void => {
    if (managed === undefined) return
    void refresh.run(async (signal) => { await managed.open(id, signal); return 'confirmed' })
  }
  const onRefresh = (): void => {
    const reload = managed?.refresh ?? props.refresh
    if (reload === undefined) return
    void refresh.run(async (signal) => { await reload(signal); return 'confirmed' }).then((outcome) => {
      if (outcome !== undefined) props.report('refresh', outcome)
    })
  }
  return <main className={css.page} data-cloud-skills-management aria-busy={view.phase === 'loading'}>
    <header className={css.header}>
      <div><h1>{t('title')}</h1><p>{t('description')}</p></div>
      <div className={css.actions}>
        {managed === undefined ? null : <button type="button" className={`${css.button} ${css.primary}`}
          disabled={managed.canInstall === false || refresh.state === 'pending' || managed.phase === 'submitting' || managed.phase === 'opening' || managed.phase === 'downloading'}
          onClick={() => { openManaged(undefined) }}>{t('installBundle')}</button>}
        {managed === undefined ? <>
          <button type="button" className={css.button} disabled={!ready || props.installText === undefined || props.limits === undefined}
            onClick={() => { setDialog('install') }}><IconPlusOutlineRegular size={15}/>{t('install')}</button>
          <button type="button" className={`${css.button} ${css.primary}`}
            disabled={!ready || props.importPackage === undefined || props.limits === undefined}
            onClick={() => { setDialog('import') }}>{t('import')}</button></> : null}
      </div>
    </header>
    <section className={css.content} aria-label={t('title')}>
      {managed?.needsRefresh ? <p className={css.note} role="status">{t('bundleRefreshAfterChange')}</p> : null}
      {managed === undefined ? null : <ManagedSkillEditor key={managed.editNumber} editor={managed} report={props.report} t={t}/> }
      {view.sample === undefined ? null : managed === undefined ? <SampleSkillEditor key={view.sample.scope} sample={view.sample} t={t}/>
        : <details><summary>{t('legacySampleEditor')}</summary><SampleSkillEditor key={view.sample.scope} sample={view.sample} t={t}/></details>}
      {recommended.length > 0 ? <section aria-label={t('recommended')}>
        <h2 className={css.sectionLabel}>{t('recommended')}</h2>
        <div className={css.recommendations}>{recommended.map(item => <button type="button" key={item.id}
          className={css.recommendation} onClick={() => { setSelectedId(item.id) }}>
          <span><IconSkillOutlineRegular size={28}/><strong>{item.name}</strong></span><p>{item.description}</p>
        </button>)}</div>
      </section> : null}
      <label className={css.search}><IconSearchOutlineRegular size={17}/><input type="search" aria-label={t('search')}
        placeholder={t('search')} value={search} onChange={(event) => { setSearch(event.target.value) }}/></label>
      <div className={css.filters}>
        <div className={css.categories} aria-label={t('categories')}>
          <button type="button" aria-pressed={category === ''} onClick={() => { setCategory('') }}>{t('all')}</button>
          {categories.map(value => <button type="button" key={value} aria-pressed={category === value}
            onClick={() => { setCategory(value) }}>{t(value)}</button>)}</div>
        <label className={css.installed}>{t('installed')}<Switch label={t('installed')} checked={installedOnly}
          onChange={setInstalledOnly}/></label>
        <button type="button" className={css.linkButton} disabled={managed === undefined && props.refresh === undefined || refresh.state === 'pending' || managed?.phase === 'opening' || managed?.phase === 'submitting' || managed?.phase === 'downloading'}
          onClick={onRefresh}>{t('refresh')}</button>
      </div>
      {view.phase === 'loading' && view.items.length === 0 ? <div className={css.grid} role="status" aria-label={t('loadLabel')}>
        {[0, 1, 2].map(index => <div key={index} className={css.skeleton}/>)}</div> : null}
      {view.phase === 'unavailable' ? <p className={css.error} role="alert">{t('unavailable')}</p> : null}
      {view.phase === 'ready' && visible.length === 0
        ? <p className={css.empty}>{t(query || category || installedOnly ? 'noMatch' : 'empty')}</p>
        : view.items.length === 0 ? null : <div className={css.grid}>{visible.map(skill =>
          <SkillCardView key={skill.id} skill={skill} actions={props} t={t}
            ready={ready} onOpen={() => { if (managed === undefined) setSelectedId(skill.id); else openManaged(skill.id) }}/>)}</div>}
      <p className={css.note}>{t('note')}</p>
    </section>
    {managed === undefined && ready && selected !== undefined ? <SkillDetailDialog key={selected.id} skill={selected} actions={props} t={t}
      onClose={() => { setSelectedId(undefined) }}/> : null}
    {ready && dialog === 'install' && props.limits !== undefined ? <SkillInstallPanel limits={props.limits}
      installText={props.installText} report={props.report} t={t} onClose={() => { setDialog(undefined) }}/> : null}
    {ready && dialog === 'import' && props.limits !== undefined ? <SkillImportPanel maxBytes={props.limits.archiveBytes}
      importPackage={props.importPackage} report={props.report} t={t} onClose={() => { setDialog(undefined) }}/> : null}
  </main>
}
function SkillCardView({ skill, actions, t, ready, onOpen }: {
  readonly skill: SkillCard
  readonly actions: SkillManagementActions
  readonly t: TranslateNS<'cloud-skill-management'>
  readonly ready: boolean
  readonly onOpen: () => void
}): ReactNode {
  const action = useSkillAction(), canAct = ready && (action.state === 'idle' || action.state === 'confirmed')
  const install = (): void => {
    const submit = actions.installCatalog
    if (submit === undefined) return
    void action.run(signal => submit(skill.id, signal)).then((outcome) => {
      if (outcome !== undefined) actions.report('catalog-install', outcome)
    })
  }
  return <article className={css.card} data-skill-id={skill.id}>
    <div className={css.cardHead}><span className={css.glyph} aria-hidden="true"><IconSkillOutlineRegular size={22}/></span>
      <span className={css.badge}>{t(skill.status)}</span></div>
    <button type="button" className={css.cardTitle} onClick={onOpen}>{skill.name}</button>
    <p className={css.cardDescription}>{skill.description}</p>
    {skill.sourceLabel === undefined ? null : <small>{skill.sourceLabel}</small>}
    {skill.shadowed === true ? <small>{skill.shadowedBy === undefined ? t('bundleShadowed') : t('bundleShadowedBy', skill.shadowedBy)}</small> : null}
    <div className={css.cardFooter}>
      <small>{skill.version === undefined ? t(skill.installed ? 'installed' : 'available') : `${t('version')} ${skill.version}`}</small>
      <div><button type="button" className={css.linkButton} onClick={onOpen}>{t('details')}</button>
        {!skill.installed ? <button type="button" className={css.linkButton} disabled={!canAct || actions.installCatalog === undefined}
          onClick={install}>{t('installCatalog')}</button> : skill.enabled === undefined ? null : <Switch checked={skill.enabled}
          label={`${skill.name} ${t('toggle')}`} disabled={!canAct || !skill.canToggle || actions.toggle === undefined}
          onChange={(enabled) => {
            const toggle = actions.toggle
            if (toggle !== undefined) void action.run(signal => toggle(skill.id, enabled, signal)).then((outcome) => {
              if (outcome !== undefined) actions.report('toggle', outcome)
            })
          }}/>}</div>
    </div>
    {action.state === 'unknown' || action.state === 'conflict' || action.state === 'unavailable'
      ? <p className={css.error} role="alert">{t(action.state === 'unavailable' ? 'actionUnavailable' : action.state)}</p> : null}
  </article>
}
