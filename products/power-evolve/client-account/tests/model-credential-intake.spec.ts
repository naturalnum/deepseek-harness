/** Browser intake keeps raw keys off Host metadata and reconciles the original uncertain upload. */
import { expect, onTestFinished, test, vi } from 'vitest'
import { ModelCredentialIntake } from '../src/client/model-credential-intake.ts'
import { bodyText, jsonRecord, jsonValue, requestUrl } from './fetch-fixture.ts'

function fixture(options: { uploadFailure?: boolean; receiptSaved?: boolean; draft?: boolean; uploadUrl?: string } = {}) {
  const metadata: { route: string; request: Record<string, unknown> }[] = [], uploaded: { value: string; init: RequestInit }[] = []
  const changed = vi.fn()
  let saved = options.receiptSaved ?? true
  const request: typeof fetch = async (url, init) => {
    const route = requestUrl(url)
    if (route.startsWith('/api/powerEvolve/')) {
      const input = jsonRecord(jsonRecord(jsonValue(bodyText(init?.body))).request)
      metadata.push({ route, request: input })
      if (route.endsWith('/modelCredentialReceipt')) return Response.json({ saved })
      return Response.json({ requestId: input.requestId, ticket: 't'.repeat(64),
        uploadUrl: options.uploadUrl ?? 'https://platform.example/model-credentials/upload', expiresAt: '2099-01-01T00:00:00.000Z' })
    }
    if (!(init?.body instanceof Uint8Array)) throw new Error('Expected the original browser byte body')
    uploaded.push({ value: new TextDecoder().decode(init.body), init })
    if (options.uploadFailure) throw new TypeError('Network response lost')
    return Response.json(options.draft ? { saved: false, models: [{ id: 'draft-model', inputModalities: ['text', 'image'] }] } : { saved: true })
  }
  const intake = new ModelCredentialIntake(() => Promise.resolve('https://platform.example'),
    () => ({ failed: 'failed', uncertain: 'uncertain' }), request, changed)
  onTestFinished(() => intake.close())
  return { intake, metadata, uploaded, changed, setSaved(value: boolean) { saved = value } }
}

test('sends only ticket metadata through Host and exact UTF-8 bytes directly to Platform', async () => {
  const f = fixture()
  expect(await f.intake.storeCredential('OWNED_API_KEY', '  owned-private-key  ')).toBeUndefined()
  expect(f.metadata).toHaveLength(1)
  expect(f.metadata[0]?.request).toMatchObject({ ref: 'OWNED_API_KEY', sizeBytes: 17 })
  expect(f.metadata[0]?.request.requestId).toMatch(/^[a-f0-9-]{36}$/u)
  expect(JSON.stringify(f.metadata)).not.toContain('owned-private-key')
  expect(f.uploaded).toHaveLength(1)
  expect(f.uploaded[0]?.value).toBe('owned-private-key')
  expect(f.uploaded[0]?.init).toMatchObject({ credentials: 'omit', redirect: 'error', referrerPolicy: 'no-referrer',
    headers: { authorization: `Bearer ${'t'.repeat(64)}`, 'content-type': 'application/octet-stream' } })
  expect(f.changed).toHaveBeenCalledTimes(1)
})

test('draft discovery carries endpoint metadata in the ticket and keeps its one-shot key out of Host', async () => {
  const f = fixture({ draft: true })
  expect(await f.intake.discoverModels('llm-pi-ai', { api: 'openai-completions', baseURL: 'https://provider.example/v1', apiKey: 'draft-private-key' }))
    .toEqual({ kind: 'found', models: [{ id: 'draft-model', inputModalities: ['text', 'image'] }] })
  expect(f.metadata[0]?.request).toMatchObject({ ref: 'MODEL_DISCOVERY_API_KEY', sizeBytes: 17,
    discovery: { settingsNs: 'llm-pi-ai', api: 'openai-completions', baseURL: 'https://provider.example/v1' } })
  expect(JSON.stringify(f.metadata)).not.toContain('draft-private-key')
  expect(JSON.stringify(f.metadata)).not.toContain('apiKey')
  expect(f.uploaded[0]?.value).toBe('draft-private-key')
  expect(f.changed).not.toHaveBeenCalled()
})

test('a lost upload response reads its original receipt and never resends key bytes', async () => {
  const f = fixture({ uploadFailure: true })
  expect(await f.intake.storeCredential('OWNED_API_KEY', 'key')).toBeUndefined()
  expect(f.metadata).toHaveLength(2)
  expect(f.metadata[1]?.request).toEqual({ requestId: f.metadata[0]?.request.requestId })
  expect(f.uploaded).toHaveLength(1)
})

test('an unresolved upload retries only its original receipt until its outcome is confirmed', async () => {
  const f = fixture({ uploadFailure: true, receiptSaved: false })
  expect(await f.intake.storeCredential('OWNED_API_KEY', 'key')).toBe('uncertain')
  expect(await f.intake.storeCredential('OWNED_API_KEY', 'key')).toBe('uncertain')
  expect(f.uploaded).toHaveLength(1)
  expect(f.metadata.filter(row => row.route.endsWith('Ticket'))).toHaveLength(1)
  f.setSaved(true)
  expect(await f.intake.storeCredential('OWNED_API_KEY', 'key')).toBeUndefined()
  expect(f.uploaded).toHaveLength(1)
  expect(new Set(f.metadata.map(row => row.request.requestId)).size).toBe(1)
})

test.each(['https://untrusted.example/model-credentials/upload', 'https://platform.example/unexpected',
  'https://platform.example/model-credentials/upload?token=unsafe', 'https://name:secret@platform.example/model-credentials/upload'])
('rejects an unexpected upload authority before sending any key: %s', async (uploadUrl) => {
  const f = fixture({ uploadUrl })
  expect(await f.intake.storeCredential('OWNED_API_KEY', 'key')).toBe('failed')
  expect(f.uploaded).toHaveLength(0)
})

test('two browser owners retain independent pending receipt identities', async () => {
  const alice = fixture({ uploadFailure: true, receiptSaved: false }), bob = fixture()
  expect(await alice.intake.storeCredential('SAME_REF', 'alice-key')).toBe('uncertain')
  expect(await bob.intake.storeCredential('SAME_REF', 'bob-key')).toBeUndefined()
  expect(alice.metadata[0]?.request.requestId).not.toBe(bob.metadata[0]?.request.requestId)
  expect(alice.uploaded[0]?.value).toBe('alice-key'); expect(bob.uploaded[0]?.value).toBe('bob-key')
  expect(JSON.stringify([...alice.metadata, ...bob.metadata])).not.toMatch(/alice-key|bob-key/u)
})

test('shutdown aborts and joins an accepted metadata request and prevents later dispatch', async () => {
  const started = Promise.withResolvers<undefined>(), changed = vi.fn(); let calls = 0
  const transport: typeof fetch = async (_url, init) => {
    calls++; started.resolve(undefined)
    return new Promise((_resolve, reject) => {
      init?.signal?.addEventListener('abort', () => { reject(new Error('Owned request aborted')) }, { once: true })
    })
  }
  const intake = new ModelCredentialIntake(() => Promise.resolve('https://platform.example'), () => ({ failed: 'failed', uncertain: 'uncertain' }), transport, changed)
  const operation = intake.storeCredential('OWNED_API_KEY', 'key')
  await started.promise; await intake.close(); await operation
  expect(await intake.storeCredential('OWNED_API_KEY', 'key')).toBe('failed')
  expect(calls).toBe(1); expect(changed).not.toHaveBeenCalled()
})
