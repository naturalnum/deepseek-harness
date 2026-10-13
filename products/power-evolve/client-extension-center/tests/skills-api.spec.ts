import { requestUrl } from './fetch-fixture.ts'
import assert from 'node:assert/strict'
import { createHash } from 'node:crypto'
import { afterEach, test, vi } from 'vitest'
import { SkillHttpClient, SkillHttpError } from '../src/client/skills-api.ts'
import { formatSkillImportBytes, skillImportFileIssue } from '../src/client/skill-import.ts'
import { builtinCatalog as builtinItems, builtinWord } from './builtin-catalog-fixture.ts'

const id = '5a010346-693c-4204-a386-29f66b11a057'
const other = 'd5bb4412-5b5b-4477-8518-d78e79b67146'
const item = { skillId: id, name: 'Proofreading', description: 'Check wording', enabled: true, revision: 1,
  kind: 'text', version: null, digest: 'a'.repeat(64), packageDigest: null,
  manifestDigest: null, observedState: 'ready' }
afterEach(() => { vi.unstubAllGlobals(); vi.restoreAllMocks() })

test('personal skill operations use only same-origin product RPCs and preserve installation identity', async () => {
  const calls: Request[] = []
  const client = new SkillHttpClient(async (input, init) => {
    const request = new Request(new URL(requestUrl(input), 'http://localhost'), init)
    calls.push(request)
    const route = new URL(request.url).pathname
    if (route.endsWith('skillsList')) return Response.json({ items: [item] })
    if (route.endsWith('skillsRead')) return Response.json({ ...item, instructions: '# Instructions\nCheck wording.' })
    if (route.endsWith('skillsInstall')) return Response.json({ ...item, skillId: other })
    if (route.endsWith('skillsRevoke')) return Response.json({ ...item, enabled: false, observedState: 'revoked', revision: 3 })
    return Response.json({ ...item, enabled: false, revision: 2 })
  })
  assert.deepEqual(await client.list(), [item])
  assert.equal((await client.read(id)).instructions, '# Instructions\nCheck wording.')
  const input = { requestId: other, name: 'Proofreading', description: 'Check wording', instructions: 'Check wording.' }
  assert.equal((await client.install(input)).skillId, other)
  assert.equal((await client.toggle(id, false)).enabled, false)
  assert.equal((await client.revoke(id)).observedState, 'revoked')
  assert.deepEqual(calls.map(call => new URL(call.url).pathname), [
    '/api/powerEvolve/skillsList', '/api/powerEvolve/skillsRead',
    '/api/powerEvolve/skillsInstall', '/api/powerEvolve/skillsToggle', '/api/powerEvolve/skillsRevoke',
  ])
  assert(calls.every(call => call.method === 'POST' && call.credentials === 'same-origin'))
  assert.deepEqual(await calls[2]!.json(), { request: input })
  assert.deepEqual(await calls[3]!.json(), { request: { skillId: id, enabled: false } })
  assert.deepEqual(await calls[4]!.json(), { request: { skillId: id } })
})

test('malformed responses and mismatched identities cannot reach the page', async () => {
  const duplicate = new SkillHttpClient(async () => Response.json({ items: [item, item] }))
  await assert.rejects(duplicate.list(), /Invalid skill list/u)
  const wrong = new SkillHttpClient(async () => Response.json({ ...item, skillId: other, instructions: 'Wrong' }))
  await assert.rejects(wrong.read(id), /Invalid skill detail/u)
  const noCall = new SkillHttpClient(async () => { throw new Error('unexpected call') })
  await assert.rejects(noCall.install({ requestId: id, name: ' ', description: 'd', instructions: 'i' }), /Invalid skill installation/u)
})

