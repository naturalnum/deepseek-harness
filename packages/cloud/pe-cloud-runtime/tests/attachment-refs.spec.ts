/** Native cold Session projections; collection checks capacity before deriving the bounded message snapshot. */
import { AttachmentId, type FileAttachmentRef } from '@deepseek-ai/dsh-attachment'
import { createMessage, createUserMessage, type RequestMessage } from '@deepseek-ai/dsh-llm'
import { Session, SessionId } from '@deepseek-ai/dsh-session'
import { expect, it, vi } from 'vitest'
import { createAttachmentRefCollector, type AttachmentRefLimits } from '../src/attachment-refs.ts'

const limits: AttachmentRefLimits = { maxSurfaceNodes: 8192, maxRefs: 16, maxRefBytes: 8192 }
const file = (name: string, bytes = 3): FileAttachmentRef => ({ attachmentId: AttachmentId(`sha256:${'a'.repeat(64)}`), name, bytes })
const user = (...refs: FileAttachmentRef[]) => createUserMessage({ source: { kind: 'user' },
  content: refs.map(attachment => ({ type: 'file' as const, attachment })) })

function coldFixture() {
  const warm = Session.create(SessionId('attachment-ref-history'))
  const old = file('old.bin')
  const event = warm.append('user/message', user(old), { surfaceOp: 'append' })
  const cold = Session.create(warm.id, [event])
  const derive = vi.spyOn(cold, 'deriveMessages')
  return { cold, old, derive }
}

it('includes cold surface history beyond the claimed batch and shares deduplication with final request inputs', () => {
  const f = coldFixture(), current = file('current.bin'), requestOnly = file('request-only.bin')
  const collector = createAttachmentRefCollector(limits)
  collector.addSessionSurface(f.cold)
  collector.addMessages([user(current)])
  const messages: RequestMessage[] = [{ role: 'user', content: [
    { type: 'file', attachment: f.old }, { type: 'file', attachment: requestOnly },
  ] }]
  collector.addMessages(messages)
  expect(collector.finish()).toEqual([f.old, current, requestOnly])
  expect(f.derive).toHaveBeenCalledOnce()
})

it('collects only user file blocks and keeps a detached immutable ref snapshot', () => {
  const ref = file('user.bin')
  const collector = createAttachmentRefCollector(limits)
  collector.addMessages([
    createMessage({ role: 'assistant', source: { kind: 'model', provider: 'fixture', model: 'text' },
      content: [{ type: 'file', attachment: file('assistant.bin') }] }),
    { role: 'user', content: [{ type: 'text', text: 'No attachment' }] },
    { role: 'user', content: [{ type: 'file', attachment: ref }] },
  ])
  const result = collector.finish()
  ref.name = 'changed-after-collection.bin'
  expect(result).toEqual([file('user.bin')])
  expect(Object.isFrozen(result)).toBe(true)
  expect(Object.isFrozen(result[0])).toBe(true)
})

it('deduplicates complete id/name identities and rejects contradictory byte lengths', () => {
  const ref = file('same.bin'), collector = createAttachmentRefCollector(limits)
  collector.addMessages([user(ref, { ...ref }, file('different-name.bin'))])
  expect(collector.finish()).toEqual([ref, file('different-name.bin')])
  expect(() => { collector.addMessages([user({ ...ref, bytes: ref.bytes + 1 })]) })
    .toThrow(expect.objectContaining({ code: 'INVALID_ATTACHMENT_REF' }))
  expect(() => collector.finish()).toThrow(expect.objectContaining({ code: 'cloud/account-unavailable' }))
})

it('rejects excessive surface nodes before deriving a message snapshot', () => {
  const f = coldFixture()
  f.cold.append('user/message', user(file('later.bin')), { surfaceOp: 'append' })
  const collector = createAttachmentRefCollector({ ...limits, maxSurfaceNodes: 1 })
  expect(() => { collector.addSessionSurface(f.cold) }).toThrow(expect.objectContaining({ code: 'cloud/capacity' }))
  expect(f.derive).not.toHaveBeenCalled()
})

it('bounds direct message batches, distinct refs and complete UTF-8 ref metadata', () => {
  const first = file('中文.bin'), cost = Buffer.byteLength(JSON.stringify(first))
  const exact = createAttachmentRefCollector({ ...limits, maxRefBytes: cost })
  exact.addMessages([user(first, { ...first })])
  expect(exact.finish()).toEqual([first])
  const oversized = createAttachmentRefCollector({ ...limits, maxRefBytes: cost - 1 })
  expect(() => { oversized.addMessages([user(first)]) }).toThrow(expect.objectContaining({ code: 'cloud/capacity' }))
  const refs = createAttachmentRefCollector({ ...limits, maxRefs: 1 })
  expect(() => { refs.addMessages([user(first, file('second.bin'))]) }).toThrow(expect.objectContaining({ code: 'cloud/capacity' }))
  const batches = createAttachmentRefCollector({ ...limits, maxSurfaceNodes: 1 })
  expect(() => { batches.addMessages([user(first), user(first)]) }).toThrow(expect.objectContaining({ code: 'cloud/capacity' }))
})
