/** Read-only facts within the existing execution-location area; confirmation belongs to the Platform page. */
import { useEffect, useState } from 'react'
import { Button, Modal } from '@deepseek-ai/dsh-client-ui-primitives'
import type { PropsLocale } from '@deepseek-ai/dsh-client-ui-slots'
import type { ExecutionResolutionInspection, ExecutionResolutionItem } from '@power-evolve/contracts/execution-resolution'
import { ExecutionResolutionClient, ExecutionResolutionHttpError } from './execution-resolution-client.ts'

type Props = PropsLocale<'powerEvolve.executionTarget'> & {
  readonly sessionId: string
  readonly removed: boolean
  readonly client: ExecutionResolutionClient
}

/** @param props - original Session and validated read-only transport.
 * @returns the existing-area entry and bounded lifetime modal.
 */
export function ExecutionResolutions({ sessionId, removed, client, t }: Props) {
  const [open, setOpen] = useState(false), [revision, setRevision] = useState(0)
  const [items, setItems] = useState<readonly ExecutionResolutionItem[]>([])
  const [inspection, setInspection] = useState<ExecutionResolutionInspection | null>(null)
  const [selected, setSelected] = useState<string | null>(null)
  const [link, setLink] = useState<string | null>(null), [error, setError] = useState(false)
  const [loading, setLoading] = useState(false), [pollEnded, setPollEnded] = useState(false)

  useEffect(() => {
    if (!open || removed) { setItems([]); setInspection(null); setSelected(null); setLink(null); return }
    const controller = new AbortController(), signal = controller.signal
    setLoading(true); setError(false); setPollEnded(false); setItems([]); setInspection(null)
    const fail = (reason: unknown) => {
      if (signal.aborted) return
      if (reason instanceof ExecutionResolutionHttpError && reason.status === 401) {
        setOpen(false); setItems([]); setInspection(null); setLink(null)
      } else setError(true)
    }
    void client.approvalUrl(signal, location.origin).then(url => { if (!signal.aborted) setLink(url) }).catch(fail)
    void (async () => {
      for (let attempt = 0; attempt < 15; attempt++) {
        const result = await client.list(sessionId, signal)
        if (signal.aborted) return
        if (!result.available) throw new Error('Execution reconciliation is unavailable')
        setItems(result.items); setLoading(false)
        if (!result.items.some(item => item.resolution?.state === 'accepted' || item.resolution?.state === 'stopping')) return
        if (attempt === 14) { setPollEnded(true); return }
        await new Promise<void>(resolve => {
          const done = () => { clearTimeout(timer); signal.removeEventListener('abort', done); resolve() }
          const timer = setTimeout(done, 2000)
          signal.addEventListener('abort', done, { once: true })
        })
        signal.throwIfAborted()
      }
    })().catch(fail).finally(() => { if (!signal.aborted) setLoading(false) })
    return () => controller.abort()
  }, [open, removed, sessionId, client, revision])

  useEffect(() => {
    if (!open || removed || selected === null) { setInspection(null); return }
    const controller = new AbortController()
    setInspection(null)
    void client.inspect(selected, controller.signal).then(result => {
      if (result.item.sessionId !== sessionId) throw new Error('Mismatched execution Session')
      if (!controller.signal.aborted) setInspection(result)
    }).catch(reason => {
      if (controller.signal.aborted) return
      if (reason instanceof ExecutionResolutionHttpError && reason.status === 401) {
        setOpen(false); setItems([]); setInspection(null); setLink(null)
      } else setError(true)
    })
    return () => controller.abort()
  }, [selected, open, removed, sessionId, client, revision])

  const close = () => { setOpen(false); setSelected(null) }
  const finalLabel = (state: ExecutionResolutionItem['executionState']) => state === 'closed_unknown' ? t('resolutionClosedUnknown')
    : state === 'succeeded' ? t('resolutionSucceeded') : state === 'failed' ? t('resolutionFailed')
      : state === 'cancelled' ? t('resolutionCancelled') : state === 'queued' ? t('resolutionQueued')
        : state === 'starting' ? t('resolutionStarting') : state === 'running' ? t('resolutionRunning')
          : state === 'cancelling' ? t('resolutionCancelling') : t('resolutionUncertain')
  const receiptLabel = (state: NonNullable<ExecutionResolutionItem['resolution']>['state']) => state === 'accepted' ? t('resolutionAccepted')
    : state === 'stopping' ? t('resolutionStopping') : state === 'blocked' ? t('resolutionBlocked') : t('resolutionCompleted')
  return <>
    <button type="button" className="pe-execution-target-pair" disabled={removed}
      onClick={() => setOpen(true)}>{t('resolutions')}</button>
    <Modal open={open && !removed} onClose={close} title={t('resolutions')} description={t('resolutionHelp')}
      closeLabel={t('close')} footer={<Button onClick={close}>{t('close')}</Button>}>
      <div className="pe-execution-resolutions">
        <Button disabled={loading} onClick={() => { setSelected(null); setRevision(value => value + 1) }}>{t('resolutionRefresh')}</Button>
        {loading && <p role="status">{t('resolutionLoading')}</p>}
        {error && <p role="alert">{t('resolutionUnavailable')}</p>}
        {pollEnded && <p role="status">{t('resolutionPollEnded')}</p>}
        {!loading && !error && items.length === 0 && <p>{t('resolutionEmpty')}</p>}
        {items.map(item => <article key={item.executionId} data-execution-id={item.executionId}>
          <strong>{finalLabel(item.executionState)}</strong>
          <p>{t('resolutionExecution')}: <code>{item.executionId}</code></p>
          <p>{t('resolutionDirectory')}: <code>{item.cwd}</code></p>
          <pre>{item.command}</pre>
          {item.executionState === 'uncertain' && <p>{t('resolutionUnknownEffects')}</p>}
          {item.executionState === 'closed_unknown' && <p>{t('resolutionClosedUnknownHelp')}</p>}
          {item.resolution && <>
            <p>{receiptLabel(item.resolution.state)} · <code>{item.resolution.requestId}</code></p>
            {item.resolution.errorCode && <p>{t('resolutionReason')}: <code>{item.resolution.errorCode}</code></p>}
          </>}
          {item.errorCode && <p>{t('resolutionReason')}: <code>{item.errorCode}</code></p>}
          <Button onClick={() => setSelected(item.executionId)}>{t('resolutionInspect')}</Button>
          {inspection?.item.executionId === item.executionId && <>
            <p>{t('resolutionObservation')}: <code>{inspection.runnerObservation}</code></p>
            {!inspection.canStop && <p>{t('resolutionReason')}: <code>{inspection.blockedReason}</code></p>}
          </>}
          {link && <a href={`${link}#execution=${encodeURIComponent(item.executionId)}`} target="_blank" rel="noopener noreferrer">
            {t('resolutionTrustedEntry')}
          </a>}
        </article>)}
      </div>
    </Modal>
  </>
}
