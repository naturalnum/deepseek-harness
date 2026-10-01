/** Locale-owned publication and execution-file copy for native artifact surfaces. */
/** Simplified Chinese artifact labels. */
export const zh = {
  title: '产物', guide: '已发布产物', guideDescription: '查看和下载已发布的文件',
  publish: '发布为产物', publishing: '正在发布…', published: '已发布', publishFailed: '发布失败，请重试',
  session: '当前会话', workspace: '当前工作区', refresh: '刷新', loading: '正在加载…',
  empty: '暂无已发布产物', listFailed: '无法读取产物列表', preview: '预览', previewFailed: '无法预览此产物',
  noPreview: '此文件没有可用预览', truncated: '预览仅显示部分内容', sizeBytes: '{size} 字节',
  download: '下载', more: '加载更多',
  producedTitle: '执行产物', publishDownload: '发布并下载', showMoreFiles: '显示更多文件',
  factsPending: '正在核验执行文件…', factsFailed: '无法读取执行文件，请刷新重试',
  factsEmpty: '此次扫描没有核验到新增或修改的文件', factsPartial: '仅显示已核验的文件；扫描或核验未完整完成',
  sourceChanged: '源文件已变化，此版本无法发布',
  budget_exceeded: '扫描达到文件或大小限制', excluded_paths: '部分路径未纳入扫描',
  read_failed: '部分文件无法读取', changed_during_scan: '部分文件在扫描时变化',
  scan_unavailable: '扫描结果不可用', verification_failed: '部分文件未通过核验',
  legacy_runner: '此次执行没有可用的文件扫描结果', execution_unavailable: '此次执行的文件事实不可用',
} as const

/** English artifact labels with the same keys as Chinese. */
export const en: Record<keyof typeof zh, string> = {
  title: 'Artifacts', guide: 'Published artifacts', guideDescription: 'View and download published files',
  publish: 'Publish artifact', publishing: 'Publishing…', published: 'Published', publishFailed: 'Publishing failed. Try again.',
  session: 'This session', workspace: 'This Workspace', refresh: 'Refresh', loading: 'Loading…',
  empty: 'No published artifacts', listFailed: 'Could not load artifacts', preview: 'Preview', previewFailed: 'Could not preview artifact',
  noPreview: 'No preview is available for this file', truncated: 'Preview shows only part of this file',
  sizeBytes: '{size} bytes', download: 'Download', more: 'Load more',
  producedTitle: 'Execution files', publishDownload: 'Publish and download', showMoreFiles: 'Show more files',
  factsPending: 'Verifying execution files…', factsFailed: 'Could not read execution files. Refresh to retry.',
  factsEmpty: 'This scan verified no new or changed files', factsPartial: 'Only verified files are shown; scanning or verification was incomplete',
  sourceChanged: 'The source file changed. This version cannot be published.',
  budget_exceeded: 'The scan reached its file or size limit', excluded_paths: 'Some paths were excluded from scanning',
  read_failed: 'Some files could not be read', changed_during_scan: 'Some files changed during scanning',
  scan_unavailable: 'Scan results are unavailable', verification_failed: 'Some files could not be verified',
  legacy_runner: 'This execution has no available file scan', execution_unavailable: 'File facts are unavailable for this execution',
}

/** Keys accepted by the artifact locale namespace. */
export type ArtifactLocaleKey = keyof typeof zh
