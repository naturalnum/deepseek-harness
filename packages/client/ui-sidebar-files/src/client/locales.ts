/**
 * `sidebarFiles` namespace dictionaries, and the namespace's declaration.
 *
 * The failure lines name what the tree could not list, one code each, because a
 * directory that is gone, one outside the workspace, and a path that is not a
 * directory each suggest a different next step.
 *
 * The namespace merge lives with its key set so that any module naming
 * `TranslateNS<'sidebarFiles'>` or `PropsLocale<'sidebarFiles'>` needs only this
 * file, whichever entry a program loads first.
 */
import type {} from '@deepseek-ai/dsh-client-ui-slots'

declare module '@deepseek-ai/dsh-client-ui-slots' {
  interface LocaleNamespaceMap {
    /** File-tree type name, guide entry, row states, and failure lines. */
    sidebarFiles: SidebarFilesKey
  }
}

/** Simplified Chinese dictionary and key-set source of truth. */
export const zh = {
  upload: '上传',
  download: '下载',
  uploadOptions: '上传选项',
  uploadFolder: '上传文件夹',
  newFolder: '新建文件夹',
  untitledFolder: '未命名文件夹',
  selectFile: '选择 {name}',
  cancel: '取消',
  folderFailed: '创建未确认。刷新检查是否已创建；检查名称和权限后重试。',
  transferFailed: '上传未完成。已完成文件保留，请刷新检查后重试未完成文件。',
  cancelledUnknown: '已停止上传。刷新检查已完成文件后再重试。',
  downloadFailed: '无法下载，请检查文件后重试。',

  'shortcut.noSession': '请先选择会话',
  'type.label': '文件',
  'guide.title': '工作区文件',
  'guide.description': '浏览会话工作区的文件',
  loading: '正在读取…',
  empty: '空目录',
  truncated: '条目太多，只显示了一部分。',
  noWorkspace: '这个会话没有工作区目录。',
  reload: '重新读取',
  autoRefresh: '自动刷新',
  'autoRefresh.enable': '开启自动刷新',
  'autoRefresh.disable': '关闭自动刷新',
  'entry.other': '这不是文件或目录，没法打开。',
  'error.notFound': '这个目录不在了。可能已被移动或删除。',
  'error.outsideWorkspace': '这个目录在工作区之外，侧栏不会读取它。',
  'error.notDirectory': '这不是一个目录。',
  'error.unavailable': '读取失败：{message}',
} satisfies Record<string, string>

/** Files dictionary key union. */
export type SidebarFilesKey = keyof typeof zh

/** English dictionary, checked against the Chinese key set. */
export const en = {
  upload: 'Upload',
  download: 'Download',
  uploadOptions: 'Upload options',
  uploadFolder: 'Upload folder',
  newFolder: 'New folder',
  untitledFolder: 'Untitled folder',
  selectFile: 'Select {name}',
  cancel: 'Cancel',
  folderFailed: 'Creation is unconfirmed. Refresh to check, then correct the name or access and retry.',
  transferFailed: 'Upload did not complete. Completed files remain; refresh before retrying unfinished files.',
  cancelledUnknown: 'Upload stopped. Refresh to check completed files before retrying.',
  downloadFailed: 'Unable to download. Check the file and try again.',

  'shortcut.noSession': 'Select a session first',
  'type.label': 'Files',
  'guide.title': 'Workspace files',
  'guide.description': 'Browse files in this session\'s workspace',
  loading: 'Reading…',
  empty: 'Empty directory',
  truncated: 'Too many entries, showing only some of them.',
  noWorkspace: 'This session has no workspace directory.',
  reload: 'Reload',
  autoRefresh: 'Auto refresh',
  'autoRefresh.enable': 'Enable auto refresh',
  'autoRefresh.disable': 'Disable auto refresh',
  'entry.other': 'Not a file or a directory, so it cannot be opened.',
  'error.notFound': 'That directory is gone. It may have been moved or deleted.',
  'error.outsideWorkspace': 'That directory is outside the workspace, so the sidebar will not read it.',
  'error.notDirectory': 'That is not a directory.',
  'error.unavailable': 'Read failed: {message}',
} satisfies Record<SidebarFilesKey, string>
