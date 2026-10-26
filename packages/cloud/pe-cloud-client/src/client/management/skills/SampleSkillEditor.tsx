/** Complete-file editing on the original page source and captured native current/publish callbacks. */
import { useEffect, useRef, useState, type ReactNode } from 'react'
import type { TranslateNS } from '@deepseek-ai/dsh-client-ui-slots'
import type { SampleSkillEditing } from '../../skill-version-editing.ts'
import type {} from './locales.ts'
import css from './SkillsPage.module.css'

/** Actual page-owned sample state and presentation-only translations. */
export interface SampleSkillEditorProps {
  readonly sample: SampleSkillEditing
  readonly t: TranslateNS<'cloud-skill-management'>
}

/**
 * Display immutable metadata and a separate complete-file draft without claiming remote document access.
 * @param props Current original-page source; all account operations remain in its narrow callbacks.
 * @returns Explicit read, local copy and once-only publication controls.
 */
export function SampleSkillEditor({ sample, t }: SampleSkillEditorProps): ReactNode {
  const markdown = useRef<HTMLInputElement>(null), resource = useRef<HTMLInputElement>(null)
  const observer = useRef<AbortController>()
  const [copying, setCopying] = useState(false), [invalid, setInvalid] = useState(false)
  useEffect(() => {
    const control = new AbortController(); observer.current = control
    return () => { control.abort(); observer.current = undefined }
  }, [])
  const alive = (control: AbortController): boolean => observer.current === control && !control.signal.aborted
  const busy = copying || sample.phase === 'opening' || sample.phase === 'publishing'
  const open = (): void => {
    const control = observer.current
    if (control === undefined || busy) return
    setInvalid(false)
    void sample.open(control.signal).catch((_unavailable: unknown) => { /* The original source publishes its unavailable state. */ })
  }
  const copyFiles = (): void => {
    const control = observer.current, textFile = markdown.current?.files?.[0], resourceFile = resource.current?.files?.[0]
    if (control === undefined || busy || sample.phase !== 'editing') return
    if (textFile === undefined || resourceFile === undefined || textFile.name !== 'SKILL.md' || resourceFile.name !== 'resource.bin'
      || textFile.size === 0 || textFile.size > sample.maxFileBytes || resourceFile.size > sample.maxFileBytes) { setInvalid(true); return }
    setCopying(true); setInvalid(false)
    const copy = async (): Promise<void> => {
      try {
        const text = new TextDecoder('utf-8', { fatal: true, ignoreBOM: true }).decode(await textFile.arrayBuffer())
        control.signal.throwIfAborted()
        const bytes = new Uint8Array(await resourceFile.arrayBuffer())
        control.signal.throwIfAborted()
        if (!alive(control)) return
        let binary = ''; for (const byte of bytes) binary += String.fromCharCode(byte)
        sample.copyFiles({ markdown: text, resourceBase64: btoa(binary) })
      } catch { if (alive(control)) setInvalid(true) }
      finally { if (alive(control)) setCopying(false) }
    }
    void copy()
  }
  const publish = (): void => {
    const control = observer.current
    if (control === undefined || busy) return
    void sample.publish(control.signal).catch(() => { if (alive(control)) setInvalid(true) })
  }
  return <section className={`${css.form} ${css.sample}`} aria-label={t('sampleTitle')}>
    <div className={css.sampleHead}><h2>{t('sampleTitle')}</h2>
      <button type="button" className={css.button} disabled={busy} onClick={open}>
        {t(sample.phase === 'idle' ? 'sampleOpen' : 'sampleReopen')}</button></div>
    <p>{t('sampleBodyUnavailable')}</p>
    {sample.phase === 'opening' || sample.phase === 'publishing' ? <p role="status">{t('pending')}</p> : null}
    {sample.phase === 'unavailable' ? <p className={css.error} role="alert">{t('unavailable')}</p> : null}
    {sample.sourceKnown ? <>
      <p>{t(sample.source === null ? 'sampleAbsent' : 'samplePresent')}</p>
      <p>{t(sample.applied ? 'sampleApplied' : 'sampleNotApplied')}</p>
      <p>{t(sample.resources === 'project-on-load' ? 'sampleResourcesOnLoad' : 'sampleResourcesUnavailable')}</p>
      {sample.source === null ? null : <details className={css.source}><summary>{t('sampleMetadata')}</summary><dl>
        <dt>{t('version')}</dt><dd>{sample.source.id}</dd>
        <dt>{t('sampleSkillHash')}</dt><dd>{sample.source.skillSha256}</dd>
        <dt>{t('sampleResourceHash')}</dt><dd>{sample.source.resourceSha256}</dd>
        <dt>{t('sampleBytes')}</dt><dd>{sample.source.skillBytes} / {sample.source.resourceBytes}</dd>
      </dl></details>}
    </> : null}
    {sample.phase === 'editing' ? <>
      <p>{t('sampleChooseHint')}</p>
      <label>{t('sampleMarkdownFile')}<input ref={markdown} type="file" accept=".md" disabled={busy}/></label>
      <label>{t('sampleResourceFile')}<input ref={resource} type="file" accept=".bin" disabled={busy}/></label>
      <div><button type="button" className={css.button} disabled={busy} onClick={copyFiles}>{t('sampleCopy')}</button></div>
    </> : null}
    {sample.draft === undefined ? null : <>
      <details className={css.source}><summary>{t('sampleOriginal')}</summary>
        <pre>{sample.draft.original.markdown}</pre><p>{t('sampleOriginalResource')} {atob(sample.draft.original.resourceBase64).length}</p></details>
      <label>{t('sampleEditable')}<textarea rows={9} value={sample.draft.markdown} disabled={busy || sample.phase !== 'editing'}
        onChange={(event) => {
          try { sample.editMarkdown(event.target.value); setInvalid(false) } catch { setInvalid(true) }
        }}/></label>
      <div><button type="button" className={`${css.button} ${css.primary}`}
        disabled={busy || sample.phase !== 'editing' || sample.draft.markdown.length === 0} onClick={publish}>{t('samplePublish')}</button></div>
    </>}
    {invalid ? <p className={css.error} role="alert">{t('sampleInvalid')}</p> : null}
    {sample.outcome === undefined ? null : sample.outcome.kind === 'persisted'
      ? <p role="status">{t('samplePersisted')}</p>
      : <p className={css.error} role="alert">{t(sample.outcome.kind === 'unknown' ? 'sampleUnknown' : 'sampleConflict')}</p>}
  </section>
}
