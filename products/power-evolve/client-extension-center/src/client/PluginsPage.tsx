import { IconApiOutlineRegular, IconChevronRightOutlineRegular, IconSearchOutlineRegular } from '@deepseek-ai/dsh-client-ui-primitives'
import { useCallback, useEffect, useMemo, useRef, useState, type ReactNode } from 'react'
import type { InjectFace, PropsLocale, PropsRuntime } from '@deepseek-ai/dsh-client-ui-slots'
import { PluginHttpError, type NotesPlugin, type NotesSetEnabled, type PluginPort } from './plugins-api.ts'
import { SkillToggle } from './SkillToggle.tsx'

type BuiltinId = 'notes' | 'mcp' | 'ssh'
type Category = '' | 'tools' | 'remote'
type View = 'installed' | 'all'

export type PluginsPageProps = PropsRuntime<'main'> & PropsLocale<'powerEvolve.extensionCenter'>
  & InjectFace<{ readonly plugins: PluginPort; readonly approvalUrl: () => Promise<string> }>

/** The old PowerEvolve Plugins layout with platform-owned personal state. */
export function PluginsPage({ plugins, approvalUrl, t }: PluginsPageProps): ReactNode {
  const [items, setItems] = useState<readonly NotesPlugin[]>([])
  const [loading, setLoading] = useState(true)
  const [loadError, setLoadError] = useState<string>()
  const [mutationError, setMutationError] = useState<string>()
  const [pending, setPending] = useState<NotesSetEnabled>()
  const [busy, setBusy] = useState(false)
  const [view, setView] = useState<View>('installed')
  const [category, setCategory] = useState<Category>('')
  const [search, setSearch] = useState('')
  const [selected, setSelected] = useState<BuiltinId>()
  const [approval, setApproval] = useState<string>()
  const [approvalError, setApprovalError] = useState(false)
  const request = useRef<AbortController>()
  const scrollTop = useRef(0)
  const list = useRef<HTMLElement>(null)

  const reload = useCallback((): void => {
    request.current?.abort()
    const controller = new AbortController()
    request.current = controller
    setLoading(true); setLoadError(undefined)
    void plugins.list(controller.signal).then(value => {
      if (!controller.signal.aborted) {
        setItems(value)
        setPending(undefined)
        setMutationError(undefined)
      }
    }).catch((cause: unknown) => {
      if (!controller.signal.aborted) setLoadError(cause instanceof PluginHttpError && cause.status === 401
        ? t('sessionExpired') : t('pluginLoadFailed'))
    }).finally(() => {
      if (!controller.signal.aborted) setLoading(false)
    })
  }, [plugins, t])

  useEffect(() => { reload(); return () => { request.current?.abort() } }, [reload])
  useEffect(() => {
    if (selected !== 'notes') return
    let active = true
    setApproval(undefined); setApprovalError(false)
    void approvalUrl().then(value => { if (active) setApproval(value) })
      .catch(() => { if (active) setApprovalError(true) })
    return () => { active = false }
  }, [selected, approvalUrl])
  useEffect(() => { if (selected === undefined && list.current) list.current.scrollTop = scrollTop.current }, [selected])

  const notes = items.find(item => item.id === 'notes')
  const candidates: readonly BuiltinId[] = view === 'installed'
    ? notes === undefined ? [] : ['notes'] : ['notes', 'mcp', 'ssh']
  const visible = useMemo(() => candidates.filter(id => {
    const group = id === 'ssh' ? 'remote' : 'tools'
    const title = id === 'notes' ? t('notesPluginTitle') : id.toUpperCase()
    const description = id === 'notes' ? t('notesPluginDescription')
      : id === 'mcp' ? t('mcpPluginDescription') : t('sshPluginDescription')
    const needle = search.trim().toLocaleLowerCase()
    return (category === '' || category === group)
      && (needle === '' || [title, description].some(value => value.toLocaleLowerCase().includes(needle)))
  }), [candidates, category, search, t])

  const setEnabled = async (input: NotesSetEnabled): Promise<void> => {
    if (busy) return
    setBusy(true); setMutationError(undefined)
    try {
      const updated = await plugins.setEnabled(input)
      setItems(current => current.map(item => item.id === updated.id ? updated : item))
      setPending(undefined)
    } catch (cause) {
      if (cause instanceof PluginHttpError && cause.status === 409) {
        setPending(undefined); setMutationError(t('pluginRevisionConflict'))
      } else if (cause instanceof PluginHttpError && cause.status === 401) {
        setPending(undefined); setMutationError(t('sessionExpired'))
      } else {
        setPending(input); setMutationError(t('pluginToggleUncertain'))
      }
    } finally { setBusy(false) }
  }

  const changeEnabled = (enabled: boolean): void => {
    if (!notes || pending || busy) return
    void setEnabled({ requestId: crypto.randomUUID(), expectedRevision: notes.revision, enabled })
  }

  if (selected === 'notes' && notes) {
    return <main className="pext-root pext-plugin-detail-page" data-power-evolve-plugin-detail="notes">
      <header className="pext-plugin-breadcrumb"><button type="button" onClick={() => { setSelected(undefined) }}>
        {t('pluginsTitle')}</button><IconChevronRightOutlineRegular size={14} /><span>{t('notesPluginTitle')}</span></header>
      <section className="pext-plugin-detail-content">
        <div className="pext-plugin-detail-heading"><span className="pext-extension-icon"><IconApiOutlineRegular size={23} /></span>
          <div><h1>{t('notesPluginTitle')}</h1><p>{t('notesPluginDescription')}</p></div></div>
        <div className="pext-plugin-detail-setting"><div><strong>{t('pluginAccess')}</strong>
          <p>{t('notesPluginAccessHint')}</p></div>
          <SkillToggle label={`${t('notesPluginTitle')} ${t('pluginEnable')}`} checked={notes.enabled}
            disabled={busy || pending !== undefined} onChange={changeEnabled} /></div>
        <div className="pext-plugin-detail-setting"><div><strong>{t('pluginApproval')}</strong>
          <p>{t('pluginApprovalHint')}</p></div>
          {approval ? <a className="pext-dialog-button" href={approval} target="_blank" rel="noopener noreferrer">
            {t('openApproval')}</a> : approvalError ? <span role="alert">{t('approvalUnavailable')}</span>
            : <span>{t('loading')}</span>}</div>
        <p className="pext-catalog-note">{t('pluginNextTaskHint')}</p>
        {mutationError && <div className="pext-error" role="alert">{mutationError}</div>}
        {pending && <button className="pext-dialog-button" type="button" disabled={busy}
          onClick={() => { void setEnabled(pending) }}>{t('pluginRetryToggle')}</button>}
        <p className="pext-plugin-revision">{t('revision').replace('{count}', String(notes.revision))}</p>
      </section>
    </main>
  }

  return <main ref={list} className="pext-root pext-catalog-page" data-power-evolve-plugins-page>
    <header className="pext-catalog-header"><nav className="pext-catalog-tabs" role="tablist" aria-label={t('pluginsTitle')}>
      <button type="button" role="tab" aria-selected={view === 'installed'} onClick={() => { setView('installed') }}>
        {t('myPlugins')}<small>{items.length}</small></button>
      <button type="button" role="tab" aria-selected={view === 'all'} onClick={() => { setView('all') }}>
        {t('allPlugins')}</button></nav></header>
    <section className="pext-catalog-content" role="tabpanel" aria-label={t('pluginsTitle')}>
      <label className="pext-catalog-search"><span className="pext-visually-hidden">{t('pluginSearch')}</span>
        <IconSearchOutlineRegular size={17} /><input type="search" value={search} placeholder={t('pluginSearch')}
          onChange={event => { setSearch(event.target.value) }} /></label>
      <div className="pext-catalog-filter-row"><div className="pext-category-tabs" aria-label={t('pluginCategory')}>
        {(['', 'tools', 'remote'] as const).map(value => <button key={value} type="button"
          aria-pressed={category === value} onClick={() => { setCategory(value) }}>
          {t(value === '' ? 'pluginCategoryAll' : value === 'tools' ? 'pluginCategoryTools' : 'pluginCategoryRemote')}</button>)}</div>
        <span>{t('resultCount').replace('{count}', String(visible.length))}</span></div>
      <button type="button" className="pext-card-action" onClick={reload}>{t('refreshList')}</button>
      {loadError && <div className="pext-error" role="alert">{loadError}</div>}
      {loading ? <div className="pext-loading" role="status">{t('pluginLoading')}</div>
        : loadError ? null : visible.length === 0 ? <div className="pext-empty">{t('pluginCatalogEmpty')}</div>
          : <div className="pext-card-grid">{visible.map(id => {
            const isNotes = id === 'notes'
            const title = isNotes ? t('notesPluginTitle') : id.toUpperCase()
            return <article className="pext-extension-card" key={id} data-plugin-id={id}>
              <div className="pext-extension-card-top"><span className="pext-extension-icon" aria-hidden="true">
                <IconApiOutlineRegular size={21} /></span><span className="pext-extension-badge">
                {isNotes && notes ? t(notes.enabled ? 'enabledState' : 'disabledState') : t('pluginPlanned')}</span></div>
              {isNotes && notes ? <button className="pext-extension-title" type="button" onClick={() => {
                scrollTop.current = list.current?.scrollTop ?? 0; setSelected('notes') }}>{title}</button>
                : <strong className="pext-extension-title">{title}</strong>}
              <p>{t(isNotes ? 'notesPluginDescription' : id === 'mcp' ? 'mcpPluginDescription' : 'sshPluginDescription')}</p>
              <div className="pext-extension-card-bottom"><span>{isNotes && notes ? t('pluginBuiltin') : t('pluginNotAvailable')}</span>
                {isNotes && notes ? <button type="button" className="pext-card-action" onClick={() => {
                  scrollTop.current = list.current?.scrollTop ?? 0; setSelected('notes') }}>{t('viewDetails')}</button> : null}</div>
            </article>
          })}</div>}
      <aside className="pext-catalog-note">{t('pluginNextTaskHint')}</aside>
    </section>
  </main>
}
