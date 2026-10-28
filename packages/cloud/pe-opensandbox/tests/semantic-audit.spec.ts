/** Private semantic delivery tests; none qualifies external physical completion or recovery. */
import { channel } from 'node:diagnostics_channel'
import { createServer } from 'node:http'
import { afterEach, expect, it, vi } from 'vitest'
import { PrivateSemanticAudit, type SemanticAuditEvent } from '../src/semantic-audit.ts'
import { createOwnedSdkTransport } from '../src/sdk-transport.ts'

const bus = channel('dsh:pe-opensandbox:semantic:v1')
const dispose: (() => void)[] = []
afterEach(() => { for (const cleanup of dispose.splice(0)) cleanup() })
function collect(receipt = true) {
  const events: SemanticAuditEvent[] = []
  const listener = (message: unknown): void => {
    const event = message as SemanticAuditEvent
    events.push(event)
    if (receipt) event.receipt()
  }
  bus.subscribe(listener); dispose.push(() => { bus.unsubscribe(listener) })
  return events
}

it('returns the original Promise and emits no reactions or events without a subscriber', async () => {
  const audit = new PrivateSemanticAudit(), original = Promise.resolve(7), then = vi.spyOn(original, 'then')
  const span = audit.begin('transport-fetch')
  expect(span).toBeUndefined(); expect(audit.watch(span, original)).toBe(original)
  expect(then).not.toHaveBeenCalled(); expect(await original).toBe(7)
})

it('records actual fulfilled and rejected settlement without wrapping or exposing failure text', async () => {
  const events = collect(), audit = new PrivateSemanticAudit(), pending = Promise.withResolvers<number>()
  const span = audit.begin('sdk-create', { sandboxId: 'original-id' })
  expect(audit.watch(span, pending.promise)).toBe(pending.promise)
  expect(events.map(event => event.phase)).toEqual(['start'])
  pending.resolve(9); await pending.promise
  expect(events.at(-1)?.outcome).toBe('fulfilled')
  const failure = new Error('NEVER_EXPOSE_PRIVATE_HEADER_TOKEN_BODY')
  const rejected = Promise.reject<number>(failure)
  expect(audit.watch(audit.begin('sdk-prepare'), rejected)).toBe(rejected)
  await expect(rejected).rejects.toBe(failure)
  expect(events.at(-1)?.outcome).toBe('rejected')
  expect(JSON.stringify(events)).not.toContain(failure.message)
  expect(JSON.stringify(events)).not.toContain('original-id')
  expect(events[0]?.fields.sandboxIdSha256).toMatch(/^[a-f0-9]{64}$/)
  expect(Object.isFrozen(events[0])).toBe(true); expect(Object.isFrozen(events[0]?.fields)).toBe(true)
  expect(events.map(event => event.sequence)).toEqual([1, 2, 3, 4])
})

it('missing, duplicate or lost receipts persistently taint that owner without changing business settlement', async () => {
  const events = collect(false), audit = new PrivateSemanticAudit(), original = Promise.resolve('unchanged')
  const span = audit.begin('transport-fetch')
  expect(audit.watch(span, original)).toBe(original); expect(await original).toBe('unchanged')
  expect(events.at(-1)?.tainted).toBe(true)
  expect(events.at(-1)?.outcome).toBe('fulfilled')
  const other = new PrivateSemanticAudit()
  const duplicate = (message: unknown): void => { const event = message as SemanticAuditEvent; event.receipt(); event.receipt() }
  bus.subscribe(duplicate)
  other.begin('transport-fetch'); other.point('sdk-root-fence', { fenced: true })
  bus.unsubscribe(duplicate)
  expect(events.at(-1)?.tainted).toBe(true)
})

it('final metadata failure produces no fabricated end and taints the next delivered event', async () => {
  const events = collect(), audit = new PrivateSemanticAudit(), original = Promise.resolve()
  void audit.watch(audit.begin('sdk-stop'), original, () => { throw new Error('PRIVATE') })
  await original
  audit.point('sdk-root-fence', { fenced: true })
  expect(events.filter(event => event.phase === 'end')).toHaveLength(0)
  expect(events.at(-1)?.tainted).toBe(true)
  expect(JSON.stringify(events)).not.toContain('PRIVATE')
})

