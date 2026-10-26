/** A fixed two-file editor inside the native settings section; drafts belong only to this mounted edit. */
import { useEffect, useRef, useState, type ReactNode } from 'react'
import { Button, Input } from '@deepseek-ai/dsh-client-ui-primitives'
import type { PropsLocale, PropsRuntime } from '@deepseek-ai/dsh-client-ui-slots'
import type {} from '@deepseek-ai/dsh-client-ui-settings/client'
import type { PreparedSkillEdit, SkillPublicationOutcome } from './skill-edit.ts'
import type {} from './skill-settings-locales.ts'

/** Plain callbacks and limits supplied by the original Cloud page's slot registration. */
export interface SkillSettingsInjected {
  readonly scope: string
  readonly maxFileBytes: number
  readonly prepare: (signal: AbortSignal) => Promise<PreparedSkillEdit>
}
/** Native settings owner/locale shares and the captured Cloud callbacks. */
export type SkillSettingsProps = SkillSettingsInjected & PropsRuntime<'settings.section'> & PropsLocale<'cloud-skill-settings'>
type View = { readonly phase: 'idle' | 'opening' | 'unavailable' }
  | { readonly phase: 'editing' | 'publishing'; readonly edit: PreparedSkillEdit; readonly invalid?: boolean }
  | { readonly phase: 'result'; readonly outcome: SkillPublicationOutcome }

/**
 * Render the fixed sample editor, remounting its local draft when the existing dependency scope changes.
 * @param props Original native settings shares and one page-scoped prepare callback.
 * @returns Existing input/button primitives; no automatic catalog read or publication.
 */
export function SkillSettings(props: SkillSettingsProps): ReactNode {
  return <SkillEditor key={props.scope} {...props}/>
}
function SkillEditor(props: SkillSettingsProps): ReactNode {
  const { t } = props
  const [view, setView] = useState<View>({ phase: 'idle' })
  const [markdown, setMarkdown] = useState<File>(), [resource, setResource] = useState<File>()
  const active = useRef<AbortController>(), intent = useRef<AbortController>(), alive = useRef(true)
  useEffect(() => {
    alive.current = true
    return () => { alive.current = false; active.current?.abort(); intent.current?.abort() }
  }, [])
  const current = (control: AbortController): boolean => alive.current && active.current === control && !control.signal.aborted
  const begin = (): void => {
    if (!alive.current || active.current !== undefined) return
    intent.current?.abort()
    const control = new AbortController(); active.current = control; intent.current = control
    setMarkdown(undefined); setResource(undefined); setView({ phase: 'opening' })
    void props.prepare(control.signal).then((edit) => {
      if (current(control)) setView({ phase: 'editing', edit })
    }, () => { if (current(control)) setView({ phase: 'unavailable' }) }).finally(() => {
      if (active.current === control) active.current = undefined
    })
  }
  const valid = markdown !== undefined && resource !== undefined && markdown.name === 'SKILL.md' && resource.name === 'resource.bin'
    && markdown.size > 0 && markdown.size <= props.maxFileBytes && resource.size <= props.maxFileBytes
  const invalidSelected = markdown !== undefined && (markdown.name !== 'SKILL.md' || markdown.size === 0 || markdown.size > props.maxFileBytes)
    || resource !== undefined && (resource.name !== 'resource.bin' || resource.size > props.maxFileBytes)
  const publish = (): void => {
    if (!alive.current || view.phase !== 'editing' || !valid || active.current !== undefined) return
    const edit = view.edit, control = new AbortController(); active.current = control
    setView({ phase: 'publishing', edit })
    const run = async (): Promise<void> => {
      let sent = false
      try {
        const text = new TextDecoder('utf-8', { fatal: true, ignoreBOM: true }).decode(await markdown.arrayBuffer())
        control.signal.throwIfAborted()
        const bytes = new Uint8Array(await resource.arrayBuffer())
        control.signal.throwIfAborted()
        let binary = ''; for (const byte of bytes) binary += String.fromCharCode(byte)
        sent = true
        const outcome = await edit.publish(text, btoa(binary), control.signal)
        if (current(control)) setView({ phase: 'result', outcome })
      } catch {
        if (current(control)) setView(sent ? { phase: 'result', outcome: { kind: 'unknown' } } : { phase: 'editing', edit, invalid: true })
      } finally { if (active.current === control) active.current = undefined }
    }
    void run()
  }
  const editing = view.phase === 'editing' || view.phase === 'publishing'
  const busy = view.phase === 'opening' || view.phase === 'publishing'
  return <section>
    <h2>{t('title')}</h2><p>{t('files')}</p><p>{t('resources')}</p>
    {view.phase === 'idle' || view.phase === 'result' || view.phase === 'unavailable'
      ? <Button onClick={begin}>{t(view.phase === 'idle' ? 'open' : 'reopen')}</Button> : null}
    {view.phase === 'opening' ? <p role="status">{t('opening')}</p> : null}
    {view.phase === 'unavailable' ? <p role="alert">{t('unavailable')}</p> : null}
    {editing ? <>
      <p>{t(view.edit.installed ? 'present' : 'absent')}</p>
      <p>{t(view.edit.applied ? 'currentApplied' : 'currentNotApplied')}</p>
      <p>{t(view.edit.resources === 'project-on-load' ? 'resourcesOnLoad' : 'resourcesUnavailable')}</p>
      <label>{t('markdown')}<Input type="file" accept=".md" aria-label={t('markdown')} disabled={busy}
        onChange={(event) => { setMarkdown(event.target.files?.[0]) }}/></label>
      <label>{t('resource')}<Input type="file" accept=".bin" aria-label={t('resource')} disabled={busy}
        onChange={(event) => { setResource(event.target.files?.[0]) }}/></label>
      {view.invalid || invalidSelected ? <p role="alert">{t('invalid')}</p> : null}
      <Button disabled={busy} onClick={() => { intent.current?.abort(); setMarkdown(undefined); setResource(undefined); setView({ phase: 'idle' }) }}>{t('cancel')}</Button>
      <Button variant="primary" disabled={busy || !valid} onClick={publish}>{t('publish')}</Button>
    </> : null}
    {view.phase === 'publishing' ? <p role="status">{t('pending')}</p> : null}
    {view.phase === 'result' ? view.outcome.kind === 'persisted'
      ? <div role="status"><p>{t('persisted')}</p><p>{t(view.outcome.applied ? 'applied' : 'notApplied')}</p>
        <p>{t(view.outcome.resources === 'project-on-load' ? 'resourcesOnLoad' : 'resourcesUnavailable')}</p></div>
      : <p role="alert">{t(view.outcome.kind)}</p> : null}
  </section>
}
