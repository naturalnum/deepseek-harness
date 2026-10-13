/** MCP controls rendered inside the official Host bundle page. */
import { useMemo } from 'react'
import type { PropsLocale, PropsRuntime } from '@deepseek-ai/dsh-client-ui-slots'
import type {} from '@deepseek-ai/dsh-client-ui-plugin-manager/client'
import { PersonalMcpPage } from './PersonalMcpPage.tsx'
import type { PersonalMcpConnectionPort } from './personal-mcp-client.ts'
import type { PersonalMcpSessionSource } from './personal-mcp-session-view.ts'
import { StdioV2Panel } from './StdioV2Panel.tsx'
import type { StdioV2Port } from './stdio-v2-api.ts'
import { StdioV2State } from './stdio-v2-state.ts'

/** Native bundle seat, localized text and account-scoped connector APIs. */
export type ConnectorConfigurationProps = PropsRuntime<'plugins.bundle.config'>
  & PropsLocale<'powerEvolve.extensionCenter'> & {
    readonly personalMcp: PersonalMcpConnectionPort
    readonly sessions: PersonalMcpSessionSource
    readonly stdioV2: StdioV2Port
    readonly approvalUrl: () => Promise<string>
  }

/** Render connector forms without replacing the native Plugins navigation or bundle controls.
 * @param props Native configuration seat and current account ports.
 * @returns Personal remote MCP and cloud STDIO sections.
 */
export function ConnectorConfiguration({ personalMcp, sessions, stdioV2, approvalUrl, t }: ConnectorConfigurationProps) {
  const state = useMemo(() => new StdioV2State(stdioV2), [stdioV2])
  return <div className="pe-extension-center" data-power-evolve-bundle-config="">
    <section><h3>{t('personalMcpTitle')}</h3><PersonalMcpPage personalMcp={personalMcp} sessions={sessions} t={t} /></section>
    <section><h3>{t('stdioV2Title')}</h3><StdioV2Panel state={state} sessions={sessions} approvalUrl={approvalUrl} t={t} /></section>
  </div>
}
