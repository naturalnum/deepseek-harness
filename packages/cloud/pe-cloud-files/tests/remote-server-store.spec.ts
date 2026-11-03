/** Actual native account-private files and credential records; independent temporary accounts, no deployed ingress claim. */
import { Context } from '@deepseek-ai/cordis'
import Storage from '@deepseek-ai/dsh-storage'
import * as JsonBackend from '@deepseek-ai/dsh-storage-json'
import * as Domains from '@deepseek-ai/dsh-storage-domain'
import Credentials from '@deepseek-ai/dsh-credentials-local'
import { brandString } from '@deepseek-ai/dsh-brand'
import type { AccountBinding } from '@deepseek-ai/dsh-pe-cloud-runtime/types'
import { ConfigSaveCoordinator } from '@deepseek-ai/dsh-pe-cloud-api'
import { generateKeyPairSync } from 'node:crypto'
import { mkdtemp, rm, readFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { expect, it } from 'vitest'
import { openRemoteServerStore } from '../src/remote-server-store.ts'

it('persists each account list and native credential independently without returning secrets and clears the deleted server key', async () => {
  const directory = await mkdtemp(join(tmpdir(), 'remote-private-native-')), contexts: Context[] = []
  const saves = new ConfigSaveCoordinator({ maxAccounts: 4, maxRunning: 2, maxQueued: 8, maxQueuedPerAccount: 4,
    maxTrackedOperations: 16, maxTrackedOperationsPerAccount: 8, maxNestedPerOperation: 8, maxWaitersPerAccount: 8 })
  const key = generateKeyPairSync('ed25519').privateKey.export({ type: 'pkcs8', format: 'pem' }).toString()
  const form = { alias: 'private', host: '127.0.0.1', user: 'fixture', port: 22, description: '', tags: [], alwaysAsk: true }
  const create = async (name: string, epoch: string) => {
    const ctx = new Context(), lifetime = new AbortController(); contexts.push(ctx)
    const binding: AccountBinding = Object.freeze({ accountId: brandString<AccountBinding['accountId']>(name),
      epoch: brandString<AccountBinding['epoch']>(epoch), recipeVersion: 'private-store-native-test', lifetime: lifetime.signal })
    ctx.provide('peAccount', binding)
    await ctx.plugin(Storage); await ctx.plugin(JsonBackend, { root: join(directory, name, 'storage') })
    await ctx.plugin(Domains, { backend: 'json' }); await ctx.plugin(Credentials, { path: join(directory, name,
      'credentials.json'), watch: false })
    const barrier = saves.createAccount(binding)
    const store = await openRemoteServerStore(ctx, binding, { maxServers: 4, maxReplyBytes: 65536, maxCommandBytes: 2048,
      maxPrivateKeyBytes: 2048, maxKnownHostsBytes: 2048, alwaysAsk: false, readOnlyAllowlist: ['hostname'] },
    () => { ctx.fiber.assertActive(); if (ctx.get('peAccount') !== binding) throw new Error('wrong account') },
    () => { lifetime.signal.throwIfAborted() }, task => barrier.admit('remote-server', task))
    return { ctx, store, lifetime, barrier }
  }
  try {
    let a = await create('A', '1')
    const b = await create('B', '1')
    const server = await a.store.mutate(() => a.store.collection.add(form))
    const old = a.store.collection.list()[0]!.reference
    await a.store.mutate(() => a.store.setCredential(server.id, { privateKey: key, knownHosts: 'localhost ssh-ed25519 AAAA\n' }))
    expect(await a.store.configured(server.id)).toBe(true)
    await expect(a.store.mutate(() => a.store.setCredential(server.id, { privateKey: 'invalid-key', knownHosts: 'x' }))).rejects.toThrow()
    expect(a.barrier.snapshot().failures).toEqual([])
    expect(b.store.collection.list()).toEqual([])
    await expect(b.store.withCredential(server.id, async () => 'must-not-run')).rejects.toThrow()
    await expect(b.store.setCredential(server.id, { privateKey: key, knownHosts: 'x' })).rejects.toThrow()
    expect(JSON.stringify(a.store.collection.states())).not.toContain('PRIVATE KEY')
    expect(a.store.collection.list()[0]!.reference).not.toBe(old)
    expect(await a.store.withCredential(server.id, async value => value.privateKey === key)).toBe(true)
    const records = await a.ctx.credentials.listRecords()
    expect(records).toHaveLength(1)
    expect(JSON.stringify(records)).not.toContain(key)
    // The native credential record contains the actual key in the authorized private store, never the server list.
    const persisted = await readFile(join(directory, 'A', 'credentials.json'), 'utf8')
    expect(persisted).toContain('remote-server/server-')
    const oldReference = a.store.collection.list()[0]!.reference
    await a.barrier.stopConfigSaves(Date.now() + 1000); await a.ctx.fiber.dispose(); a.lifetime.abort()
    saves.releaseAccount(a.barrier)
    a = await create('A', '2')
    expect(a.store.collection.list()[0]?.entry).toEqual(server)
    expect(a.store.collection.list()[0]?.reference).not.toBe(oldReference)
    expect(await a.store.withCredential(server.id, async value => value.privateKey === key)).toBe(true)
    await expect(a.store.collection.execute(oldReference, 'hostname', undefined, new AbortController().signal,
      async () => { throw new Error('Stale reference must not execute') })).rejects.toThrow()
    await a.store.mutate(() => a.store.collection.remove(server.id))
    expect(await a.ctx.credentials.listRecords()).toEqual([])
    a.lifetime.abort()
    expect(() => a.store.collection.list()).toThrow()
    await a.barrier.stopConfigSaves(Date.now() + 1000)
    await b.barrier.stopConfigSaves(Date.now() + 1000)
  } finally {
    for (const ctx of contexts) await ctx.fiber.dispose()
    await rm(directory, { recursive: true, force: true })
  }
})
