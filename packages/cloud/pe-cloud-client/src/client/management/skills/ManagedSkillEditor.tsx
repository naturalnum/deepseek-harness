/** Complete-package input and actual detail/result presentation on the original page's managed skill source. */
import { useEffect, useRef, useState, type ReactNode } from 'react'
import { Modal } from '@deepseek-ai/dsh-client-ui-primitives'
import type { TranslateNS } from '@deepseek-ai/dsh-client-ui-slots'
import type { ManagedSkillEditing, ManagedSkillFileContent, ManagedSkillOutcome } from '../../managed-skill-editing.ts'
import { readSelectedSkillBundle } from './selected-bundle.ts'
import type { SkillManagementActions } from './types.ts'
import { SkillMarkdown } from './SkillMarkdown.tsx'
import css from './SkillsPage.module.css'

/**
 * Render explicit local selection and once-only native actions without parsing archives or installing packages locally.
 * @param props Original page-owned editor, existing feedback callback, and localized text.
 * @returns A bounded file/ZIP editor with separate persistence, application, and browser-download facts.
 */
export function ManagedSkillEditor({ editor, report, t }: {
  readonly editor: ManagedSkillEditing
  readonly report: SkillManagementActions['report']
  readonly t: TranslateNS<'cloud-skill-management'>
}): ReactNode {
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
  const busy = copying || editor.phase === 'opening' || editor.phase === 'submitting' || editor.phase === 'downloading'
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
    if (file === undefined || !/\.(zip|skill)$/i.test(file.name) || file.size === 0 || file.size > limits.maxArchiveBytes) {
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
      if (outcome.kind === 'invalid-bundle') return
      report(remove ? 'remove' : selection === null ? 'install' : 'update', outcome.kind === 'persisted' ? 'confirmed' : outcome.kind)
    }
    void action(control.signal).then(show, () => { if (alive(control)) setInvalid(true) })
  }
  if (selection === undefined) return <>
    {editor.draft === undefined ? null : <p className={css.note}>{t('bundleRetained')}</p>}
    {editor.outcome?.kind === 'unknown' || editor.outcome?.kind === 'conflict'
      ? <p className={css.error} role="alert">{t(editor.outcome.kind === 'unknown' ? 'sampleUnknown' : 'sampleConflict')}</p> : null}
  </>
  return <Modal open title={selection === null ? t('installBundle') : detail?.item.name ?? t('bundleEditor')}
    closeLabel={t('close')} onClose={() => { if (!busy) { fileRead.current?.abort(); editor.close() } }} className={`${css.managedModal}`}>
    <section className={css.form} aria-label={t('bundleEditor')} aria-busy={busy}>
      {editor.phase === 'opening' || editor.phase === 'submitting' || editor.phase === 'downloading' ? <p role="status">{t('pending')}</p> : null}
      {editor.phase === 'unavailable' ? <p className={css.error} role="alert">{t('unavailable')}</p> : null}
      {detail === undefined ? null : <>
        <p className={css.skillDescription}>{detail.item.description}</p>
        <p>{detail.item.sourceLabel}</p>
        {detail.item.publisher === undefined ? null : <p>{t('publisher')} {detail.item.publisher}</p>}
        {detail.item.version === undefined ? null : <p>{t('version')} {detail.item.version}</p>}<p>{detail.item.shadowedBy === undefined
          ? t(detail.item.shadowed === undefined ? 'bundleSelectionUnknown' : detail.item.shadowed ? 'bundleShadowed' : 'bundleSelected')
          : t('bundleShadowedBy', detail.item.shadowedBy)}</p>
        <div className={css.detailActions}>
          <button type="button" className={css.button} aria-pressed={view === 'files'} disabled={busy}
            onClick={() => { changeView(view === 'files' ? 'summary' : 'files') }}>{t(view === 'files' ? 'backToSummary' : 'details')}</button>
          {detail.update === undefined && draft === undefined ? null : <button type="button" className={css.button}
            aria-pressed={view === 'edit'} disabled={busy} onClick={() => { changeView(view === 'edit' ? 'summary' : 'edit') }}>{t('bundleEdit')}</button>}
          {detail.download === undefined ? null : <button type="button" className={css.button} disabled={busy || editor.phase !== 'editing'}
            onClick={() => {
              const control = observer.current
              if (control === undefined) return
              setDownloadFailed(false)
              void editor.download(control.signal).then(() => { report('download', 'confirmed') }, () => { if (alive(control)) setDownloadFailed(true) })
            }}>{t('bundleDownload')}</button>}</div>
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
      {detail?.uninstall === undefined ? null : <div className={css.footer}>
        {confirmRemove ? <span>{t('bundleRemoveHint')}</span> : null}
        <button type="button" className={css.button} disabled={busy || editor.phase !== 'editing'}
          onClick={() => { if (confirmRemove) submit(true); else setConfirmRemove(true) }}>{t(confirmRemove ? 'confirmRemove' : 'remove')}</button></div>}
      {editor.downloadStarted ? <p role="status">{t('bundleDownloadStarted')}</p> : null}
      {downloadFailed ? <p className={css.error} role="alert">{t('bundleDownloadFailed')}</p> : null}
      {editor.outcome === undefined ? null : editor.outcome.kind === 'persisted'
        ? <p role="status">{t(editor.outcome.applied ? 'bundleApplied' : 'bundleSavedPending')}</p>
        : <p className={css.error} role="alert">{t(editor.outcome.kind === 'conflict' ? 'sampleConflict'
          : editor.outcome.kind === 'unavailable' ? 'bundleCapacity' : editor.outcome.kind === 'invalid-bundle' ? 'bundleMissingManifest' : 'sampleUnknown')}</p>}
      {invalid ? <p className={css.error} role="alert">{t('bundleInvalid')}</p> : null}
    </section>
  </Modal>
}
