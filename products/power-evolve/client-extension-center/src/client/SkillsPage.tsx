import { IconPlusOutlineRegular, IconSearchOutlineRegular, IconSkillOutlineRegular, Modal } from '@deepseek-ai/dsh-client-ui-primitives'
import { useCallback, useEffect, useMemo, useRef, useState, type ReactNode } from 'react'
import type { InjectFace, PropsLocale, PropsRuntime, TranslateNS } from '@deepseek-ai/dsh-client-ui-slots'
import { SkillHttpError, type BuiltinSkill, type InstallBuiltinSkillInput, type PersonalSkill, type SkillPort } from './skills-api.ts'
import { SkillDetailDialog } from './SkillDetailDialog.tsx'
import { SkillImportPanel } from './SkillImportPanel.tsx'
import { SkillInstallPanel } from './SkillInstallPanel.tsx'
import { SkillToggle } from './SkillToggle.tsx'

export type SkillsPageProps = PropsRuntime<'main'> & PropsLocale<'powerEvolve.extensionCenter'>
  & InjectFace<{ readonly client: SkillPort; readonly trySkill: (skill: PersonalSkill) => Promise<void> }>

type View = 'installed' | 'all'
type Category = 'writing-office' | 'data-analysis' | 'research-knowledge' | 'development-tools' | 'imported' | 'other'
const purposeCategories: readonly Category[] = ['writing-office', 'data-analysis', 'research-knowledge', 'development-tools']
const builtinCategories: Readonly<Record<string, Category>> = {
  'builtin.word': 'writing-office', 'builtin.powerpoint': 'writing-office',
  'builtin.excel': 'data-analysis', 'builtin.pdf': 'research-knowledge',
  'builtin.latex-report-writer': 'writing-office', 'builtin.power-grid-technical-report-writer': 'writing-office',
  'builtin.report-reviewer': 'writing-office', 'builtin.report-workflow-orchestrator': 'writing-office',
  'builtin.tech-report-writer': 'writing-office',
}
const categoryLabels = {
  'writing-office': 'skillCategoryWritingOffice', 'data-analysis': 'skillCategoryDataAnalysis',
  'research-knowledge': 'skillCategoryResearchKnowledge', 'development-tools': 'skillCategoryDevelopmentTools',
  imported: 'skillCategoryImported', other: 'skillCategoryOther',
} as const

function categoryOf(skill: BuiltinSkill): Category {
  const known = builtinCategories[skill.id]
  if (known !== undefined) return known
  const value = skill.category.toLocaleLowerCase()
  if (/(?:writing|office|document|productivity|presentation|文档|写作|办公|演示)/u.test(value)) return 'writing-office'
  if (/(?:data|analysis|analytics|spreadsheet|excel|数据|分析|表格)/u.test(value)) return 'data-analysis'
  if (/(?:research|knowledge|reading|pdf|search|研究|知识|阅读|检索)/u.test(value)) return 'research-knowledge'
  if (/(?:development|developer|coding|code|web|开发|编程|代码|网页)/u.test(value)) return 'development-tools'
  return 'other'
}

function matches(values: readonly string[], query: string): boolean {
  return values.some(value => value.toLocaleLowerCase().includes(query))
}

function catalogStatus(skill: BuiltinSkill, personal: PersonalSkill | undefined,
  t: TranslateNS<'powerEvolve.extensionCenter'>): string {
  if (personal?.observedState === 'revoked') return t('revokedState')
  if (personal !== undefined) return t(personal.enabled ? 'enabledState' : 'disabledState')
  return skill.installedSkillId === null ? t('builtinAvailable') : t('builtinInstalled')
}

