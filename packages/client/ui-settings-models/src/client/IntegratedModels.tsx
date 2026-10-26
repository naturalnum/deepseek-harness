/** Stable native registration components consuming renderer-made page-admission hooks. */
import type { ReactNode } from 'react'
import type { ObservableSnapshot } from '@deepseek-ai/dsh-client-store'
import type { InjectFace, PropsRenderSlots, PropsRuntime } from '@deepseek-ai/dsh-client-ui-slots'
import { ModelsSection, type ModelsSectionInjected } from './ModelsSection.tsx'
import { DeepSeekOnboardingDialog, type DeepSeekOnboardingInjected } from './DeepSeekOnboardingDialog.tsx'
import type { ModelsCredentialEditing } from './operations.ts'

type EditingSource = ObservableSnapshot<ModelsCredentialEditing | null | undefined>

/** Registration face; the renderer alone turns its source into useCredentialEditing. */
export interface IntegratedModelsInjected extends ModelsSectionInjected {
  hooks: ModelsSectionInjected['hooks'] & { credentialEditing: EditingSource }
}

/** Original onboarding registration plus the same page-admission source. */
export interface IntegratedOnboardingInjected extends DeepSeekOnboardingInjected {
  hooks: DeepSeekOnboardingInjected['hooks'] & { credentialEditing: EditingSource }
}

/**
 * Read the original page source and delegate to the native Models component.
 * @param props Native registration shares, including a renderer-bound source.
 * @returns The original Models section; null revocation unmounts its keyed editor.
 */
export function IntegratedModels(props: InjectFace<IntegratedModelsInjected>
  & PropsRenderSlots<'settings.models.provider-card' | 'settings.models.footer'>): ReactNode {
  const { useCredentialEditing, ...native } = props
  const editing = useCredentialEditing(value => value)
  return <ModelsSection {...native} {...editing === undefined ? {} : { credentialEditing: editing }} />
}

/**
 * Read page admission for the original explicit/automatic onboarding component.
 * @param props Original onboarding owner, child slots and injected dependencies.
 * @returns Native onboarding with the same protected edit semantics as Models.
 */
export function IntegratedModelsOnboarding(props: PropsRuntime<'settings.onboarding'>
  & PropsRenderSlots<'settings.models.sign-in'> & InjectFace<IntegratedOnboardingInjected>): ReactNode {
  const { useCredentialEditing, ...native } = props
  const editing = useCredentialEditing(value => value)
  return <DeepSeekOnboardingDialog {...native} {...editing === undefined ? {} : { credentialEditing: editing }} />
}
