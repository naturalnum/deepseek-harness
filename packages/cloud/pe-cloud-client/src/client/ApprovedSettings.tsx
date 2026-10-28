/** One shared settings section and data-driven namespace forms; persistence stays with ConfigForms. */
import { useId } from 'react'
import { SettingsForm, SettingsValueField } from '@deepseek-ai/dsh-client-ui-primitives'
import type { SettingsFormActions, SettingsFormShell, SettingsFieldState } from '@deepseek-ai/dsh-client-ui-primitives'
import type { ObservableSnapshot } from '@deepseek-ai/dsh-client-store'
import type { InjectFace, PropsLocale, PropsRenderSlots, PropsRuntime } from '@deepseek-ai/dsh-client-ui-slots'
import type {} from '@deepseek-ai/dsh-client-ui-settings/client'
export type {} from './approved-settings-locales.ts'

/** One supported, schema-validated scalar editor. */
export interface ApprovedFieldState extends SettingsFieldState {
  readonly field: string
  readonly kind: 'string' | 'number' | 'boolean'
  readonly choices?: readonly (string | number | boolean)[]
}
/** Original staged form projection; this contains no second accepted configuration store. */
export interface ApprovedSettingsState extends SettingsFormShell {
  readonly namespace: string
  readonly fields: readonly ApprovedFieldState[]
  readonly unsupported: readonly string[]
}
/** The original staged model supplies the only draft actions. */
export interface ApprovedSettingsFace extends SettingsFormActions {
  readonly hooks: { readonly approvedSettings: ObservableSnapshot<ApprovedSettingsState> }
}
declare module '@deepseek-ai/dsh-client-ui-slots' {
  interface SlotMap {
    /** Namespace forms contributed only under the original page's approved settings section. */
    'settings.approved.namespace': { kind: 'list'; scope: 'root'; owner: Record<never, never> }
  }
}
type SectionProps = PropsRenderSlots<'settings.approved.namespace'> & PropsLocale<'cloud-approved-settings'> & { readonly general?: boolean }
type FormProps = PropsRuntime<'settings.approved.namespace'> & PropsLocale<'cloud-approved-settings'> & InjectFace<ApprovedSettingsFace>

/** Render the one shared settings entry; the original renderer owns the namespace contributions.
 * @param props Existing settings slot shares.
 * @returns The approved fields section.
 */
export function ApprovedSettingsSection(props: SectionProps) {
  return <section><h2>{props.t(props.general ? 'generalTitle' : 'title')}</h2>
    <p>{props.t('introduction')}</p>{props.renderSlot('settings.approved.namespace', {})}</section>
}
/** Render one data-derived scalar form without accessing Cordis or starting requests.
 * @param props Original model state and actions bound by the slot renderer.
 * @returns Staged fields and unsupported-field notices.
 */
export function ApprovedSettingsForm(props: FormProps) {
  const state = props.useApprovedSettings(value => value), id = useId(), { t } = props
  return <section><h2>{state.namespace}</h2>
    {state.unsupported.map(field => <p key={field} role="status">{t('unsupported', { field })}</p>)}
    <SettingsForm state={state} labels={{ unavailable: t('unavailable'), readOnly: t('readOnly'), saveFailed: t('failed'),
      save: t('save'), saving: t('saving') }} onSave={props.save} onDiscard={props.discard}>
      {state.fields.map(field => <SettingsValueField key={field.field} id={`${id}:${field.field}`} label={field.field}
        text={field.text} overridden={field.overridden} invalid={field.invalid}
        hint={field.choices === undefined ? t(field.kind) : t('choices', { values: JSON.stringify(field.choices) })}
        overriddenLabel={t('overridden')} resetLabel={t('reset')} invalidLabel={t('invalid')}
        numeric={field.kind === 'number'} disabled={!state.writable || !state.available || state.saving}
        onEdit={(text) => { props.edit(field.field, text) }} onReset={() => { props.resetField(field.field) }}/>) }
    </SettingsForm>
  </section>
}
