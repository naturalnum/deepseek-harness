import { TerminalBindings } from '@deepseek-ai/dsh-api-terminal-controller/src/client/bindings.ts'
import { TerminalCloseRequests } from '@deepseek-ai/dsh-api-terminal-controller/src/client/close-requests.ts'
import { preferredShell, rememberShell } from '@deepseek-ai/dsh-api-terminal-controller/src/client/shell-preference.ts'
import type { WebTerminalId } from '@deepseek-ai/dsh-api-terminal-controller/types'
/** Actual native stores share a captured cache port; no global Storage replacement. */
import { expect, it, vi } from 'vitest'
import { createSnapshotStore, defineStore } from '@deepseek-ai/dsh-client-store'
import type { SessionId } from '@deepseek-ai/dsh-session/types'
import { createConversationStore, readConversationDraft, readConversationViewPreference } from '@deepseek-ai/dsh-client-ui-conversation/src/client/stores.ts'
import { createSidebarRightStore } from '@deepseek-ai/dsh-client-ui-sidebar-right/src/client/stores.ts'
import { readSidebarLayout } from '@deepseek-ai/dsh-client-ui-sidebar-right/src/client/persistence.ts'
import { SidebarTabInventory } from '@deepseek-ai/dsh-client-ui-sidebar-right/src/client/tab-inventory.ts'
import { CloudPagePersistence, CloudPersistenceError, type CloudPersistenceLimits } from '../src/client/persistence.ts'

function storage() {
  const data = new Map<string, string>()
  return { data, getItem: (key: string) => data.get(key) ?? null,
    setItem: (key: string, value: string) => { data.set(key, value) }, removeItem: (key: string) => { data.delete(key) } }
}
const limits: CloudPersistenceLimits = {
  maxKeys: 20, maxKeyBytes: 128, maxValueBytes: 8000, maxTotalBytes: 20000, maxNamespaceBytes: 256,
}
const sessionId = 'same-session' as SessionId
function cache(backend: ReturnType<typeof storage>, accountId = 'A', connectionGeneration = 'G1', budget = limits) {
  return new CloudPagePersistence({ storage: backend, expectation: { accountId, connectionGeneration }, limits: budget })
}

it('restores only the same account and opaque generation through native draft, view, selection and sidebar paths', () => {
  const backend = storage(), a = cache(backend), b = cache(backend, 'B'), g2 = cache(backend, 'A', 'G2')
  const conversation = createConversationStore().create(sessionId, a.port)
  conversation.actions.setDraft('private A')
  conversation.actions.setView('trajectory')
  createSnapshotStore({ selected: sessionId }, { persist: { name: 'dsh.sessions.current', storage: a.port } }).set({ selected: sessionId })
  const sidebar = createSidebarRightStore(() => ({ kind: 'guide', title: 'Private A' })).create(sessionId, a.port)
  sidebar.actions.setExpanded(sessionId, true)
  for (const port of [b.port, g2.port]) {
    expect(readConversationDraft(sessionId, port).text).toBe('')
    expect(readConversationViewPreference(sessionId, port)).toBeNull()
    expect(readSidebarLayout(sessionId, port)).toBeUndefined()
    expect(new SidebarTabInventory(port).source.getSnapshot()).toEqual([])
    expect(createSnapshotStore({}, { persist: { name: 'dsh.sessions.current', storage: port } }).getSnapshot()).toEqual({})
    expect(port.keys()).toEqual([])
  }
  const refreshed = cache(backend)
  expect(readConversationDraft(sessionId, refreshed.port).text).toBe('private A')
  expect(readConversationViewPreference(sessionId, refreshed.port)).toBe('trajectory')
  expect(new SidebarTabInventory(refreshed.port).source.getSnapshot()).toHaveLength(1)
  expect(createConversationStore().create(sessionId, refreshed.port).getSnapshot().draft).toBe('private A')
})

it('revokes before cleanup so late generic and sidebar subscriptions cannot recreate keys or delete B', () => {
  const backend = storage(), a = cache(backend), b = cache(backend, 'B')
  const handle = defineStore({ init: () => '', persist: 'draft', actions: { set: (_draft, _value: string) => {} } })
  const old = handle.create(sessionId, a.port)
  const sidebar = createSidebarRightStore(() => ({ kind: 'guide', title: 'A' })).create(sessionId, a.port)
  sidebar.actions.setExpanded(sessionId, true)
  b.port.setItem('draft.same-session', 'B')
  a.revoke()
  a.clear()
  const before = [...backend.data]
  expect(() => { old.store.set('late A') }).toThrow(CloudPersistenceError)
  expect(() => { old.clearPersisted() }).toThrow(CloudPersistenceError)
  const reported = vi.spyOn(console, 'error').mockImplementation(() => {})
  try { sidebar.actions.toggleExpanded(sessionId) } finally { reported.mockRestore() }
  expect(() => { sidebar.clearPersisted() }).toThrow(CloudPersistenceError)
  expect([...backend.data]).toEqual(before)
  expect(b.port.getItem('draft.same-session')).toBe('B')
  expect(a.getSnapshot()).toEqual({ phase: 'revoked', cleanup: 'confirmed', failure: undefined })
})

