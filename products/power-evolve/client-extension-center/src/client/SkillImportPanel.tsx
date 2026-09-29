import { Modal } from '@deepseek-ai/dsh-client-ui-primitives'
import { useRef, useState, type ReactNode } from 'react'
import type { TranslateNS } from '@deepseek-ai/dsh-client-ui-slots'
import { SkillHttpError, type PersonalSkill, type SkillPort } from './skills-api.ts'
import { formatSkillImportBytes, SKILL_IMPORT_FILE_ACCEPT, SKILL_PACKAGE_MAX_BYTES,
  skillImportFileIssue, type SkillImportFileIssue } from './skill-import.ts'

export function SkillImportPanel({ open, client, t, onClose, onImported }: {
  readonly open: boolean
  readonly client: SkillPort
  readonly t: TranslateNS<'powerEvolve.extensionCenter'>
  readonly onClose: () => void
  readonly onImported: (skill: PersonalSkill) => void
}): ReactNode {
  const input = useRef<HTMLInputElement>(null)
  const controller = useRef<AbortController>()
  const [file, setFile] = useState<File>()
  const [requestId, setRequestId] = useState<string>()
  const [busy, setBusy] = useState(false)
  const [error, setError] = useState<string>()
  const issue = file === undefined ? undefined : skillImportFileIssue(file)

  const submit = async (): Promise<void> => {
    if (file === undefined || issue !== undefined || busy) return
    const id = requestId ?? crypto.randomUUID()
    setRequestId(id); setBusy(true); setError(undefined)
    const abort = new AbortController()
    controller.current = abort
    try {
      const skill = await client.importPackage(file, id, abort.signal)
      setFile(undefined); setRequestId(undefined)
      if (input.current) input.current.value = ''
      onImported(skill)
    } catch (cause) {
      if (cause instanceof SkillHttpError) {
        setError(cause.status === 401 ? t(cause.code === 'invalid_upload_ticket' ? 'skillImportUncertain' : 'sessionExpired')
          : cause.status === 413 ? t(cause.code === 'skill_limit' ? 'skillLimit' : 'skillImportTooLarge')
            : cause.status === 409 ? t('skillImportConflict')
              : [400, 415, 422].includes(cause.status) ? t('skillImportInvalidPackage')
                : t('skillImportUncertain'))
      } else setError(t('skillImportUncertain'))
    } finally { controller.current = undefined; setBusy(false) }
  }
  const close = (): void => { if (busy) return; setError(undefined); onClose() }
  const issueMessage = (value: SkillImportFileIssue): string => value === 'empty' ? t('skillImportEmpty')
    : value === 'too-large' ? t('skillImportTooLarge')
      : value === 'invalid-name' ? t('skillImportInvalidName') : t('skillImportInvalidType')

  return <Modal open={open} onClose={close} title={t('skillImportTitle')} closeLabel={t('close')}
    className="pext-install-modal" footer={<div className="pext-skill-dialog-footer">
      <button type="button" className="pext-dialog-button" onClick={() => { if (busy) controller.current?.abort(); else close() }}>
        {busy ? t('skillImportCancel') : t('cancel')}</button>
      <button type="button" className="pext-dialog-button pext-dialog-button-primary"
        disabled={busy || file === undefined || issue !== undefined} onClick={() => { void submit() }}>
        {busy ? t('skillImporting') : requestId ? t('retryInstall') : t('skillImportAction')}</button>
    </div>}>
    <div className="pext-import-body">
      <p>{t('skillImportHint').replace('{max}', formatSkillImportBytes(SKILL_PACKAGE_MAX_BYTES))}</p>
      <label className="pext-import-drop">
        <input ref={input} type="file" accept={SKILL_IMPORT_FILE_ACCEPT} aria-label={t('skillImportFile')}
          disabled={busy || requestId !== undefined}
          onChange={event => { setFile(event.currentTarget.files?.[0]); setRequestId(undefined); setError(undefined) }} />
        <strong>{file?.name ?? t('chooseSkillArchive')}</strong>
        <span>{file === undefined ? t('skillArchiveOnly') : formatSkillImportBytes(file.size)}</span>
      </label>
      {issue && <div className="pext-error" role="alert">{issueMessage(issue)}</div>}
      {error && <div className="pext-error" role="alert">{error}</div>}
      {error && requestId && !busy && <button type="button" className="pext-dialog-button"
        onClick={() => { setFile(undefined); setRequestId(undefined); setError(undefined)
          if (input.current) input.current.value = '' }}>{t('skillImportChooseAnother')}</button>}
      {busy && <div className="pext-loading" role="status">{t('skillImportProcessing')}</div>}
    </div>
  </Modal>
}
