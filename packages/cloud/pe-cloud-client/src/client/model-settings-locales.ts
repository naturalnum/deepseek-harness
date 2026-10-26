/** Localized native model-key operation outcomes; server diagnostics are never rendered. */
const en = {
  unavailable: 'The key operation could not be confirmed. Check its current state before editing again.',
  conflict: 'The key changed after this editor opened. Open a new edit to continue.',
}
const zh: Record<keyof typeof en, string> = {
  unavailable: '无法确认此次密钥操作。请核对当前状态后重新编辑。',
  conflict: '此编辑器打开后密钥已变更，请重新打开编辑。',
}

/** Exact Models integration copy keys. */
export type ModelSettingsKey = keyof typeof en
/** Locale namespace for Cloud key outcomes. */
export const MODEL_SETTINGS_NAMESPACE = 'cloud-model-settings'
/** Complete locale dictionaries registered by the original Cloud dependency fiber. */
export const modelSettingsDictionaries = { en, zh }

declare module '@deepseek-ai/dsh-client-ui-slots' {
  interface LocaleNamespaceMap {
    /** Cloud-native key save/refusal copy. */
    'cloud-model-settings': ModelSettingsKey
  }
}
