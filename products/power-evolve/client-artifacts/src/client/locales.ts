export const zh = {
  title: '产物', guide: '已发布产物', guideDescription: '查看和下载已发布的文件',
  publish: '发布为产物', publishing: '正在发布…', published: '已发布', publishFailed: '发布失败，请重试',
  session: '当前会话', workspace: '当前工作区', refresh: '刷新', loading: '正在加载…',
  empty: '暂无已发布产物', listFailed: '无法读取产物列表', preview: '预览', previewFailed: '无法预览此产物',
  noPreview: '此文件没有可用预览', truncated: '预览仅显示部分内容', sizeBytes: '{size} 字节',
  download: '下载', more: '加载更多',
} as const

export const en: Record<keyof typeof zh, string> = {
  title: 'Artifacts', guide: 'Published artifacts', guideDescription: 'View and download published files',
  publish: 'Publish artifact', publishing: 'Publishing…', published: 'Published', publishFailed: 'Publishing failed. Try again.',
  session: 'This session', workspace: 'This Workspace', refresh: 'Refresh', loading: 'Loading…',
  empty: 'No published artifacts', listFailed: 'Could not load artifacts', preview: 'Preview', previewFailed: 'Could not preview artifact',
  noPreview: 'No preview is available for this file', truncated: 'Preview shows only part of this file',
  sizeBytes: '{size} bytes', download: 'Download', more: 'Load more',
}

export type ArtifactLocaleKey = keyof typeof zh
