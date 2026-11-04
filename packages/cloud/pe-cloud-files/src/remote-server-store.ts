/** Account-private server metadata and credentials over original native providers; no executable or Host path selection. */
import { AsyncLocalStorage } from 'node:async_hooks'
import { brandString } from '@deepseek-ai/dsh-brand'
import { createPrivateKey } from 'node:crypto'
import { z } from 'zod'
import type { Context } from '@deepseek-ai/cordis'
import { credentialKey } from '@deepseek-ai/dsh-credentials'
import type { CredentialProvider } from '@deepseek-ai/dsh-credentials'
import { defineDomain } from '@deepseek-ai/dsh-storage-domain'
import type { AccountBinding } from '@deepseek-ai/dsh-pe-cloud-runtime/types'
import { AccountRemoteServers, remoteServerRecord, type RemoteServer, type ServerId } from '@deepseek-ai/dsh-remote-server-cloud'

/** Explicit credential/input bounds, bounded again by the unchanged managed range carrier. */
export interface RemoteStoreLimits {
  readonly maxServers: number
  readonly maxReplyBytes: number
  readonly maxCommandBytes: number
  readonly maxPrivateKeyBytes: number
  readonly maxKnownHostsBytes: number
  readonly alwaysAsk: boolean
  readonly readOnlyAllowlist: readonly string[]
}
/** Private, short-lived input consumed by the original managed execution provider; never a Remote result. */
export interface RemoteCredential { readonly privateKey: string; readonly knownHosts: string }
const credential = z.strictObject({ version: z.literal(1), privateKey: z.string(), knownHosts: z.string() })
function unavailable(): never { throw new Error('cloud/remote-credential-unavailable') }

/** Reject encrypted or invalid keys without invoking an ambient SSH client or returning parser details.
 * @param value Uploaded key.
 * @param maxBytes Account upload bound.
 */
export function validateRemotePrivateKey(value: string, maxBytes: number): void {
  if (!value || Buffer.byteLength(value) > maxBytes || value.includes('\0')) unavailable()
  try {
    if (value.startsWith('-----BEGIN OPENSSH PRIVATE KEY-----')) {
      const body = Buffer.from(value.replace(/-----[^\n]+-----/g, '').replace(/\s/g, ''), 'base64')
      const magic = Buffer.from('openssh-key-v1\0')
      if (!body.subarray(0, magic.length).equals(magic) || body.length < magic.length + 8) unavailable()
      const size = body.readUInt32BE(magic.length)
      if (size !== 4 || body.subarray(magic.length + 4, magic.length + 8).toString() !== 'none') unavailable()
    } else { createPrivateKey(value) }
  } catch (_error) { unavailable() }
}

/** Open only the original account backend, preserving the domain's actual close operation.
 * @param ctx Account provider scope with native private storage/credentials.
 * @param binding Original installed binding.
 * @param limits Deployment-owned finite input policy.
 * @param mounted Original files/API graph installation check, valid during restore.
 * @param current Original business admission, used by every operation after restore.
 * @param submit Original account save barrier; retains failures and actual writes beyond observer cancellation.
 * @returns Private owner and its browser-safe collection; no key read method is exported over RPC.
 */