test('built-in catalog and installation use bounded same-origin product RPCs', async () => {
  const calls: Request[] = []
  const packaged = { ...item, skillId: other, name: builtinWord.name, kind: 'package', version: builtinWord.version,
    packageDigest: builtinWord.archiveDigest, manifestDigest: builtinWord.manifestDigest.slice(7) }
  const client = new SkillHttpClient(async (input, init) => {
    const request = new Request(new URL(requestUrl(input), 'http://localhost'), init)
    calls.push(request)
    return Response.json(request.url.endsWith('skillsCatalog') ? { items: builtinItems } : packaged)
  })
  assert.deepEqual(await client.catalog(), builtinItems)
  const input = { requestId: id, catalogId: builtinWord.id, version: builtinWord.version }
  assert.deepEqual(await client.installBuiltin(input), packaged)
  assert.deepEqual(calls.map(call => new URL(call.url).pathname), [
    '/api/powerEvolve/skillsCatalog', '/api/powerEvolve/skillsInstallBuiltin',
  ])
  assert(calls.every(call => call.method === 'POST' && call.credentials === 'same-origin'))
  assert.deepEqual(await calls[0]!.json(), { request: {} })
  assert.deepEqual(await calls[1]!.json(), { request: input })
})

test('catalog outage and malformed catalog are errors, not a sample catalog', async () => {
  const outage = new SkillHttpClient(async () => Response.json({ error: 'unavailable' }, { status: 503 }))
  await assert.rejects(outage.catalog(), (error: unknown) => error instanceof SkillHttpError && error.status === 503)
  const oversized = new SkillHttpClient(async () => Response.json({ items: Array.from({ length: 10 }, (_, index) => ({
    ...builtinWord, id: `builtin.catalog-${String(index)}`,
  })) }))
  await assert.rejects(oversized.catalog(), /Invalid builtin skill catalog/u)
  const duplicate = new SkillHttpClient(async () => Response.json({ items: [...builtinItems.slice(0, 8), builtinItems[0]] }))
  await assert.rejects(duplicate.catalog(), /Invalid builtin skill catalog/u)
  const badDigest = new SkillHttpClient(async () => Response.json({ items: [
    { ...builtinItems[0], manifestDigest: 'b'.repeat(64) }, ...builtinItems.slice(1),
  ] }))
  await assert.rejects(badDigest.catalog(), /Invalid builtin skill response/u)
  const noCall = new SkillHttpClient(async () => { throw new Error('unexpected request') })
  await assert.rejects(noCall.installBuiltin({ requestId: id, catalogId: '../word', version: '1.0.0' }),
    /Invalid builtin skill installation/u)
  const wrongVersion = new SkillHttpClient(async () => Response.json({ ...item, kind: 'package', version: '2.0.0',
    packageDigest: 'c'.repeat(64), manifestDigest: 'b'.repeat(64) }))
  await assert.rejects(wrongVersion.installBuiltin({ requestId: id, catalogId: builtinWord.id, version: builtinWord.version }),
    /Builtin skill installation response mismatch/u)
})

test('a deployment can expose only PDF or disable its built-in catalog without losing the bounded response checks', async () => {
  const pdf = builtinItems.find(entry => entry.id === 'builtin.pdf')
  assert(pdf)
  for (const items of [[], [pdf], builtinItems.slice(0, 8)]) {
    assert.deepEqual(await new SkillHttpClient(async () => Response.json({ items })).catalog(), items)
  }
})

test('the enabled catalog does not filter installed packages or their historical instructions', async () => {
  const pdf = builtinItems.find(entry => entry.id === 'builtin.pdf')
  assert(pdf)
  const historical = { ...item, name: builtinWord.name, kind: 'package', version: builtinWord.version,
    packageDigest: builtinWord.archiveDigest, manifestDigest: builtinWord.manifestDigest.slice(7) }
  const calls: Request[] = []
  const client = new SkillHttpClient(async (input, init) => {
    const request = new Request(new URL(requestUrl(input), 'http://localhost'), init)
    calls.push(request)
    const route = new URL(request.url).pathname
    if (route.endsWith('skillsCatalog')) return Response.json({ items: [pdf] })
    if (route.endsWith('skillsList')) return Response.json({ items: [historical] })
    return Response.json({ ...historical, instructions: 'Retained Word instructions' })
  })
  assert.deepEqual(await client.catalog(), [pdf])
  assert.deepEqual(await client.list(), [historical])
  assert.deepEqual(await client.read(id), { ...historical, instructions: 'Retained Word instructions' })
  assert.deepEqual(calls.map(call => new URL(call.url).pathname), [
    '/api/powerEvolve/skillsCatalog', '/api/powerEvolve/skillsList', '/api/powerEvolve/skillsRead',
  ])
  assert.deepEqual(await calls[2]?.json(), { request: { skillId: id } })
  assert(calls.every(call => call.method === 'POST' && call.credentials === 'same-origin'))
})

