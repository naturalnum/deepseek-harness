import { useEffect, useRef, useState } from 'react'
import { Button, Modal } from '@deepseek-ai/dsh-client-ui-primitives'
import type { PropsLocale, PropsRuntime } from '@deepseek-ai/dsh-client-ui-slots'
import { ExecutionTargetClient, targetKey, type ExecutionTarget, type Pairing, type TargetOption } from './execution-target-client.ts'
import type { ExecutionTargetLocaleKey } from './locales.ts'
import { ExecutionResolutions } from './ExecutionResolutions.tsx'
import { ExecutionResolutionClient } from './execution-resolution-client.ts'
import { localDeviceAuthorization } from './local-device-bridge.ts'

export type ExecutionTargetPickerProps = PropsRuntime<'conversation.input.right'> & {
  readonly sessionId: string
  readonly client: ExecutionTargetClient
  readonly resolutionClient: ExecutionResolutionClient
} & PropsLocale<'powerEvolve.executionTarget'>

export function ExecutionTargetPicker({ sessionId, client, resolutionClient, useSession, t }: ExecutionTargetPickerProps) {
  const removed = useSession(state => state.removed)
  const [options, setOptions] = useState<readonly TargetOption[]>([])
  const [selected, setSelected] = useState<ExecutionTarget>(() => client.current(sessionId))
  const [loading, setLoading] = useState(true)
  const [error, setError] = useState(false)
  const [revision, setRevision] = useState(0)
  const [pairOpen, setPairOpen] = useState(false)
  const [pairBusy, setPairBusy] = useState(false)
  const [pairError, setPairError] = useState(false)
  const [pairing, setPairing] = useState<Pairing | null>(null)
  const [localOpenFailed, setLocalOpenFailed] = useState(false)
  const openLocal = localDeviceAuthorization()
  const pairRequest = useRef<AbortController | null>(null)
  useEffect(() => () => pairRequest.current?.abort(), [])

  useEffect(() => {
    const controller = new AbortController()
    setLoading(true)
    void client.list(controller.signal).then(items => {
      if (controller.signal.aborted) return
      setOptions(items)
      setSelected(client.reconcile(sessionId, items))
      setError(false)
    }).catch(() => {
      if (!controller.signal.aborted) setError(true)
    }).finally(() => {
      if (!controller.signal.aborted) setLoading(false)
    })
    return () => controller.abort()
  }, [client, sessionId, revision])

  const currentKey = targetKey(selected)
  const currentKnown = currentKey === 'cloud' || options.some(option => option.key === currentKey)
  const closePair = () => {
    pairRequest.current?.abort()
    pairRequest.current = null
    setPairOpen(false)
    setPairing(null)
    setPairBusy(false)
    setPairError(false)
    setLocalOpenFailed(false)
    setRevision(value => value + 1)
  }
  const beginPair = () => {
    if (pairRequest.current !== null) return
    const controller = new AbortController()
    pairRequest.current = controller
    setPairOpen(true)
    setPairBusy(true)
    setPairError(false)
    setPairing(null)
    void client.pair(controller.signal).then(value => {
      if (!controller.signal.aborted) setPairing(value)
    }).catch(() => {
      if (!controller.signal.aborted) setPairError(true)
    }).finally(() => {
      if (pairRequest.current === controller) pairRequest.current = null
      if (!controller.signal.aborted) setPairBusy(false)
    })
  }
  return (
    <div className="pe-execution-target" data-execution-target="">
      <label className="pe-execution-target-label">
        <span className="pe-execution-target-caption">{t('target')}</span>
        <select
          aria-label={t('target')}
          value={currentKey}
          disabled={removed || loading}
          onChange={event => {
            const target = event.currentTarget.value === 'cloud'
              ? { kind: 'cloud' as const }
              : options.find(option => option.key === event.currentTarget.value)?.target
            if (target === undefined) return
            client.select(sessionId, target, options)
            setSelected(target)
          }}
        >
          <option value="cloud">{t('cloud')}</option>
          {!currentKnown && selected.kind === 'desktop' ? (
            <option value={currentKey}>{t('unavailable')}</option>
          ) : null}
          {options.map(option => (
            <option key={option.key} value={option.key}>
              {t('desktop').replace('{device}', option.device).replace('{directory}', option.directory)}
            </option>
          ))}
        </select>
      </label>
      <button type="button" className="pe-execution-target-refresh" title={t('refresh')}
        aria-label={t('refresh')} disabled={removed || loading} onClick={() => setRevision(value => value + 1)}>
        ↻
      </button>
      <button type="button" className="pe-execution-target-pair" disabled={removed}
        onClick={beginPair}>{t('pair')}</button>
      {error ? <span role="alert" className="pe-execution-target-error">{t('unavailable')}</span> : null}
      <ExecutionResolutions sessionId={sessionId} removed={removed} client={resolutionClient} t={t} />
      <Modal open={pairOpen} onClose={closePair} title={t('pairTitle')} description={t('pairHelp')}
        closeLabel={t('close')} footer={<Button onClick={closePair}>{t('close')}</Button>}>
        {pairBusy && <p role="status">{t('pairLoading')}</p>}
        {pairError && <p role="alert">{t('pairFailed')}</p>}
        {pairing !== null && <div className="pe-execution-target-pairing">
          <label htmlFor="pe-device-pair-code">{t('pairCode')}</label>
          <input id="pe-device-pair-code" readOnly data-modal-autofocus value={pairing.code}
            onFocus={event => event.currentTarget.select()} />
          <span>{t('pairExpires').replace('{time}', new Date(pairing.expiresAt).toLocaleTimeString())}</span>
          {openLocal !== undefined && <Button onClick={() => {
            setLocalOpenFailed(false)
            void openLocal().catch(() => { setLocalOpenFailed(true) })
          }}>{t('openLocalAuthorization')}</Button>}
          {localOpenFailed && <p role="alert">{t('openLocalFailed')}</p>}
        </div>}
      </Modal>
    </div>
  )
}

export type { ExecutionTargetLocaleKey }
