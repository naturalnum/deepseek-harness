import { useEffect, useRef, useState } from 'react'
import { Tooltip } from '@deepseek-ai/dsh-client-ui-primitives'
import type { PropsLocale, PropsRuntime } from '@deepseek-ai/dsh-client-ui-slots'
import type { WorkspaceFileLocaleKey } from './locales.ts'
import type { WorkspaceFileCapabilities, WorkspaceFileUpload } from './workspace-file-client.ts'
import { appendWorkspaceFileReference } from './workspace-file-client.ts'

export interface WorkspaceFileActions {
  readonly capabilities: () => Promise<WorkspaceFileCapabilities | null>
  readonly upload: (file: File, signal: AbortSignal) => Promise<WorkspaceFileUpload>
}

export type WorkspaceFileButtonProps = PropsRuntime<'conversation.input.left'>
  & WorkspaceFileActions
  & PropsLocale<'powerEvolve.workspaceFiles'>

export function WorkspaceFileButton({
  capabilities,
  upload,
  useInput,
  useSession,
  inputActions,
  t,
}: WorkspaceFileButtonProps) {
  const draft = useInput(state => state.draft)
  const removed = useSession(state => state.removed)
  const draftRef = useRef(draft)
  draftRef.current = draft
  const inputRef = useRef<HTMLInputElement>(null)
  const requestRef = useRef<AbortController | null>(null)
  const [limits, setLimits] = useState<WorkspaceFileCapabilities | null | undefined>()
  const [status, setStatus] = useState<'uploading' | 'error' | null>(null)
  const [message, setMessage] = useState('')

  useEffect(() => {
    let active = true
    void capabilities().then(value => {
      if (active) setLimits(value)
    }).catch(() => {
      if (active) {
        setLimits(undefined)
        setStatus('error')
        setMessage(t('unavailable'))
      }
    })
    return () => {
      active = false
      requestRef.current?.abort()
    }
  }, [capabilities, t])

  if (limits === null) return null

  const choose = () => {
    if (status === 'uploading') {
      requestRef.current?.abort()
      return
    }
    inputRef.current?.click()
  }

  const selected = async (file: File): Promise<void> => {
    if (limits === undefined) return
    if (file.size > limits.maxFileBytes) {
      setStatus('error')
      setMessage(t('tooLarge').replace('{max}', formatBytes(limits.maxFileBytes)))
      return
    }
    const controller = new AbortController()
    requestRef.current = controller
    setStatus('uploading')
    setMessage(t('uploading'))
    try {
      const result = await upload(file, controller.signal)
      inputActions.setDraft(appendWorkspaceFileReference(draftRef.current, result))
      setStatus(null)
      setMessage('')
    } catch {
      if (controller.signal.aborted) {
        setStatus(null)
        setMessage('')
      } else {
        setStatus('error')
        setMessage(t('failed'))
      }
    } finally {
      if (requestRef.current === controller) requestRef.current = null
    }
  }

  const label = status === 'uploading' ? t('cancel') : t('attach')
  const disabled = limits === undefined || removed
  return (
    <div className="pe-workspace-file" data-workspace-file-control="">
      <Tooltip label={label} side="top" delayMs={500}>
        <button
          type="button"
          className="pe-workspace-file-button"
          aria-label={label}
          disabled={disabled}
          onClick={choose}
        >
          <PaperclipIcon />
        </button>
      </Tooltip>
      <input
        ref={inputRef}
        className="pe-workspace-file-input"
        type="file"
        tabIndex={-1}
        aria-hidden="true"
        onChange={event => {
          const file = event.currentTarget.files?.[0]
          event.currentTarget.value = ''
          if (file !== undefined) void selected(file)
        }}
      />
      {message === '' ? null : (
        <span
          className="pe-workspace-file-status"
          {...(status === 'error' ? { 'data-error': '', role: 'alert' } : {})}
        >
          {message}
        </span>
      )}
    </div>
  )
}

function PaperclipIcon() {
  return (
    <svg viewBox="0 0 16 16" width="16" height="16" aria-hidden="true" fill="none">
      <path
        d="M5.2 8.8 9.75 4.25a2.05 2.05 0 1 1 2.9 2.9L7.2 12.6a3.2 3.2 0 0 1-4.53-4.53l5.1-5.1"
        stroke="currentColor"
        strokeWidth="1.4"
        strokeLinecap="round"
      />
    </svg>
  )
}

function formatBytes(bytes: number): string {
  if (bytes < 1024 * 1024) return `${Math.ceil(bytes / 1024)} KiB`
  return `${Math.round(bytes / (1024 * 1024))} MiB`
}

export type { WorkspaceFileLocaleKey }