/** The old PowerEvolve catalog layout with owner-scoped personal-skill RPCs. */
export function SkillsPage({ client, t, trySkill }: SkillsPageProps): ReactNode {
  const [view, setView] = useState<View>('installed')
  const [items, setItems] = useState<readonly PersonalSkill[]>([])
  const [catalog, setCatalog] = useState<readonly BuiltinSkill[]>([])
  const [loading, setLoading] = useState(true)
  const [catalogLoading, setCatalogLoading] = useState(true)
  const [loadError, setLoadError] = useState<string>()
  const [catalogError, setCatalogError] = useState<string>()
  const [mutationError, setMutationError] = useState<string>()
  const [notice, setNotice] = useState<string>()
  const [search, setSearch] = useState('')
  const [category, setCategory] = useState<Category | ''>('')
  const [selectedId, setSelectedId] = useState<string>()
  const [selectedCatalogId, setSelectedCatalogId] = useState<string>()
  const [installOpen, setInstallOpen] = useState(false)
  const [importOpen, setImportOpen] = useState(false)
  const [busyId, setBusyId] = useState<string>()
  const [pendingBuiltin, setPendingBuiltin] = useState<InstallBuiltinSkillInput>()
  const listRequest = useRef<AbortController>()
  const catalogRequest = useRef<AbortController>()
  const mutationRequest = useRef<AbortController>()
  const currentClient = useRef(client)
  const busy = useRef(false)
  const alive = useRef(false)

  const reloadCatalog = useCallback((): void => {
    catalogRequest.current?.abort()
    const controller = new AbortController()
    catalogRequest.current = controller
    setCatalogLoading(true); setCatalogError(undefined)
    void client.catalog(controller.signal).then(value => {
      if (!controller.signal.aborted) setCatalog(value)
    }).catch((cause: unknown) => {
      if (!controller.signal.aborted) setCatalogError(cause instanceof SkillHttpError && cause.status === 401
        ? t('sessionExpired') : t('builtinCatalogFailed'))
    }).finally(() => {
      if (!controller.signal.aborted) setCatalogLoading(false)
    })
  }, [client, t])

  /** Listing may lazily preinstall built-ins, so read the catalog only after it settles. */
  const reload = useCallback((): void => {
    listRequest.current?.abort(); catalogRequest.current?.abort()
    const controller = new AbortController()
    listRequest.current = controller
    setLoading(true); setLoadError(undefined)
    setCatalogLoading(true); setCatalogError(undefined)
    void client.list(controller.signal).then(value => {
      if (controller.signal.aborted) return
      setItems(value)
      reloadCatalog()
    }).catch((cause: unknown) => {
      if (controller.signal.aborted) return
      setLoadError(cause instanceof SkillHttpError && cause.status === 401
        ? t('sessionExpired') : t('loadFailed'))
      setCatalogLoading(false)
    }).finally(() => {
      if (!controller.signal.aborted) setLoading(false)
    })
  }, [client, reloadCatalog, t])

  useEffect(() => {
    if (currentClient.current !== client) {
      currentClient.current = client
      busy.current = false
      setItems([]); setCatalog([]); setPendingBuiltin(undefined); setBusyId(undefined)
      setSelectedId(undefined); setSelectedCatalogId(undefined)
      setInstallOpen(false); setImportOpen(false); setMutationError(undefined); setNotice(undefined)
    }
    alive.current = true
    reload()
    return () => {
      alive.current = false
      listRequest.current?.abort(); catalogRequest.current?.abort(); mutationRequest.current?.abort()
    }
  }, [client, reload])

  const toggle = async (skillId: string, enabled: boolean): Promise<void> => {
    if (busy.current) return
    busy.current = true; listRequest.current?.abort(); setLoading(false); setCatalogLoading(false)
    setBusyId(skillId); setMutationError(undefined); setNotice(undefined)
    try {
      const updated = await client.toggle(skillId, enabled)
      if (alive.current && currentClient.current === client)
        setItems(current => current.map(item => item.skillId === skillId ? updated : item))
    } catch (cause) {
      if (alive.current && currentClient.current === client) setMutationError(cause instanceof SkillHttpError
        ? cause.status === 401 ? t('sessionExpired') : cause.status === 404 ? t('skillMissing') : t('toggleFailed')
        : t('toggleFailed'))
    } finally { if (currentClient.current === client) { busy.current = false; if (alive.current) setBusyId(undefined) } }
  }

  const revoke = async (skillId: string): Promise<void> => {
    if (busy.current) return
    busy.current = true; listRequest.current?.abort(); setLoading(false); setCatalogLoading(false)
    setBusyId(skillId); setMutationError(undefined); setNotice(undefined)
    try {
      const updated = await client.revoke(skillId)
      if (alive.current && currentClient.current === client) {
        setItems(current => current.map(item => item.skillId === skillId ? updated : item))
        setNotice(t('skillRevoked'))
      }
    } catch (cause) {
      if (alive.current && currentClient.current === client) setMutationError(cause instanceof SkillHttpError && cause.status === 401
        ? t('sessionExpired') : t('revokeFailed'))
    } finally { if (currentClient.current === client) { busy.current = false; if (alive.current) setBusyId(undefined) } }
  }

  const installed = (skill: PersonalSkill): void => {
    if (!alive.current || currentClient.current !== client) return
    listRequest.current?.abort()
    setLoading(false); setCatalogLoading(false); setLoadError(undefined)
    setItems(current => [...current.filter(item => item.skillId !== skill.skillId), skill]
      .sort((left, right) => left.name.localeCompare(right.name)))
    setInstallOpen(false); setImportOpen(false); setNotice(t('installed'))
  }

  const installBuiltin = async (entry: BuiltinSkill): Promise<void> => {
    if (busy.current || (pendingBuiltin !== undefined && pendingBuiltin.catalogId !== entry.id)) return
    const input = pendingBuiltin ?? { requestId: crypto.randomUUID(), catalogId: entry.id, version: entry.version }
    busy.current = true; listRequest.current?.abort(); catalogRequest.current?.abort()
    setLoading(false); setCatalogLoading(false)
    const controller = new AbortController()
    mutationRequest.current = controller
    setPendingBuiltin(input); setBusyId(entry.id); setMutationError(undefined); setNotice(undefined)
    try {
      const skill = await client.installBuiltin(input, controller.signal)
      if (!alive.current || currentClient.current !== client || controller.signal.aborted) return
      setPendingBuiltin(undefined)
      setCatalog(current => current.map(item => item.id === entry.id ? { ...item, installedSkillId: skill.skillId } : item))
      installed(skill)
      setSelectedCatalogId(undefined); setSelectedId(skill.skillId); setView('installed'); setCategory('')
    } catch (cause) {
      if (!alive.current || currentClient.current !== client || controller.signal.aborted) return
      if (cause instanceof SkillHttpError && [400, 401, 404, 409, 413].includes(cause.status)) {
        setPendingBuiltin(undefined)
        setMutationError(cause.status === 401 ? t('sessionExpired') : cause.status === 409
          ? t('builtinInstallConflict') : cause.status === 413 ? t('skillLimit') : t('builtinInstallFailed'))
      } else setMutationError(t('builtinInstallUncertain'))
    } finally {
      if (currentClient.current === client) {
        busy.current = false
        if (alive.current) setBusyId(undefined)
      }
    }
  }

  const personalById = useMemo(() => new Map(items.map(item => [item.skillId, item])), [items])
  const catalogByPersonalId = useMemo(() => new Map(catalog.flatMap(entry => entry.installedSkillId === null
    ? [] : [[entry.installedSkillId, entry] as const])), [catalog])
  const query = search.trim().toLocaleLowerCase()
  const visiblePersonal = items.filter(item => (category === '' || (catalogByPersonalId.get(item.skillId)
    ? categoryOf(catalogByPersonalId.get(item.skillId)!) : 'imported') === category)
    && (!query || matches([item.name, item.description], query)))
  const visibleCatalog = catalog.filter(entry => (category === '' || categoryOf(entry) === category)
    && (!query || matches([entry.name, entry.id, entry.summary, entry.description, entry.category, entry.publisher], query)))
  const categories = view === 'all'
    ? [...purposeCategories, ...(catalog.some(entry => categoryOf(entry) === 'other') ? ['other' as const] : [])]
    : [...purposeCategories, 'imported' as const]
  const selected = items.find(item => item.skillId === selectedId)
  const selectedCatalog = catalog.find(item => item.id === selectedCatalogId)
  const clientChanged = currentClient.current !== client
  const pageLoading = clientChanged || loading || (view === 'all' && catalogLoading)
  const pageError = clientChanged ? undefined : loadError ?? (view === 'all' ? catalogError : undefined)
  const visibleCount = view === 'all' ? visibleCatalog.length : visiblePersonal.length
  const refresh = (): void => { reload() }

  return <main className="pext-root pext-catalog-page" data-power-evolve-skills-page>
    <header className="pext-catalog-header">
      <nav className="pext-catalog-tabs" role="tablist" aria-label={t('skillsTitle')}>
        <button type="button" role="tab" aria-selected={view === 'installed'} onClick={() => { setView('installed'); setCategory('') }}>
          {t('mySkills')}<small>{clientChanged ? 0 : items.length}</small></button>
        <button type="button" role="tab" aria-selected={view === 'all'} onClick={() => { setView('all'); setCategory('') }}>
          {t('allSkills')}</button>
      </nav>
      <div className="pext-catalog-actions">
        <button type="button" className="pext-dialog-button" onClick={() => { setMutationError(undefined); setInstallOpen(true) }}>
          <IconPlusOutlineRegular size={15} />{t('installSkill')}</button>
        <button type="button" className="pext-dialog-button pext-dialog-button-primary"
          onClick={() => { setMutationError(undefined); setImportOpen(true) }}>{t('importSkillPackage')}</button>
      </div>
    </header>
    <section className="pext-catalog-content" role="tabpanel" aria-label={view === 'all' ? t('allSkills') : t('mySkills')}>
      <label className="pext-catalog-search"><span className="pext-visually-hidden">{view === 'all' ? t('searchAllSkills') : t('searchMySkills')}</span>
        <IconSearchOutlineRegular size={17} /><input type="search" value={search}
          placeholder={view === 'all' ? t('searchAllSkills') : t('searchMySkills')}
          onChange={event => { setSearch(event.target.value) }} /></label>
      <div className="pext-catalog-filter-row">
        <div className="pext-category-tabs" aria-label={t('skillCategory')}>
          <button type="button" aria-pressed={category === ''} onClick={() => { setCategory('') }}>{t('allCategories')}</button>
          {categories.map(value => <button key={value} type="button" aria-pressed={category === value}
            onClick={() => { setCategory(value) }}>{t(categoryLabels[value])}</button>)}
        </div>
        <span>{t('resultCount').replace('{count}', String(clientChanged ? 0 : visibleCount))}</span>
        <button type="button" className="pext-card-action" onClick={refresh}>{t('refreshList')}</button>
      </div>
      {pageError && <div className="pext-error" role="alert">{pageError}</div>}
      {!clientChanged && mutationError && <div className="pext-error" role="alert">{mutationError}</div>}
      {!clientChanged && notice && <div className="pext-catalog-note" role="status">{notice}</div>}
      {pageLoading ? <div className="pext-loading" role="status">{t('loading')}</div>
        : pageError ? null
          : visibleCount === 0 ? <div className="pext-empty">{search.trim() || category
            ? t('searchEmpty') : view === 'all' ? t('builtinCatalogEmpty') : t('mySkillsEmpty')}</div>
          : view === 'all' ? <div className="pext-card-grid">{visibleCatalog.map(entry => {
            const personal = entry.installedSkillId === null ? undefined : personalById.get(entry.installedSkillId)
            const canInstall = entry.installedSkillId === null && (pendingBuiltin === undefined || pendingBuiltin.catalogId === entry.id)
            return <article className="pext-extension-card" key={entry.id}>
              <div className="pext-extension-card-top">
                <span className="pext-extension-icon" aria-hidden="true"><IconSkillOutlineRegular size={21} /></span>
                <span className="pext-extension-badge" data-enabled={personal?.enabled && personal.observedState === 'ready' || undefined}>
                  {catalogStatus(entry, personal, t)}</span>
              </div>
              <button type="button" className="pext-extension-title" onClick={() => { setSelectedCatalogId(entry.id); setMutationError(undefined) }}>
                {entry.name}</button>
              <p>{entry.summary}</p>
              <div className="pext-extension-card-bottom"><span>{t('skillVersion').replace('{version}', entry.version)}</span>
                <div><button type="button" className="pext-card-action" onClick={() => { setSelectedCatalogId(entry.id); setMutationError(undefined) }}>
                  {t('viewDetails')}</button>
                  {canInstall && <button type="button" className="pext-card-action pext-card-action-primary"
                    disabled={busyId !== undefined} onClick={() => { void installBuiltin(entry) }}>
                    {busyId === entry.id ? t('builtinInstalling') : pendingBuiltin?.catalogId === entry.id ? t('retryInstall') : t('builtinInstall')}
                  </button>}
                  {personal?.observedState === 'ready' && <SkillToggle label={`${entry.name} ${t('enable')}`}
                    checked={personal.enabled} disabled={busyId !== undefined}
                    onChange={enabled => { void toggle(personal.skillId, enabled) }} />}</div>
              </div>
            </article>
          })}</div>
          : <div className="pext-card-grid">{visiblePersonal.map(skill => <article className="pext-extension-card" key={skill.skillId}>
            <div className="pext-extension-card-top">
              <span className="pext-extension-icon" aria-hidden="true"><IconSkillOutlineRegular size={21} /></span>
              <span className="pext-extension-badge" data-enabled={skill.enabled && skill.observedState === 'ready' || undefined}>
                {t(skill.observedState === 'revoked' ? 'revokedState' : skill.enabled ? 'enabledState' : 'disabledState')}</span>
            </div>
            <button type="button" className="pext-extension-title" onClick={() => { setSelectedId(skill.skillId); setMutationError(undefined) }}>
              {skill.name}</button>
            <p>{skill.description}</p>
            <div className="pext-extension-card-bottom">
              <span>{skill.kind === 'package' ? `${t('skillVersion').replace('{version}', skill.version ?? '')} · ${t(skill.observedState === 'ready' ? 'readyState' : 'revokedState')}`
                : t('revision').replace('{count}', String(skill.revision))}</span>
              <div><button type="button" className="pext-card-action" onClick={() => { setSelectedId(skill.skillId); setMutationError(undefined) }}>
                {t('viewDetails')}</button>
                <SkillToggle label={`${skill.name} ${t('enable')}`} checked={skill.enabled}
                  disabled={busyId !== undefined || skill.observedState === 'revoked'}
                  onChange={enabled => { void toggle(skill.skillId, enabled) }} /></div>
            </div>
          </article>)}</div>}
      <aside className="pext-catalog-note">{view === 'all' ? t('builtinPreviewHint') : t('nextTaskHint')}</aside>
    </section>
    <SkillInstallPanel open={!clientChanged && installOpen} client={client} t={t} onClose={() => { setInstallOpen(false) }}
      onInstalled={installed} />
    <SkillImportPanel open={!clientChanged && importOpen} client={client} t={t} onClose={() => { setImportOpen(false) }}
      onImported={() => { if (currentClient.current !== client) return
        setImportOpen(false); setNotice(t('installed')); reload() }} />
    {!clientChanged && selected && <SkillDetailDialog skill={selected} client={client} busy={busyId !== undefined}
      mutationError={mutationError} t={t} onClose={() => { setSelectedId(undefined); setMutationError(undefined) }}
      onToggle={enabled => { void toggle(selected.skillId, enabled) }}
      onRevoke={() => { void revoke(selected.skillId) }} onTry={() => trySkill(selected)} />}
    {!clientChanged && selectedCatalog && <CatalogDetailDialog skill={selectedCatalog}
      personal={selectedCatalog.installedSkillId === null ? undefined : personalById.get(selectedCatalog.installedSkillId)}
      busy={busyId !== undefined} pending={pendingBuiltin?.catalogId === selectedCatalog.id}
      blocked={pendingBuiltin !== undefined && pendingBuiltin.catalogId !== selectedCatalog.id}
      error={mutationError} t={t} onClose={() => { setSelectedCatalogId(undefined); setMutationError(undefined) }}
      onInstall={() => { void installBuiltin(selectedCatalog) }}
      onOpenPersonal={() => { if (selectedCatalog.installedSkillId === null) return
        setSelectedCatalogId(undefined); setSelectedId(selectedCatalog.installedSkillId) }} />}
  </main>
}

