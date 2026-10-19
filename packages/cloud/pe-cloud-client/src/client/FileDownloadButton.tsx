/** Independent download action; Root supplies its native resource occurrence and localized copy. */
import { useEffect, useRef, useState, type ReactElement } from 'react'
import { Button } from '@deepseek-ai/dsh-client-ui-primitives'
import { CloudFileDownload, type CloudFileDownloadInput, type CloudFileDownloadResult } from './file-download.ts'

/** Complete locale-owned labels; this component owns no translated fallback strings. */
export interface FileDownloadLabels {
  readonly download: string
  readonly pending: string
  readonly cancel: string
  readonly cancelled: string
  readonly started: string
  readonly failed: string
  readonly tooLarge: string
  readonly invalid: string
}

/** Fixed native file occurrence and its complete localized presentation. */
export interface FileDownloadButtonProps extends CloudFileDownloadInput {
  readonly labels: FileDownloadLabels
}

interface InstalledDownload extends CloudFileDownloadInput { readonly owner: CloudFileDownload }

/**
 * Request a complete byte save for one captured native file occurrence.
 * @param props Original Session/resource/page/carrier, native cap and localized labels.
 * @returns A button and local status; replacement/unmount ignores old results and disposes the old occurrence.
 */
export function FileDownloadButton(props: FileDownloadButtonProps): ReactElement {
  const { sessionId, resourceAddress, signal, readBytes, maxFileBytes, labels } = props
  const [installed, setInstalled] = useState<InstalledDownload>()
  const active = useRef<InstalledDownload | undefined>(undefined)
  const [pending, setPending] = useState(false)
  const [result, setResult] = useState<CloudFileDownloadResult>()
  useEffect(() => {
    const owner = new CloudFileDownload({ sessionId, resourceAddress, signal, readBytes, maxFileBytes })
    const occurrence = { owner, sessionId, resourceAddress, signal, readBytes, maxFileBytes }
    active.current = occurrence
    setInstalled(occurrence)
    setPending(false)
    setResult(undefined)
    return () => {
      if (active.current === occurrence) active.current = undefined
      void owner.dispose()
    }
  }, [sessionId, resourceAddress, signal, readBytes, maxFileBytes])
  const current = installed !== undefined && installed.sessionId === sessionId && installed.resourceAddress === resourceAddress
    && installed.signal === signal && installed.readBytes === readBytes && installed.maxFileBytes === maxFileBytes
    ? installed : undefined
  const save = (): void => {
    if (current === undefined || pending || signal.aborted) return
    const occurrence = current
    setPending(true)
    void occurrence.owner.save().then((value) => {
      if (active.current !== occurrence || signal.aborted) return
      if (value.kind === 'busy') return
      setPending(false)
      setResult(value)
    })
  }
  const failure = current !== undefined && result?.kind === 'failed' ? result : undefined
  return <>
    <Button onClick={save} disabled={current === undefined || pending || signal.aborted} aria-busy={pending && current !== undefined}>
      {pending && current !== undefined ? labels.pending : labels.download}
    </Button>
    {pending && current !== undefined && <Button onClick={() => { void current.owner.cancel() }}>{labels.cancel}</Button>}
    {current !== undefined && result?.kind === 'started' && <span role="status">{labels.started}</span>}
    {current !== undefined && result?.kind === 'cancelled' && <span role="status">{labels.cancelled}</span>}
    {failure !== undefined && <span role="alert">{
      failure.reason === 'too-large' ? labels.tooLarge : failure.reason === 'invalid-resource' ? labels.invalid : labels.failed
    }</span>}
  </>
}
