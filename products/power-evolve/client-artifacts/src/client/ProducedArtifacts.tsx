/** Platform-verified file versions displayed at their invoking native turn. */
import { useState } from 'react'
import type { InjectFace, PropsLocale, PropsRuntime } from '@deepseek-ai/dsh-client-ui-slots'
import type { TurnTailOwnerProps } from '@deepseek-ai/dsh-client-ui-chat/client'
import type { ClosingFactsSource } from './execution-facts.ts'
import { filesForClosing, producedFileKey } from './execution-facts.ts'
import { referencesForClosing } from './produced-artifacts.ts'

/** The renderer synthesizes the subscription hook; source identities are local to this plugin. */
export interface ProducedArtifactsInjected {
  /** Borrow plain actions for one closing; the observable remains in the registration closure.
   * @param owner - native turn and closing coordinates.
   * @returns an opaque hook key and explicit file actions.
   */
  readonly forClosing: (owner: TurnTailOwnerProps) => ClosingActions
  readonly keyedHooks: { readonly closingFacts: (key: string) => ClosingFactsSource | undefined }
}
type ClosingActions = Pick<ClosingFactsSource, 'key' | 'refresh' | 'publish'>
type Props = PropsRuntime<'conversation.chat.turnTail'> & PropsLocale<'powerEvolve.artifacts'> & InjectFace<ProducedArtifactsInjected>

/** Observe one closing, including trusted continuation associations; only original receipts render a row.
 * @param props - native owner, viewed Session and generated observation hook.
 * @returns the verified file row, or no visible row for a continuation without new executions.
 */
export function ProducedArtifacts(props: Props) {
  const closing = props.forClosing(props)
  return <ClosingArtifacts key={closing.key} {...props} closing={closing} />
}

function ClosingArtifacts({ closing, useClosingFacts, t, ...owner }: Props & { readonly closing: ClosingActions }) {
  const snapshot = useClosingFacts(closing.key)
  const [expanded, setExpanded] = useState(false)
  const references = referencesForClosing(owner)
  if (references.length === 0 || snapshot === undefined) return null
  const items = snapshot.items.filter(item => references.some(ref => ref.executionId === item.executionId && ref.callId === item.callId))
  const files = filesForClosing(snapshot, references)
  const pending = items.some(item => item.status === 'pending')
  const incomplete = items.some(item => item.status === 'partial' || item.status === 'unavailable')
  const reasons = [...new Set(items.flatMap(item => item.reasons))]
  const visible = expanded ? files : files.slice(0, 6)
  return <section className="pe-produced" data-produced-artifacts="" aria-label={t('producedTitle')}>
    <div className="pe-produced-heading"><strong>{t('producedTitle')}</strong>
      <button type="button" onClick={() => { closing.refresh() }} disabled={snapshot.state === 'loading'}>{t('refresh')}</button>
    </div>
    {(snapshot.state === 'idle' || snapshot.state === 'loading' || pending) && <span role="status">{t('factsPending')}</span>}
    {snapshot.state === 'failed' && <span role="alert">{t('factsFailed')}</span>}
    {snapshot.state === 'ready' && !pending && files.length === 0 && !incomplete && <span>{t('factsEmpty')}</span>}
    {incomplete && <span>{t('factsPartial')}</span>}
    {reasons.length > 0 && <ul className="pe-produced-reasons">{reasons.map(reason => <li key={reason}>{t(reason)}</li>)}</ul>}
    <ul className="pe-produced-files">{visible.map(file => {
      const key = producedFileKey(file)
      const state = snapshot.publications[key]
      return <li key={key} data-produced-file={file.path}>
        <button type="button" title={`/workspace/${file.path}`} aria-label={`${file.path}: ${t(state === 'busy' ? 'publishing' : 'publishDownload')}`} aria-busy={state === 'busy'}
          disabled={state === 'busy' || state === 'changed'} onClick={() => { void closing.publish(file) }}>
          <span className="pe-produced-path">{file.path}</span>
          <span>{t(state === 'busy' ? 'publishing' : 'publishDownload')}</span>
        </button>
        {state === 'failed' && <span role="alert">{t('publishFailed')}</span>}
        {state === 'changed' && <span role="alert">{t('sourceChanged')}</span>}
      </li>
    })}</ul>
    {!expanded && files.length > visible.length && <button type="button" onClick={() => { setExpanded(true) }}>{t('showMoreFiles')}</button>}
  </section>
}
