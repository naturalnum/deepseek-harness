/** Simplified Chinese labels for native storage selection and binding recovery. */
export const zh = {
  title: '云工作区', name: '工作区名称', create: '创建', cancel: '关闭', close: '关闭',
  invalid: '请输入 1–80 个字符的名称，且不要使用控制字符',
  mode: '工作区操作', newDirectory: '新建目录', existingDirectory: '选择已有目录', recovery: '恢复绑定',
  newDescription: '为新工作区创建独立的私人目录',
  recoveryDescription: '选择原工作区和新的目录。恢复会等待旧执行停止，并保留已有会话',
  missingWorkspace: '需要恢复的工作区', noMissing: '没有需要恢复的工作区',
  storage: '私人存储', noStorage: '没有可用的私人存储', root: '存储根目录', parent: '上一级',
  selectedDirectory: '选中的目录', directories: '子目录', noDirectories: '此目录没有子目录',
  nextPage: '下一页', directoryName: '新目录名称', mkdir: '新建子目录', invalidDirectory: '请输入有效的单个目录名称',
  restore: '恢复原工作区', checkStatus: '查询恢复状态', refresh: '刷新', loading: '正在加载…',
  accepted: '恢复请求已受理。可查询最新状态', stopping: '正在等待旧执行停止。可查询最新状态',
  completed: '绑定已恢复，原工作区和已有会话保持不变', blocked: '恢复暂时受阻，原绑定保持不变。请查询状态或重试',
  overlap: '此目录与其他工作区重叠，请选择其他目录', changed: '工作区绑定已变化，请刷新后再恢复',
  conflict: '请求与当前工作区或目录状态冲突，请刷新后重试', denied: '无法访问此存储或工作区',
  failed: '操作未能完成。请刷新列表，或查询恢复状态后重试',
  resumeRecovery: '此工作区已有恢复请求，请查询状态后继续', refreshFailed: '绑定已恢复，但列表未能刷新，请稍后刷新',
} as const

/** English labels with the same keys as the Chinese dictionary. */
export const en: Record<keyof typeof zh, string> = {
  title: 'Cloud Workspaces', name: 'Workspace name', create: 'Create', cancel: 'Close', close: 'Close',
  invalid: 'Enter a name of 1–80 characters without control characters.',
  mode: 'Workspace action', newDirectory: 'New directory', existingDirectory: 'Existing directory', recovery: 'Recover binding',
  newDescription: 'Create a separate private directory for the new Workspace.',
  recoveryDescription: 'Select the original Workspace and a replacement directory. Recovery waits for old execution to stop and keeps existing Sessions.',
  missingWorkspace: 'Workspace to recover', noMissing: 'No Workspaces need recovery.',
  storage: 'Private storage', noStorage: 'No private storage is available.', root: 'Storage root', parent: 'Parent directory',
  selectedDirectory: 'Selected directory', directories: 'Child directories', noDirectories: 'This directory has no child directories.',
  nextPage: 'Next page', directoryName: 'New directory name', mkdir: 'Create child directory', invalidDirectory: 'Enter one valid directory name.',
  restore: 'Recover original Workspace', checkStatus: 'Check recovery status', refresh: 'Refresh', loading: 'Loading…',
  accepted: 'Recovery accepted. Check for the latest status.', stopping: 'Waiting for old execution to stop. Check for the latest status.',
  completed: 'Binding recovered. The original Workspace and existing Sessions are retained.', blocked: 'Recovery is blocked. The original binding is retained. Check status or retry.',
  overlap: 'This directory overlaps another Workspace. Select a different directory.', changed: 'The Workspace binding changed. Refresh before recovering.',
  conflict: 'The request conflicts with the current Workspace or directory. Refresh and retry.', denied: 'This storage or Workspace is unavailable to you.',
  failed: 'The operation could not finish. Refresh the list, or check recovery status before retrying.',
  resumeRecovery: 'This Workspace already has a recovery request. Check its status to continue.', refreshFailed: 'The binding recovered, but the list could not refresh. Refresh it again.',
}

/** Typed locale keys owned by the cloud Workspace modal. */
export type CloudWorkspaceLocaleKey = keyof typeof zh
