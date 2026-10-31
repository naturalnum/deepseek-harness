/** Existing account card styling for one original-version edit and explicit application-mode choice. */
import { useId, type ReactNode } from 'react'
import { Button, ConfigField, JsonTree } from '@deepseek-ai/dsh-client-ui-primitives'
import type { TranslateNS } from '@deepseek-ai/dsh-client-ui-slots'
import type { AccountPluginEditor } from './types.ts'
import { pluginFieldPolicy, samePluginPath } from './plugin-schema.ts'
import type {} from './locales.ts'
import css from './PluginManagementPage.module.css'

/**
 * Render one ordinary approved field with shared native controls, retaining no private version or implicit submit mode.
 * @param props Original source-owned interaction and plugin namespace copy.
 * @returns Existing native controls and the actual outcome, with no reset or retry action.
 */
export function PluginEditPanel({ editor, t }: { readonly editor: AccountPluginEditor
  readonly t: TranslateNS<'cloud-plugin-management'> }): ReactNode {
  const fieldId = useId()
  const editing = editor.phase === 'editing', busy = editor.phase === 'opening' || editor.phase === 'submitting'
  const field = editor.fields?.find(field => samePluginPath(field.path, editor.path ?? []))
  const policy = field === undefined ? undefined : pluginFieldPolicy(field)
  const canSubmit = editing && (editor.action !== 'selected' || editor.selected !== undefined)
    && (editor.action !== 'configure' || field !== undefined && editor.invalid === false && policy?.writable === true)
  return <section className={css.detail} aria-label={t('editPlugin')} aria-busy={busy}>
    <div className={css.detailHead}><h2 className={css.groupTitle}>
      {t(editor.action === 'configure' ? 'configure' : editor.action === 'selected'
        ? editor.selected ? 'selectAction' : 'deselectAction' : editor.enabled ? 'enableAction' : 'disableAction')}</h2>
    <Button size="sm" disabled={editor.phase === 'submitting'} onClick={editor.close}>{t('closeEdit')}</Button></div>
    {editor.phase === 'opening' ? <p className={css.reason} role="status">{t('openingEdit')}</p> : null}
    {editor.action === 'configure' && editor.fields !== undefined ? <>
      <label htmlFor={fieldId}>{t('fieldPath')}</label>
      <select id={fieldId} value={JSON.stringify(editor.path)} disabled={!editing}
        onChange={(event) => {
          const chosen = editor.fields?.find(field => JSON.stringify(field.path) === event.target.value)
          if (chosen !== undefined) editor.chooseField(chosen.path)
        }}>
        {editor.fields.map(field => <option key={JSON.stringify(field.path)} value={JSON.stringify(field.path)}>
          {JSON.stringify(field.path)}</option>)}
      </select>
      {field === undefined ? null : <>
        <ConfigField label={t('literalValue')} value={editor.valueText ?? ''} secret={policy?.secret === true} choices={[]}
          disabled={!editing || policy?.writable !== true} overridden={false} invalid={editor.invalid === true}
          labels={{ reset: t('resetUnavailable'), inherited: t('missingValue'), invalid: t('invalidLiteral') }} onChange={editor.editValue}
          onReset={() => { throw new Error('Cloud plugin fields do not support reset') }}/>
        <p className={css.reason}>{t('singleFieldExplanation')}</p>
        <p className={css.reason}>{t('resetUnavailable')}</p>
        <p className={css.reason}>{t(field.acceptsMissing === true ? 'acceptsMissing' : field.acceptsMissing === false ? 'requiresValue' : 'missingRuntime')}</p>
        {policy?.secret === true ? <p className={css.reason}>{t('secretValue')}</p> : <>
          {!Object.hasOwn(field, 'value') ? <p className={css.reason}>{t('missingValue')}</p> : null}
          <details><summary>{t('schema')}</summary>
            {field.schema !== null && typeof field.schema === 'object'
              ? <JsonTree data={field.schema} label={t('schema')} copyable={false} expandTopLevel={false}
                labels={{ copyValue: t('copyValue'), copyJson: t('copyJson'), copyPath: t('copyPath'), copyPrettyJson: t('copyPrettyJson'),
                  copyCompactJson: t('copyCompactJson'), copied: t('copied'), copyFailed: t('copyFailed'),
                  collapseNode: t('collapseNode'), expandNode: t('expandNode'), copyButtonTitle: action => t('copyButtonTitle', { action }) }}/>
              : <code>{JSON.stringify(field.schema)}</code>}
          </details>
        </>}
        {field.secrets.length > 0 ? <ul>{field.secrets.map(secret => <li key={JSON.stringify(secret.path)}>
          {t('secretPosition', { path: JSON.stringify(secret.path) })}: {t(secret.set ? 'secretSet' : 'secretUnset')}</li>)}</ul> : null}
        {policy?.writable !== true ? <p className={css.reason} role="status">
          {t(policy?.volatile === true ? 'volatileUnavailable' : field.readOnlyReason === 'protected' ? 'protectedField'
            : field.readOnlyReason === 'unproven' ? 'unprovenField' : 'fieldReadOnly')}</p> : null}
        <p className={css.reason}>{t('nativeValidation')}</p>
        {field.limitations.length > 0 ? <div className={css.reason}><p>{t('schemaLimitations')}</p>
          <ul>{field.limitations.map((limitation, index) => <li key={index}>{limitation}</li>)}</ul></div> : null}
      </>}
    </> : null}
    <p className={css.reason}>{t('modeExplanation')}</p>
    <div className={css.toolbar}>
      <Button size="sm" disabled={!canSubmit} onClick={() => { editor.submit('if-idle') }}>{t('applyIfIdle')}</Button>
      <Button size="sm" variant="outline" disabled={!canSubmit}
        onClick={() => { editor.submit('stop-and-apply') }}>{t('stopAndApply')}</Button>
    </div>
    {editor.phase === 'submitting' ? <p className={css.reason} role="status">{t('submittingEdit')}</p> : null}
    {editor.outcome === undefined ? null : <p className={css.reason}
      role={editor.outcome === 'busy' || editor.outcome === 'unknown' || editor.outcome === 'conflict' || editor.outcome === 'unavailable' ? 'alert' : 'status'}>
      {t(editor.outcome === 'applied' ? 'changeApplied' : editor.outcome === 'accepted-rebuild' ? 'rebuildAccepted'
        : editor.outcome === 'busy' ? 'busy' : editor.outcome === 'conflict' ? 'editConflict' : editor.outcome === 'unknown' ? 'unknown' : 'editUnavailable')}</p>}
  </section>
}
