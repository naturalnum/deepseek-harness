/** Navigation and transient feedback owned by the original Cloud management scope. */
const en = {
  skills: 'Skills', plugins: 'Plugins', 'plugin-refresh': 'Refresh plugins', 'plugin-toggle': 'Change plugin availability',
  'plugin-configure': 'Configure plugin', reminderTitle: 'Repeated tool call reminder',
  reminderDescription: 'Remind the model when it repeats the same tool call without progress',
  'accepted-rebuild': 'The rebuild was accepted; reconnect and refresh its state', operationReport: '{operation}: {outcome}',
  install: 'Install skill', import: 'Import package', 'catalog-install': 'Install skill', toggle: 'Change skill availability',
  update: 'Update skill', download: 'Request skill download', remove: 'Remove skill', try: 'Open skill draft', refresh: 'Refresh skills',
  confirmed: 'The operation was confirmed', conflict: 'The current state changed; inspect it before continuing',
  busy: 'The account reported busy. Refresh its state before choosing another action.',
  unknown: 'The outcome is unconfirmed; inspect the current state and do not repeat the action',
  unavailable: 'This action is unavailable for the current account',
}
const zh: Record<keyof typeof en, string> = {
  skills: '技能', plugins: '插件', 'plugin-refresh': '刷新插件', 'plugin-toggle': '调整插件可用状态',
  'plugin-configure': '配置插件', reminderTitle: '重复工具调用提醒', reminderDescription: '提醒模型跳出没有进展的重复工具调用',
  'accepted-rebuild': '重建请求已接受，请重连并刷新状态', operationReport: '{operation}：{outcome}',
  install: '安装技能', import: '导入技能包', 'catalog-install': '安装技能', toggle: '调整技能可用状态',
  update: '更新技能', download: '请求下载技能', remove: '移除技能', try: '打开技能草稿', refresh: '刷新技能',
  confirmed: '操作已确认', conflict: '当前状态已变化，请核对后再继续',
  busy: '账户报告忙碌，请刷新账户状态后再决定后续操作。',
  unknown: '结果尚未确认，请核对当前状态，勿重复提交', unavailable: '当前账户尚未开放此操作',
}
/** Namespace owned by the one Cloud management assembly. */
export const CLOUD_MANAGEMENT_NAMESPACE = 'cloud-management'
/** Paired navigation and feedback copy; sample persistence remains in its own source. */
export const cloudManagementDictionaries = { en, zh }
/** Typed navigation and transient outcome keys. */
export type CloudManagementKey = keyof typeof en

declare module '@deepseek-ai/dsh-client-ui-slots' {
  interface LocaleNamespaceMap { 'cloud-management': CloudManagementKey }
}