it('publisher failure cannot replace the original result or produce a clean subsequent event', async () => {
  const events = collect(), audit = new PrivateSemanticAudit(), original = Promise.resolve('retained')
  const publication = vi.spyOn(bus, 'publish').mockImplementationOnce(() => { throw new Error('PRIVATE_PUBLISHER') })
  const span = audit.begin('transport-fetch')
  publication.mockRestore()
  expect(audit.watch(span, original)).toBe(original); expect(await original).toBe('retained')
  expect(events.at(-1)?.tainted).toBe(true)
  expect(JSON.stringify(events)).not.toContain('PRIVATE_PUBLISHER')
})

it('subscriber disappearance and oversized identities cannot silently yield clean evidence', async () => {
  const events = collect(), audit = new PrivateSemanticAudit(), original = Promise.resolve()
  const facts = { sandboxId: 's'.repeat(100000), method: 'PRIVATE_HEADER_TOKEN', token: 'PRIVATE_HEADER_TOKEN' }
  const span = audit.begin('transport-fetch', facts)
  expect(JSON.stringify(events[0]?.fields).length).toBeLessThan(200)
  expect(JSON.stringify(events)).not.toContain('PRIVATE_HEADER_TOKEN')
  dispose.pop()?.()
  void audit.watch(span, original); await original
  const later = collect()
  audit.point('sdk-root-fence', { fenced: true })
  expect(later.at(-1)?.tainted).toBe(true)
})

it('observes fetch before deferred body serialization and ends only after the original complete Response', async () => {
  const events = collect(), entered = Promise.withResolvers<undefined>(), release = Promise.withResolvers<undefined>()
  const server = createServer((request, response) => {
    void (async () => {
      for await (const _chunk of request) { /* Only this local HTTP fixture consumes the request. */ }
      entered.resolve(undefined); await release.promise
      response.writeHead(202); response.write('retained-'); response.end('bytes')
    })().catch((error: unknown) => { response.destroy(error instanceof Error ? error : new Error('Local fixture failed.')) })
  })
  await new Promise<void>((resolve) => { server.listen(0, '127.0.0.1', resolve) })
  const address = server.address()
  if (address === null || typeof address === 'string') throw new Error('Missing local address.')
  const transport = createOwnedSdkTransport({ connections: 1, connectTimeoutMs: 1000, headersTimeoutMs: 1000,
    bodyTimeoutMs: 1000, keepAliveTimeoutMs: 1000, maxHeaderBytes: 8192, maxRequestBytes: 8192, maxResponseBytes: 8192 })
  let closed = false
  try {
    const actual = transport.fetch(`http://127.0.0.1:${address.port}/sandboxes`, { method: 'POST', body: 'PRIVATE_BODY',
      headers: { 'x-private-token': 'PRIVATE_HEADER' } })
    expect(events.find(event => event.operation === 'transport-fetch')?.phase).toBe('start')
    await entered.promise
    expect(events.filter(event => event.operation === 'transport-fetch' && event.phase === 'end')).toHaveLength(0)
    release.resolve(undefined); const response = await actual
    expect(await response.text()).toBe('retained-bytes')
    expect(events.find(event => event.operation === 'transport-fetch' && event.phase === 'end')?.fields.statusCode).toBe(202)
    expect(JSON.stringify(events)).not.toMatch(/PRIVATE_BODY|PRIVATE_HEADER/)
    await transport.close()
    closed = true
    expect(events.find(event => event.operation === 'transport-close' && event.phase === 'end')?.outcome).toBe('fulfilled')
  } finally {
    release.resolve(undefined); if (!closed) await transport.close(); server.closeAllConnections()
    await new Promise<void>((resolve) => { server.close(() => { resolve() }) })
  }
})
