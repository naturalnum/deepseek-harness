/** Native keyed Tool row; all navigation belongs to the injected original page callback. */
import { Button, DisclosureRow, IconCodeOutlineRegular } from '@deepseek-ai/dsh-client-ui-primitives'
import type { PropsLocale } from '@deepseek-ai/dsh-client-ui-slots'
import type { ToolCallViewProps } from '@deepseek-ai/dsh-client-ui-tool/client'
import type {} from '@deepseek-ai/dsh-client-ui-session/client'
import { cloudServicePreviewMeta, type CloudServicePreviewNavigation } from './service-preview.ts'
import type {} from './service-preview-locales.ts'
import css from './ServicePreviewRow.module.css'

/** The page/declaration assembly supplies a required narrow action; absent carriers register no row. */
export interface ServicePreviewRowInjected {
  readonly navigatePreview: CloudServicePreviewNavigation
}

/** Framework SessionId, original Tool phase/node and the captured page action. */
export type ServicePreviewRowProps = ToolCallViewProps & PropsLocale<'cloud-service-preview'> & ServicePreviewRowInjected

/**
 * Render recorded process output with an independent controlled-preview action when metadata permits.
 * @param props The actual framework Session seat, durable task data and original page navigation callback.
 * @returns Native disclosure and optional button; no URL, credential, current account or HTTP-ready state is constructed.
 */
export function ServicePreviewRow(props: ServicePreviewRowProps) {
  const { expanded, toggle } = props.useDisclosure()
  const result = props.phase === 'result' ? props.block : undefined
  const meta = result === undefined || result.isError || props.toolName !== 'dev_service'
    || result.call?.name !== 'dev_service' ? undefined : cloudServicePreviewMeta(result.meta)
  const text = result?.content.filter(block => block.type === 'text').map(block => block.text).join('\n') ?? ''
  const open = (): void => {
    if (meta !== undefined) props.navigatePreview(Object.freeze({ sessionId: props.sessionId, serviceHandle: meta.serviceHandle }))
  }
  return <DisclosureRow icon={<IconCodeOutlineRegular size={14} />} title={props.t('title')}
    open={expanded && text !== ''} expandable={text !== ''} onToggle={toggle} running={result === undefined}
    collapsedContent={props.t(result === undefined ? 'pending' : result.isError ? 'failed' : 'completed')}
    headerAccessory={meta === undefined ? undefined : <Button size="sm" variant="toolbar" onClick={open}>{props.t('open')}</Button>}>
    {expanded && text !== '' && <pre className={css.output}>{text}</pre>}
  </DisclosureRow>
}
