import { Modal } from '@deepseek-ai/dsh-client-ui-primitives'
import { randomUUID } from '@deepseek-ai/dsh-util-crypto'
import { useEffect, useRef, useState, type FormEvent, type ReactNode } from 'react'
import type { TranslateNS } from '@deepseek-ai/dsh-client-ui-slots'
import { SkillHttpError, validInstall, type InstallSkillInput, type PersonalSkill, type SkillPort } from './skills-api.ts'

export function SkillInstallPanel({ open, client, t, onClose, onInstalled }: {
  readonly open: boolean
  readonly client: SkillPort
  readonly t: TranslateNS<'powerEvolve.extensionCenter'>
  readonly onClose: () => void
  readonly onInstalled: (skill: PersonalSkill) => void
}): ReactNode {
  const [name, setName] = useState('')
  const [description, setDescription] = useState('')
  const [instructions, setInstructions] = useState('')
  const [pending, setPending] = useState<InstallSkillInput>()
  const [busy, setBusy] = useState(false)
  const [error, setError] = useState<string>()
  const request = useRef<AbortController>()
  useEffect(() => {
    setPending(undefined); setBusy(false); setError(undefined)
    setName(''); setDescription(''); setInstructions('')
    return () => { request.current?.abort(); request.current = undefined }
  }, [client])

  const submit = async (input: InstallSkillInput): Promise<void> => {
    if (request.current) return
    const controller = new AbortController(); request.current = controller
    setPending(input); setBusy(true); setError(undefined)
    try {
      const skill = await client.install(input)
      if (controller.signal.aborted) return
      setPending(undefined); setName(''); setDescription(''); setInstructions('')
      onInstalled(skill)
    } catch (cause) {
      if (controller.signal.aborted) return
      if (cause instanceof SkillHttpError) {
        if (cause.status === 409) { setPending(undefined); setError(t('nameConflict')) }
        else if (cause.status === 413) { setPending(undefined); setError(t('skillLimit')) }
        else if (cause.status === 401) { setError(t('sessionExpired')) }
        else { setError(t('installUncertain')) }
      } else { setError(t('installUncertain')) }
    } finally {
      if (request.current === controller) { request.current = undefined; setBusy(false) }
    }
  }
  const save = (event: FormEvent): void => {
    event.preventDefault()
    if (busy) return
    const input = pending ?? { requestId: randomUUID(), name: name.trim(),
      description: description.trim(), instructions: instructions.trim() }
    if (validInstall(input)) void submit(input)
  }
  const close = (): void => { if (busy) return; setPending(undefined); setError(undefined); onClose() }
  const candidate: InstallSkillInput = { requestId: pending?.requestId ?? '00000000-0000-0000-0000-000000000000',
    name: name.trim(), description: description.trim(), instructions: instructions.trim() }
  const canSave = pending !== undefined || validInstall(candidate)

  return <Modal open={open} onClose={close} title={t('installTitle')} closeLabel={t('close')}
    className="pext-install-modal" footer={<div className="pext-skill-dialog-footer">
      <button type="button" className="pext-dialog-button" disabled={busy} onClick={close}>{t('cancel')}</button>
      <button type="submit" form="pext-skill-install" className="pext-dialog-button pext-dialog-button-primary"
        disabled={!canSave || busy}>{busy ? t('installing') : pending ? t('retryInstall') : t('installSkill')}</button>
    </div>}>
    <form id="pext-skill-install" className="pext-install-form" onSubmit={save}>
      <p>{t('installHint')}</p>
      <label>{t('name')}<input data-modal-autofocus value={name} maxLength={80} disabled={busy || pending !== undefined}
        onChange={(event) => { setName(event.target.value); setError(undefined) }} required /></label>
      <label>{t('description')}<input value={description} maxLength={500} disabled={busy || pending !== undefined}
        onChange={(event) => { setDescription(event.target.value); setError(undefined) }} required /></label>
      <label>{t('instructions')}<textarea value={instructions} maxLength={4096} rows={10} disabled={busy || pending !== undefined}
        onChange={(event) => { setInstructions(event.target.value); setError(undefined) }} required /></label>
      {error && <div className="pext-error" role="alert">{error}</div>}
    </form>
  </Modal>
}
