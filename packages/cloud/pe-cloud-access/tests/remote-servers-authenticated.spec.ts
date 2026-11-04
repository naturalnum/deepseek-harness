/** Two real PostgreSQL logins and native RPC over Loader accounts; original Root publication is an explicit fixture capability. */
import { readFileSync } from 'node:fs'
import { randomUUID, generateKeyPairSync } from 'node:crypto'
import { z } from 'zod'
import { expect, it } from 'vitest'
import type { RemoteServerReply, RemoteServerRequest } from '@deepseek-ai/dsh-pe-cloud-api/remote-server-types'
import { remoteAcceptanceServer } from './fixtures/remote-servers/server.ts'

const path = process.env.PE_ACCESS_POSTGRES_CONFIG
const database = z.object({ host: z.string(), port: z.number(), user: z.string(), password: z.string(),
  databases: z.object({ access: z.string() }) })
const form = { alias: 'fixture', host: '192.0.2.1', user: 'fixture', port: 2222, description: 'isolated acceptance',
  tags: ['test'], alwaysAsk: true }

it.skipIf(path === undefined)('keeps CRUD, imports, credential upload and opaque references inside each real authenticated account', async () => {
  const input = database.parse(JSON.parse(readFileSync(path!, 'utf8')))
  const fixture = await remoteAcceptanceServer({ host: input.host, port: input.port, user: input.user,
    password: input.password, database: input.databases.access })
  const signup = async () => {
    const response = await fetch(fixture.url + '/cloud/auth/sign-up/email', { method: 'POST',
      headers: { 'content-type': 'application/json', origin: fixture.url },
      body: JSON.stringify({ email: 'remote-' + randomUUID() + '@example.test',
        password: 'fixture-' + randomUUID() + '-Password1!', name: 'Remote acceptance' }) })
    expect(response.status).toBe(200)
    return response.headers.getSetCookie().map(value => value.split(';')[0]).join('; ')
  }
  const rpc = async (cookie: string, request: RemoteServerRequest | object) => {
    const response = await fetch(fixture.url + '/api/cloudRemoteServers/action', { method: 'POST',
      headers: { 'content-type': 'application/json', cookie, origin: fixture.url },
      body: JSON.stringify({ type: 'client-request', rpcId: randomUUID(), method: 'cloudRemoteServers/action',
        payload: { args: { request } } }) })
    const wire: unknown = await response.json()
    return { status: response.status, wire }
  }
  const value = async (cookie: string, request: RemoteServerRequest): Promise<RemoteServerReply> => {
    const result = await rpc(cookie, request)
    expect(result.status, JSON.stringify(result.wire)).toBe(200)
    const wire = z.object({ result: z.object({ ok: z.literal(true), value: z.unknown() }) }).parse(result.wire)
    const installed = [...fixture.accounts.values()][0]
    const descriptor = installed?.account.ctx.typert.local.get('cloudRemoteServers/action')
    if (descriptor?.result.mode !== 'strict') throw new Error('Original result codec absent')
    return descriptor.result.create().parse(wire.result.value) as RemoteServerReply
  }
  try {
    const a = await signup(), b = await signup()
    expect((await value(a, { action: 'list' })).servers).toEqual([])
    expect((await value(b, { action: 'list' })).servers).toEqual([])
    const added = await value(a, { action: 'add', entry: form }), server = added.servers[0]!
    expect(server.configured).toBe(false)
    expect((await value(b, { action: 'list' })).servers).toEqual([])
    const key = generateKeyPairSync('ed25519').privateKey.export({ type: 'pkcs8', format: 'pem' }).toString()
    const credential = await value(a, { action: 'credential', id: server.entry.id, privateKey: key,
      knownHosts: '[192.0.2.1]:2222 ssh-ed25519 AAAA\n' })
    expect(credential.servers[0]?.configured).toBe(true)
    expect(credential.servers[0]?.reference).not.toBe(server.reference)
    expect(JSON.stringify(credential)).not.toContain(key)
    for (const request of [
      { action: 'list', accountId: server.entry.id }, { action: 'list', path: '/private/credentials' },
      { action: 'execute', command: 'id' }, { action: 'credential', id: server.entry.id, password: 'must-not-accept' },
    ]) {
      const denied = await rpc(a, request)
      expect(JSON.stringify(denied.wire)).not.toContain('"ok":true')
    }
    const foreign = await rpc(b, { action: 'remove', id: server.entry.id })
    expect(JSON.stringify(foreign.wire)).not.toContain('"ok":true')
    expect((await value(a, { action: 'list' })).servers).toHaveLength(1)
    const imported = await value(a, { action: 'import',
      text: 'Host second\n HostName 192.0.2.2\n User fixture\n IdentityFile /never/read/this\n' })
    expect(imported.imported).toBe(1); expect(imported.servers).toHaveLength(2)
    const ids = imported.servers.map(row => row.entry.id).reverse()
    expect((await value(a, { action: 'reorder', ids })).servers.map(row => row.entry.id)).toEqual(ids)
    const invalidImport = await rpc(a, { action: 'import', text: 'Include /private/ssh/*\n' })
    expect(JSON.stringify(invalidImport.wire)).not.toContain('"ok":true')
    expect((await value(a, { action: 'list' })).servers).toHaveLength(2)
    for (const installed of fixture.accounts.values()) expect(installed.account.barrier.snapshot().failures).toEqual([])
    const updated = await value(a, { action: 'update', id: server.entry.id, entry: { ...form, host: '192.0.2.3' } })
    expect(updated.servers.find(row => row.entry.id === server.entry.id)?.reference).not.toBe(credential.servers[0]?.reference)
    const remaining = await value(a, { action: 'remove', id: server.entry.id })
    expect(remaining.servers).toHaveLength(1)
    const aAccount = [...fixture.accounts.values()].find(row => row.account.ctx.get('credentials') !== undefined
      && row.account.ctx.get('peAccount')?.accountId === row.binding.accountId)
    expect(aAccount).toBeDefined()
    // Expire the actual database sessions; the next original authentication read must refuse before RPC dispatch.
    await fixture.pool.query('UPDATE "session" SET "expiresAt" = $1', [new Date(Date.now() - 1000)])
    expect((await rpc(a, { action: 'list' })).status).toBe(401)
    expect(fixture.cleanups).toEqual([])
    console.info(JSON.stringify({ evidence: 'real-two-account-native-management-rpc', authenticatedAccounts: 2,
      accountSelectorRejected: true, keyInReplies: false, invalidRequestsPoisonSaveBarrier: false, expiredLoginRejected: true,
      productionRootQualification: false }))
  } finally { await fixture.close() }
}, 120000)
