/** Account-management copy owned by the Cloud settings contribution. */
const en = {
  title: 'Account management', introduction: 'Manage platform accounts. Project data remains private to each account.',
  refresh: 'Refresh', search: 'Search email', email: 'Email', displayName: 'Display name', password: 'Password',
  template: 'Resource template', prepare: 'Prepare resources', previous: 'Previous', next: 'Next',
  resourcesLegacy: 'Uses preallocated resources', resourcesReady: 'Resources ready', resourcesPending: 'Resources need preparation', resourcesUnknown: 'Resource cleanup is unconfirmed',
  role: 'Role', admin: 'Administrator', user: 'User', enabled: 'Enabled', disabled: 'Disabled', loginBlocked: 'Sign-in blocked', retryDisable: 'Retry disabling',
  create: 'Create account', save: 'Save', resetPassword: 'Reset password', enable: 'Enable', disable: 'Disable',
  failed: 'The operation was refused or its result is unconfirmed. Refresh before trying again.',
  pending: 'Processing…', created: 'Account created and ready to use.',
  capacityFull: 'Account capacity is full. Add capacity before creating another account.',
  diagnosticTitle: 'Execution diagnostics', diagnosticAccount: 'Target Account ID', diagnosticSession: 'Session ID',
  diagnosticFrom: 'From (UTC, inclusive)', diagnosticTo: 'To (UTC, exclusive)', diagnosticRun: 'Find execution records',
  diagnosticDenied: 'This Account and Session are unavailable to your login.',
  diagnosticFailed: 'The diagnostic query could not be completed.',
  diagnosticInvalid: 'Enter both IDs and a time range of up to 24 hours.',
  diagnosticEmpty: 'No records in this time range.', diagnosticMore: 'More records exist. Narrow the time range to see them.',
  diagnosticObserved: 'Observed (UTC)', diagnosticAllocation: 'Allocation ID', diagnosticState: 'State',
  diagnosticReason: 'Reason code', diagnosticStage: 'Stage',
}
const zh: typeof en = {
  title: '账号管理', introduction: '管理平台账号，各账号的项目数据保持独立。',
  refresh: '刷新', search: '搜索邮箱', email: '邮箱', displayName: '显示名称', password: '密码',
  template: '资源模板', prepare: '准备资源', previous: '上一页', next: '下一页',
  resourcesLegacy: '沿用已预分配资源', resourcesReady: '资源已就绪', resourcesPending: '资源尚待准备', resourcesUnknown: '资源停止尚未确认',
  role: '角色', admin: '管理员', user: '普通用户', enabled: '已启用', disabled: '已停用', loginBlocked: '已禁止登录', retryDisable: '重试停用',
  create: '创建账号', save: '保存', resetPassword: '重置密码', enable: '启用', disable: '停用',
  failed: '操作被拒绝或结果尚未确认，请先刷新核对状态再尝试。',
  pending: '正在处理…', created: '账号已创建，可以使用。',
  capacityFull: '账号资源容量已用完，扩容后可继续创建账号。',
  diagnosticTitle: '执行诊断', diagnosticAccount: '目标账号 ID', diagnosticSession: '会话 ID',
  diagnosticFrom: '开始时间（UTC，含）', diagnosticTo: '结束时间（UTC，不含）', diagnosticRun: '查询执行记录',
  diagnosticDenied: '当前登录无法查看此账号和会话。',
  diagnosticFailed: '诊断查询未完成。',
  diagnosticInvalid: '请输入两个 ID 和不超过 24 小时的时间范围。',
  diagnosticEmpty: '此时间范围内没有记录。', diagnosticMore: '还有更多记录，请缩小时间范围查询。',
  diagnosticObserved: '观察时间（UTC）', diagnosticAllocation: '分配 ID', diagnosticState: '状态',
  diagnosticReason: '原因码', diagnosticStage: '阶段',
}
/** Native locale namespace for the account settings menu. */
export const ACCOUNT_MANAGEMENT_NS = 'cloud-account-management'
/** Complete native dictionaries. */
export const accountManagementDictionaries = { en, zh }
declare module '@deepseek-ai/dsh-client-ui-slots' {
  interface LocaleNamespaceMap { 'cloud-account-management': keyof typeof en }
}
