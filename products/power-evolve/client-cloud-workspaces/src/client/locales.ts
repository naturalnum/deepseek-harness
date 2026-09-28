export const zh = {
  title: '新建云工作区', name: '工作区名称', create: '创建', cancel: '取消', close: '关闭',
  invalid: '请输入 1–80 个字符的名称，且不要使用控制字符。',
} as const

export const en: Record<keyof typeof zh, string> = {
  title: 'New cloud Workspace', name: 'Workspace name', create: 'Create', cancel: 'Cancel', close: 'Close',
  invalid: 'Enter a name of 1–80 characters without control characters.',
}

export type CloudWorkspaceLocaleKey = keyof typeof zh
