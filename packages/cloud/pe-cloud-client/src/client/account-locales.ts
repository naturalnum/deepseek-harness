/** Copy for the Cookie-authenticated Cloud sidebar account launcher. */
const en = {
  menu: 'Account: {name}', settings: 'Settings', signOut: 'Sign out',
  unavailable: 'Sign out is unavailable. Refresh the page and check your sign-in status.',
}
const zh: typeof en = {
  menu: '账号：{name}', settings: '设置', signOut: '退出登录',
  unavailable: '暂时无法退出登录，请刷新页面检查登录状态',
}
/** Namespace owned by the Cloud account launcher. */
export const ACCOUNT_NS = 'cloud-account'
/** Complete locale dictionaries, withdrawn with the original page contribution. */
export const accountDictionaries = { en, zh }
declare module '@deepseek-ai/dsh-client-ui-slots' {
  interface LocaleNamespaceMap { 'cloud-account': keyof typeof en }
}