test('personal list accepts 256 entries but rejects 257', async () => {
  const items = Array.from({ length: 256 }, (_, index) => ({ ...item,
    skillId: `00000000-0000-4000-8000-${index.toString(16).padStart(12, '0')}` }))
  const accepted = new SkillHttpClient(async () => Response.json({ items }))
  assert.equal((await accepted.list()).length, 256)
  const rejected = new SkillHttpClient(async () => Response.json({ items: [...items, item] }))
  await assert.rejects(rejected.list(), /Invalid skill list/u)
})

test('HTTP status is retained without exposing private server details', async () => {
  const client = new SkillHttpClient(async () => Response.json({ privateDetail: 'secret' }, { status: 409 }))
  const error: unknown = await client.install({ requestId: id, name: 'x', description: 'd', instructions: 'i' }).catch((value: unknown) => value)
  assert(error instanceof SkillHttpError)
  assert.equal(error.status, 409)
  assert(!String(error).includes('secret'))
})

test('package bytes use a scoped ticket and bypass the Host', async () => {
  const bytes = 'ZIP bytes'
  const digest = createHash('sha256').update(bytes).digest('hex')
  const file = new File([bytes], 'proofreading.zip', { type: 'application/zip' })
  const packaged = { ...item, kind: 'package', version: '1.0.0', packageDigest: digest,
    manifestDigest: 'b'.repeat(64) }
  const calls: Request[] = []
  const client = new SkillHttpClient(async (input, init) => {
    const request = new Request(new URL(requestUrl(input), 'http://localhost'), init)
    calls.push(request)
    if (new URL(request.url).pathname.endsWith('skillsUploadTicket')) {
      return Response.json({ state: 'pending', ticket: 't'.repeat(48),
        uploadUrl: 'https://platform.example/skills/upload', expiresAt: new Date(Date.now() + 60_000).toISOString() })
    }
    return Response.json(packaged, { status: 201 })
  })
  assert.deepEqual(await client.importPackage(file, other), packaged)
  assert.equal(new URL(calls[0]!.url).pathname, '/api/powerEvolve/skillsUploadTicket')
  assert.deepEqual(await calls[0]!.json(), { request: { requestId: other, sizeBytes: file.size, sha256: digest } })
  assert.equal(calls[0]!.credentials, 'same-origin')
  assert.equal(calls[1]!.url, 'https://platform.example/skills/upload')
  assert.equal(calls[1]!.credentials, 'omit')
  assert.equal(calls[1]!.headers.get('authorization'), `Bearer ${'t'.repeat(48)}`)
  assert.equal(calls[1]!.headers.get('content-type'), 'application/zip')
  assert.equal(await calls[1]!.text(), bytes)
})

test('an already committed ticket result needs no second upload', async () => {
  const file = new File(['ZIP bytes'], 'proofreading.skill')
  const digest = createHash('sha256').update('ZIP bytes').digest('hex')
  const packaged = { ...item, kind: 'package', version: `sha256:${digest}`,
    packageDigest: digest, manifestDigest: 'b'.repeat(64) }
  let calls = 0
  const client = new SkillHttpClient(async () => { calls++; return Response.json({ state: 'ready', item: packaged }) })
  assert.deepEqual(await client.importPackage(file, other), packaged)
  assert.equal(calls, 1)
})

test('browser rejects empty, oversized, and wrong suffix before requesting a ticket', async () => {
  assert.equal(skillImportFileIssue({ name: 'empty.zip', size: 0 }), 'empty')
  assert.equal(skillImportFileIssue({ name: 'large.zip', size: 1024 * 1024 + 1 }), 'too-large')
  assert.equal(skillImportFileIssue({ name: 'source.js', size: 10 }), 'invalid-type')
  const client = new SkillHttpClient(async () => { throw new Error('unexpected network request') })
  await assert.rejects(client.importPackage(new File(['source'], 'source.js'), other), /Invalid skill package/u)
})

test.each([null, [], {}, { items: null }])('rejects malformed personal list %j', async (value) => {
  await assert.rejects(new SkillHttpClient(async () => Response.json(value)).list())
})

