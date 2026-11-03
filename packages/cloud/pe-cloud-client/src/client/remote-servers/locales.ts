/** Locale-owned copy for account server management and structured mentions. */
const en = {
  hostname: 'Hostname', os: 'Operating system', kernel: 'Kernel', arch: 'Architecture', cpuModel: 'CPU', cpuCores: 'CPU cores',
  memTotalKb: 'Memory total (KiB)', memAvailableKb: 'Memory available (KiB)', diskTotalKb: 'Disk total (KiB)',
  diskAvailableKb: 'Disk available (KiB)', uptimeSeconds: 'Uptime (seconds)', collectedAt: 'Collected at',
  title: 'Servers', intro: 'Manage your account’s SSH servers. Authentication uses uploaded keys.',
  add: 'Add server', edit: 'Edit', remove: 'Remove', save: 'Save', cancel: 'Cancel', refresh: 'Refresh state',
  alias: 'Alias', host: 'Host', user: 'SSH username', port: 'Port', description: 'Description', tags: 'Tags (comma separated)',
  alwaysAsk: 'Always ask before running commands', up: 'Move up', down: 'Move down', empty: 'No servers registered',
  factsOmitted: 'Facts exceed this account’s response limit. Read a smaller result in chat.',
  unknown: 'Not checked', reachable: 'Reachable', unreachable: 'Connection failed', keyStored: 'Key stored', keyNeeded: 'SSH key required',
  key: 'Private key file', knownHosts: 'Verified known_hosts file', upload: 'Store SSH credentials', import: 'Import SSH config file',
  failed: 'Operation is unconfirmed. Refresh the saved state before trying again.',
  chooseFiles: 'Choose both the private key and verified known_hosts files.',
  chatHint: 'In a chat, type @ and select a configured server. Ask to check its information or run a command. Refresh this page to read the resulting facts.',
  importHint: 'Import literal Host, HostName, User and Port entries. Local key paths are discarded; include, proxy and forwarding directives are refused.',
  credentialsHint: 'Only unencrypted SSH keys are supported. Key contents stay private to this account and are never sent to the model.',
  approvalHint: 'Always-ask and high-risk commands use the existing approval flow. Native never policy refuses them; choose an existing permission setting that permits asking.',
  noPick: 'Configure a server and its key in Settings → Servers', pending: 'Working…', facts: 'Observed machine facts',
}
const zh: Record<keyof typeof en, string> = {
  hostname: '主机名', os: '操作系统', kernel: '内核', arch: '架构', cpuModel: 'CPU', cpuCores: 'CPU 核数',
  memTotalKb: '内存总量（KiB）', memAvailableKb: '可用内存（KiB）', diskTotalKb: '磁盘总量（KiB）',
  diskAvailableKb: '可用磁盘（KiB）', uptimeSeconds: '运行时间（秒）', collectedAt: '采集时间',
  title: '服务器', intro: '管理当前账户的 SSH 服务器，使用上传的密钥认证。', add: '添加服务器', edit: '编辑', remove: '删除',
  save: '保存', cancel: '取消', refresh: '刷新状态', alias: '别名', host: '主机', user: 'SSH 用户名', port: '端口',
  description: '说明', tags: '标签（逗号分隔）', alwaysAsk: '执行命令前始终询问', up: '上移', down: '下移', empty: '尚未登记服务器',
  factsOmitted: '机器信息超出当前账户响应上限，请在聊天中读取较小的结果。',
  unknown: '尚未检查', reachable: '可连接', unreachable: '连接失败', keyStored: '已保存密钥', keyNeeded: '需要 SSH 密钥',
  key: '私钥文件', knownHosts: '已核实的 known_hosts 文件', upload: '保存 SSH 凭据', import: '导入 SSH 配置文件',
  failed: '操作结果尚未确认，请先刷新已保存的状态再重试。', chooseFiles: '请选择私钥和已核实的 known_hosts 两个文件。',
  chatHint: '在聊天中输入 @，选择已配置的服务器，再要求检查服务器信息或执行命令。刷新本页可查看执行后采集的事实。',
  importHint: '导入明确的 Host、HostName、User、Port 配置。本机密钥路径会被丢弃；Include、代理及转发指令会被拒绝。',
  credentialsHint: '仅支持未加密的 SSH 密钥。私钥仅供当前账户使用，不会发送给模型。',
  approvalHint: '始终询问及高风险命令沿用现有审批。原生 never 策略会拒绝此类调用，请选择现有允许询问的权限设置。',
  noPick: '请在设置 → 服务器中配置服务器及密钥', pending: '正在处理…', facts: '实际采集的机器信息',
}
/** Typed namespace and paired dictionaries. */
export const REMOTE_SERVERS_NAMESPACE = 'cloud-remote-servers'
/** Paired locale-owned UI copy. */
export const remoteServerDictionaries = { en, zh }
/** Keys accepted by the native locale lookup. */
export type RemoteServersKey = keyof typeof en
declare module '@deepseek-ai/dsh-client-ui-slots' { interface LocaleNamespaceMap { 'cloud-remote-servers': RemoteServersKey } }
