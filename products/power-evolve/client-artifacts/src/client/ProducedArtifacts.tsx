/** Platform-verified file versions displayed at their invoking native turn. */
import type { Session } from '@deepseek-ai/dsh-api-session-controller/client'
import { useState } from 'react'
import type { InjectFace, PropsLocale, PropsRuntime } from '@deepseek-ai/dsh-client-ui-slots'
import type { ClosingFactsSource, ExecutionFacts } from './execution-facts.ts'
import { filesForClosing, producedFileKey } from './execution-facts.ts'
import { referencesForClosing } from './produced-artifacts.ts'

/** The renderer synthesizes the subscription hook; source identities are local to this plugin. */
export interface ProducedArtifactsInjected {
  readonly sessionId: Session['sessionId']
  readonly facts: ExecutionFacts
  readonly keyedHooks: { readonly closingFacts: (key: string) => ClosingFactsSource | undefined }
}
type Props = PropsRuntime<'conversation.chat.turnTail'> & PropsLocale<'powerEvolve.artifacts'> & InjectFace<ProducedArtifactsInjected>

/** Observe one closing, including trusted continuation associations; only original receipts render a row.
 * @param props - native owner, viewed Session and generated observation hook.
 * @returns the verified file row, or no visible row for a continuation without new executions.
 */
export function ProducedArtifacts(props: Props) {
  const source = props.facts.forClosing(props.sessionId, props)
  return <ClosingArtifacts key={source.key} {...props} source={source} />
}

function ClosingArtifacts({ source, useClosingFacts, t, ...owner }: Props & { readonly source: ClosingFactsSource }) {
  const snapshot = useClosingFacts(source.key)
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
      <button type="button" onClick={() => { source.refresh() }} disabled={snapshot.state === 'loading'}>{t('refresh')}</button>
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
          disabled={state === 'busy' || state === 'changed'} onClick={() => { void source.publish(file) }}>
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
