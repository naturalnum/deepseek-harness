/** Deferred SSH composition retained for historical connector tests; current client entry does not register it. */
import { useEffect, useMemo, useState } from 'react'
import type { PropsLocale, PropsRuntime } from '@deepseek-ai/dsh-client-ui-slots'
import type {} from '@deepseek-ai/dsh-client-ui-plugin-manager/client'
import { PersonalMcpPage } from './PersonalMcpPage.tsx'
import type { PersonalMcpConnectionPort } from './personal-mcp-client.ts'
import type { PersonalMcpSessionSource } from './personal-mcp-session-view.ts'
import { PersonalSshPage } from './PersonalSshPage.tsx'
import type { PersonalSshList, PersonalSshPort } from './ssh-api.ts'
import { StdioV2Panel } from './StdioV2Panel.tsx'
import type { StdioV2Port } from './stdio-v2-api.ts'
import { StdioV2State } from './stdio-v2-state.ts'

/** Native bundle seat, localized text and account-scoped connector APIs. */
export type DeferredConnectorConfigurationProps = PropsRuntime<'plugins.bundle.config'>
  & PropsLocale<'powerEvolve.extensionCenter'> & {
    readonly personalMcp: PersonalMcpConnectionPort
    readonly sessions: PersonalMcpSessionSource
    readonly stdioV2: StdioV2Port
    readonly ssh: PersonalSshPort
    readonly approvalUrl: () => Promise<string>
  }

/** Render connector forms without replacing the native Plugins navigation or bundle controls.
 * @param props Native configuration seat and current account ports.
 * @returns Personal MCP, SSH and cloud STDIO sections.
 */
export function DeferredConnectorConfiguration({
  personalMcp, sessions, stdioV2, ssh, approvalUrl, t,
}: DeferredConnectorConfigurationProps) {
  const state = useMemo(() => new StdioV2State(stdioV2), [stdioV2])
  const [sshData, setSshData] = useState<PersonalSshList>()
  const [failed, setFailed] = useState(false)
  const [revision, reload] = useState(0)
  useEffect(() => {
    const abort = new AbortController()
    setSshData(undefined)
    setFailed(false)
    void ssh.list(abort.signal).then((value) => {
      if (!abort.signal.aborted) setSshData(value)
    }, () => { if (!abort.signal.aborted) setFailed(true) })
    return () => { abort.abort() }
  }, [ssh, revision])
  return <div className="pe-extension-center" data-power-evolve-bundle-config="">
    <section><h3>{t('personalMcpTitle')}</h3><PersonalMcpPage personalMcp={personalMcp} sessions={sessions} t={t} /></section>
    <section><h3>{t('sshMyServers').replace('{count}', String(sshData?.items.length ?? 0))}</h3>
      {failed && <div role="alert">{t('sshLoadFailed')} <button onClick={() => { reload(value => value + 1) }}>{t('retry')}</button></div>}
      {sshData && <PersonalSshPage data={sshData} port={ssh} t={t}
        onChange={(items) => { setSshData({ ...sshData, items }) }} onReload={() => { reload(value => value + 1) }} />}
    </section>
    <section><h3>{t('stdioV2Title')}</h3><StdioV2Panel state={state} sessions={sessions} approvalUrl={approvalUrl} t={t} /></section>
  </div>
}
