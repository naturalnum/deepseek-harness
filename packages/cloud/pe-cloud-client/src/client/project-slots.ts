/** Reversible title-form registration into the native Workspace slots. */
import type { Context } from '@deepseek-ai/cordis'
import type {} from '@deepseek-ai/dsh-client-ui-renderer/client'
import type {} from '@deepseek-ai/dsh-client-ui-workspace/client'
import type {} from '@deepseek-ai/dsh-client-locale/client'
import { CloudProjectFlow, type CloudProjectFlowInjected } from './project-flow.tsx'
import { projectDictionaries } from './locales.ts'

const namespace = 'cloud-projects'

/**
 * Fill the two existing Workspace directory-flow holes with one account-fixed creation action.
 * @param owner Original Cloud Client dependency scope; registrations leave with its fiber.
 * @param createProject Title-only action using the native generated Remote.
 */
export function registerCloudProjectSlots(owner: Context, createProject: CloudProjectFlowInjected['createProject']): void {
  owner.effect(() => {
    const disposers: (() => void)[] = []
    try {
      for (const [locale, dictionary] of Object.entries(projectDictionaries)) {
        disposers.push(owner.locale.register(namespace, locale, dictionary))
      }
    } catch (error) {
      for (const dispose of disposers.reverse()) dispose()
      throw error
    }
    return () => { for (const dispose of disposers.reverse()) dispose() }
  }, 'pe-cloud-client: project dictionaries')
  const injected = (): CloudProjectFlowInjected => ({ t: owner.locale.bind(namespace), createProject })
  owner.slots.inject('conversation.hero.workspace.directoryFlow', () =>
    owner.slots.inject('sidebar.workspaces.directoryFlow', function* () {
      yield owner.slots.register({ name: 'conversation.hero.workspace.directoryFlow', inject: injected }, CloudProjectFlow)
      yield owner.slots.register({ name: 'sidebar.workspaces.directoryFlow', inject: injected }, CloudProjectFlow)
    }))
}
