/** Brand copy owned by the Cloud sidebar contribution. */
const en = { brandName: 'PowerEvolve' }
const zh: typeof en = { brandName: 'PowerEvolve' }
/** Namespace withdrawn with the Cloud brand contribution. */
export const CLOUD_BRAND_NAMESPACE = 'cloud-brand'
/** Complete dictionaries for the Cloud brand name. */
export const cloudBrandDictionaries = { en, zh }
declare module '@deepseek-ai/dsh-client-ui-slots' {
  interface LocaleNamespaceMap { 'cloud-brand': keyof typeof en }
}
