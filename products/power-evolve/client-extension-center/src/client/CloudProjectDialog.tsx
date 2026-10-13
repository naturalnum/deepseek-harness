/** Cloud project creation in the existing native workspace directory-flow seats. */
import { useEffect, useId, useRef, useState } from 'react'
import { Button, IconCloseOutlineRegular, IconFolderOpenRegular, Input, Modal } from '@deepseek-ai/dsh-client-ui-primitives'
import type { PropsLocale } from '@deepseek-ai/dsh-client-ui-slots'
import type { DirectoryFlowOwnerProps } from '@deepseek-ai/dsh-client-ui-workspace/client'

/** Native flow conversation and the account-scoped cloud directory operation. */
export type CloudProjectDialogProps = DirectoryFlowOwnerProps & PropsLocale<'powerEvolve.extensionCenter'> & {
  createProjectDirectory: (name: string) => Promise<string>
}

/** Create a named cloud directory, then let the native owner register the workspace.
 * @param props Native flow callbacks, directory creation and localized labels.
 * @returns The shared modal with cloud-only project fields.
 */
export function CloudProjectDialog({ open, busy, onPicked, onCancel, createProjectDirectory, t }: CloudProjectDialogProps) {
  const inputId = useId()
  const [draft, setDraft] = useState('')
  const [creating, setCreating] = useState(false)
  const [failed, setFailed] = useState(false)
  const inFlight = useRef(false)
  const composing = useRef(false)
  const visible = useRef(open)
  const generation = useRef(0)
  visible.current = open
  const name = draft.trim().normalize('NFC')
  const valid = name.length > 0 && name.length <= 80 && !['.', '..'].includes(name)
    && !/[\u0000-\u001f\u007f/\\]/u.test(name)
  const pending = creating || busy
  const error = failed ? t('projectCreateFailed') : name && !valid ? t('projectInvalidName') : ''

  useEffect(() => {
    visible.current = open
    generation.current += 1
    if (open) setCreating(inFlight.current)
    if (!open) { setDraft(''); setFailed(false); composing.current = false }
    return () => { visible.current = false }
  }, [open])

  const close = () => { if (!inFlight.current && !busy) onCancel() }
  const create = async () => {
    if (!valid || busy || inFlight.current || composing.current) return
    inFlight.current = true
    const interaction = generation.current
    setCreating(true); setFailed(false)
    try {
      const path = await createProjectDirectory(name)
      if (visible.current && generation.current === interaction) onPicked(path)
    } catch {
      if (visible.current && generation.current === interaction) setFailed(true)
    } finally {
      inFlight.current = false
      if (visible.current) setCreating(false)
    }
  }

  return <Modal open={open} onClose={close} title={t('projectCreateTitle')} headless className="pext-project-dialog">
    <Button variant="ghost" className="pext-project-close" aria-label={t('close')} disabled={pending} onClick={close}>
      <IconCloseOutlineRegular size={16} />
    </Button>
    <form className="pext-project-form" aria-busy={pending} onSubmit={(event) => { event.preventDefault(); void create() }}>
      <header className="pext-project-header">
        <span className="pext-project-icon" aria-hidden="true"><IconFolderOpenRegular size={28} /></span>
        <h2>{t('projectCreateTitle')}</h2>
      </header>
      <div className="pext-project-field">
        <label htmlFor={inputId}>{t('projectName')}</label>
        <Input id={inputId} className="pext-project-input" value={draft} maxLength={80} disabled={pending}
          placeholder={t('projectNamePlaceholder')} data-modal-autofocus
          aria-invalid={Boolean(error)} aria-describedby={error ? `${inputId}-error` : undefined}
          onChange={(event) => { setDraft(event.target.value); setFailed(false) }}
          onCompositionStart={() => { composing.current = true }} onCompositionEnd={() => { composing.current = false }}
          onKeyDown={(event) => { if (event.key === 'Enter' && (composing.current || event.nativeEvent.isComposing)) event.preventDefault() }} />
        <div className="pext-project-error" id={`${inputId}-error`} role={error ? 'alert' : undefined}>{error}</div>
      </div>
      <footer className="pext-project-actions">
        <Button variant="outline" disabled={pending} onClick={close}>{t('cancel')}</Button>
        <Button type="submit" variant="primary" disabled={!valid || pending}>{t('projectCreate')}</Button>
      </footer>
    </form>
  </Modal>
}
