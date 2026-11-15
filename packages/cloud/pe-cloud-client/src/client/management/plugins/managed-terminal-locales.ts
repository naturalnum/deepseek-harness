/** Managed Shell copy belongs to the account page, preserving every existing language. */
const en = {
  maxTimeoutMs: 'Maximum command timeout (ms)',
  maxTimeoutMsHint: 'The maximum timeout any command can request.',
  managedOutputHint: 'Maximum output retained per stream by this managed executor.',
}
const zh: Record<keyof typeof en, string> = {
  maxTimeoutMs: '命令超时上限（毫秒）',
  maxTimeoutMsHint: '单条命令可以请求的最大超时时间。',
  managedOutputHint: '受管执行器为每个输出流保留的最大字节数。',
}
const ja: Record<keyof typeof en, string> = {
  maxTimeoutMs: 'コマンドの最大タイムアウト (ms)',
  maxTimeoutMsHint: '各コマンドが要求できる最大タイムアウト。',
  managedOutputHint: 'この管理対象実行環境がストリームごとに保持する最大出力量。',
}
const es: Record<keyof typeof en, string> = {
  maxTimeoutMs: 'Tiempo de espera máximo del comando (ms)',
  maxTimeoutMsHint: 'El tiempo de espera máximo que puede solicitar un comando.',
  managedOutputHint: 'Salida máxima retenida por flujo por este ejecutor administrado.',
}
const fr: Record<keyof typeof en, string> = {
  maxTimeoutMs: 'Délai maximal des commandes (ms)',
  maxTimeoutMsHint: 'Le délai maximal qu’une commande peut demander.',
  managedOutputHint: 'Sortie maximale conservée par flux par cet exécuteur géré.',
}
const de: Record<keyof typeof en, string> = {
  maxTimeoutMs: 'Maximales Befehlszeitlimit (ms)',
  maxTimeoutMsHint: 'Das maximale Zeitlimit, das ein Befehl anfordern kann.',
  managedOutputHint: 'Maximale Ausgabemenge, die diese verwaltete Ausführung pro Stream aufbewahrt.',
}
const ru: Record<keyof typeof en, string> = {
  maxTimeoutMs: 'Максимальное время ожидания команды (мс)',
  maxTimeoutMsHint: 'Максимальное время ожидания, которое может запросить команда.',
  managedOutputHint: 'Максимальный объём вывода, сохраняемый этим управляемым исполнителем для каждого потока.',
}
const pt: Record<keyof typeof en, string> = {
  maxTimeoutMs: 'Tempo limite máximo do comando (ms)',
  maxTimeoutMsHint: 'O tempo limite máximo que um comando pode solicitar.',
  managedOutputHint: 'Saída máxima retida por fluxo por este executor gerido.',
}
/** Dictionary owned by the active Cloud plugin catalog. */
export const MANAGED_TERMINAL_NAMESPACE = 'cloud-managed-terminal'
/** Exact managed limit labels and hints, kept outside Native defaults. */
export const managedTerminalDictionaries = { en, zh, ja, es, fr, de, ru, pt }

declare module '@deepseek-ai/dsh-client-ui-slots' {
  interface LocaleNamespaceMap { 'cloud-managed-terminal': keyof typeof en }
}