function CatalogDetailDialog({ skill, personal, busy, pending, blocked, error, t, onClose, onInstall, onOpenPersonal }: {
  readonly skill: BuiltinSkill
  readonly personal: PersonalSkill | undefined
  readonly busy: boolean
  readonly pending: boolean
  readonly blocked: boolean
  readonly error: string | undefined
  readonly t: TranslateNS<'powerEvolve.extensionCenter'>
  readonly onClose: () => void
  readonly onInstall: () => void
  readonly onOpenPersonal: () => void
}): ReactNode {
  const available = skill.installedSkillId === null
  return <Modal open onClose={onClose} title={skill.name} closeLabel={t('close')} className="pext-skill-dialog"
    footer={<div className="pext-skill-dialog-footer">
      {available ? <button type="button" className="pext-dialog-button pext-dialog-button-primary" disabled={busy || blocked}
        onClick={onInstall}>{busy ? t('builtinInstalling') : pending ? t('retryInstall') : t('builtinInstall')}</button>
        : personal && <button type="button" className="pext-dialog-button pext-dialog-button-primary" onClick={onOpenPersonal}>
          {t('viewDetails')}</button>}
    </div>}>
    <div className="pext-skill-dialog-body">
      <header className="pext-skill-dialog-header">
        <span className="pext-skill-dialog-glyph" aria-hidden="true"><IconSkillOutlineRegular size={21} /></span>
        <div><div className="pext-skill-dialog-title"><strong>{skill.name}</strong></div>
          <p>{skill.summary}</p><small>{t('skillVersion').replace('{version}', skill.version)}</small></div>
      </header>
      <div className="pext-skill-state"><span>{t('builtinPublisher').replace('{publisher}', skill.publisher)}</span>
        <span>{catalogStatus(skill, personal, t)}</span></div>
      {error && <div className="pext-error" role="alert">{error}</div>}
      <section className="pext-skill-document" aria-label={t('builtinDescription')}>
        <div className="pext-skill-document-bar">{t('builtinDescription')}</div>
        <div className="pext-skill-document-reader pext-skill-markdown"><p>{skill.description}</p></div>
      </section>
      <p className="pext-catalog-note">{t('builtinPreviewHint')}</p>
    </div>
  </Modal>
}
