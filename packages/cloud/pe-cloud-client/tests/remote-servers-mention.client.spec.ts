/** Native structured-reference source; all calls stay with the original captured page callback. */
import { expect, it } from 'vitest'
import type { SessionId } from '@deepseek-ai/dsh-session/types'
import { brandString } from '@deepseek-ai/dsh-brand'
import { remoteServerMentionSource } from '../src/client/remote-servers/install.ts'
import { remoteServerDictionaries } from '../src/client/remote-servers/locales.ts'
import type { RemoteServerReply, RemoteServerView } from '@deepseek-ai/dsh-pe-cloud-api/types'
const item: RemoteServerView = { entry: { id: 'a', alias: 'fixture', host: '192.0.2.1', user: 'fixture', port: 22,
  description: '', tags: [], alwaysAsk: true }, reference: 'one-generation-reference', configured: true }
const limits = { maxPrivateKeyBytes: 2048, maxKnownHostsBytes: 2048, maxImportBytes: 4096 }

it('serializes only a freshly checked exact reference and refuses stale references instead of falling back to alias text', async () => {
  let active = true, rows = [item]
  const source = remoteServerMentionSource(async () => ({ servers: rows, limits }),
    () => { if (!active) throw new Error('page ended') }, key => remoteServerDictionaries.en[key])
  const session = { sessionId: brandString<SessionId>('native-reference-session') }, signal = new AbortController().signal
  const choices = await source.candidates(session, { query: 'fixture', signal, position: 'inline', drilled: false })
  const candidate = choices[0]!
  const outcome = source.onPick({ candidate, session, position: 'inline', via: 'menu', action: 'pick',
    span: { start: 0, end: 3, draftRev: 1 } })
  expect(outcome).toEqual({ insert: { source: 'cloud-remote-servers', ref: item.reference, label: 'fixture', clipboardText: '@fixture' } })
  expect(await source.codec!.serialize(item.reference,
    signal)).toBe('Remote server reference: {"server":"one-generation-reference","alias":"fixture"}')
  rows = [{ ...item, reference: 'new-generation-reference' }]
  await expect(source.codec!.serialize(item.reference, signal)).rejects.toThrow('stale-server-reference')
  active = false
  await expect(source.candidates(session, { query: '', signal, position: 'inline', drilled: false })).rejects.toThrow('page ended')
})

it('does not offer unconfigured targets or publish a response after its original page ends', async () => {
  let active = true
  const pending = Promise.withResolvers<RemoteServerReply>()
  const source = remoteServerMentionSource(() => pending.promise, () => { if (!active) throw new Error('ended') },
    key => remoteServerDictionaries.en[key])
  const load = source.candidates({ sessionId: brandString<SessionId>('pending-reference') }, { query: '',
    signal: new AbortController().signal, position: 'inline', drilled: false })
  active = false; pending.resolve({ servers: [{ ...item, configured: false }], limits })
  await expect(load).rejects.toThrow('ended')
})
