/** Localized copy for Cloud project creation, with identical keys in both dictionaries. */
/** Title form copy owned by the cloud-projects namespace. */
export type CloudProjectKey = 'title' | 'name' | 'create' | 'cancel' | 'pending' | 'unknown' | 'invalid'

declare module '@deepseek-ai/dsh-client-ui-slots' {
  interface LocaleNamespaceMap {
    'cloud-projects': CloudProjectKey
  }
}

/** Complete locale-owned title form dictionaries. */
export const projectDictionaries: Record<'en' | 'zh', Record<CloudProjectKey, string>> = {
  en: { title: 'Create project', name: 'Project name', create: 'Create', cancel: 'Cancel',
    pending: 'Creating project…', invalid: 'Project name is too long. Use a shorter name.',
    unknown: 'The creation result is unknown. Refresh the page and check your projects before trying again.' },
  zh: { title: '创建项目', name: '项目名称', create: '创建', cancel: '取消',
    pending: '正在创建项目…', invalid: '项目名称过长，请缩短名称', unknown: '创建结果未确认，请刷新页面检查项目后再决定是否重试' },
}
