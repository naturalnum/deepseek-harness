/** Locale-owned account HTTP MCP settings copy. */
const en = {
  title: 'MCP connections', intro: 'Connect external HTTP MCP services for this account. Their tools are available in chat.',
  empty: 'No MCP services configured.', refresh: 'Refresh', add: 'Add MCP service', edit: 'Edit', remove: 'Remove',
  enable: 'Enable', disable: 'Disable', enabled: 'Enabled', disabled: 'Disabled', save: 'Save', cancel: 'Cancel',
  serverName: 'Server name', url: 'MCP endpoint URL', token: 'Bearer token', headers: 'Additional headers (JSON object)',
  credentialsHint: 'Headers are stored privately. Leave both fields blank when editing to retain the stored headers.',
  headersStored: 'Private headers stored', noHeaders: 'No private headers stored', clearHeaders: 'Clear stored headers',
  timeout: 'Tool timeout (milliseconds)', test: 'Test connection', reachable: 'Connection test succeeded',
  unreachable: 'Connection test failed. Check the endpoint and credentials.', toolCount: '{count} discovered tools',
  pending: 'Applying MCP operation…', failed: 'The MCP operation failed or its outcome could not be confirmed. Refresh before retrying.',
  invalidHeaders: 'Headers must be a JSON object with string values.', loading: 'Loading MCP connections…',
  changed: 'The connections changed while you were editing. Reopen the connection to review the current values before saving.',
  removeConfirm: 'Confirm removal', removeHint: 'Remove this connection and its private headers?',
  httpHint: 'URLs are reached from the cloud server. HTTP and HTTPS are supported; local-process and OAuth connections are not available.',
}
const zh: Record<keyof typeof en, string> = {
  title: 'MCP 连接', intro: '为当前账号配置外部 HTTP MCP 服务，Agent 可在聊天中调用其工具。',
  empty: '尚未配置 MCP 服务。', refresh: '刷新', add: '添加 MCP 服务', edit: '编辑', remove: '移除',
  enable: '启用', disable: '停用', enabled: '已启用', disabled: '已停用', save: '保存', cancel: '取消',
  serverName: '服务名称', url: 'MCP 服务地址', token: 'Bearer Token', headers: '其他请求头（JSON 对象）',
  credentialsHint: '请求头保存在账号私有凭据中。编辑时两项都留空，将保留已保存的请求头。',
  headersStored: '已保存私有请求头', noHeaders: '未保存私有请求头', clearHeaders: '清除已保存的请求头',
  timeout: '工具调用时限（毫秒）', test: '测试连接', reachable: '连接测试成功',
  unreachable: '连接测试失败，请检查服务地址和凭据。', toolCount: '已发现 {count} 个工具',
  pending: '正在应用 MCP 操作…', failed: 'MCP 操作失败或结果尚未确认，请刷新后再试。',
  invalidHeaders: '请求头必须是值为字符串的 JSON 对象。', loading: '正在读取 MCP 连接…',
  changed: '编辑期间连接配置已变化，请重新打开该连接，核对最新值后再保存。',
  removeConfirm: '确认移除', removeHint: '移除此连接及其私有请求头？',
  httpHint: '服务地址由云端服务器访问。支持 HTTP 和 HTTPS，暂不支持本地进程和 OAuth 连接。',
}
/** Native locale namespace for the optional MCP settings entry. */
export const MCP_SETTINGS_NAMESPACE = 'cloud-mcp-settings'
/** Dictionaries registered by the optional settings plugin. */
export const mcpSettingsDictionaries = { en, zh }
/** Locale keys accepted by the native settings contribution. */
export type McpSettingsKey = keyof typeof en
declare module '@deepseek-ai/dsh-client-ui-slots' {
  interface LocaleNamespaceMap { 'cloud-mcp-settings': McpSettingsKey }
}
