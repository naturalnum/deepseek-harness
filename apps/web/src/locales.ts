/** Typed copy for the pre-Cordis Cloud login and page-owned exit controls. */
interface CloudWebCopy {
  title: string
  email: string
  password: string
  signIn: string
  signOut: string
  check: string
  pending: string
  invalidCredentials: string
  requestTooLarge: string
  previewClosed: string
  previewDenied: string
  unavailable: string
  stopped: string
  authUnknown: string
  logoutUnknown: string
  unconfirmed: string
}

const en: CloudWebCopy = {
  title: 'Sign in to DSH', email: 'Email', password: 'Password', signIn: 'Sign in', signOut: 'Sign out',
  check: 'Check sign-in status', pending: 'Please wait',
  invalidCredentials: 'Sign-in was refused. Check your email and password.',
  requestTooLarge: 'The sign-in details are too long. Shorten them and try again.',
  previewClosed: 'This page has closed. Check your sign-in status before opening a preview.',
  previewDenied: 'The preview could not open. Check the service status and try again.',
  unavailable: 'The workspace could not open. Check your sign-in status or sign out.',
  stopped: 'The workspace has closed. Check your sign-in status or sign out.',
  authUnknown: 'Sign-in could not be confirmed. Check its status before trying again.',
  logoutUnknown: 'Sign-out could not be confirmed. Check its status before continuing.',
  unconfirmed: 'Workspace cleanup has not been confirmed. Keep this page open and do not switch accounts.',
}

const zh: CloudWebCopy = {
  title: '登录 DSH', email: '邮箱', password: '密码', signIn: '登录', signOut: '退出登录',
  check: '检查登录状态', pending: '请稍候',
  invalidCredentials: '登录被拒绝，请检查邮箱和密码',
  requestTooLarge: '登录信息过长，请缩短后重试',
  previewClosed: '此页面已关闭，请检查登录状态后再打开预览',
  previewDenied: '无法打开预览，请检查服务状态后重试',
  unavailable: '暂时无法打开工作区，请检查登录状态或退出登录',
  stopped: '工作区已关闭，请检查登录状态或退出登录',
  authUnknown: '尚无法确认登录结果，请先检查登录状态再继续',
  logoutUnknown: '尚无法确认退出结果，请先检查登录状态再继续',
  unconfirmed: '尚未确认工作区清理完成，请保持此页面打开，暂勿切换账户',
}

/**
 * Resolve supported copy without accessing unauthenticated browser persistence.
 * @param language - document language after native locale initialization, otherwise browser language.
 * @returns the complete localized entry copy.
 */
export function cloudWebCopy(language: string): CloudWebCopy {
  return /^zh(?:-|$)/i.test(language) ? zh : en
}
