/** Real authenticated Host mux packets for the native Client's single-opening regression. */
import { randomUUID } from 'node:crypto'
import { once } from 'node:events'
import { writeFile } from 'node:fs/promises'
import WebSocket, { type RawData } from 'ws'
import { Context } from '@deepseek-ai/cordis'
import TypertRegistry from '@deepseek-ai/dsh-typert-registry'
import TypertGateway from '@deepseek-ai/dsh-api-gateway'
import type {} from '@deepseek-ai/dsh-tools'
import { nativeRuntimeEvents } from '../src/host/native-runtime-events.ts'
import { expect, test, vi } from 'vitest'
import { z } from 'zod'
import { nativeHost } from './employee7-native-wire-fixture.ts'

function rawText(data: RawData): string {
  const bytes = Array.isArray(data) ? Buffer.concat(data) : Buffer.isBuffer(data) ? data : Buffer.from(data)
  return bytes.toString('utf8')
}

const item = z.object({ type: z.literal('item'), streamId: z.enum(['control', 'events']), value: z.json() }).strict()
const summary = (sessionId: string, asOfSeq: number, model: string, preset: string) => ({
  sessionId, updatedAt: asOfSeq + 2, agentAvailable: true, running: false, blank: asOfSeq === -1,
  projections: { kind: 'sequenced', asOfSeq, values: {
    modelSelection: { lastUsed: null, next: { provider: 'owned-provider', model, reasoningEffort: 'off' } },
    agentPreset: preset, title: model,
  } },
})

test('native control wire captures empty membership and genuine projection cuts without inventing a sequence', () => nativeHost(async (f) => {
  const oldId = f.sessionId, newId = randomUUID(), foreignId = randomUUID()
  f.platform.sessionItems = [summary(oldId, -1, 'old-model', 'standard')]
  const socket = new WebSocket(f.origin.replace('http:', 'ws:') + '/native/api/remote.mux', {
    headers: { origin: f.origin, authorization: `Bearer ${f.token}` },
  })
  const frames: z.infer<typeof item>[] = [], phases: z.infer<typeof item>[][] = [], transportFailures: unknown[] = []
  socket.on('message', (data) => {
    const frame: unknown = JSON.parse(rawText(data))
    const parsed = item.safeParse(frame)
    if (parsed.success) frames.push(parsed.data)
    else transportFailures.push(frame)
  })
  const native = new Context(), lifetime = new AbortController()
  let events: Promise<void> | undefined, eventFailure: unknown, nativeSourceClosed = false
  const capture = () => { phases.push(frames.splice(0)) }
  const added = (id: string, model: string) => frames.some(frame => frame.streamId === 'events'
    && JSON.stringify(frame.value).includes(id) && JSON.stringify(frame.value).includes(model))
  try {
    await native.plugin(TypertRegistry); await native.plugin(TypertGateway, {})
    // This explicit idle notification provider leaves membership to the actual owned-roster merger.
    native.effect(() => native.typertGateway.registerRemoteEvents(async function* (signal) {
      try { if (!signal.aborted) await once(signal, 'abort') }
      finally { nativeSourceClosed = true }
    }, { home: '/workspace' }))
    const roster = z.object({ items: z.array(z.object({ sessionId: z.string(), running: z.boolean() }).loose()) }).strict()
    events = (async () => {
      try {
        for await (const value of nativeRuntimeEvents(native, async () => roster.parse(
          await f.runtime.call('/native/sessions/list', f.token, {}, lifetime.signal)).items, 10, lifetime.signal)) {
          frames.push(item.parse({ type: 'item', streamId: 'events', value }))
        }
      } catch (error) { if (!lifetime.signal.aborted) throw error }
    })().catch((error: unknown) => { eventFailure = error })
    await once(socket, 'open')
    socket.send(JSON.stringify({ type: 'open', streamId: 'control', endpoint: 'session/control', payload: { args: {} } }))
    await vi.waitFor(() => {
      expect(eventFailure).toBeUndefined()
      expect(frames.some(frame => frame.streamId === 'control')).toBe(true)
      expect(added(oldId, 'old-model')).toBe(true)
    })
    capture()
    for (const [seq, model, preset] of [
      [-1, 'new-model', 'coding'], [-1, 'same-cut-change', 'standard'],
      [0, 'same-cut-change', 'standard'], [1, 'event-model', 'coding'],
    ] as const) {
      const before = f.platform.listReads
      f.platform.sessionItems = [summary(oldId, -1, 'old-model', 'standard'), summary(newId, seq, model, preset)]
      await vi.waitFor(() => { expect(added(newId, model)).toBe(true); expect(f.platform.listReads).toBeGreaterThan(before + 2) },
        { timeout: 5000 })
      capture()
    }
    expect(transportFailures).toEqual([])
    lifetime.abort(); await events
    expect(eventFailure).toBeUndefined(); expect(nativeSourceClosed).toBe(false)
    socket.send(JSON.stringify({ type: 'cancel', streamId: 'control' }))
    socket.close(); await once(socket, 'close')
    const replacement = new WebSocket(f.origin.replace('http:', 'ws:') + '/native/api/remote.mux', {
      headers: { origin: f.origin, authorization: `Bearer ${f.token}` },
    })
    const reopened = new Set<string>(), failures: unknown[] = []
    replacement.on('message', (data) => {
      const frame = z.object({ type: z.string(), streamId: z.string(), value: z.unknown().optional() }).loose()
        .parse(JSON.parse(rawText(data)))
      if (frame.type === 'item') reopened.add(frame.streamId)
      if (frame.type === 'fail') failures.push(frame)
    })
    try {
      await once(replacement, 'open')
      for (const streamId of ['one', 'two', 'three', 'four']) {
        replacement.send(JSON.stringify({ type: 'open', streamId, endpoint: 'session/control', payload: { args: {} } }))
      }
      await vi.waitFor(() => { expect(reopened.size).toBe(4); expect(failures).toEqual([]) })
    } finally { replacement.close(); await once(replacement, 'close') }
    expect(phases.flat().some(frame => JSON.stringify(frame.value).includes(foreignId))).toBe(false)
    await nativeHost(async (other) => {
      other.platform.sessionItems = [summary(foreignId, -1, 'foreign-model', 'standard')]
      const response = await fetch(other.origin + '/native/api/session/list', { method: 'POST',
        headers: { origin: other.origin, authorization: `Bearer ${f.token}`, 'content-type': 'application/json' },
        body: JSON.stringify({ type: 'client-request', rpcId: 'foreign', method: 'session/list', payload: { args: { _request: {} } } }),
      })
      expect(response.status).toBe(401)
      const owned = await fetch(other.origin + '/native/api/session/list', { method: 'POST',
        headers: { origin: other.origin, authorization: `Bearer ${other.token}`, 'content-type': 'application/json' },
        body: JSON.stringify({ type: 'client-request', rpcId: 'owned', method: 'session/list', payload: { args: { _request: {} } } }),
      })
      expect(owned.status).toBe(200)
      const ownedBody = await owned.text()
      expect(ownedBody).toContain(foreignId); expect(ownedBody).not.toContain(oldId); expect(ownedBody).not.toContain(newId)
    })
    const output = process.env['PE_NATIVE_CONTROL_FIXTURE_FILE']
    if (output !== undefined) await writeFile(output, JSON.stringify({ oldId, newId, foreignId, phases }) + '\n')
  } finally {
    lifetime.abort(); await events; await native.fiber.dispose(); expect(nativeSourceClosed).toBe(true)
    if (socket.readyState !== WebSocket.CLOSED) { socket.close(); await once(socket, 'close') }
  }
}), 30_000)
