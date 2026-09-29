import { IconSkillOutlineRegular, Modal } from '@deepseek-ai/dsh-client-ui-primitives'
import { useEffect, useState, type ReactNode } from 'react'
import type { TranslateNS } from '@deepseek-ai/dsh-client-ui-slots'
import type { PersonalSkill, PersonalSkillDetail, SkillPort } from './skills-api.ts'
import { SkillHttpError } from './skills-api.ts'
import { SkillMarkdown } from './SkillMarkdown.tsx'
import { SkillToggle } from './SkillToggle.tsx'

export function SkillDetailDialog({ skill, client, busy, mutationError, t, onClose, onToggle }: {
  readonly skill: PersonalSkill
  readonly client: SkillPort
  readonly busy: boolean
  readonly mutationError: string | undefined
  readonly t: TranslateNS<'powerEvolve.extensionCenter'>
  readonly onClose: () => void
  readonly onToggle: (enabled: boolean) => void
}): ReactNode {
  const [detail, setDetail] = useState<PersonalSkillDetail>()
  const [error, setError] = useState<string>()
  const [loading, setLoading] = useState(true)
  const [attempt, setAttempt] = useState(0)

  useEffect(() => {
    const controller = new AbortController()
    setDetail(undefined); setError(undefined); setLoading(true)
    void client.read(skill.skillId, controller.signal).then(value => {
      if (!controller.signal.aborted) setDetail(value)
    }).catch((cause: unknown) => {
      if (!controller.signal.aborted) setError(cause instanceof SkillHttpError
        ? cause.status === 401 ? t('sessionExpired') : cause.status === 404 ? t('skillMissing') : t('detailFailed')
        : t('detailFailed'))
    }).finally(() => {
      if (!controller.signal.aborted) setLoading(false)
    })
    return () => { controller.abort() }
  }, [client, skill.skillId, attempt, t])

  return <Modal open onClose={onClose} title={skill.name} closeLabel={t('close')}
    className="pext-skill-dialog">
    <div className="pext-skill-dialog-body" data-skill-detail={skill.skillId}>
      <header className="pext-skill-dialog-header">
        <span className="pext-skill-dialog-glyph" aria-hidden="true"><IconSkillOutlineRegular size={21} /></span>
        <div>
          <div className="pext-skill-dialog-title"><strong>{skill.name}</strong>
            {!skill.enabled && <span>{t('disabledState')}</span>}</div>
          <p>{skill.description}</p>
          <small>{t('revision').replace('{count}', String(skill.revision))}</small>
        </div>
        <SkillToggle label={`${skill.name} ${t('enable')}`} checked={skill.enabled} disabled={busy} onChange={onToggle} />
      </header>
      {mutationError && <div className="pext-error" role="alert">{mutationError}</div>}
      <section className="pext-skill-document" aria-label={t('skillDocument')}>
        <div className="pext-skill-document-bar"><span>{t('skillDocument')}</span></div>
        <div className="pext-skill-document-reader">
          {loading && <div className="pext-skill-document-state" role="status">{t('loading')}</div>}
          {!loading && error && <div className="pext-skill-document-state pext-skill-document-error" role="alert">
            <span>{error}</span><button type="button" className="pext-dialog-button" onClick={() => { setAttempt(value => value + 1) }}>{t('retry')}</button>
          </div>}
          {!loading && !error && detail && <SkillMarkdown document={detail.instructions} />}
          {!loading && !error && detail === undefined && <div className="pext-skill-document-state">{t('skillDocumentEmpty')}</div>}
        </div>
      </section>
    </div>
  </Modal>
}
