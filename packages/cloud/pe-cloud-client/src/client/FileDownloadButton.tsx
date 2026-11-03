/** Native icon action; the browser owns attachment progress after handoff. */
import { useState, useMemo, useEffect, useRef, type ReactElement } from 'react'
import { IconDownloadOutlineRegular, Tooltip } from '@deepseek-ai/dsh-client-ui-primitives'
import { CloudFileDownload, type CloudFileDownloadInput } from './file-download.ts'

/** Complete locale-owned labels retained for native occurrence consumers. */
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
/** Captured page/resource with localized labels. */
export interface FileDownloadButtonProps extends CloudFileDownloadInput { readonly labels: FileDownloadLabels }
/** @param props Captured native occurrence. @returns An accessible icon and failure-only feedback. */
export function FileDownloadButton(props: FileDownloadButtonProps): ReactElement {
  const owner = useMemo(() => new CloudFileDownload(props), [props.sessionId, props.resourceAddress,
    props.signal, props.fetch, props.navigationUrl, props.maxFileBytes, props.paths])
  const active = useRef<CloudFileDownload | undefined>(owner)
  active.current = owner
  useEffect(() => () => {
    if (active.current === owner) active.current = undefined
    void owner.dispose()
  }, [owner])
  const [state, setState] = useState<{ owner: CloudFileDownload; kind: 'pending' | 'failed' | 'started' }>()
  const pending = state?.owner === owner && state.kind === 'pending'
  const failed = state?.owner === owner && state.kind === 'failed'
  return <>
    <Tooltip label={props.labels.download} side="bottom"><button type="button" aria-label={props.labels.download}
      disabled={pending || props.signal.aborted} aria-busy={pending}
      style={{ display: 'inline-flex', alignItems: 'center', justifyContent: 'center', flexShrink: 0,
        width: 28, height: 28, padding: 6, background: 'transparent', color: 'inherit', border: 0, borderRadius: 4, cursor: 'pointer' }}
      onClick={() => {
        setState({ owner, kind: 'pending' })
        void owner.save().then((result) => {
          if (active.current === owner && !props.signal.aborted) setState({ owner, kind: result.kind === 'failed' ? 'failed' : 'started' })
        })
      }}><IconDownloadOutlineRegular size={16} /></button></Tooltip>
    {failed && <span role="alert" style={{ maxWidth: 220, overflowWrap: 'anywhere', fontSize: 12 }}>{props.labels.failed}</span>}
  </>
}
