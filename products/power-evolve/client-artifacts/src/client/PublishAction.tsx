import { useEffect, useRef, useState } from 'react'
import { Tooltip } from '@deepseek-ai/dsh-client-ui-primitives'
import type { PropsLocale, PropsRuntime } from '@deepseek-ai/dsh-client-ui-slots'
import type { ArtifactHttpClient } from './api.ts'

type Props = PropsRuntime<'sidebar.right.tab.document.actions'>
  & PropsLocale<'powerEvolve.artifacts'>
  & { readonly sessionId: string; readonly client: ArtifactHttpClient; readonly onPublished: () => void }

/** One explicit publish gesture for the file selected in the native preview. */
export function PublishAction(props: Props) {
  return <PublishActionForFile key={`${props.sessionId}:${props.absolutePath}`} {...props} />
}

function PublishActionForFile({ absolutePath, sessionId, client, onPublished, t }: Props) {
  const [state, setState] = useState<'idle' | 'busy' | 'done' | 'failed'>('idle')
  const attempt = useRef<{ requestId: string; controller: AbortController | null } | null>(null)
  useEffect(() => () => attempt.current?.controller?.abort(), [])
  const publish = async () => {
    if (attempt.current?.controller !== null && attempt.current?.controller !== undefined) return
    const requestId = attempt.current?.requestId ?? crypto.randomUUID()
    const controller = new AbortController()
    attempt.current = { requestId, controller }
    setState('busy')
    try {
      await client.publish(sessionId, absolutePath, requestId, controller.signal)
      if (!controller.signal.aborted) { setState('done'); onPublished() }
    } catch {
      if (!controller.signal.aborted) setState('failed')
    } finally {
      if (attempt.current?.controller === controller) attempt.current = { requestId, controller: null }
    }
  }
  const label = t(state === 'busy' ? 'publishing' : state === 'done' ? 'published' : 'publish')
  return <span className="pe-artifact-publish" data-artifact-publish="">
    <Tooltip label={label} side="bottom" delayMs={500}>
      <button type="button" aria-label={label} aria-busy={state === 'busy'} disabled={state === 'busy' || state === 'done'}
        onClick={() => { void publish() }}>
        <svg viewBox="0 0 16 16" width="16" height="16" fill="none" aria-hidden="true">
          <path d="M8 11V2m-3 3 3-3 3 3M2 10v3h12v-3" stroke="currentColor" strokeWidth="1.4" strokeLinecap="round" strokeLinejoin="round" />
        </svg>
      </button>
    </Tooltip>
    {state === 'failed' && <span className="pe-artifact-publish-error" role="alert">{t('publishFailed')}</span>}
  </span>
}
