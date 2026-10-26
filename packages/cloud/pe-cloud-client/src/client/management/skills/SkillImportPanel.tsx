/** Local archive selection only; no upload ticket, hashing transport or legacy installation ledger. */
import { useState, type ReactNode } from 'react'
import { Modal } from '@deepseek-ai/dsh-client-ui-primitives'
import type { TranslateNS } from '@deepseek-ai/dsh-client-ui-slots'
import type { SkillManagementActions } from './types.ts'
import { useSkillAction } from './use-skill-action.ts'
import css from './SkillsPage.module.css'

/** Render the retained package dialog with an explicitly supplied current-account callback.
 * @param props Account limit, original callback and localized labels.
 * @returns A once-only import interaction, disabled when the capability is absent.
 */
export function SkillImportPanel({ maxBytes, importPackage, report, t, onClose }: {
  readonly maxBytes: number
  readonly importPackage: SkillManagementActions['importPackage']
  readonly report: SkillManagementActions['report']
  readonly t: TranslateNS<'cloud-skill-management'>
  readonly onClose: () => void
}): ReactNode {
  const [file, setFile] = useState<File>(), action = useSkillAction()
  const valid = file !== undefined && file.size > 0 && file.size <= maxBytes && /\.(?:zip|skill)$/iu.test(file.name)
    && !/[\u0000-\u001f\u007f]/u.test(file.name)
  const busy = action.state === 'pending', editable = action.state === 'idle'
  const close = (): void => { if (!busy) onClose() }
  const submit = (): void => {
    if (!valid || importPackage === undefined || !editable) return
    void action.run(signal => importPackage(file, signal)).then((outcome) => {
      if (outcome === undefined) return
      report('import', outcome)
      if (outcome === 'confirmed') onClose()
    })
  }
  return <Modal open onClose={close} title={t('importTitle')} closeLabel={t('close')} className={`${css.formModal}`}
    footer={<div className={css.footer}>
      <button type="button" className={css.button} disabled={busy} onClick={close}>{t('cancel')}</button>
      <button type="button" className={`${css.button} ${css.primary}`} disabled={!valid || !editable || importPackage === undefined}
        onClick={submit}>{busy ? t('pending') : t('import')}</button>
    </div>}>
    <div className={css.form}>
      <p>{t('importHint')}</p>
      <label className={css.drop}>{t('archive')}<input type="file" aria-label={t('archive')} accept=".zip,.skill,application/zip"
        disabled={!editable} onChange={(event) => { setFile(event.target.files?.[0]) }} />
      <strong>{file?.name ?? t('chooseArchive')}</strong></label>
      {file !== undefined && !valid ? <p className={css.error} role="alert">{t('invalidFile')}</p> : null}
      {action.state !== 'idle' && action.state !== 'pending' && action.state !== 'confirmed'
        ? <p className={css.error} role="alert">{t(action.state === 'unavailable' ? 'actionUnavailable' : action.state)}</p> : null}
    </div>
  </Modal>
}
