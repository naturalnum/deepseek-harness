/** Original Cloud key-control copy and explicit provider presentation; no credential or settings I/O. */
import type { Context } from '@deepseek-ai/cordis'
import type { ModelsProviderEditorLayout } from '@deepseek-ai/dsh-client-ui-settings-models/client'

import { modelCredentialCopy } from './locales/model-credentials.ts'
export { modelCredentialCopy }

/** Display data belongs to this Cloud dictionary and never enters the Native editing contract. */
type ModelCredentialCopy = { readonly [K in keyof typeof modelCredentialCopy.en]: string }


/**
 * Read original display text through the current Native root locale, with the original English before locale is available.
 * @param root - Original page root; the callback reads only its public locale.
 * @returns Display data for this render, without I/O or mutation authority.
 */
export function modelCredentialCopyFor(root: Context | undefined): ModelCredentialCopy {
  const locale = root?.get('locale')
  const text = (key: keyof ModelCredentialCopy): string => locale?.resolveText({
    en: modelCredentialCopy.en[key],
    zh: modelCredentialCopy.zh[key],
    ja: modelCredentialCopy.ja[key],
    es: modelCredentialCopy.es[key],
    fr: modelCredentialCopy.fr[key],
    de: modelCredentialCopy.de[key],
    ru: modelCredentialCopy.ru[key],
    pt: modelCredentialCopy.pt[key],
  }) ?? modelCredentialCopy.en[key]
  return {
    editKey: text('editKey'),
    removeKey: text('removeKey'),
    removeKeyTitle: text('removeKeyTitle'),
    removeKeyDescription: text('removeKeyDescription'),
    removingKey: text('removingKey'),
    keyPreparing: text('keyPreparing'),
    keyEditUnavailable: text('keyEditUnavailable'),
  }
}

/**
 * Choose display layout for the original Cloud model provider, preserving other Native namespace defaults.
 * @param provider - Original provider id from its admitted metadata row.
 * @returns Explicit Native layout data, or undefined for its existing default.
 */
export function cloudModelEditorLayout(provider: string): ModelsProviderEditorLayout | undefined {
  return provider === 'deepseek-official' ? 'deepseek' : undefined
}
