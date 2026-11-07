/** Account-management copy owned by the Cloud settings contribution. */
const en = {
  title: 'Account management', introduction: 'Manage platform accounts. Project data remains private to each account.',
  refresh: 'Refresh', search: 'Search email', email: 'Email', displayName: 'Display name', password: 'Password',
  role: 'Role', admin: 'Administrator', user: 'User', enabled: 'Enabled', disabled: 'Disabled',
  create: 'Create account', save: 'Save', resetPassword: 'Reset password', enable: 'Enable', disable: 'Disable',
  failed: 'The operation was refused or its result is unconfirmed. Refresh before trying again.',
  pending: 'Saving…', created: 'Account created. Resource preparation must finish before it can sign in.',
}
const zh: typeof en = {
  title: '账号管理', introduction: '管理平台账号，各账号的项目数据保持独立。',
  refresh: '刷新', search: '搜索邮箱', email: '邮箱', displayName: '显示名称', password: '密码',
  role: '角色', admin: '管理员', user: '普通用户', enabled: '已启用', disabled: '已停用',
  create: '创建账号', save: '保存', resetPassword: '重置密码', enable: '启用', disable: '停用',
  failed: '操作被拒绝或结果尚未确认，请先刷新核对状态再尝试。',
  pending: '正在保存…', created: '账号已创建，资源准备完成后才可登录。',
}
/** Native locale namespace for the account settings menu. */
export const ACCOUNT_MANAGEMENT_NS = 'cloud-account-management'
/** Complete native dictionaries. */
export const accountManagementDictionaries = { en, zh }
declare module '@deepseek-ai/dsh-client-ui-slots' {
  interface LocaleNamespaceMap { 'cloud-account-management': keyof typeof en }
}
