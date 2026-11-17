/** Running Turn clock isolated from the transcript's render cycle. */
import { memo, useEffect, useState } from 'react'
import { TextShimmer } from '@deepseek-ai/dsh-client-ui-primitives'
import type { PropsRenderSlots } from '@deepseek-ai/dsh-client-ui-slots'
import type { ChatViewSlotProps } from '../contract/slots.ts'
import { formatRunDuration, LIVE_RUN_CLOCK_INTERVAL_MS } from './message-chrome.ts'
import { RunningWhaleTail } from './RunningWhaleTail.tsx'
import a11yCss from './accessibility.module.css'
import css from './ChatView.module.css'

interface RunningStatusProps {
  readonly startTime: number | undefined
  /** Freeze the shown duration while the Client cannot observe the Session. */
  readonly paused?: boolean
  /** Keep the slot without showing or announcing the status: the Session stopped before its Turn closed. */
  readonly holding?: boolean
  readonly t: ChatViewSlotProps['t']
  /** Original framework dispatcher; absent direct drawings keep the Native content. */
  readonly renderSlotChain?: PropsRenderSlots<'conversation.chat.running.mark' | 'conversation.chat.running.copy'>['renderSlotChain']
}

/**
 * Show live elapsed time after the current Turn's content without announcing ticks.
 * @param props - Current Turn start time, pause state, and localized copy.
 * @returns the blue running indicator; mount while the Session is running, or holding its slot hidden until the
 * Turn's actions row replaces it.
 */
export const RunningStatus = memo(function RunningStatus({
  startTime, paused, holding = false, t, renderSlotChain,
}: RunningStatusProps) {
  const [now, setNow] = useState(Date.now)
  useEffect(() => {
    if (startTime === undefined || paused || holding) return
    setNow(Date.now())
    const timer = setInterval(() => { setNow(Date.now()) }, LIVE_RUN_CLOCK_INTERVAL_MS)
    return () => { clearInterval(timer) }
  }, [startTime, paused, holding])
  const duration = startTime === undefined ? undefined
    : formatRunDuration(Math.max(1000, now - startTime), t).map(part => part.text).join('')
  const label = duration === undefined ? t('chat.deepDiving') : t('chat.deepDivingFor', { duration })
  const copy = (announcement: boolean) => {
    const text = announcement ? t('chat.deepDiving') : label
    const fallback = announcement ? text : <TextShimmer active={!holding} className={css.runningText}>{text}</TextShimmer>
    return renderSlotChain === undefined ? fallback : renderSlotChain('conversation.chat.running.copy', {
      duration: announcement ? undefined : duration, announcement, active: !holding, className: css.runningText,
    }, { fallback })
  }
  return (
    <div className={css.running} data-chat-running data-holding={holding ? '' : undefined} aria-hidden={holding || undefined}>
      {holding ? null : (
        <span className={a11yCss.visuallyHidden} role="status" aria-live="polite" aria-atomic="true">{copy(true)}</span>
      )}
      <span className={css.runningDivider} aria-hidden="true" />
      <span className={css.runningContent}>
        {renderSlotChain === undefined ? <RunningWhaleTail />
          : renderSlotChain('conversation.chat.running.mark', {}, { fallback: <RunningWhaleTail /> })}
        {copy(false)}
      </span>
    </div>
  )
})