it('encodes tuple components without delimiter collisions and ignores lost storage notifications', () => {
  const backend = storage()
  const first = cache(backend, 'a:b', 'c'), second = cache(backend, 'a', 'b:c')
  first.port.setItem('same', 'first')
  second.port.setItem('same', 'second')
  expect(first.port.getItem('same')).toBe('first')
  expect(second.port.getItem('same')).toBe('second')
  expect(backend.data.size).toBe(2)
})

it.each([
  ['keys', { maxKeys: 1 }, (port: CloudPagePersistence['port']) => { port.setItem('one', 'a'); port.setItem('two', 'b') }],
  ['key bytes', { maxKeyBytes: 2 }, (port: CloudPagePersistence['port']) => { port.setItem('界', 'a') }],
  ['value bytes', { maxValueBytes: 2 }, (port: CloudPagePersistence['port']) => { port.setItem('one', '界') }],
  ['total bytes', { maxTotalBytes: 80 }, (port: CloudPagePersistence['port']) => { port.setItem('one', 'a'.repeat(60)) }],
] as const)('seals %s budget failures without changing another namespace', (_label, budget, operation) => {
  const backend = storage(), b = cache(backend, 'B')
  b.port.setItem('kept', 'B')
  const before = b.port.getItem('kept')
  const a = cache(backend, 'A', 'G1', { ...limits, ...budget })
  expect(() => { operation(a.port) }).toThrow(CloudPersistenceError)
  expect(a.getSnapshot().phase).toBe('failed')
  expect(() => { a.port.removeItem('one') }).toThrow(CloudPersistenceError)
  expect(b.port.getItem('kept')).toBe(before)
})

it('rejects nonfinite budgets and oversized namespace identity before storage access', () => {
  const backend = storage(), read = vi.spyOn(backend, 'getItem')
  for (const maxKeys of [0, -1, Infinity, NaN, 1.5]) {
    expect(() => cache(backend, 'A', 'G1', { ...limits, maxKeys })).toThrow(CloudPersistenceError)
  }
  expect(() => cache(backend, '界'.repeat(100), 'G1')).toThrow(CloudPersistenceError)
  expect(read).not.toHaveBeenCalled()
})

it('seals unavailable/quota storage and retains unconfirmed cleanup until an owner retry verifies removal', () => {
  const backend = storage(), a = cache(backend)
  const quota = new Error('quota')
  const write = vi.spyOn(backend, 'setItem').mockImplementation(() => { throw quota })
  expect(() => { a.port.setItem('draft', 'A') }).toThrow(CloudPersistenceError)
  expect(a.getSnapshot().failure).toBe('storage-unavailable')
  write.mockRestore()
  const b = cache(backend, 'B')
  b.port.setItem('draft', 'B')
  b.revoke()
  const remove = vi.spyOn(backend, 'removeItem').mockImplementation(() => {})
  expect(() => { b.clear() }).toThrow(CloudPersistenceError)
  expect(b.getSnapshot().cleanup).toBe('unconfirmed')
  remove.mockRestore()
  b.clear()
  expect(b.getSnapshot().cleanup).toBe('confirmed')
})

it('rejects corrupt persisted envelopes and refuses cleanup through an active owner', () => {
  const backend = storage(), a = cache(backend)
  a.port.setItem('draft', 'A')
  const key = [...backend.data.keys()][0]!
  backend.data.set(key, '{')
  expect(() => a.port.keys()).toThrow(CloudPersistenceError)
  expect(a.getSnapshot().failure).toBe('invalid-data')
  expect(() => { cache(storage()).clear() }).toThrow(CloudPersistenceError)
})


it('partitions native terminal recovery, close inventory and shell preferences without changing terminal identities', () => {
  const backend = storage(), a = cache(backend), b = cache(backend, 'B')
  const id = 'terminal-a' as WebTerminalId
  const bindings = new TerminalBindings(a.port)
  bindings.set(sessionId, 'content', id)
  const requests = new TerminalCloseRequests(a.port)
  requests.save({ sessionId, id, title: 'A terminal' })
  rememberShell('/bin/a', a.port)
  expect(new TerminalBindings(b.port).get(sessionId, 'content')).toBeUndefined()
  expect(new TerminalCloseRequests(b.port).pending()).toEqual([])
  expect(preferredShell(b.port)).toBeNull()
  const refreshed = cache(backend)
  expect(new TerminalBindings(refreshed.port).get(sessionId, 'content')).toBe(id)
  expect(new TerminalCloseRequests(refreshed.port).pending()).toEqual([{ sessionId, id, title: 'A terminal' }])
  expect(preferredShell(refreshed.port)).toBe('/bin/a')
  a.revoke()
  a.clear()
  expect(() => { bindings.delete(sessionId, 'content') }).toThrow(CloudPersistenceError)
  expect(() => { requests.remove(id) }).toThrow(CloudPersistenceError)
  expect(() => { rememberShell('/bin/late', a.port) }).toThrow(CloudPersistenceError)
  expect(b.port.keys()).toEqual([])
})

it('seals an unavailable storage read before any native persisted state can be restored', () => {
  const backend = storage(), a = cache(backend)
  const read = vi.spyOn(backend, 'getItem').mockImplementation(() => { throw new Error('storage denied') })
  try {
    expect(() => createSnapshotStore('', { persist: { name: 'draft', storage: a.port } })).toThrow(CloudPersistenceError)
    expect(a.getSnapshot().failure).toBe('storage-unavailable')
  } finally { read.mockRestore() }
})
