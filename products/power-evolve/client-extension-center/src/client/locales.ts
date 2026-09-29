export const NS = 'powerEvolve.extensionCenter'

export const zh = {
  skillsNav: '技能', skillsTitle: '技能', mySkills: '我的技能', installSkill: '安装技能',
  searchMySkills: '搜索我的技能', resultCount: '共 {count} 项', viewDetails: '查看详情',
  enabledState: '已启用', disabledState: '已停用', enable: '启用技能',
  mySkillsEmpty: '当前账号还没有安装技能', searchEmpty: '没有找到符合条件的技能',
  nextTaskHint: '安装、启用或停用只影响之后受理的任务；已经受理的任务保持原有技能选择。',
  refreshList: '刷新列表', loading: '正在读取技能…', loadFailed: '技能列表暂不可用，请重试。',
  detailFailed: '无法读取技能说明，请重试。', skillDetails: '技能详情', skillDocument: '技能说明',
  skillDocumentEmpty: '技能说明为空。', retry: '重试', close: '关闭', cancel: '取消',
  installTitle: '安装文本技能', name: '名称', description: '简介', instructions: '技能说明',
  installHint: '输入仅含说明文字的个人技能；新任务会读取已启用的技能。',
  installing: '正在安装…', installed: '技能已安装。', retryInstall: '重试安装',
  installUncertain: '安装结果尚不确定。重试会使用同一个请求编号。',
  nameConflict: '已有同名技能，或请求编号与已有内容冲突。',
  skillLimit: '最多可安装 8 项个人技能。',
  sessionExpired: '登录已失效，请重新登录。',
  skillMissing: '此技能不存在或当前账号无权访问。请刷新列表。',
  toggleFailed: '无法更改技能状态，请重试。',
  revision: '状态修订 {count}',
} satisfies Record<string, string>

export type ExtensionCenterLocaleKey = keyof typeof zh

export const en = {
  skillsNav: 'Skills', skillsTitle: 'Skills', mySkills: 'My skills', installSkill: 'Install skill',
  searchMySkills: 'Search my skills', resultCount: '{count} results', viewDetails: 'View details',
  enabledState: 'Enabled', disabledState: 'Disabled', enable: 'Enable skill',
  mySkillsEmpty: 'No skills are installed for this account', searchEmpty: 'No matching skills',
  nextTaskHint: 'Installing, enabling, or disabling affects future tasks. Accepted tasks keep their skill selection.',
  refreshList: 'Refresh list', loading: 'Loading skills…', loadFailed: 'Could not load skills. Please retry.',
  detailFailed: 'Could not read the skill instructions. Please retry.', skillDetails: 'Skill details', skillDocument: 'Skill instructions',
  skillDocumentEmpty: 'The skill instructions are empty.', retry: 'Retry', close: 'Close', cancel: 'Cancel',
  installTitle: 'Install text skill', name: 'Name', description: 'Description', instructions: 'Skill instructions',
  installHint: 'Enter a personal text skill. New tasks can read skills that are enabled.',
  installing: 'Installing…', installed: 'Skill installed.', retryInstall: 'Retry installation',
  installUncertain: 'The installation result is uncertain. Retry will use the same request ID.',
  nameConflict: 'A skill with this name exists, or the request ID conflicts with existing content.',
  skillLimit: 'You can install up to 8 personal skills.',
  sessionExpired: 'Your sign-in expired. Please sign in again.',
  skillMissing: 'This skill is unavailable to your account. Refresh the list.',
  toggleFailed: 'Could not change the skill state. Please retry.',
  revision: 'State revision {count}',
} satisfies Record<ExtensionCenterLocaleKey, string>
