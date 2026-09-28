import { useEffect, useRef, useState } from 'react'
import { Button, Modal, Tooltip } from '@deepseek-ai/dsh-client-ui-primitives'
import type { PropsLocale, PropsRuntime } from '@deepseek-ai/dsh-client-ui-slots'
import type { WorkspaceFileLocaleKey } from './locales.ts'
import { WorkspaceDownloadError } from './workspace-file-download.ts'
import { type EditableFile, WorkspaceFileEditError, WorkspaceFileEditorClient } from './workspace-file-editor.ts'

type Props = PropsRuntime<'sidebar.right.tab.document.actions'>
  & PropsLocale<'powerEvolve.workspaceFiles'>
  & { readonly client: WorkspaceFileEditorClient }

/** A path change resets the editor and aborts reads for the previous preview. */
export function PreviewEdit(props: Props) {
  return <PreviewEditForPath key={props.absolutePath} {...props} />
}

function PreviewEditForPath({ absolutePath, client, t }: Props) {
  const [open, setOpen] = useState(false)
  const [file, setFile] = useState<EditableFile | null>(null)
  const [text, setText] = useState('')
  const [busy, setBusy] = useState(false)
  const [error, setError] = useState<WorkspaceFileLocaleKey | null>(null)
  const pending = useRef<AbortController | null>(null)
  const attempt = useRef<{ text: string; requestId: string } | null>(null)
  useEffect(() => () => pending.current?.abort(), [])

  const close = () => {
    pending.current?.abort()
    pending.current = null
    attempt.current = null
    setOpen(false)
    setFile(null)
    setBusy(false)
    setError(null)
  }

  const begin = async () => {
    if (pending.current !== null) return
    const controller = new AbortController()
    pending.current = controller
    setOpen(true)
    setBusy(true)
    setError(null)
    try {
      const current = await client.open(absolutePath, controller.signal)
      if (!controller.signal.aborted) {
        setFile(current)
        setText(current.text)
      }
    } catch (failure) {
      if (!controller.signal.aborted) setError(editError(failure))
    } finally {
      if (pending.current === controller) {
        pending.current = null
        setBusy(false)
      }
    }
  }

  const save = async () => {
    if (file === null || pending.current !== null || text === file.text || error === 'editConflict') return
    const controller = new AbortController()
    pending.current = controller
    setBusy(true)
    setError(null)
    if (attempt.current?.text !== text) attempt.current = { text, requestId: crypto.randomUUID() }
    try {
      await client.save(file, text, attempt.current.requestId, controller.signal)
      if (!controller.signal.aborted) close()
    } catch (failure) {
      if (!controller.signal.aborted) setError(editError(failure))
    } finally {
      if (pending.current === controller) {
        pending.current = null
        setBusy(false)
      }
    }
  }

  const title = t('editTitle').replace('{name}', absolutePath.split('/').at(-1) ?? absolutePath)
  return <span className="pe-workspace-edit" data-workspace-edit="">
    <Tooltip label={t('edit')} side="bottom" delayMs={500}>
      <button type="button" className="pe-workspace-download-button" aria-label={t('edit')}
        onClick={() => { void begin() }}>
        <svg viewBox="0 0 16 16" width="16" height="16" fill="none" aria-hidden="true">
          <path d="m3 11 8-8 2 2-8 8-3 1 1-3ZM9.5 4.5l2 2" stroke="currentColor"
            strokeWidth="1.4" strokeLinecap="round" strokeLinejoin="round" />
        </svg>
      </button>
    </Tooltip>
    <Modal open={open} onClose={close} title={title} description={absolutePath} closeLabel={t('close')}
      className="pe-workspace-edit-modal" footer={<>
        <Button onClick={close}>{t('cancelEdit')}</Button>
        <Button variant="primary" onClick={() => { void save() }}
          disabled={busy || file === null || text === file.text || error === 'editConflict'}>{t('saveEdit')}</Button>
      </>}>
      {file !== null && <textarea value={text} data-modal-autofocus spellCheck={false}
        aria-label={t('editText')} onChange={event => {
          setText(event.target.value)
          if (attempt.current?.text !== event.target.value) attempt.current = null
        }} />}
      {busy && <p role="status">{t(file === null ? 'loadingEdit' : 'savingEdit')}</p>}
      {error && <p role="alert">{t(error)}</p>}
    </Modal>
  </span>
}

function editError(failure: unknown): WorkspaceFileLocaleKey {
  if (failure instanceof WorkspaceFileEditError) {
    switch (failure.reason) {
      case 'binary': return 'editBinary'
      case 'large': return 'editLarge'
      case 'conflict': return 'editConflict'
      case 'denied': return 'editDenied'
      case 'missing': return 'editMissing'
      default: return 'editFailed'
    }
  }
  if (failure instanceof WorkspaceDownloadError) {
    return failure.status === 404 ? 'editMissing'
      : failure.status === 401 || failure.status === 403 ? 'editDenied' : 'editFailed'
  }
  return 'editFailed'
}
