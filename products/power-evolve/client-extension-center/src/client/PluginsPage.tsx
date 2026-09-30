import { IconApiOutlineRegular, IconChevronRightOutlineRegular, IconSearchOutlineRegular } from '@deepseek-ai/dsh-client-ui-primitives'
import { useCallback, useEffect, useMemo, useRef, useState, type ReactNode } from 'react'
import type { InjectFace, PropsLocale, PropsRuntime } from '@deepseek-ai/dsh-client-ui-slots'
import type { FixedMcpList, FixedMcpPort } from './mcp-api.ts'
import { FixedMcpPage } from './FixedMcpPage.tsx'
import { PersonalMcpPage } from './PersonalMcpPage.tsx'
import type { PersonalMcpConnection, PersonalMcpConnectionPage, PersonalMcpConnectionPort } from './personal-mcp-client.ts'
import type { PersonalMcpSessionSource } from './personal-mcp-session-view.ts'
import { PersonalSshPage } from './PersonalSshPage.tsx'
import { StdioMcpPage } from './StdioMcpPage.tsx'
import type { StdioMcpList, StdioMcpPort } from './stdio-mcp-api.ts'
import type { PersonalSshList, PersonalSshPort } from './ssh-api.ts'
import { PluginHttpError, type NotesPlugin, type NotesSetEnabled, type PluginPort } from './plugins-api.ts'
import { SkillToggle } from './SkillToggle.tsx'

type BuiltinId = 'notes' | 'mcp' | 'personal-mcp' | 'stdio' | 'ssh'
type Category = '' | 'tools' | 'remote'
type View = 'installed' | 'all'

export type PluginsPageProps = PropsRuntime<'main'> & PropsLocale<'powerEvolve.extensionCenter'>
  & InjectFace<{ readonly plugins: PluginPort; readonly mcp: FixedMcpPort;
    readonly personalMcp?: PersonalMcpConnectionPort; readonly mcpSessions?: PersonalMcpSessionSource;
    readonly stdio: StdioMcpPort; readonly ssh: PersonalSshPort;
    readonly approvalUrl: () => Promise<string> }>