test.each([null, { skillId: 1 }, { skillId: 'bad' }, { name: '' }, { name: 'x'.repeat(81) }, { description: '' },
  { enabled: 1 }, { revision: 1.5 }, { revision: 0 }, { digest: 1 }, { digest: 'bad' },
  { observedState: 'unknown' }, { observedState: 'revoked', enabled: true }, { version: 'unexpected' },
  { packageDigest: 'a'.repeat(64) }, { manifestDigest: 'a'.repeat(64) }, { kind: 'unknown' },
  { kind: 'package', version: '' }, { kind: 'package', version: '1.0.0', packageDigest: 'bad' },
  { kind: 'package', version: '1.0.0', packageDigest: 'a'.repeat(64), manifestDigest: 'bad' },
])('does not expose a malformed skill record %j', async (patch) => {
  const candidate = patch === null ? null : { ...item, ...patch }
  await assert.rejects(new SkillHttpClient(async () => Response.json({ items: [candidate] })).list())
})

test.each([null, { id: 1 }, { id: '../word' }, { name: '' }, { summary: '' }, { description: '' }, { category: '' },
  { publisher: '' }, { version: 1 }, { version: 'latest' }, { manifestDigest: 1 }, { manifestDigest: 'bad' },
  { archiveDigest: 'bad' }, { archiveSize: 1.5 }, { archiveSize: 0 }, { archiveSize: 1024 * 1024 + 1 }, { installedSkillId: 'bad' },
])('does not offer a malformed catalog release %j', async (patch) => {
  const candidate = patch === null ? null : { ...builtinWord, ...patch }
  await assert.rejects(new SkillHttpClient(async () => Response.json({ items: [candidate, ...builtinItems.slice(1)] })).catalog())
})

test('refuses two catalog entries claiming the same installed identity', async () => {
  const items = builtinItems.map((entry, index) => ({ ...entry, installedSkillId: index < 2 ? id : null }))
  await assert.rejects(new SkillHttpClient(async () => Response.json({ items })).catalog(), /Invalid builtin/u)
})

test('validates IDs and text budgets before transmitting skill mutations', async () => {
  const request = vi.fn<typeof fetch>()
  const client = new SkillHttpClient(request)
  await assert.rejects(client.read('bad')); await assert.rejects(client.toggle('bad', true)); await assert.rejects(client.revoke('bad'))
  for (const input of [{ requestId: 'bad', name: 'n', description: 'd', instructions: 'i' },
    { requestId: id, name: 'n', description: '', instructions: 'i' }, { requestId: id, name: 'n', description: 'd', instructions: '' }]) {
    await assert.rejects(client.install(input))
  }
  await assert.rejects(client.installBuiltin({ requestId: 'bad', catalogId: builtinWord.id,
    version: builtinWord.version }))
  await assert.rejects(client.installBuiltin({ requestId: id, catalogId: builtinWord.id, version: 'latest' }))
  await assert.rejects(client.importPackage(new File(['zip'], 'a.zip'), 'bad'))
  assert.equal(request.mock.calls.length, 0)
})

test('requires complete package instructions and confirms mutation identity and state', async () => {
  const packaged = { ...item, kind: 'package', version: builtinWord.version, packageDigest: builtinWord.archiveDigest, manifestDigest: builtinWord.manifestDigest.slice(7) }
  assert.equal((await new SkillHttpClient(async () => Response.json({ ...packaged, instructions: 'x'.repeat(4097) })).read(id)).instructions.length, 4097)
  await assert.rejects(new SkillHttpClient(async () => Response.json({ ...item, instructions: '' })).read(id))
  await assert.rejects(new SkillHttpClient(async () => Response.json(item)).install({ requestId: other, name: 'n', description: 'd', instructions: 'i' }))
  await assert.rejects(new SkillHttpClient(async () => Response.json(packaged)).install({ requestId: id, name: 'n', description: 'd', instructions: 'i' }))
  for (const result of [{ ...item, skillId: other }, item]) {
    await assert.rejects(new SkillHttpClient(async () => Response.json(result)).toggle(id, false))
    await assert.rejects(new SkillHttpClient(async () => Response.json(result)).revoke(id))
  }
  await assert.rejects(new SkillHttpClient(async () => Response.json(item)).installBuiltin({ requestId: id, catalogId: builtinWord.id,
    version: builtinWord.version }))
  await assert.rejects(new SkillHttpClient(async () => Response.json({ ...packaged, observedState: 'revoked', enabled: false })).installBuiltin({ requestId: id, catalogId: builtinWord.id,
    version: builtinWord.version }))
})

