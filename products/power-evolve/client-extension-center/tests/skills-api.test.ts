import assert from 'node:assert/strict'
import { createHash } from 'node:crypto'
import { test } from 'node:test'
import { SkillHttpClient, SkillHttpError } from '../src/client/skills-api.ts'
import { skillImportFileIssue } from '../src/client/skill-import.ts'

const id = '5a010346-693c-4204-a386-29f66b11a057'
const other = 'd5bb4412-5b5b-4477-8518-d78e79b67146'
const item = { skillId: id, name: 'Proofreading', description: 'Check wording', enabled: true, revision: 1,
  kind: 'text', version: null, digest: 'a'.repeat(64), packageDigest: null,
  manifestDigest: null, observedState: 'ready' }
const builtinItems = Array.from({ length: 9 }, (_, index) => ({
  id: index === 0 ? 'builtin.word' : `builtin.example-${index}`,
  name: index === 0 ? 'word' : `Skill ${index}`, summary: `Summary ${index}`,
  description: `Description ${index}`, category: 'office', publisher: 'PowerEvolve',
  version: '1.0.0', manifestDigest: `sha256:${'b'.repeat(64)}`,
  archiveDigest: 'c'.repeat(64), archiveSize: 100, installedSkillId: null,
}))

test('personal skill operations use only same-origin product RPCs and preserve installation identity', async () => {
  const calls: Request[] = []
  const client = new SkillHttpClient(async (input, init) => {
    const request = new Request(new URL(String(input), 'http://localhost'), init)
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
  const packaged = { ...item, skillId: other, name: 'word', kind: 'package', version: '1.0.0',
    packageDigest: 'c'.repeat(64), manifestDigest: 'b'.repeat(64) }
  const client = new SkillHttpClient(async (input, init) => {
    const request = new Request(new URL(String(input), 'http://localhost'), init)
    calls.push(request)
    return Response.json(request.url.endsWith('skillsCatalog') ? { items: builtinItems } : packaged)
  })
  assert.deepEqual(await client.catalog(), builtinItems)
  const input = { requestId: id, catalogId: 'builtin.word', version: '1.0.0' }
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
  const short = new SkillHttpClient(async () => Response.json({ items: builtinItems.slice(0, 8) }))
  await assert.rejects(short.catalog(), /Invalid builtin skill catalog/u)
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
  await assert.rejects(wrongVersion.installBuiltin({ requestId: id, catalogId: 'builtin.word', version: '1.0.0' }),
    /Builtin skill installation response mismatch/u)
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
  const error = await client.install({ requestId: id, name: 'x', description: 'd', instructions: 'i' }).catch(value => value)
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
    const request = new Request(new URL(String(input), 'http://localhost'), init)
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
