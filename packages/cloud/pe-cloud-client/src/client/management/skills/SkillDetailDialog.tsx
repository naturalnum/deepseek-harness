/** The retained detail surface reads through current-account callbacks and keeps unavailable controls closed. */
import { useEffect, useState, type ReactNode } from 'react'
import { IconSkillOutlineRegular, Modal, Switch } from '@deepseek-ai/dsh-client-ui-primitives'
import type { TranslateNS } from '@deepseek-ai/dsh-client-ui-slots'
import type { SkillCard, SkillDetail, SkillManagementActions, SkillAction, SkillActionOutcome } from './types.ts'
import { SkillMarkdown } from './SkillMarkdown.tsx'
import { useSkillAction } from './use-skill-action.ts'
import css from './SkillsPage.module.css'

/** Render one stable selection; the parent keys this interaction by the actual row identity.
 * @param props Actual card, narrow callbacks and localized labels.
 * @returns The native dialog, inert document renderer and explicit management controls.
 */
export function SkillDetailDialog({ skill, actions, t, onClose }: {
  readonly skill: SkillCard
  readonly actions: SkillManagementActions
  readonly t: TranslateNS<'cloud-skill-management'>
  readonly onClose: () => void
}): ReactNode {
  const [detail, setDetail] = useState<SkillDetail>(), [readState, setReadState] = useState<'loading' | 'ready' | 'error'>('loading')
  const [attempt, setAttempt] = useState(0), [confirmRemove, setConfirmRemove] = useState(false)
  const action = useSkillAction(), read = actions.readDetail, busy = action.state === 'pending'
  useEffect(() => {
    if (read === undefined) return
    const controller = new AbortController()
    setDetail(undefined); setReadState('loading')
    void read(skill.id, controller.signal).then((value) => {
      if (!controller.signal.aborted) { setDetail(value); setReadState('ready') }
    }, () => { if (!controller.signal.aborted) setReadState('error') })
    return () => { controller.abort() }
  }, [read, skill.id, attempt])
  const run = (name: SkillAction, operation: (signal: AbortSignal) => Promise<SkillActionOutcome>): void => {
    void action.run(operation).then((outcome) => { if (outcome !== undefined) actions.report(name, outcome) })
  }
  const canAct = action.state === 'idle' || action.state === 'confirmed'
  const close = (): void => { if (!busy) onClose() }
  return <Modal open onClose={close} title={skill.name} closeLabel={t('close')} className={`${css.detailModal}`}
    footer={<div className={css.footer}>
      {!skill.installed ? <button type="button" className={css.button}
        disabled={!canAct || actions.installCatalog === undefined}
        onClick={() => {
          const install = actions.installCatalog
          if (install !== undefined) run('catalog-install', signal => install(skill.id, signal))
        }}>{t('installCatalog')}</button> : null}
      {skill.installed ? <button type="button" className={css.button}
        disabled={!canAct || !skill.canRemove || actions.remove === undefined}
        onClick={() => {
          if (!confirmRemove) { setConfirmRemove(true); return }
          const remove = actions.remove
          if (remove !== undefined) run('remove', signal => remove(skill.id, signal))
        }}>{t(confirmRemove ? 'confirmRemove' : 'remove')}</button> : null}
      {confirmRemove ? <button type="button" className={css.button} disabled={busy}
        onClick={() => { setConfirmRemove(false) }}>{t('cancel')}</button> : null}
      <button type="button" className={`${css.button} ${css.primary}`}
        disabled={!canAct || !skill.canTry || actions.openDraft === undefined}
        onClick={() => { const open = actions.openDraft; if (open !== undefined) run('try', signal => open(skill.id, signal)) }}>{t('try')}</button>
    </div>}>
    <div className={css.detailBody}>
      <header className={css.detailHead}>
        <span className={css.glyph} aria-hidden="true"><IconSkillOutlineRegular size={24}/></span>
        <div><strong>{skill.name}</strong><p>{skill.description}</p>
          {skill.version === undefined ? null : <small>{t('version')} {skill.version}</small>}
          {skill.publisher === undefined ? null : <small>{t('publisher')} {skill.publisher}</small>}
        </div>
        {skill.enabled === undefined ? null : <Switch checked={skill.enabled} label={`${skill.name} ${t('toggle')}`}
          disabled={!canAct || !skill.canToggle || actions.toggle === undefined}
          onChange={(value) => { const toggle = actions.toggle; if (toggle !== undefined) run('toggle', signal => toggle(skill.id, value, signal)) }}/>}</header>
      <p className={css.note}>{t(skill.status)}</p>
      {action.state !== 'idle' && action.state !== 'pending' && action.state !== 'confirmed'
        ? <p className={css.error} role="alert">{t(action.state === 'unavailable' ? 'actionUnavailable' : action.state)}</p> : null}
      {busy ? <p role="status">{t('pending')}</p> : null}
      <section className={css.document} aria-label={t('document')}>
        <div className={css.documentBar}>{t('document')}</div>
        <div className={css.documentReader}>
          {read === undefined ? <p>{t('documentUnavailable')}</p> : readState === 'loading' ? <p role="status">{t('loadLabel')}</p>
            : readState === 'error' ? <div role="alert"><p>{t('detailFailed')}</p>
              <button type="button" className={css.button} onClick={() => { setAttempt(value => value + 1) }}>{t('retry')}</button></div>
              : detail === undefined ? null : <SkillMarkdown document={detail.instructions}/>}</div>
      </section>
    </div>
  </Modal>
}
