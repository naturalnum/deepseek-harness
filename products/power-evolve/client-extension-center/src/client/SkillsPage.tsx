import { IconPlusOutlineRegular, IconSearchOutlineRegular, IconSkillOutlineRegular } from '@deepseek-ai/dsh-client-ui-primitives'
import { useCallback, useEffect, useMemo, useRef, useState, type ReactNode } from 'react'
import type { InjectFace, PropsLocale, PropsRuntime } from '@deepseek-ai/dsh-client-ui-slots'
import { SkillHttpError, type PersonalSkill, type SkillPort } from './skills-api.ts'
import { SkillDetailDialog } from './SkillDetailDialog.tsx'
import { SkillInstallPanel } from './SkillInstallPanel.tsx'
import { SkillToggle } from './SkillToggle.tsx'

export type SkillsPageProps = PropsRuntime<'main'> & PropsLocale<'powerEvolve.extensionCenter'>
  & InjectFace<{ readonly client: SkillPort }>

/** The old PowerEvolve Skills card layout with the current personal-skill RPC. */
export function SkillsPage({ client, t }: SkillsPageProps): ReactNode {
  const [items, setItems] = useState<readonly PersonalSkill[]>([])
  const [loading, setLoading] = useState(true)
  const [loadError, setLoadError] = useState<string>()
  const [mutationError, setMutationError] = useState<string>()
  const [notice, setNotice] = useState<string>()
  const [search, setSearch] = useState('')
  const [selectedId, setSelectedId] = useState<string>()
  const [installOpen, setInstallOpen] = useState(false)
  const [busyId, setBusyId] = useState<string>()
  const request = useRef<AbortController>()
  const busy = useRef(false)

  const reload = useCallback((): void => {
    request.current?.abort()
    const controller = new AbortController()
    request.current = controller
    setLoading(true); setLoadError(undefined)
    void client.list(controller.signal).then(value => {
      if (!controller.signal.aborted) setItems(value)
    }).catch((cause: unknown) => {
      if (!controller.signal.aborted) setLoadError(cause instanceof SkillHttpError && cause.status === 401
        ? t('sessionExpired') : t('loadFailed'))
    }).finally(() => {
      if (!controller.signal.aborted) setLoading(false)
    })
  }, [client, t])

  useEffect(() => { reload(); return () => { request.current?.abort() } }, [reload])

  const toggle = async (skillId: string, enabled: boolean): Promise<void> => {
    if (busy.current) return
    busy.current = true; setBusyId(skillId); setMutationError(undefined); setNotice(undefined)
    try {
      const updated = await client.toggle(skillId, enabled)
      setItems(current => current.map(item => item.skillId === skillId ? updated : item))
    } catch (cause) {
      setMutationError(cause instanceof SkillHttpError
        ? cause.status === 401 ? t('sessionExpired') : cause.status === 404 ? t('skillMissing') : t('toggleFailed')
        : t('toggleFailed'))
    } finally { busy.current = false; setBusyId(undefined) }
  }

  const visible = useMemo(() => {
    const query = search.trim().toLocaleLowerCase()
    return query ? items.filter(item => [item.name, item.description]
      .some(value => value.toLocaleLowerCase().includes(query))) : items
  }, [items, search])
  const selected = items.find(item => item.skillId === selectedId)

  return <main className="pext-root pext-catalog-page" data-power-evolve-skills-page>
    <header className="pext-catalog-header">
      <div className="pext-catalog-tabs"><span className="pext-catalog-current">
        {t('mySkills')}<small>{items.length}</small></span></div>
      <button type="button" className="pext-dialog-button" onClick={() => { setMutationError(undefined); setInstallOpen(true) }}>
        <IconPlusOutlineRegular size={15} />{t('installSkill')}
      </button>
    </header>
    <section className="pext-catalog-content" aria-label={t('skillsTitle')}>
      <label className="pext-catalog-search"><span className="pext-visually-hidden">{t('searchMySkills')}</span>
        <IconSearchOutlineRegular size={17} /><input type="search" value={search} placeholder={t('searchMySkills')}
          onChange={event => { setSearch(event.target.value) }} /></label>
      <div className="pext-catalog-filter-row"><span>{t('resultCount').replace('{count}', String(visible.length))}</span>
        <button type="button" className="pext-card-action" onClick={reload}>{t('refreshList')}</button></div>
      {loadError && <div className="pext-error" role="alert">{loadError}</div>}
      {mutationError && <div className="pext-error" role="alert">{mutationError}</div>}
      {notice && <div className="pext-catalog-note" role="status">{notice}</div>}
      {loading ? <div className="pext-loading" role="status">{t('loading')}</div>
        : loadError ? null
          : visible.length === 0 ? <div className="pext-empty">{search.trim() ? t('searchEmpty') : t('mySkillsEmpty')}</div>
          : <div className="pext-card-grid">{visible.map(skill => <article className="pext-extension-card" key={skill.skillId}>
            <div className="pext-extension-card-top">
              <span className="pext-extension-icon" aria-hidden="true"><IconSkillOutlineRegular size={21} /></span>
              <span className="pext-extension-badge" data-enabled={skill.enabled || undefined}>
                {t(skill.enabled ? 'enabledState' : 'disabledState')}</span>
            </div>
            <button type="button" className="pext-extension-title" onClick={() => { setSelectedId(skill.skillId); setMutationError(undefined) }}>
              {skill.name}</button>
            <p>{skill.description}</p>
            <div className="pext-extension-card-bottom">
              <span>{t('revision').replace('{count}', String(skill.revision))}</span>
              <div><button type="button" className="pext-card-action" onClick={() => { setSelectedId(skill.skillId); setMutationError(undefined) }}>
                {t('viewDetails')}</button>
                <SkillToggle label={`${skill.name} ${t('enable')}`} checked={skill.enabled} disabled={busyId !== undefined}
                  onChange={enabled => { void toggle(skill.skillId, enabled) }} /></div>
            </div>
          </article>)}</div>}
      <aside className="pext-catalog-note">{t('nextTaskHint')}</aside>
    </section>
    <SkillInstallPanel open={installOpen} client={client} t={t} onClose={() => { setInstallOpen(false) }}
      onInstalled={skill => { setItems(current => [...current.filter(item => item.skillId !== skill.skillId), skill]
        .sort((left, right) => left.name.localeCompare(right.name))); setInstallOpen(false); setNotice(t('installed')) }} />
    {selected && <SkillDetailDialog skill={selected} client={client} busy={busyId !== undefined}
      mutationError={mutationError} t={t} onClose={() => { setSelectedId(undefined); setMutationError(undefined) }}
      onToggle={enabled => { void toggle(selected.skillId, enabled) }} />}
  </main>
}
