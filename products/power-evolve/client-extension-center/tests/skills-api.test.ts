import assert from 'node:assert/strict'
import { test } from 'node:test'
import { SkillHttpClient, SkillHttpError } from '../src/client/skills-api.ts'

const id = '5a010346-693c-4204-a386-29f66b11a057'
const other = 'd5bb4412-5b5b-4477-8518-d78e79b67146'
const item = { skillId: id, name: 'Proofreading', description: 'Check wording', enabled: true, revision: 1 }

test('personal skill operations use only same-origin product RPCs and preserve installation identity', async () => {
  const calls: Request[] = []
  const client = new SkillHttpClient(async (input, init) => {
    const request = new Request(new URL(String(input), 'http://localhost'), init)
    calls.push(request)
    const route = new URL(request.url).pathname
    if (route.endsWith('skillsList')) return Response.json({ items: [item] })
    if (route.endsWith('skillsRead')) return Response.json({ ...item, instructions: '# Instructions\nCheck wording.' })
    if (route.endsWith('skillsInstall')) return Response.json({ ...item, skillId: other })
    return Response.json({ ...item, enabled: false, revision: 2 })
  })
  assert.deepEqual(await client.list(), [item])
  assert.equal((await client.read(id)).instructions, '# Instructions\nCheck wording.')
  const input = { requestId: other, name: 'Proofreading', description: 'Check wording', instructions: 'Check wording.' }
  assert.equal((await client.install(input)).skillId, other)
  assert.equal((await client.toggle(id, false)).enabled, false)
  assert.deepEqual(calls.map(call => new URL(call.url).pathname), [
    '/api/powerEvolve/skillsList', '/api/powerEvolve/skillsRead',
    '/api/powerEvolve/skillsInstall', '/api/powerEvolve/skillsToggle',
  ])
  assert(calls.every(call => call.method === 'POST' && call.credentials === 'same-origin'))
  assert.deepEqual(await calls[2]!.json(), { request: input })
  assert.deepEqual(await calls[3]!.json(), { request: { skillId: id, enabled: false } })
})

test('malformed responses and mismatched identities cannot reach the page', async () => {
  const duplicate = new SkillHttpClient(async () => Response.json({ items: [item, item] }))
  await assert.rejects(duplicate.list(), /Invalid skill list/u)
  const wrong = new SkillHttpClient(async () => Response.json({ ...item, skillId: other, instructions: 'Wrong' }))
  await assert.rejects(wrong.read(id), /Invalid skill detail/u)
  const noCall = new SkillHttpClient(async () => { throw new Error('unexpected call') })
  await assert.rejects(noCall.install({ requestId: id, name: ' ', description: 'd', instructions: 'i' }), /Invalid skill installation/u)
})

test('HTTP status is retained without exposing private server details', async () => {
  const client = new SkillHttpClient(async () => Response.json({ privateDetail: 'secret' }, { status: 409 }))
  const error = await client.install({ requestId: id, name: 'x', description: 'd', instructions: 'i' }).catch(value => value)
  assert(error instanceof SkillHttpError)
  assert.equal(error.status, 409)
  assert(!String(error).includes('secret'))
})
