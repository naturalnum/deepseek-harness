import assert from 'node:assert/strict'
import { test } from 'node:test'
import type { Context } from '@deepseek-ai/cordis'
import { fillSkillDraft, skillInvocationName } from '../src/client/skill-try.ts'

test('skill trial creates a native session and fills an editable draft without sending it', async () => {
  const events: string[] = []
  const id = '5a010346-693c-4204-a386-29f66b11a057'
  const scope = {}
  const ctx = {
    sessions: {
      create: async () => { events.push('create'); return id },
      using: async (_id: string, _options: object, action: (reference: { sessionId: string }) => void) => {
        events.push('retain'); action({ sessionId: id }); events.push('release')
      },
      scope: () => { events.push('scope'); return scope },
    },
    conversation: { input: { for: (value: object) => {
      assert.equal(value, scope)
      return { setDraft: (prompt: string) => { events.push(`draft:${prompt}`) } }
    } } },
    uiWorkspace: { openSession: (sessionId: string) => { events.push(`open:${sessionId}`) } },
  } as Context
  await fillSkillDraft(ctx, 'Use my skill')
  assert.deepEqual(events, ['create', 'retain', 'scope', 'draft:Use my skill', `open:${id}`, 'release'])
})

test('native skill invocation alias preserves legal names and maps other names to the Host alias', () => {
  const skillId = '5a010346-693c-4204-a386-29f66b11a057'
  assert.equal(skillInvocationName({ skillId, name: 'word' }), 'word')
  assert.equal(skillInvocationName({ skillId, name: 'report-reviewer' }), 'report-reviewer')
  for (const name of ['My Report', 'Word', 'pe-user-skill-fake', 'word_skill', '文档']) {
    assert.equal(skillInvocationName({ skillId, name }), `pe-user-skill-${skillId}`)
  }
})
