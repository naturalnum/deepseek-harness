/** Browser acceptance of the actual Servers component against the native authenticated RPC fixture. */
import { randomUUID } from '@deepseek-ai/dsh-util-crypto'
import { useState } from 'react'
import { createRoot } from 'react-dom/client'
import { ServersSection } from '../../../src/client/remote-servers/ServersSection.tsx'
import { remoteServerDictionaries } from '../../../src/client/remote-servers/locales.ts'
import { allowAllAccess, makeTranslate } from '@deepseek-ai/dsh-client-test-runtime'
import type { RemoteServerRequest, RemoteServerReply } from '@deepseek-ai/dsh-pe-cloud-api/types'
import '../../../../../client/ui-theme/src/styles/base.css'
import '../../../../../client/ui-theme/src/styles/design-platform.css'

const unused = (): never => { throw new Error('Unused native slot prop in browser acceptance') }
function Acceptance() {
  const [signedIn, setSignedIn] = useState(false), [error, setError] = useState('')
  const signup = async () => {
    const response = await fetch('/cloud/auth/sign-up/email', { method: 'POST', headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ email: 'browser-' + randomUUID() + '@example.test',
        password: randomUUID() + '-Password1!', name: 'Browser acceptance' }) })
    if (!response.ok) { setError('Fixture authentication failed'); return }
    setSignedIn(true)
  }
  const call = async (request: RemoteServerRequest): Promise<RemoteServerReply> => {
    const response = await fetch('/api/cloudRemoteServers/action', { method: 'POST', headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ type: 'client-request', rpcId: randomUUID(),
        method: 'cloudRemoteServers/action', payload: { args: { request } } }) })
    const wire: unknown = await response.json()
    if (wire === null || typeof wire !== 'object' || !('result' in wire)) throw new Error('Native reply absent')
    const result = wire.result as { ok: boolean; value: RemoteServerReply }
    if (!response.ok || !result.ok) throw new Error('Native management RPC refused')
    return result.value
  }
  if (!signedIn) return <main><p>Isolated browser acceptance · native authentication and management RPC</p>
    <button onClick={() => { void signup() }}>Create acceptance account</button><p role="alert">{error}</p></main>
  return <ServersSection {...allowAllAccess} useSessions={unused} useSessionStatus={unused} useSessionRetainInfo={unused}
    usePanelInfo={unused} useWorkspaces={unused} useResource={unused} scope="browser-fixture" close={() => {}}
    t={makeTranslate(remoteServerDictionaries.zh)} call={call}/>
}
const root = document.getElementById('root')
if (root === null) throw new Error('Browser root absent')
createRoot(root).render(<Acceptance/> )
