export const zh = {
  attach: '上传文件到工作区',
  cancel: '取消上传',
  uploading: '正在上传…',
  unavailable: '文件上传暂不可用',
  tooLarge: '文件超过大小限制（最大 {max}）',
  failed: '文件上传失败，请重试',
} as const

export const en: Record<keyof typeof zh, string> = {
  attach: 'Upload file to Workspace',
  cancel: 'Cancel upload',
  uploading: 'Uploading…',
  unavailable: 'File upload is unavailable',
  tooLarge: 'File exceeds the size limit (maximum {max})',
  failed: 'File upload failed. Try again.',

}

export type WorkspaceFileLocaleKey = keyof typeof zh
