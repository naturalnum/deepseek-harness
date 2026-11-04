/** Source-generated Gateway/Cloud API and real private providers; login/Root authority remains a fixture. */
import { mkdtempSync, mkdirSync, realpathSync, rmSync } from 'node:fs'
import { generateKeyPairSync } from 'node:crypto'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { brandString } from '@deepseek-ai/dsh-brand'
import { credentialKey } from '@deepseek-ai/dsh-credentials'
import { CloudAccountFiles } from '@deepseek-ai/dsh-pe-cloud-files'
import type { AccountBinding, AccountUse } from '@deepseek-ai/dsh-pe-cloud-runtime/types'
import type { PeerScope } from '@deepseek-ai/dsh-typert-protocol'
import { expect, it, vi } from 'vitest'
import { descriptors, managementAccount } from './fixtures/remote-servers/account.ts'
import { remoteManagedFixture } from '../../pe-opensandbox/tests/remote-managed-fixture.ts'

it('reads credentials written by the original management action through the native grant provider', async () => {
  const home = realpathSync(mkdtempSync(join(tmpdir(), 'remote-credential-roundtrip-')))
  const root = await remoteManagedFixture(), accounts: Awaited<ReturnType<typeof managementAccount>>[] = []
  const storeCalls = vi.spyOn(CloudAccountFiles.prototype, 'remoteServers')
  const open = async (name: string) => {
    const path = join(home, name); mkdirSync(path)
    const lifetime = new AbortController(), binding: AccountBinding = Object.freeze({
      accountId: brandString<AccountBinding['accountId']>(name), epoch: brandString<AccountBinding['epoch']>('1'),
      recipeVersion: 'credential-roundtrip', lifetime: lifetime.signal })
    const selected: { account?: Awaited<ReturnType<typeof managementAccount>>; peer?: PeerScope } = {}
    const current = (): void => {
      lifetime.signal.throwIfAborted()
      if (selected.account === undefined) throw new Error('Account fixture absent')
      selected.account.api.assertInstalled()
    }
    const account = await managementAccount(path, binding, root, {
      withModelKeyPeerUse(actual, consume) {
        current()
        if (actual !== selected.peer || selected.account === undefined) throw new Error('Foreign fixture Peer')
        const use: AccountUse = { binding, context: selected.account.ctx, assertCurrent: current, release() {} }
        return consume(use, current)
      },
    })
    selected.account = account; accounts.push(account)
    const peer: PeerScope = { id: brandString<PeerScope['id']>('peer-' + name), ctx: account.ctx, principal: { kind: 'owner' },
      interactions: 'answer', signal: lifetime.signal, dispose: () => Promise.resolve() }
    selected.peer = peer
    const result = storeCalls.mock.results.at(-1)
    if (result?.type !== 'return') throw new Error('Original private store was not prepared')
    const store = await result.value
    return { ...account, store, lifetime, peer,
      invoke(request: object, selected = peer) {
        return account.ctx.typertGateway.invoke({ namespace: 'cloudRemoteServers', method: 'action',
          args: { request }, peer: selected })
      } }
  }
  try {
    descriptors(home)
    const a = await open('account-a'), b = await open('account-b')
    await a.invoke({ action: 'add', entry: { alias: 'qa', host: '192.0.2.1', user: 'fixture', port: 2222,
      description: '', tags: [], alwaysAsk: true } })
    const server = a.store.collection.list()[0]!.entry
    const privateKey = generateKeyPairSync('ed25519').privateKey.export({ type: 'pkcs8', format: 'pem' }).toString()
    const knownHosts = '[192.0.2.1]:2222 ssh-ed25519 AAAA\n'
    const request = { action: 'credential', id: server.id, privateKey, knownHosts }
    await expect(a.invoke(request)).resolves.toMatchObject({ servers: [{ configured: true }] })
    let consumed = 0
    await a.store.withCredential(server.id, async (value) => {
      consumed++
      expect(value.privateKey === privateKey && value.knownHosts === knownHosts).toBe(true)
      expect(Object.keys(value).sort()).toEqual(['knownHosts', 'privateKey'])
    })
    expect(consumed).toBe(1)
    const key = credentialKey('remote-server', 'server-' + server.id)
    const record = await a.ctx.credentials.readRecord(key)
    if (record?.kind !== 'grant' || record.payload === null || typeof record.payload !== 'object') throw new Error('Original grant absent')
    expect(Object.keys(record.payload).sort()).toEqual(['knownHosts', 'privateKey', 'version'])
    expect(await b.ctx.credentials.readRecord(key)).toBeUndefined()
    await expect(b.invoke(request)).rejects.toThrow()
    await expect(a.invoke(request, b.peer)).rejects.toThrow()
    await expect(a.invoke({ ...request, privateKey: 'invalid' })).rejects.toThrow()
    await expect(a.invoke({ ...request, accountId: 'account-b' })).rejects.toThrow()
    expect(a.barrier.snapshot().failures).toEqual([])
    expect(b.barrier.snapshot().failures).toEqual([])
    // Original provider accepts JSON grants; the owning reader must still reject incompatible records.
    await a.ctx.credentials.modifyRecord(key, () => Promise.resolve({ kind: 'grant',
      payload: { version: 1, privateKey, knownHosts, action: 'credential' } }))
    await expect(a.store.withCredential(server.id, async () => { consumed++ })).rejects.toThrow('cloud/remote-credential-unavailable')
    expect(consumed).toBe(1)
    await a.invoke(request)
    a.lifetime.abort()
    await expect(a.store.withCredential(server.id, async () => { consumed++ })).rejects.toThrow()
    await expect(a.invoke({ action: 'list' })).rejects.toThrow()
    expect(consumed).toBe(1)
    console.info(JSON.stringify({ evidence: 'remote-api-native-credential-roundtrip', generatedGatewayAndLoader: true,
      nativeGrantProvider: true, exactPersistedFields: 3, credentialConsumerCalled: 1, strictReaderUnchanged: true,
      wrongAccountAndPeerRejected: true, invalidPayloadRejected: true, revokedGenerationRejected: true,
      productionLoginOrSshAcceptance: false }))
  } finally {
    for (const account of accounts) await account.close()
    storeCalls.mockRestore(); await root.close(); rmSync(home, { recursive: true, force: true })
  }
}, 60000)
