export const zh = {
  target: '执行位置',
  cloud: '云端执行',
  desktop: '本地：{device} / {directory}',
  refresh: '刷新本地目录',
  unavailable: '无法读取本地目录，请稍后重试',
  noDesktop: '尚未授权本地目录',
  pair: '配对本地设备',
  pairTitle: '连接本地 PowerEvolve',
  pairHelp: '在本机设备页面输入此配对码，然后授权项目目录。完成后刷新执行位置列表。',
  pairCode: '一次性配对码',
  pairLoading: '正在生成配对码…',
  pairFailed: '无法生成配对码，请重试',
  pairExpires: '有效期至 {time}',
  close: '关闭',
} as const

export const en: Record<keyof typeof zh, string> = {
  target: 'Execution location',
  cloud: 'Cloud',
  desktop: 'Local: {device} / {directory}',
  refresh: 'Refresh local directories',
  unavailable: 'Cannot load local directories. Try again later.',
  noDesktop: 'No local directory authorized',
  pair: 'Pair local device',
  pairTitle: 'Connect local PowerEvolve',
  pairHelp: 'Enter this code in the local device page, then authorize a project directory. Refresh the execution list afterward.',
  pairCode: 'One-time pairing code',
  pairLoading: 'Creating pairing code…',
  pairFailed: 'Cannot create a pairing code. Try again.',
  pairExpires: 'Valid until {time}',
  close: 'Close',
}

export type ExecutionTargetLocaleKey = keyof typeof zh
