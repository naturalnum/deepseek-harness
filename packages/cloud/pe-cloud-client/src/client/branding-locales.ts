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

/** Original running copy, owned and withdrawn with the Cloud brand contribution. */
const runningEN = { running: 'Processing', runningFor: 'Processing for {duration}…' }
const runningZH = { running: '处理中', runningFor: '处理中，用时 {duration}…' } satisfies typeof runningEN
const runningJA = { running: '深掘り中', runningFor: '{duration} の間深く分析中 ···' } satisfies typeof runningEN
const runningES = { running: 'Razonamiento profundo', runningFor: 'Razonando a fondo durante {duration} ···' } satisfies typeof runningEN
const runningFR = { running: 'Réflexion approfondie', runningFor: 'Réflexion approfondie depuis {duration} ···' } satisfies typeof runningEN
const runningDE = { running: 'Gründliches Nachdenken', runningFor: 'Gründliches Nachdenken seit {duration} ···' } satisfies typeof runningEN
const runningRU = { running: 'Глубокое размышление', runningFor: 'Глубокое размышление в течение {duration} ···' } satisfies typeof runningEN
const runningPT = { running: 'Raciocínio profundo', runningFor: 'Raciocínio profundo há {duration} ···' } satisfies typeof runningEN
export const CLOUD_RUNNING_NAMESPACE = 'cloud-running-status'
export const cloudRunningDictionaries = {
  en: runningEN, zh: runningZH, ja: runningJA, es: runningES,
  fr: runningFR, de: runningDE, ru: runningRU, pt: runningPT,
}
declare module '@deepseek-ai/dsh-client-ui-slots' {
  interface LocaleNamespaceMap { 'cloud-running-status': keyof typeof runningEN }
}
