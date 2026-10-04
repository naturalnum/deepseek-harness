/** Product-owned text for local Device actions and retained unknown execution records. */
export const deviceZh = {
  menu: '本机设备', open: '打开本机授权',
  startupTitle: '本机设备不可用', startupBody: '无法启动或连接本机设备，请检查配置后重试。云端会话仍可使用。',
  quitTitle: '退出 PowerEvolve？', quitActive: '本机执行将尝试停止。云端任务继续运行。',
  quitUnknown: '本机执行状态尚未全部确认。原记录将保留，下次启动先核对，不会自动重放命令。',
  quitFailed: '尚未确认本机进程退出或授权窗口清理完成，应用将保持运行。请重试退出并检查本机设备日志。',
  quit: '退出', cancel: '取消', acknowledge: '确认',
} as const
/** English counterpart with the same local lifecycle messages. */
export const deviceEn: Record<keyof typeof deviceZh, string> = {
  menu: 'Local device', open: 'Open local authorization',
  startupTitle: 'Local device unavailable', startupBody: 'The local device could not start or connect. Check its configuration and retry. Cloud conversations remain available.',
  quitTitle: 'Quit PowerEvolve?', quitActive: 'Local execution will attempt to stop. Cloud tasks continue running.',
  quitUnknown: 'Some local execution states remain unconfirmed. Original records will be retained and reconciled on the next start; commands will not replay automatically.',
  quitFailed: 'Local process exit or authorization window cleanup has not been confirmed. The application will remain open. Retry quitting and check the local device logs.',
  quit: 'Quit', cancel: 'Cancel', acknowledge: 'Confirm',
}
