/** Locale-owned copy for the native development-service task row. */
export const SERVICE_PREVIEW_NAMESPACE = 'cloud-service-preview'

/** Complete row and action labels. */
export const servicePreviewDictionaries = {
  en: { title: 'Development service', pending: 'In progress', completed: 'Process observation', failed: 'Action failed',
    open: 'Open controlled preview' },
  zh: { title: '开发服务', pending: '处理中', completed: '进程状态', failed: '操作失败', open: '打开受控预览' },
} satisfies Record<'en' | 'zh', Record<ServicePreviewKey, string>>

/** All visible copy for this feature. */
export type ServicePreviewKey = 'title' | 'pending' | 'completed' | 'failed' | 'open'

declare module '@deepseek-ai/dsh-client-ui-slots' {
  interface LocaleNamespaceMap {
    'cloud-service-preview': ServicePreviewKey
  }
}