test.each(['plain failure', 'null', '[]', '{}', '{"error":"skill_forbidden"}', '{"error":5}'])('preserves permission status for %s', async (body) => {
  vi.stubGlobal('fetch', async () => new Response(body, { status: 403 }))
  await assert.rejects(new SkillHttpClient().list(), error => error instanceof SkillHttpError && error.status === 403
    && error.code === (body.includes('skill_forbidden') ? 'skill_forbidden' : undefined))
})

const zip = new File(['ZIP bytes'], 'a.skill')
const zipDigest = createHash('sha256').update('ZIP bytes').digest('hex')
const uploaded = { ...item, kind: 'package', version: builtinWord.version, packageDigest: zipDigest, manifestDigest: 'b'.repeat(64) }
const ticket = { state: 'pending', ticket: 't'.repeat(48), uploadUrl: 'https://platform.test/skills/upload', expiresAt: '2026-10-10T00:00:00Z' }
test.each([null, {}, { ...ticket, state: 'unknown' }, { ...ticket, ticket: '' }, { ...ticket, ticket: 'bad!' }, { ...ticket, expiresAt: '' },
  { ...ticket, uploadUrl: '' }, { ...ticket, uploadUrl: 'http://remote.test/skills/upload' }, { ...ticket, uploadUrl: 'https://u:p@platform.test/skills/upload' },
  { ...ticket, uploadUrl: 'https://platform.test/other' }, { ...ticket, uploadUrl: 'https://platform.test/skills/upload?q=1' }, { ...ticket, uploadUrl: 'https://platform.test/skills/upload#fragment' },
  { state: 'ready', item }, { state: 'ready', item: { ...uploaded, packageDigest: 'c'.repeat(64) } },
])('refuses invalid or mismatched upload authorization before sending bytes: %j', async (value) => {
  const request = vi.fn<typeof fetch>(async () => Response.json(value))
  await assert.rejects(new SkillHttpClient(request).importPackage(zip, other))
  assert.equal(request.mock.calls.length, 1)
})

test.each(['https://platform.test/skills/upload', 'http://localhost:1234/skills/upload', 'http://127.0.0.1:1234/skills/upload', 'http://[::1]:1234/skills/upload'])('uploads only with the scoped bearer and requested signal to %s', async (url) => {
  const controller = new AbortController()
  const request = vi.fn<typeof fetch>(async input => Response.json(requestUrl(input).endsWith('skillsUploadTicket') ? { ...ticket, uploadUrl: url } : uploaded))
  await new SkillHttpClient(request).importPackage(zip, other, controller.signal)
  assert.equal(request.mock.calls[1]?.[1]?.signal, controller.signal)
  assert.equal(request.mock.calls[1]?.[1]?.credentials, 'omit')
})

test.each([new Response('{"error":"skill_forbidden"}', { status: 403 }), Response.json(item), Response.json({ ...uploaded, packageDigest: 'c'.repeat(64) })])('refuses a failed or mismatched upload result', async (reply) => {
  const request = vi.fn<typeof fetch>(async input => requestUrl(input).endsWith('skillsUploadTicket') ? Response.json(ticket) : reply)
  await assert.rejects(new SkillHttpClient(request).importPackage(zip, other))
  assert.equal(request.mock.calls.length, 2)
})

test('file validation rejects control characters and counts Unicode names; sizes are presented consistently', () => {
  for (const name of ['', `${'密'.repeat(256)}.zip`, 'bad\u0000.zip', 'bad\u007f.zip']) assert.equal(skillImportFileIssue({ name, size: 1 }), 'invalid-name')
  assert.equal(skillImportFileIssue({ name: '✨.SKILL', size: 1 }), undefined)
  assert.deepEqual([1, 1024, 1024 * 1024].map(formatSkillImportBytes), ['1 B', '1 KiB', '1 MiB'])
})
