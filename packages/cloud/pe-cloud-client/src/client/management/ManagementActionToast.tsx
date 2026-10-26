/** Transient management feedback hosted outside the selected main panel. */
import type { ReactNode } from 'react'
import { IconWarningOutlineRegular, Toast } from '@deepseek-ai/dsh-client-ui-primitives'
import type { HostObservable, InjectFace, PropsLocale, PropsRuntime } from '@deepseek-ai/dsh-client-ui-slots'
import type { SkillAction, SkillActionOutcome } from './skills/types.ts'
export type {} from './locales.ts'
export type {} from '@deepseek-ai/dsh-client-ui-layout/client'

/** One completed UI operation; no pending, persistence or account ledger lives here. */
export interface ManagementNotice {
  readonly sequence: number
  readonly action: SkillAction | 'plugin-refresh' | 'plugin-toggle' | 'plugin-configure'
  readonly outcome: SkillActionOutcome | 'accepted-rebuild' | 'busy'
}
/** The original management owner's single transient source and matching dismissal. */
export interface ManagementActionToastInjected {
  readonly hooks: { readonly managementNotice: HostObservable<ManagementNotice | null> }
  readonly dismiss: (sequence: number) => void
}
/** Original overlay shares and renderer-bound feedback observation. */
export type ManagementActionToastProps = PropsRuntime<'shell.overlay'> & PropsLocale<'cloud-management'>
  & InjectFace<ManagementActionToastInjected>

/**
 * Show the final operation result through the shared application Toast primitive.
 * @param props Original overlay source, locale and dismissal; this owner outlives navigation.
 * @returns The current transient notice, or nothing when none has been reported.
 */
export function ManagementActionToast({ useManagementNotice, dismiss, t }: ManagementActionToastProps): ReactNode {
  const notice = useManagementNotice(value => value)
  if (notice === null) return null
  return <Toast key={notice.sequence}
    text={t('operationReport', { operation: t(notice.action), outcome: t(notice.outcome) })}
    {...notice.outcome === 'confirmed' ? { tone: 'success' as const } : {}}
    icon={<IconWarningOutlineRegular/>} onDone={() => { dismiss(notice.sequence) }}/>
}
