/** User management-page presentation on the current account source; no registration, transport or backend adapter. */
import { useId, useRef, useState, type ReactNode } from 'react'
import { Button, IconPlusOutlineRegular, IconRefreshOutlineRegular, IconSearchOutlineRegular, Input, Pill, Switch, Tooltip } from '@deepseek-ai/dsh-client-ui-primitives'
import type { InjectFace, PropsLocale, PropsRuntime, TranslateNS } from '@deepseek-ai/dsh-client-ui-slots'
import type { SkillCard, SkillCategory, SkillManagementActions, SkillsPageInjected } from './types.ts'
import { ManagedSkillEditor } from './ManagedSkillEditor.tsx'
import { SkillDetailDialog } from './SkillDetailDialog.tsx'
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
  const refresh = useSkillAction('read'), importing = useSkillAction<'invalid-bundle'>('read')
  const unmanagedImport = useSkillAction()
  const importInput = useRef<HTMLInputElement>(null), [invalidArchive, setInvalidArchive] = useState(false)
  const query = search.trim().toLocaleLowerCase()
  const visible = view.items.filter(item => (!installedOnly || item.installed) && (!category || item.category === category)
    && (!query || [item.name, item.description, item.id].some(value => value.toLocaleLowerCase().includes(query))))
  const selected = view.items.find(item => item.id === selectedId)
  const ready = view.phase === 'ready', managed = view.managed
  const managedBusy = managed?.phase === 'opening' || managed?.phase === 'submitting' || managed?.phase === 'downloading'
  const importBusy = importing.state === 'pending' || unmanagedImport.state === 'pending' || managedBusy
  const importConsumed = managed === undefined ? unmanagedImport.state !== 'idle' && unmanagedImport.state !== 'confirmed'
    : managed.outcome?.kind === 'unknown'
  const chooseArchive = (file: File | undefined): void => {
    if (file === undefined || importBusy || importConsumed) return
    setInvalidArchive(false)
    const valid = (maximum: number | undefined): boolean => file.size > 0 && (maximum === undefined || file.size <= maximum)
      && /\.(?:zip|skill)$/iu.test(file.name) && !/[\u0000-\u001f\u007f]/u.test(file.name)
    if (!valid(managed === undefined ? props.limits?.archiveBytes : undefined)) { setInvalidArchive(true); return }
    if (managed !== undefined) {
      void importing.run(async (signal) => {
        const outcome = await managed.installZip(file, signal)
        return outcome.kind === 'persisted' ? 'confirmed' : outcome.kind
      }).then((outcome) => { if (outcome !== undefined && outcome !== 'invalid-bundle') props.report('install', outcome) })
      return
    }
    const submit = props.importPackage
    if (submit !== undefined) void unmanagedImport.run(signal => submit(file, signal)).then((outcome) => {
      if (outcome !== undefined) props.report('import', outcome)
    })
  }
  const openManaged = (id: string | undefined): void => {
    if (managed === undefined) return
    setInvalidArchive(false)
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
      <h1>{t('title')}</h1>
      <div className={css.actions}>
        <Button size="sm" variant="outline" icon={<IconPlusOutlineRegular size={15}/>}
          disabled={importBusy || importConsumed || refresh.state === 'pending' || (managed === undefined
            ? !ready || props.importPackage === undefined || props.limits === undefined : managed.canInstall === false)}
          onClick={() => { importInput.current?.click() }}>{t('import')}</Button>
        <input ref={importInput} type="file" hidden accept=".zip,.skill,application/zip" aria-label={t('chooseArchive')}
          onChange={(event) => { const file = event.currentTarget.files?.[0]; event.currentTarget.value = ''; chooseArchive(file) }}/>
      </div>
    </header>
    <section className={css.content} aria-label={t('title')}>
      {invalidArchive || importing.state === 'unavailable' && managed?.outcome === undefined && managed?.phase !== 'unavailable'
        ? <p className={css.error} role="alert">{t(managed === undefined ? 'invalidFile' : 'invalidZip')}</p> : null}
      {importBusy && managed?.selection !== null ? <p className={css.note} role="status">{t('pending')}</p> : null}
      {managed === undefined && unmanagedImport.state !== 'idle' && unmanagedImport.state !== 'pending' && unmanagedImport.state !== 'confirmed'
        ? <p className={css.error} role="alert">{t(unmanagedImport.state === 'unavailable' ? 'actionUnavailable' : unmanagedImport.state)}</p> : null}
      {managed?.needsRefresh ? <p className={css.note} role="status">{t('bundleRefreshAfterChange')}</p> : null}
      {managed?.selection === null && managed.phase === 'unavailable'
        ? <p className={css.error} role="alert">{t('unavailable')}</p> : null}
      {managed?.selection === null && managed.outcome !== undefined ? <p
        className={managed.outcome.kind === 'persisted' ? css.note : css.error}
        role={managed.outcome.kind === 'persisted' ? 'status' : 'alert'}>{t(managed.outcome.kind === 'persisted'
          ? managed.outcome.applied ? 'bundleApplied' : 'bundleSavedPending' : managed.outcome.kind === 'conflict' ? 'sampleConflict'
            : managed.outcome.kind === 'unavailable' ? 'bundleCapacity' : managed.outcome.kind === 'invalid-bundle' ? 'bundleMissingManifest' : 'sampleUnknown')}</p> : null}
      <Input icon={<IconSearchOutlineRegular size={16}/>} type="search" aria-label={t('search')}
        placeholder={t('search')} value={search} onChange={(event) => { setSearch(event.target.value) }}/>
      <div className={css.filters}>
        <div className={css.categories} role="group" aria-label={t('categories')}>
          <Pill active={category === ''} aria-pressed={category === ''} onClick={() => { setCategory('') }}>{t('all')}</Pill>
          {categories.map(value => <Pill key={value} active={category === value} aria-pressed={category === value}
            onClick={() => { setCategory(value) }}>{t(value)}</Pill>)}</div>
        <label className={css.installed}>{t('installed')}<Switch label={t('installed')} checked={installedOnly}
          onChange={setInstalledOnly}/></label>
        <Tooltip label={t('refresh')} portal><Button size="sm" aria-label={t('refresh')}
          disabled={importBusy || managed === undefined && props.refresh === undefined || refresh.state === 'pending'}
          icon={<IconRefreshOutlineRegular size={16}/>} onClick={onRefresh}/></Tooltip>
      </div>
      {view.phase === 'loading' && view.items.length === 0 ? <div className={css.grid} role="status" aria-label={t('loadLabel')}>
        {[0, 1, 2].map(index => <div key={index} className={css.skeleton}/>)}</div> : null}
      {view.phase === 'unavailable' ? <p className={css.error} role="alert">{t('unavailable')}</p> : null}
      {view.phase === 'ready' && visible.length === 0
        ? <p className={css.empty}>{t(query || category || installedOnly ? 'noMatch' : 'empty')}</p>
        : view.items.length === 0 ? null : <div className={css.grid}>{visible.map(skill =>
          <SkillCardView key={skill.id} skill={skill} actions={props} t={t}
            ready={ready && !importBusy && refresh.state !== 'pending'} onOpen={() => { if (importBusy || refresh.state === 'pending') return; if (managed === undefined) setSelectedId(skill.id); else openManaged(skill.id) }}/>)}</div>}
      {managed === undefined || managed.selection === null ? null
        : <ManagedSkillEditor key={managed.editNumber} editor={managed} actions={props} t={t}/> }
    </section>
    {managed === undefined && ready && selected !== undefined ? <SkillDetailDialog key={selected.id} skill={selected} actions={props} t={t}
      onClose={() => { setSelectedId(undefined) }}/> : null}
  </main>
}
function SkillCardView({ skill, actions, t, ready, onOpen }: {
  readonly skill: SkillCard
  readonly actions: SkillManagementActions
  readonly t: TranslateNS<'cloud-skill-management'>
  readonly ready: boolean
  readonly onOpen: () => void
}): ReactNode {
  const descriptionId = useId(), action = useSkillAction(), canAct = ready && (action.state === 'idle' || action.state === 'confirmed')
  const install = (): void => {
    const submit = actions.installCatalog
    if (submit === undefined) return
    void action.run(signal => submit(skill.id, signal)).then((outcome) => {
      if (outcome !== undefined) actions.report('catalog-install', outcome)
    })
  }
  return <article className={css.card} data-skill-id={skill.id}>
    <div className={css.cardHead}>
      <button type="button" className={css.cardTitle} aria-describedby={descriptionId} disabled={!ready} onClick={onOpen}>{skill.name}</button>
      <div className={css.cardControl}>
        {!skill.installed ? <button type="button" className={css.linkButton} aria-label={`${t('installCatalog')} ${skill.name}`} disabled={!canAct || actions.installCatalog === undefined}
          onClick={install}>{t('installCatalog')}</button> : skill.enabled === undefined ? null : <Switch checked={skill.enabled}
          label={`${skill.name} ${t('toggle')}`} disabled={!canAct || !skill.canToggle || actions.toggle === undefined}
          onChange={(enabled) => {
            const toggle = actions.toggle
            if (toggle !== undefined) void action.run(signal => toggle(skill.id, enabled, signal)).then((outcome) => {
              if (outcome !== undefined) actions.report('toggle', outcome)
            })
          }}/>}</div>
    </div>
    <p className={css.cardDescription} id={descriptionId}>{skill.description}</p>
    <div className={css.cardFooter}>
      <small>{t(skill.status)}</small>
      {skill.sourceLabel === undefined ? null : <small>{skill.sourceLabel}</small>}
      {skill.version === undefined ? null : <small>{t('version')} {skill.version}</small>}
    </div>
    {skill.installed && skill.shadowed === undefined ? <small className={css.cardNotice}>{t('bundleSelectionUnknown')}</small> : null}
    {skill.shadowed === true ? <small className={css.cardNotice}>{skill.shadowedBy === undefined ? t('bundleShadowed') : t('bundleShadowedBy', skill.shadowedBy)}</small> : null}
    {action.state === 'unknown' || action.state === 'conflict' || action.state === 'unavailable'
      ? <p className={css.error} role="alert">{t(action.state === 'unavailable' ? 'actionUnavailable' : action.state)}</p> : null}
  </article>
}