/** The old PowerEvolve Plugins layout with platform-owned personal state. */
export function PluginsPage({ plugins, mcp, personalMcp, mcpSessions, stdio, ssh, approvalUrl, t }: PluginsPageProps): ReactNode {
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
  const [mcpData, setMcpData] = useState<FixedMcpList>()
  const [mcpLoading, setMcpLoading] = useState(true)
  const [mcpLoadError, setMcpLoadError] = useState(false)
  const [personalMcpData, setPersonalMcpData] = useState<PersonalMcpConnectionPage>()
  const [personalMcpLoading, setPersonalMcpLoading] = useState(true)
  const [personalMcpLoadError, setPersonalMcpLoadError] = useState(false)
  const [stdioData, setStdioData] = useState<StdioMcpList>()
  const [stdioLoading, setStdioLoading] = useState(true)
  const [stdioLoadError, setStdioLoadError] = useState(false)
  const [sshData, setSshData] = useState<PersonalSshList>()
  const [sshLoading, setSshLoading] = useState(true)
  const [sshLoadError, setSshLoadError] = useState(false)
  const request = useRef<AbortController>()
  const mcpRequest = useRef<AbortController>()
  const personalMcpRequest = useRef<AbortController>()
  const stdioRequest = useRef<AbortController>()
  const sshRequest = useRef<AbortController>()
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

  const reloadMcp = useCallback((): void => {
    mcpRequest.current?.abort()
    const controller = new AbortController()
    mcpRequest.current = controller
    setMcpLoading(true); setMcpLoadError(false)
    void mcp.list(controller.signal).then(value => {
      if (!controller.signal.aborted) setMcpData(value)
    }).catch(() => {
      if (!controller.signal.aborted) setMcpLoadError(true)
    }).finally(() => {
      if (!controller.signal.aborted) setMcpLoading(false)
    })
  }, [mcp])

  const reloadSsh = useCallback((): void => {
    sshRequest.current?.abort()
    const controller = new AbortController()
    sshRequest.current = controller
    setSshLoading(true); setSshLoadError(false)
    void ssh.list(controller.signal).then(value => {
      if (!controller.signal.aborted) setSshData(value)
    }).catch(() => {
      if (!controller.signal.aborted) setSshLoadError(true)
    }).finally(() => {
      if (!controller.signal.aborted) setSshLoading(false)
    })
  }, [ssh])

  const reloadPersonalMcp = useCallback((): void => {
    personalMcpRequest.current?.abort()
    if (personalMcp === undefined) { setPersonalMcpLoading(false); return }
    const controller = new AbortController()
    personalMcpRequest.current = controller
    setPersonalMcpLoading(true); setPersonalMcpLoadError(false)
    void personalMcp.list({}, controller.signal).then(value => {
      if (!controller.signal.aborted) setPersonalMcpData(value)
    }).catch(() => {
      if (!controller.signal.aborted) setPersonalMcpLoadError(true)
    }).finally(() => { if (!controller.signal.aborted) setPersonalMcpLoading(false) })
  }, [personalMcp])
  const updatePersonalMcpItems = useCallback((next: readonly PersonalMcpConnection[]): void => {
    setPersonalMcpData(current => current === undefined ? current : { ...current, items: next })
  }, [])

  const reloadStdio = useCallback((): void => {
    stdioRequest.current?.abort()
    const controller = new AbortController()
    stdioRequest.current = controller
    setStdioLoading(true); setStdioLoadError(false)
    void stdio.list(controller.signal).then(value => {
      if (!controller.signal.aborted) setStdioData(value)
    }).catch(() => {
      if (!controller.signal.aborted) setStdioLoadError(true)
    }).finally(() => { if (!controller.signal.aborted) setStdioLoading(false) })
  }, [stdio])

  useEffect(() => { reload(); reloadMcp(); reloadPersonalMcp(); reloadStdio(); reloadSsh(); return () => {
    request.current?.abort(); mcpRequest.current?.abort(); stdioRequest.current?.abort(); sshRequest.current?.abort()
    personalMcpRequest.current?.abort()
  } }, [reload, reloadMcp, reloadPersonalMcp, reloadStdio, reloadSsh])
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
  const mcpInstalled = (mcpData?.items.length ?? 0) > 0
  const personalMcpInstalled = (personalMcpData?.items.length ?? 0) > 0
  const stdioInstalled = (stdioData?.items.length ?? 0) > 0
  const sshInstalled = (sshData?.items.length ?? 0) > 0
  const candidates: readonly BuiltinId[] = view === 'installed'
    ? [...(notes === undefined ? [] : ['notes'] as const), ...(mcpInstalled ? ['mcp'] as const : []),
      ...(personalMcpInstalled ? ['personal-mcp'] as const : []),
      ...(stdioInstalled ? ['stdio'] as const : []),
      ...(sshInstalled ? ['ssh'] as const : [])]
    : ['notes', 'mcp', ...(personalMcp === undefined ? [] : ['personal-mcp'] as const), 'stdio', 'ssh']
  const visible = useMemo(() => candidates.filter(id => {
    const group = id === 'ssh' ? 'remote' : 'tools'
    const title = id === 'notes' ? t('notesPluginTitle')
      : id === 'personal-mcp' ? t('personalMcpPluginTitle')
      : id === 'stdio' ? t('stdioMcpTitle') : id.toUpperCase()
    const description = id === 'notes' ? t('notesPluginDescription')
      : id === 'personal-mcp' ? t('personalMcpPluginDescription')
      : id === 'mcp' ? t('mcpPluginDescription')
        : id === 'stdio' ? t('stdioMcpDescription') : t('sshPluginDescription')
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

  if (selected === 'mcp' && mcpData) {
    return <main className="pext-root pext-plugin-detail-page" data-power-evolve-plugin-detail="mcp">
      <header className="pext-plugin-breadcrumb"><button type="button" onClick={() => { setSelected(undefined) }}>
        {t('pluginsTitle')}</button><IconChevronRightOutlineRegular size={14} /><span>{t('mcp')}</span></header>
      <FixedMcpPage data={mcpData} port={mcp} t={t} onReload={reloadMcp}
        onChange={next => { setMcpData(current => current === undefined ? current : { ...current, items: next }) }} />
    </main>
  }

  if (selected === 'stdio' && stdioData) {
    return <main className="pext-root pext-plugin-detail-page" data-power-evolve-plugin-detail="stdio">
      <header className="pext-plugin-breadcrumb"><button type="button" onClick={() => { setSelected(undefined) }}>
        {t('pluginsTitle')}</button><IconChevronRightOutlineRegular size={14} /><span>{t('stdioMcpTitle')}</span></header>
      <StdioMcpPage data={stdioData} port={stdio} t={t}
        onChange={next => { setStdioData(current => current === undefined ? current : { ...current, items: next }) }} />
    </main>
  }

  if (selected === 'personal-mcp' && personalMcp !== undefined && mcpSessions !== undefined) {
    return <main className="pext-root pext-plugin-detail-page" data-power-evolve-plugin-detail="personal-mcp">
      <header className="pext-plugin-breadcrumb"><button type="button" onClick={() => { setSelected(undefined) }}>
        {t('pluginsTitle')}</button><IconChevronRightOutlineRegular size={14} /><span>{t('personalMcpPluginTitle')}</span></header>
      <PersonalMcpPage personalMcp={personalMcp} sessions={mcpSessions} t={t} onConnectionsChange={updatePersonalMcpItems} />
    </main>
  }

  if (selected === 'ssh' && sshData) {
    return <main className="pext-root pext-plugin-detail-page" data-power-evolve-plugin-detail="ssh">
      <header className="pext-plugin-breadcrumb"><button type="button" onClick={() => { setSelected(undefined) }}>
        {t('pluginsTitle')}</button><IconChevronRightOutlineRegular size={14} /><span>SSH</span></header>
      <PersonalSshPage data={sshData} port={ssh} t={t} onReload={reloadSsh}
        onChange={next => { setSshData(current => current === undefined ? current : { ...current, items: next }) }} />
    </main>
  }

  return <main ref={list} className="pext-root pext-catalog-page" data-power-evolve-plugins-page>
    <header className="pext-catalog-header"><nav className="pext-catalog-tabs" role="tablist" aria-label={t('pluginsTitle')}>
      <button type="button" role="tab" aria-selected={view === 'installed'} onClick={() => { setView('installed') }}>
        {t('myPlugins')}<small>{items.length + Number(mcpInstalled) + Number(personalMcpInstalled) + Number(stdioInstalled) + Number(sshInstalled)}</small></button>
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
      <button type="button" className="pext-card-action" onClick={() => {
        reload(); reloadMcp(); reloadPersonalMcp(); reloadStdio(); reloadSsh() }}>{t('refreshList')}</button>
      {loadError && <div className="pext-error" role="alert">{loadError}</div>}
      {mcpLoadError && <div className="pext-error" role="alert">{t('mcpLoadFailed')}</div>}
      {personalMcpLoadError && <div className="pext-error" role="alert">{t('mcpLoadFailed')}</div>}
      {stdioLoadError && <div className="pext-error" role="alert">{t('stdioLoadFailed')}</div>}
      {sshLoadError && <div className="pext-error" role="alert">{t('sshLoadFailed')}</div>}
      {loading ? <div className="pext-loading" role="status">{t('pluginLoading')}</div>
        : loadError ? null : visible.length === 0 ? <div className="pext-empty">{t('pluginCatalogEmpty')}</div>
          : <div className="pext-card-grid">{visible.map(id => {
            const isNotes = id === 'notes'
            const isMcp = id === 'mcp'
            const isPersonalMcp = id === 'personal-mcp'
            const isStdio = id === 'stdio'
            const isSsh = id === 'ssh'
            const title = isNotes ? t('notesPluginTitle')
              : isPersonalMcp ? t('personalMcpPluginTitle')
              : isStdio ? t('stdioMcpTitle') : id.toUpperCase()
            const openable = isNotes && notes !== undefined || isMcp && mcpData !== undefined
              && (mcpData.available || mcpInstalled) || isStdio && stdioData !== undefined
              && (stdioData.available || stdioInstalled) || isPersonalMcp && personalMcp !== undefined
              && mcpSessions !== undefined && personalMcpData !== undefined && (personalMcpData.available || personalMcpInstalled)
              || isSsh && sshData !== undefined
              && (sshData.available || sshInstalled)
            return <article className="pext-extension-card" key={id} data-plugin-id={id}>
              <div className="pext-extension-card-top"><span className="pext-extension-icon" aria-hidden="true">
                <IconApiOutlineRegular size={21} /></span><span className="pext-extension-badge">
                {isNotes && notes ? t(notes.enabled ? 'enabledState' : 'disabledState')
                  : isPersonalMcp && personalMcpInstalled ? t('mcpInstalled')
                    : isPersonalMcp && personalMcpLoading ? t('mcpLoading')
                      : isPersonalMcp && personalMcpData?.available ? t('pluginBuiltin')
                  : isMcp && mcpInstalled ? t('mcpInstalled')
                    : isMcp && mcpLoading ? t('mcpLoading')
                      : isMcp && mcpData?.available ? t('pluginBuiltin')
                        : isStdio && stdioInstalled ? t('mcpInstalled')
                          : isStdio && stdioLoading ? t('mcpLoading')
                            : isStdio && stdioData?.available ? t('pluginBuiltin')
                        : isSsh && sshInstalled ? t('mcpInstalled')
                          : isSsh && sshLoading ? t('sshLoading')
                            : isSsh && sshData?.available ? t('pluginBuiltin') : t('pluginNotAvailable')}</span></div>
              {openable ? <button className="pext-extension-title" type="button" onClick={() => {
                scrollTop.current = list.current?.scrollTop ?? 0; setSelected(id) }}>{title}</button>
                : <strong className="pext-extension-title">{title}</strong>}
              <p>{t(isNotes ? 'notesPluginDescription' : isPersonalMcp ? 'personalMcpPluginDescription' : isMcp ? 'mcpPluginDescription'
                : isStdio ? 'stdioMcpDescription' : 'sshPluginDescription')}</p>
              <div className="pext-extension-card-bottom"><span>{openable ? t('pluginBuiltin') : t('pluginNotAvailable')}</span>
                {openable ? <button type="button" className="pext-card-action" onClick={() => {
                  scrollTop.current = list.current?.scrollTop ?? 0; setSelected(id) }}>{t('viewDetails')}</button> : null}</div>
            </article>
          })}</div>}
      <aside className="pext-catalog-note">{t('pluginNextTaskHint')}</aside>
    </section>
  </main>
}
