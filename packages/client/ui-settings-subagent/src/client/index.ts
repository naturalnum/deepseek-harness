/**
 * The Subagent settings page, browser half: the delegation limits over the
 * `subagent` namespace and the models agents may choose over the
 * `subagent-model-selection` namespace, on one page with one save. The page
 * registers into the Plugins page's `plugins.item` slot while the Host serves
 * either namespace and shows the sections it serves.
 */

// Type-only: pulls the locale plugin's Context merge (ctx.locale).
import type {} from '@deepseek-ai/dsh-client-locale/client'
// Type-only: the ctx.configForms Context merge. Cross-plugin collaboration
// goes through the service, never a value import (client bundle purity gate).
import type {} from '@deepseek-ai/dsh-client-ui-settings/client'
// Type-only: the Plugins page's SlotMap merge (the 'plugins.item' entry).
import type {} from '@deepseek-ai/dsh-client-ui-plugin-manager/client'
import type {} from '@deepseek-ai/dsh-client-ui-renderer/client'
// Type-only: the ctx.remote Context merge and the forwarded-event key face.
import type {} from '@deepseek-ai/dsh-api-remotes/client'
import type { Context as ClientContext } from '@deepseek-ai/cordis'
import type { SubagentSettingsIntegration } from './integration.ts'
export type { SubagentSettingsIntegration } from './integration.ts'
import { SubagentCard } from './SubagentCard.tsx'
import { subagentCardFace } from './subagent-card-controller.ts'
import { SubagentLimitsCardController } from './subagent-limits-card-controller.ts'
import {
  SUBAGENT_MODEL_SELECTION_NS, SubagentModelSelectionCardController,
} from './subagent-model-selection-card-controller.ts'
import { en, zh, type SubagentSettingsLocaleKey } from './locales.ts'

export type { SubagentCardProps } from './SubagentCard.tsx'
export type { SubagentCardFace } from './subagent-card-controller.ts'
export type { SubagentLimitsCardFace, SubagentLimitsCardState, SubagentLimitsSettings } from './subagent-limits-card-controller.ts'
export type {
  SubagentModelSelectionCardFace, SubagentModelSelectionCardState, SubagentModelSelectionSettings,
} from './subagent-model-selection-card-controller.ts'
export type { SubagentSettingsLocaleKey } from './locales.ts'

declare module '@deepseek-ai/dsh-client-ui-slots' {
  interface LocaleNamespaceMap {
    /** Subagent settings page copy. */
    'settings.subagent': SubagentSettingsLocaleKey
  }
}

/** Dictionary namespace owned by this plugin. */
export const NS = 'settings.subagent'

/**
 * Namespace of the delegation limits. Spelled here rather than imported: a
 * client package must not depend on a Host package.
 */
export const SUBAGENT_NS = 'subagent'

/** Required services (cordis fiber inject). */
export const inject = ['slots', 'locale', 'remote', 'remote.session', 'configForms']

/**
 * Mount the Subagent settings page while the Host serves either of its namespaces.
 * @param ctx - the browser plugin context.
 */
export function apply(ctx: ClientContext): void {
  const t = ctx.locale.bind(NS)
  ctx.effect(() => ctx.locale.register(NS, { zh, en }), 'ui-settings-subagent: dictionaries')
  const models = new SubagentModelSelectionCardController(
    ctx.configForms.get(SUBAGENT_MODEL_SELECTION_NS),
    ctx,
  )
  const modelsFace = models.inject()
  // The model catalogue is not part of any settings section: adapters come and
  // go, and a document commit elsewhere can change which routes are stored.
  ctx.effect(
    () => ctx.remote.$on('llm/adapters-updated', () => { models.refreshCatalog() }),
    'ui-settings-subagent: adapter invalidations',
  )
  ctx.effect(
    () => ctx.remote.$on('settings/document-updated', () => { models.refreshCatalog() }),
    'ui-settings-subagent: settings invalidations',
  )
  ctx.effect(
    () => ctx.on('connection/reset', () => { models.resetConnection() }),
    'ui-settings-subagent: connection generation',
  )
  ctx.effect(() => () => { models.dispose() }, 'ui-settings-subagent: model preference')
  const mount = (namespace: string, binding?: SubagentSettingsIntegration): (() => void) => {
    let live = true
    const shared = ctx.configForms.get<import('./subagent-limits-card-controller.ts').SubagentLimitsSettings>(namespace)
    const scope = binding === undefined ? shared : {
      getSnapshot: () => shared.getSnapshot(),
      subscribe: (listener: () => void) => shared.subscribe(listener),
      mutate: (ops: Parameters<typeof shared.mutate>[0], revision?: number) => shared.mutate(ops, revision, () => {
        const value = shared.getSnapshot().value
        if (!live || ctx.get('subagentSettingsIntegration') !== binding || value === undefined
          || ops.some(op => op.path.length !== 1 || !binding.fields.includes(op.path[0] ?? '')
            || !Object.hasOwn(value, op.path[0] ?? ''))) throw new Error('Subagent settings binding is no longer current.')
      }),
    }
    const limits = new SubagentLimitsCardController(scope, binding?.fields)
    const unwatch = ctx.configForms.whileServed([namespace, SUBAGENT_MODEL_SELECTION_NS], () => ctx.slots.inject('plugins.item', () => ctx.slots.register({
      name: 'plugins.item', id: 'subagent', order: 10,
      label: () => t('subagentTitle'), locale: NS,
      inject: () => {
        const face = subagentCardFace(limits.inject(), modelsFace)
        return { ...face,
          editLimit: (...args: Parameters<typeof face.editLimit>) => { if (live) face.editLimit(...args) },
          resetLimit: (...args: Parameters<typeof face.resetLimit>) => { if (live) face.resetLimit(...args) },
          toggleEnabled: (...args: Parameters<typeof face.toggleEnabled>) => { if (live) face.toggleEnabled(...args) },
          toggleModel: (...args: Parameters<typeof face.toggleModel>) => { if (live) face.toggleModel(...args) },
          retryCatalog: () => { if (live) face.retryCatalog() },
          save: () => { if (live) face.save() }, discard: () => { if (live) face.discard() } }
      },
    }, SubagentCard)))
    return () => { live = false; unwatch(); limits.dispose() }
  }
  let active = true, unmount = mount(SUBAGENT_NS)
  const integration = ctx.inject(['subagentSettingsIntegration'], (scope) => {
    const binding = scope.get('subagentSettingsIntegration')
    if (binding === undefined || !active) return
    unmount()
    unmount = mount(binding.namespace, binding)
    return () => {
      unmount()
      if (active) unmount = mount(SUBAGENT_NS)
    }
  })
  ctx.effect(() => async () => { active = false; unmount(); await integration.dispose() }, 'ui-settings-subagent: page')
}
