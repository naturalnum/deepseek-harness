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
  folderFailed: '创建结果未确认。请刷新文件列表检查。',
  transferFailed: '上传未完成。请刷新文件列表检查保存结果。',
  cancelledUnknown: '已停止等待上传结果。请刷新文件列表检查保存结果。',
  storageQuotaExceeded: '账号存储配额不足，当前文件或目录未写入。请刷新文件列表核对已保存项。',
  storageDiskFull: '服务器磁盘空间不足，当前文件或目录未写入。请刷新文件列表核对已保存项。',
  downloadFailed: '无法下载，请检查文件后重试。',

  'shortcut.noSession': '请先选择会话',
  'type.label': '文件',
  'guide.title': '工作区文件',
  'guide.description': '浏览会话工作区的文件',
  loading: '正在读取…',
  empty: '空目录',
  truncated: '条目太多，只显示了一部分。',
  'page.browse': '分页浏览',
  'page.number': '第 {number} 页',
  'page.next': '下一页',
  'page.restart': '从第一页重新读取',
  'error.directoryChanged': '目录已变化，旧页面已清除。请从第一页重新读取。',
  'error.directoryStopped': '本次目录浏览已结束。请从第一页重新读取。',
  'error.directoryCloseFailed': '目录关闭尚未确认，暂不能打开或下载文件。请重新进入会话后再试。',
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
  folderFailed: 'Creation is unconfirmed. Refresh the file list to check.',
  transferFailed: 'Upload did not complete. Refresh the file list to check what was saved.',
  cancelledUnknown: 'Stopped waiting for the upload. Refresh the file list to check what was saved.',
  storageQuotaExceeded: 'The account storage quota was exceeded. The current file or folder was not saved. Refresh the file list to check what was saved.',
  storageDiskFull: 'The server is out of disk space. The current file or folder was not saved. Refresh the file list to check what was saved.',
  downloadFailed: 'Unable to download. Check the file and try again.',

  'shortcut.noSession': 'Select a session first',
  'type.label': 'Files',
  'guide.title': 'Workspace files',
  'guide.description': 'Browse files in this session\'s workspace',
  loading: 'Reading…',
  empty: 'Empty directory',
  truncated: 'Too many entries, showing only some of them.',
  'page.browse': 'Browse pages',
  'page.number': 'Page {number}',
  'page.next': 'Next page',
  'page.restart': 'Restart from the first page',
  'error.directoryChanged': 'The directory changed and the old page was cleared. Restart from the first page.',
  'error.directoryStopped': 'This directory enumeration ended. Restart from the first page.',
  'error.directoryCloseFailed': 'Directory closure is unconfirmed. Opening and downloading are blocked. Reopen the session before trying again.',
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