export async function openRemoteServerStore(ctx: Context, binding: AccountBinding, limits: RemoteStoreLimits,
  mounted: () => void, current: () => void, submit: <T>(work: () => Promise<T>) => Promise<T>): Promise<AccountRemoteServerStore> {
  mounted()
  const facility = ctx.get('storageDomain'), provider: CredentialProvider | undefined = ctx.get('credentials')
  if (facility === undefined || provider === undefined || ctx.get('peAccount') !== binding) unavailable()
  for (const n of [limits.maxServers, limits.maxCommandBytes, limits.maxPrivateKeyBytes, limits.maxKnownHostsBytes]) {
    if (!Number.isSafeInteger(n) || n < 1 || n > 65536) unavailable()
  }
  const spec = defineDomain({ name: 'cloud_remote_server_accounts', version: 1,
    global: { schema: z.strictObject({ accountId: z.string(), servers: z.array(remoteServerRecord).max(limits.maxServers) }),
      initial: { accountId: String(binding.accountId), servers: [] } }, tables: {} })
  const domain = await facility.open(spec)
  ctx.effect(() => () => domain.close(), 'pe-cloud-files: close account-private remote metadata')
  mounted()
  if (domain.global.get().accountId !== binding.accountId) unavailable()
  const check = (): void => {
    mounted(); current()
    if (binding.lifetime.aborted || ctx.get('credentials') === undefined
      || domain.global.get().accountId !== binding.accountId) unavailable()
  }
  const mutation = new AsyncLocalStorage<{ submitted: boolean }>()
  ctx.effect(() => () => { mutation.disable() }, 'pe-cloud-files: withdraw remote save scope')
  const submitted = (): void => { const scope = mutation.getStore(); if (scope === undefined) unavailable(); scope.submitted = true }
  const key = (id: ServerId) => credentialKey('remote-server', 'server-' + id)
  const collection = new AccountRemoteServers(ctx, binding, {
    maxServers: limits.maxServers, maxCommandBytes: limits.maxCommandBytes,
    policy: { alwaysAsk: limits.alwaysAsk, readOnlyAllowlist: limits.readOnlyAllowlist }, assertCurrent: check,
    read: () => domain.global.get().servers.map(entry => ({ ...entry, id: brandString<ServerId>(entry.id) })),
    write: async (servers: readonly RemoteServer[]) => {
      check()
      const minimumReply = { servers: servers.map(entry => ({ entry, reference: '0'.repeat(36), configured: false, factsOmitted: true,
        connectivity: { reachable: false, checkedAt: '9999-12-31T23:59:59.999Z', failure: 'unknown' } })),
      limits: { maxPrivateKeyBytes: limits.maxPrivateKeyBytes, maxKnownHostsBytes: limits.maxKnownHostsBytes, maxImportBytes: 65536 } }
      if (Buffer.byteLength(JSON.stringify(minimumReply)) > limits.maxReplyBytes - 1024) throw new Error('cloud/remote-list-too-large')
      submitted(); await domain.global.set({ accountId: String(binding.accountId), servers: [...servers] }); check()
    },
    deleteCredential: async (id) => { check(); submitted(); await provider.deleteRecord(key(id)); check() },
  })
  const exists = (id: string): ServerId => {
    check()
    const server = collection.list().find(row => row.entry.id === id)
    if (server === undefined) unavailable()
    return server.entry.id
  }
  return {
    collection,
    /** Original save owner serializes complete metadata/credential mutations together. */
    mutate: async <T>(work: () => Promise<T>): Promise<T> => {
      const result = await submit(() => mutation.run({ submitted: false }, async () => {
        const scope = mutation.getStore()
        if (scope === undefined) unavailable()
        try { check(); const value = await work(); check(); return { ok: true as const, value } }
        catch (error) { if (scope.submitted) throw error; return { ok: false as const, error } }
      }))
      if (!result.ok) throw result.error
      return result.value
    },
    async configured(id: string): Promise<boolean> {
      const selected = exists(id), value = await provider.describeRecord(key(selected)); check()
      return value.configured
    },
    async setCredential(id: string, value: RemoteCredential): Promise<void> {
      const selected = exists(id)
      validateRemotePrivateKey(value.privateKey, limits.maxPrivateKeyBytes)
      if (!value.knownHosts || Buffer.byteLength(value.knownHosts) > limits.maxKnownHostsBytes
        || /[\0\r]/.test(value.knownHosts)) unavailable()
      const target = collection.list().find(row => row.entry.id === selected)?.entry
      if (target === undefined) unavailable()
      if (Buffer.byteLength(JSON.stringify({ ...value, host: target.host, user: target.user, port: target.port,
        connect: 60, probe: true })) > 4096) unavailable()
      collection.revokeCredential(selected)
      submitted()
      await provider.modifyRecord(key(selected),
        () => { check(); exists(selected); return Promise.resolve({ kind: 'grant' as const,
          payload: { version: 1, privateKey: value.privateKey, knownHosts: value.knownHosts } }) })
      check()
    },
    async withCredential<T>(id: ServerId, consume: (value: RemoteCredential) => Promise<T>): Promise<T> {
      exists(id)
      const record = await provider.readRecord(key(id)); check()
      if (record?.kind !== 'grant') unavailable()
      const result = credential.safeParse(record.payload)
      if (!result.success) unavailable()
      validateRemotePrivateKey(result.data.privateKey, limits.maxPrivateKeyBytes)
      if (Buffer.byteLength(result.data.knownHosts) > limits.maxKnownHostsBytes) unavailable()
      exists(id)
      return consume({ privateKey: result.data.privateKey, knownHosts: result.data.knownHosts })
    },
  }
}
/** Private preparation result; contains no serialized identity or browser authority. */
export interface AccountRemoteServerStore {
  readonly collection: AccountRemoteServers
  readonly mutate: <T>(work: () => Promise<T>) => Promise<T>
  readonly configured: (id: string) => Promise<boolean>
  readonly setCredential: (id: string, value: RemoteCredential) => Promise<void>
  readonly withCredential: <T>(id: ServerId, consume: (value: RemoteCredential) => Promise<T>) => Promise<T>
}
