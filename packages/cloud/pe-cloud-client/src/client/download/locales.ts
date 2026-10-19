/** Locale-owned copy for native file download actions. */
import type { FileDownloadLabels } from '../FileDownloadButton.tsx'

/** Isolated namespace for the Cloud download action. */
export const DOWNLOAD_NAMESPACE = 'cloud-file-download'
/** Complete English and Chinese download dictionaries. */
export const downloadDictionaries = {
  en: {
    download: 'Download', pending: 'Downloading…', cancel: 'Cancel download', cancelled: 'Download cancelled',
    started: 'Download requested', failed: 'Unable to download. Check the file and try again.',
    tooLarge: 'This file exceeds the download limit.', invalid: 'This file cannot be downloaded.',
  },
  zh: {
    download: '下载', pending: '正在下载…', cancel: '取消下载', cancelled: '下载已取消',
    started: '已请求下载', failed: '无法下载，请检查文件后重试', tooLarge: '文件超过下载大小限制', invalid: '此文件无法下载',
  },
} satisfies Record<'en' | 'zh', FileDownloadLabels>

declare module '@deepseek-ai/dsh-client-ui-slots' {
  interface LocaleNamespaceMap {
    'cloud-file-download': keyof FileDownloadLabels
  }
}
