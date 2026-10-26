/** Copy for the fixed sample skill editor; catalog application does not imply project-resource readiness. */
const en = {
  nav: 'Skills', title: 'Sample skill', files: 'Publish the complete SKILL.md and resource.bin files together.',
  open: 'Open an edit', reopen: 'Start a new edit', cancel: 'Cancel edit', publish: 'Publish once',
  markdown: 'Complete SKILL.md', resource: 'Complete resource.bin', opening: 'Reading the current sample…',
  pending: 'Publishing the sample…', present: 'A sample is currently published.', absent: 'No sample is currently published.',
  currentApplied: 'The current sample is applied to the native skill catalog.',
  currentNotApplied: 'The current sample is not applied to the native skill catalog.',
  persisted: 'Persistence: confirmed.', applied: 'Native catalog application: confirmed.',
  notApplied: 'Native catalog application: not confirmed.',
  unavailable: 'This edit could not be opened. Check the current account state before opening another edit.',
  conflict: 'The sample changed after this edit opened. Start a new edit to inspect the current state.',
  unknown: 'Persistence outcome: unknown. Do not repeat this publication; inspect the current state in a new edit.',
  invalid: 'Choose both complete files within the configured byte limit. SKILL.md must contain valid UTF-8 text.',
  resources: 'Resource readiness is separate from publication. No successful skill load is confirmed here.',
  resourcesUnavailable: 'Project resource preparation is unavailable.',
  resourcesOnLoad: 'Project copies are prepared only during an authorized skill load; this does not confirm a successful load.',
}
const zh: Record<keyof typeof en, string> = {
  nav: '技能', title: '示例技能', files: '同时发布完整的 SKILL.md 和 resource.bin 文件。',
  open: '打开一次编辑', reopen: '开始新的编辑', cancel: '取消编辑', publish: '发布一次',
  markdown: '完整 SKILL.md', resource: '完整 resource.bin', opening: '正在读取当前示例…',
  pending: '正在发布示例…', present: '当前已发布一个示例。', absent: '当前未发布示例。',
  currentApplied: '当前示例已应用到原生技能目录。', currentNotApplied: '当前示例尚未应用到原生技能目录。',
  persisted: '持久化：已确认。', applied: '原生目录应用：已确认。', notApplied: '原生目录应用：未确认。',
  unavailable: '无法打开此次编辑，请核对当前账户状态后再打开新的编辑。',
  conflict: '此次编辑打开后示例已变更，请开始新的编辑以核对当前状态。',
  unknown: '持久化结果：未知。请勿重复此次发布，应在新的编辑中核对当前状态。',
  invalid: '请选择字节数不超过配置限制的两份完整文件；SKILL.md 必须是有效的 UTF-8 文本。',
  resources: '资源就绪状态与发布结果分别显示；此处不确认技能已成功加载。',
  resourcesUnavailable: '项目资源准备尚不可用。',
  resourcesOnLoad: '仅在获授权的技能加载期间准备项目副本；此状态不代表加载已成功。',
}
/** Fixed skill-settings namespace. */
export const SKILL_SETTINGS_NAMESPACE = 'cloud-skill-settings'
/** Complete localized copy registered by the existing Cloud dependency fiber. */
export const skillSettingsDictionaries = { en, zh }
/** Local editor copy keys. */
export type SkillSettingsKey = keyof typeof en

declare module '@deepseek-ai/dsh-client-ui-slots' {
  interface LocaleNamespaceMap { 'cloud-skill-settings': SkillSettingsKey }
}
