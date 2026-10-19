/** Native preview action adapter: only the actual session-scope seat selects the Session. */
import type { ReactElement } from 'react'
import type { PropsLocale, PropsRuntime } from '@deepseek-ai/dsh-client-ui-slots'
import type {} from '@deepseek-ai/dsh-client-ui-sidebar-documentpreview/client'
import type {} from '@deepseek-ai/dsh-client-ui-session/client'
import { sessionFileAddress } from '@deepseek-ai/dsh-util-workspace-path'
import { FileDownloadButton } from './FileDownloadButton.tsx'
import type { CloudFileReadBytes } from './file-download.ts'
import type {} from './download/locales.ts'

/** Stable page/declaration inputs supplied by the Cordis-owned installer. */
export interface FileDownloadActionInjected {
  readonly signal: AbortSignal
  readonly maxFileBytes: number
  readonly readBytes: CloudFileReadBytes
}

/** Original native action owner and framework Session seat, without a global selection read. */
export type FileDownloadActionProps = PropsRuntime<'sidebar.right.tab.document.actions'>
  & PropsLocale<'cloud-file-download'> & FileDownloadActionInjected

/**
 * Render one download action in either native preview action list.
 * @param props Native owner absolutePath, actual injected SessionId and captured page inputs.
 * @returns The existing independent byte-save component; its unmount owns occurrence cancellation.
 */
export function FileDownloadAction(props: FileDownloadActionProps): ReactElement {
  return <FileDownloadButton sessionId={props.sessionId}
    resourceAddress={sessionFileAddress(props.sessionId, props.absolutePath)}
    signal={props.signal} readBytes={props.readBytes} maxFileBytes={props.maxFileBytes}
    labels={{ download: props.t('download'), pending: props.t('pending'), cancel: props.t('cancel'),
      cancelled: props.t('cancelled'), started: props.t('started'), failed: props.t('failed'),
      tooLarge: props.t('tooLarge'), invalid: props.t('invalid') }} />
}
