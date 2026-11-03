/** Complete-package input and actual detail/result presentation on the original page's managed skill source. */
import { useEffect, useRef, useState, type ReactNode } from 'react'
import { IconSkillOutlineRegular, Modal, Switch } from '@deepseek-ai/dsh-client-ui-primitives'
import type { TranslateNS } from '@deepseek-ai/dsh-client-ui-slots'
import type { ManagedSkillEditing, ManagedSkillFileContent, ManagedSkillOutcome } from '../../managed-skill-editing.ts'
import { readSelectedSkillBundle } from './selected-bundle.ts'
import type { SkillManagementActions } from './types.ts'
import { SkillMarkdown } from './SkillMarkdown.tsx'
import { useSkillAction } from './use-skill-action.ts'
import css from './SkillsPage.module.css'

/**
 * Render explicit local selection and once-only native actions without parsing archives or installing packages locally.
 * @param props Original page-owned editor, existing feedback callback, and localized text.
 * @returns A bounded file/ZIP editor with separate persistence, application, and browser-download facts.
 */
export function ManagedSkillEditor({ editor, actions, t }: {
  readonly editor: ManagedSkillEditing
  readonly actions: SkillManagementActions
  readonly t: TranslateNS<'cloud-skill-management'>
}): ReactNode {
  const report = actions.report, toggleAction = useSkillAction()
  const observer = useRef<AbortController>()
  const fileRead = useRef<AbortController>()
  const [copying, setCopying] = useState(false), [invalid, setInvalid] = useState(false)
  const [downloadFailed, setDownloadFailed] = useState(false)
  const [confirmRemove, setConfirmRemove] = useState(false)
  const [view, setView] = useState<'summary' | 'files' | 'edit'>('summary')
  const [selectedFile, setSelectedFile] = useState<string>()
  const [fileContent, setFileContent] = useState<ManagedSkillFileContent>()
  const [filePhase, setFilePhase] = useState<'loading' | 'ready' | 'error' | 'unavailable'>('unavailable')
  useEffect(() => {
    const control = new AbortController(); observer.current = control
    return () => { control.abort(); fileRead.current?.abort(); observer.current = undefined }
  }, [])
  const busy = copying || toggleAction.state === 'pending' || editor.phase === 'opening' || editor.phase === 'submitting' || editor.phase === 'downloading'
  const selection = editor.selection, detail = editor.detail, limits = editor.limits
  const draft = editor.draft !== undefined && editor.draft.forSkill === selection ? editor.draft.bundle : undefined
  const canPublish = editor.phase === 'editing' && editor.canPublish
  const alive = (control: AbortController): boolean => observer.current === control && !control.signal.aborted
  const showFile = (path: string): void => {
    const control = observer.current
    if (control === undefined || busy || detail === undefined) return
    fileRead.current?.abort()
    setSelectedFile(path); setFileContent(undefined)
    if (detail.readFile === undefined) {
      if (path === 'SKILL.md' && detail.markdown !== undefined) {
        setFileContent({ kind: 'text', text: detail.markdown }); setFilePhase('ready')
      } else setFilePhase('unavailable')
      return
    }
    const request = new AbortController(), read = detail.readFile
    fileRead.current = request; setFilePhase('loading')
    void read(path, AbortSignal.any([control.signal, request.signal])).then((content) => {
      if (alive(control) && !request.signal.aborted) { setFileContent(content); setFilePhase('ready') }
    }, () => { if (alive(control) && !request.signal.aborted) setFilePhase('error') })
  }
  const changeView = (next: 'summary' | 'files' | 'edit'): void => {
    fileRead.current?.abort(); setView(next)
    if (next === 'files') {
      const path = detail?.files.find(file => file.path === 'SKILL.md')?.path ?? detail?.files[0]?.path
      if (path !== undefined) showFile(path)
    }
  }
  const choose = (files: readonly File[], directory: boolean): void => {
    const control = observer.current
    if (control === undefined || busy || !canPublish || limits === undefined) return
    setCopying(true); setInvalid(false)
    const copy = async (): Promise<void> => {
      try {
        const relative = files[0]?.webkitRelativePath
        const separator = relative?.indexOf('/')
        if (directory && (relative === undefined || separator === undefined || separator < 1)) { setInvalid(true); return }
        const prefix = directory && relative !== undefined && separator !== undefined ? relative.slice(0, separator) + '/' : ''
        if (directory && files.some(file => !file.webkitRelativePath.startsWith(prefix))) { setInvalid(true); return }
        const selected = files.map(file => ({ file, path: directory ? file.webkitRelativePath.slice(prefix.length) : file.name }))
        const result = await readSelectedSkillBundle(selected, limits, control.signal)
        if (!alive(control)) return
        if (!result.ok) { setInvalid(true); return }
        editor.choose(Object.freeze({ kind: 'files', selection: result.value, markdown: result.value.markdown }))
      } catch { if (alive(control)) setInvalid(true) }
      finally { if (alive(control)) setCopying(false) }
    }
    void copy()
  }
  const zip = (file: File | undefined): void => {
    if (busy || !canPublish || limits === undefined) return
    if (file === undefined) return
    if (!/\.(zip|skill)$/i.test(file.name) || file.size === 0 || file.size > limits.maxArchiveBytes) {
      setInvalid(true); return
    }
    try { editor.choose(Object.freeze({ kind: 'zip', file })); setInvalid(false) }
    catch { setInvalid(true) }
  }
  const submit = (remove: boolean): void => {
    const control = observer.current
    if (control === undefined || busy) return
    setInvalid(false)
    const action = remove ? editor.uninstall : editor.publish
    const show = (outcome: ManagedSkillOutcome): void => {
      if (!alive(control) || outcome.kind === 'invalid-bundle') return
      report(remove ? 'remove' : selection === null ? 'install' : 'update', outcome.kind === 'persisted' ? 'confirmed' : outcome.kind)
    }
    void action(control.signal).then(show, () => { if (alive(control)) setInvalid(true) })
  }
  if (selection === undefined) return <>
    {editor.draft === undefined ? null : <p className={css.note}>{t('bundleRetained')}</p>}
    {editor.outcome?.kind === 'unknown' || editor.outcome?.kind === 'conflict'
      ? <p className={css.error} role="alert">{t(editor.outcome.kind === 'unknown' ? 'sampleUnknown' : 'sampleConflict')}</p> : null}
  </>
  const item = detail?.item
  const close = (): void => { if (!busy) { fileRead.current?.abort(); editor.close() } }
  const download = (): void => {
    const control = observer.current
    if (control === undefined || busy) return
    setDownloadFailed(false)
    void editor.download(control.signal).then(() => { if (alive(control)) report('download', 'confirmed') },
      () => { if (alive(control)) { setDownloadFailed(true); report('download', 'unavailable') } })
  }
  return <Modal open title={selection === null ? t('importTitle') : item?.name ?? t('details')}
    closeLabel={t('close')} onClose={close} className={`${view === 'summary' ? css.detailModal : css.managedModal}`}
    footer={<div className={css.footer}>
      {selection === null ? null : <button type="button" className={css.button}
        disabled={busy || editor.phase !== 'editing' || detail?.download === undefined} onClick={download}>{t('bundleDownload')}</button>}
      {detail?.uninstall === undefined ? null : <>
        {confirmRemove ? <span>{t('bundleRemoveHint')}</span> : null}
        <button type="button" className={css.button} disabled={busy || editor.phase !== 'editing'}
          onClick={() => { if (confirmRemove) submit(true); else setConfirmRemove(true) }}>{t(confirmRemove ? 'confirmRemove' : 'remove')}</button>
        {confirmRemove ? <button type="button" className={css.button} disabled={busy}
          onClick={() => { setConfirmRemove(false) }}>{t('cancel')}</button> : null}
      </>}
    </div>}>
    <section className={`${css.detailBody} ${css.form}`} aria-label={t('bundleEditor')} aria-busy={busy}>
      {editor.phase === 'opening' || editor.phase === 'submitting' || editor.phase === 'downloading' ? <p role="status">{t('pending')}</p> : null}
      {editor.phase === 'unavailable' ? <p className={css.error} role="alert">{t('unavailable')}</p> : null}
      {item === undefined ? null : <>
        <header className={css.detailHead}>
          <span className={css.glyph} aria-hidden="true"><IconSkillOutlineRegular size={24}/></span>
          <div><strong>{item.name}</strong><p>{item.description}</p>
            {item.sourceLabel === undefined ? null : <small>{item.sourceLabel}</small>}
            {item.version === undefined ? null : <small>{t('version')} {item.version}</small>}
            {item.publisher === undefined ? null : <small>{t('publisher')} {item.publisher}</small>}
          </div>
          {item.enabled === undefined ? null : <Switch checked={item.enabled} label={`${item.name} ${t('toggle')}`}
            disabled={busy || editor.phase !== 'editing' || !item.canToggle || actions.toggle === undefined
              || (toggleAction.state !== 'idle' && toggleAction.state !== 'confirmed')}
            onChange={(enabled) => {
              const toggle = actions.toggle
              if (toggle !== undefined) void toggleAction.run(signal => toggle(item.id, enabled, signal))
                .then((outcome) => { if (outcome !== undefined) report('toggle', outcome) })
            }}/>}
        </header>
        <p className={css.note}>{t(item.status)} · {item.shadowedBy === undefined
          ? t(item.shadowed === undefined ? 'bundleSelectionUnknown' : item.shadowed ? 'bundleShadowed' : 'bundleSelected')
          : t('bundleShadowedBy', item.shadowedBy)}</p>
      </>}
      {detail === undefined ? null : <>
        {view !== 'summary' ? null : <section className={css.document} aria-label={t('document')}>
          <div className={css.documentBar}>{t('document')}</div>
          <div className={css.documentReader}>{detail.markdown === undefined ? <p>{t('documentUnavailable')}</p>
            : <SkillMarkdown document={detail.markdown}/>}</div>
        </section>}
        <div className={css.detailActions}>
          <button type="button" className={css.button} aria-pressed={view === 'files'} disabled={busy}
            onClick={() => { changeView(view === 'files' ? 'summary' : 'files') }}>{t(view === 'files' ? 'backToSummary' : 'details')}</button>
          {detail.update === undefined && draft === undefined ? null : <button type="button" className={css.button}
            aria-pressed={view === 'edit'} disabled={busy} onClick={() => { changeView(view === 'edit' ? 'summary' : 'edit') }}>{t('bundleEdit')}</button>}
        </div>
        {view !== 'files' ? null : <div className={css.fileBrowser}>
          <nav className={css.fileList} aria-label={t('bundleFiles')}><ul>{detail.files.map(file =>
            <li key={file.path}><button type="button" aria-pressed={selectedFile === file.path}
              onClick={() => { showFile(file.path) }}>{file.path} <small>({file.bytes})</small></button></li>)}</ul></nav>
          <section className={css.fileContent} aria-label={t('document')}>
            <div className={css.documentBar}>{selectedFile}</div>
            {filePhase === 'loading' ? <p role="status">{t('fileLoading')}</p> : filePhase === 'error' ? <div className={css.fileError} role="alert">
              <p>{t('fileReadFailed')}</p><button type="button" className={css.button}
                onClick={() => { if (selectedFile !== undefined) showFile(selectedFile) }}>{t('retry')}</button></div>
              : filePhase === 'unavailable' ? <p>{t('documentUnavailable')}</p>
                : fileContent?.kind === 'binary' ? <p>{t('binaryFile')}</p>
                  : fileContent?.kind !== 'text' ? null : selectedFile === 'SKILL.md'
                    ? <div className={css.skillDocument}><SkillMarkdown document={fileContent.text}/></div>
                    : <pre><code>{fileContent.text}</code></pre>}
          </section>
        </div>}
      </>}
      {(view === 'edit' || selection === null) && canPublish && limits !== undefined ? <>
        <p>{t('bundleChooseHint')}</p>
        <label>{t('bundleDirectory')}<input type="file" multiple disabled={busy}
          ref={(element) => { if (element !== null) element.setAttribute('webkitdirectory', '') }}
          onChange={(event) => { choose(Array.from(event.target.files ?? []), true) }}/></label>
        <label>{t('bundleLooseFiles')}<input type="file" multiple disabled={busy}
          onChange={(event) => { choose(Array.from(event.target.files ?? []), false) }}/></label>
        <label>{t('archive')}<input type="file" accept=".zip,.skill" disabled={busy}
          onChange={(event) => { zip(event.target.files?.[0]) }}/></label>
      </> : null}
      {draft === undefined ? null : draft.kind === 'zip' ? <p>{draft.file.name} ({draft.file.size})</p> : <>
        <details className={css.source}><summary>{t('sampleOriginal')}</summary><pre>{draft.selection.markdown}</pre>
          <ul>{draft.selection.files.map(file => <li key={file.path}>{file.path} ({file.file.size})</li>)}</ul></details>
        <label>{t('sampleEditable')}<textarea rows={9} value={draft.markdown} disabled={busy || !canPublish}
          onChange={(event) => { try { editor.editMarkdown(event.target.value); setInvalid(false) } catch { setInvalid(true) } }}/></label>
      </>}
      {(view === 'edit' || selection === null) && (selection === null || detail?.update !== undefined) ? <button type="button" className={`${css.button} ${css.primary}`}
        disabled={busy || !canPublish || draft === undefined} onClick={() => { submit(false) }}>{t(selection === null ? 'installBundle' : 'bundleUpdate')}</button> : null}
      {editor.downloadStarted ? <p role="status">{t('bundleDownloadStarted')}</p> : null}
      {toggleAction.state === 'unknown' || toggleAction.state === 'conflict' || toggleAction.state === 'unavailable'
        ? <p className={css.error} role="alert">{t(toggleAction.state === 'unavailable' ? 'actionUnavailable' : toggleAction.state)}</p> : null}
      {downloadFailed ? <p className={css.error} role="alert">{t('bundleDownloadFailed')}</p> : null}
      {editor.outcome === undefined ? null : editor.outcome.kind === 'persisted'
        ? <p role="status">{t(editor.outcome.applied ? 'bundleApplied' : 'bundleSavedPending')}</p>
        : <p className={css.error} role="alert">{t(editor.outcome.kind === 'conflict' ? 'sampleConflict'
          : editor.outcome.kind === 'unavailable' ? 'bundleCapacity' : editor.outcome.kind === 'invalid-bundle' ? 'bundleMissingManifest' : 'sampleUnknown')}</p>}
      {invalid ? <p className={css.error} role="alert">{t('bundleInvalid')}</p> : null}
    </section>
  </Modal>
}
