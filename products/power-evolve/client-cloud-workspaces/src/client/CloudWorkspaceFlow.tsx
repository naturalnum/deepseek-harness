import { useEffect, useRef, useState } from 'react'
import { Button, Modal } from '@deepseek-ai/dsh-client-ui-primitives'
import type { PropsLocale, PropsRuntime } from '@deepseek-ai/dsh-client-ui-slots'
import { cloudWorkspaceTitlePath } from './path.ts'

type Props = PropsRuntime<'conversation.hero.workspace.directoryFlow'>
  & PropsLocale<'powerEvolve.cloudWorkspaces'>

/** Shared occupant for the native Workspace picker and Workspace sidebar add flow. */
export function CloudWorkspaceFlow({ open, busy, onPicked, onCancel, t }: Props) {
  const [name, setName] = useState('')
  const [invalid, setInvalid] = useState(false)
  const submitted = useRef(false)
  useEffect(() => { if (!open) { setName(''); setInvalid(false); submitted.current = false } }, [open])
  const create = () => {
    if (busy || submitted.current) return
    let path: string
    try { path = cloudWorkspaceTitlePath(name) }
    catch { setInvalid(true); return }
    submitted.current = true
    setInvalid(false)
    onPicked(path)
  }
  return <Modal open={open} onClose={() => { if (!busy) onCancel() }} title={t('title')}
    closeLabel={t('close')} footer={<>
      <Button disabled={busy} onClick={onCancel}>{t('cancel')}</Button>
      <Button variant="primary" disabled={busy} aria-busy={busy} onClick={create}>{t('create')}</Button>
    </>}>
    <label className="pe-cloud-workspace-field">
      <span>{t('name')}</span>
      <input className="pe-cloud-workspace-input" data-modal-autofocus value={name} maxLength={80} disabled={busy}
        onChange={event => { setName(event.target.value); setInvalid(false) }}
        onKeyDown={event => { if (event.key === 'Enter') { event.preventDefault(); create() } }} />
    </label>
    {invalid && <p className="pe-cloud-workspace-error" role="alert">{t('invalid')}</p>}
  </Modal>
}
