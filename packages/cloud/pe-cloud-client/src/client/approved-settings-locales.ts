/** Copy for the one account-approved native live configuration form. */
const en = {
  generalTitle: 'Additional preferences', title: 'Approved configuration', introduction: 'Only approved live fields are editable here.',
  unavailable: 'This configuration is unavailable.', readOnly: 'This configuration is read-only.',
  failed: 'The result is unconfirmed or was refused. Check current state before trying again.',
  save: 'Save', saving: 'Saving…', overridden: 'Overridden', reset: 'Use inherited value', invalid: 'Invalid value',
  number: 'Enter a number.', boolean: 'Enter true or false.', string: 'Enter a text value.',
  choices: 'Allowed values: {values}', unsupported: 'This field cannot be edited with this form: {field}',
}
const zh: typeof en = {
  generalTitle: '其他设置', title: '已批准配置', introduction: '此处仅可编辑已批准的实时字段。',
  unavailable: '此配置当前不可用。', readOnly: '此配置为只读。',
  failed: '结果尚未确认或操作已被拒绝，请先核对当前状态再尝试。',
  save: '保存', saving: '正在保存…', overridden: '已覆盖', reset: '使用继承值', invalid: '值无效',
  number: '请输入数值。', boolean: '请输入 true 或 false。', string: '请输入文本值。',
  choices: '允许的值：{values}', unsupported: '此表单不支持编辑该字段：{field}',
}
/** Typed dictionary namespace owned by the existing account-page contribution. */
export const APPROVED_SETTINGS_NS = 'cloud-approved-settings'
/** Complete copy consumed by the original locale provider. */
export const approvedSettingsDictionaries = { en, zh }
/** Translation keys for account-approved configuration. */
export type ApprovedSettingsKey = keyof typeof en
declare module '@deepseek-ai/dsh-client-ui-slots' {
  interface LocaleNamespaceMap { 'cloud-approved-settings': ApprovedSettingsKey }
}
