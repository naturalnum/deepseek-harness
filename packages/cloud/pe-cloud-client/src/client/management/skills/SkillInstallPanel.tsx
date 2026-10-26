/** Text-skill form retained from the user's page; the injected owner performs the actual action. */
import { useId, useState, type FormEvent, type ReactNode } from 'react'
import { Modal } from '@deepseek-ai/dsh-client-ui-primitives'
import type { TranslateNS } from '@deepseek-ai/dsh-client-ui-slots'
import type { SkillFormLimits, SkillManagementActions } from './types.ts'
import { useSkillAction } from './use-skill-action.ts'
import css from './SkillsPage.module.css'

/** Render one text form; closing and reopening is a new explicit interaction.
 * @param props Original account action, explicit limits and localized presentation.
 * @returns A native Modal with complete draft fields and once-only submission.
 */
export function SkillInstallPanel({ limits, installText, report, t, onClose }: {
  readonly limits: SkillFormLimits
  readonly installText: SkillManagementActions['installText']
  readonly report: SkillManagementActions['report']
  readonly t: TranslateNS<'cloud-skill-management'>
  readonly onClose: () => void
}): ReactNode {
  const id = useId(), action = useSkillAction()
  const [name, setName] = useState(''), [description, setDescription] = useState(''), [instructions, setInstructions] = useState('')
  const valid = name.trim().length > 0 && description.trim().length > 0 && instructions.trim().length > 0
    && name.length <= limits.nameCharacters && description.length <= limits.descriptionCharacters
    && new TextEncoder().encode(instructions).byteLength <= limits.instructionsBytes
  const busy = action.state === 'pending', editable = action.state === 'idle'
  const close = (): void => { if (!busy) onClose() }
  const submit = (event: FormEvent): void => {
    event.preventDefault()
    if (!valid || installText === undefined || !editable) return
    const draft = { name: name.trim(), description: description.trim(), instructions }
    void action.run(signal => installText(draft, signal)).then((outcome) => {
      if (outcome === undefined) return
      report('install', outcome)
      if (outcome === 'confirmed') onClose()
    })
  }
  return <Modal open onClose={close} title={t('installTitle')} closeLabel={t('close')} className={`${css.formModal}`}
    footer={<div className={css.footer}>
      <button type="button" className={css.button} disabled={busy} onClick={close}>{t('cancel')}</button>
      <button type="submit" form={id} className={`${css.button} ${css.primary}`}
        disabled={!valid || !editable || installText === undefined}>{busy ? t('pending') : t('install')}</button>
    </div>}>
    <form id={id} className={css.form} onSubmit={submit}>
      <p>{t('installHint')}</p>
      <label>{t('name')}<input data-modal-autofocus value={name} maxLength={limits.nameCharacters} disabled={!editable}
        onChange={(event) => { setName(event.target.value) }} required /></label>
      <label>{t('summary')}<input value={description} maxLength={limits.descriptionCharacters} disabled={!editable}
        onChange={(event) => { setDescription(event.target.value) }} required /></label>
      <label>{t('instructions')}<textarea value={instructions} rows={10} disabled={!editable}
        onChange={(event) => { setInstructions(event.target.value) }} required /></label>
      {action.state !== 'idle' && action.state !== 'pending' && action.state !== 'confirmed'
        ? <p className={css.error} role="alert">{t(action.state === 'unavailable' ? 'actionUnavailable' : action.state)}</p> : null}
    </form>
  </Modal>
}
