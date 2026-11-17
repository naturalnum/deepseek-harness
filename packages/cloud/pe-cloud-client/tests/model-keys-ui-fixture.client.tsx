/** Real Native Slot/Factory/renderer composition for moved Cloud key-control purposes. */
import { Context } from '@deepseek-ai/cordis'
import { SlotRegistry } from '@deepseek-ai/dsh-client-ui-renderer/client'
import { createSnapshotStore } from '@deepseek-ai/dsh-client-store'
import type { StandardSourceBinding } from '@deepseek-ai/dsh-client-ui-slots'
import { LocaleRuntime } from '@deepseek-ai/dsh-client-locale/client'
import { ModelsSection, type ModelsSectionProps } from '../../../client/ui-settings-models/src/client/ModelsSection.tsx'
import type { ModelsOperations } from '../../../client/ui-settings-models/src/client/operations.ts'
import type { SettingsSchemaOperations } from '../../../client/ui-settings-models/src/client/schema-operations.ts'
import { ProviderEditor } from '../../../client/ui-settings-models/src/client/ProviderEditor.tsx'
import { en, zh } from '../../../client/ui-settings-models/src/client/locales.ts'
import { createSlotRenderer } from '../../../client/ui-renderer/src/client/scoped-slots.tsx'
import { installCloudModelKeyActions } from '../src/client/model-key-actions.tsx'
import { onTestFinished } from 'vitest'

/** Existing apply fixtures use the actual Native factory; isolated editor fixtures register that same original component. */
export async function createModelKeyTestRenderer(ctx: Context,
  native?: { operations: ModelsOperations; schema: SettingsSchemaOperations; props: ModelsSectionProps }, install = true) {
  const slots = ctx.get('slots') ?? new SlotRegistry(ctx), locale = ctx.get('locale') ?? new LocaleRuntime(ctx)
  if (ctx.get('locale') === undefined) ctx.provide('locale', locale)
  locale.setLocale('en'); slots.installLocale(locale); slots.install(createSlotRenderer())
  // Settings has no selected Session. The real renderer still needs its ordinary adapter and public absent-binding value.
  const currentSession = createSnapshotStore<StandardSourceBinding>({ key: undefined, hooks: {}, keyedHooks: {}, props: {} })
  slots.installScope('session', { current: currentSession, bindingSource: () => currentSession })

  for (const id of ['ja', 'es', 'fr', 'de', 'ru', 'pt']) {
    ctx.effect(() => locale.addLanguage({ id, label: id, fallback: 'en' }))
  }
  if (native !== undefined) {
    const removeCopy = locale.register('settings.models', { en, zh })
    const removeFactory = slots.registerFactory({ name: 'settings.models.provider-editor', scope: 'root',
      locale: 'settings.models', inject: () => native }, ProviderEditor)
    const { renderSlot: _originalManualSeat, ...face } = native.props
    const removeRoot = slots.register({ name: 'root', inject: () => face, children: {
      'settings.models.provider-card': { kind: 'keyed', scope: 'root' },
      'settings.models.footer': { kind: 'list', scope: 'root' },
      'settings.models.provider.credentials': { kind: 'single', scope: 'root' },
    } }, ModelsSection)
    onTestFinished(() => { removeRoot(); removeFactory(); removeCopy() })
  }
  const lifetime = new AbortController()
  const owner = install ? ctx.plugin((scope) => { installCloudModelKeyActions(scope, lifetime.signal) }) : undefined
  if (owner !== undefined) await owner.await()
  onTestFinished(async () => { lifetime.abort(); await owner?.dispose() })
  return { lifetime, owner, slots, locale }
}
