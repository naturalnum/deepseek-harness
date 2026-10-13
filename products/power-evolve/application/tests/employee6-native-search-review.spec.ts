/** Official search helpers expose the boundary between event-local scans and current-surface search. */
import { randomUUID } from 'node:crypto'
import { Session, SessionId, SessionSeq, type SessionEvent } from '@deepseek-ai/dsh-session'
import { createAssistantMessage, createUserMessage, ToolCallId } from '@deepseek-ai/dsh-llm'
import { buildSessionEventSearchDocuments } from '../../../../packages/session-query/session-query/src/documents.ts'
import { extractSessionEventText } from '../../../../packages/session-query/session-query/src/extraction.ts'
import { compileSessionTextFilter, filterSessionEventDocuments } from '../../../../packages/session-query/session-query/src/filters.ts'
import { expect, test } from 'vitest'
import { headerSchema, parseEvents } from '../src/session-records.ts'

function session(): Session { return Session.create(SessionId(randomUUID())) }
function append(native: Session, text: string): SessionEvent<'user/message'> {
  return native.append('user/message', createUserMessage({ content: [{ type: 'text', text }], source: { kind: 'user' } }),
    { surfaceOp: 'append' })
}
function replacement(native: Session, text: string, start: number, end: number, sources: readonly number[]) {
  return native.append('user/message', createUserMessage({ content: [{ type: 'text', text }], source: { kind: 'user' } }),
    { surfaceOp: { op: 'replace', startSeq: SessionSeq(start), endSeq: SessionSeq(end) },
      sourceEventSeqs: sources.map(SessionSeq) })
}
function decoded(value: unknown): unknown { return JSON.parse(JSON.stringify(value)) }

test('official current filtering excludes a replaced raw-history message', () => {
  const native = session()
  append(native, 'retired needle')
  replacement(native, 'visible answer', 0, 0, [0])
  const documents = buildSessionEventSearchDocuments(native.id, native.snapshotEvents())
  expect(documents.map(d => [d.seq, d.surface])).toEqual([[0, 'shadowed'], [1, 'current']])
  expect(filterSessionEventDocuments(documents, [{ kind: 'text', text: 'needle' }])).toHaveLength(1)
  expect(filterSessionEventDocuments(documents, [
    { kind: 'type', values: ['user/message', 'assistant/message'] },
    { kind: 'surface', values: ['current'] }, { kind: 'text', text: 'needle' },
  ])).toEqual([])
})

test('replacement endpoints follow surface order and may reverse physical sequence order', () => {
  const native = session()
  append(native, 'first'); append(native, 'second'); append(native, 'third')
  replacement(native, 'replacement first second', 0, 1, [0, 1])
  expect(native.surface.nodes).toEqual([3, 2])
  replacement(native, 'final current message', 3, 2, [3, 2])
  expect(native.surface.nodes).toEqual([4])
  const documents = buildSessionEventSearchDocuments(native.id, native.snapshotEvents())
  expect(documents.map(d => [d.seq, d.surface])).toEqual([
    [0, 'shadowed'], [1, 'shadowed'], [2, 'shadowed'], [3, 'shadowed'], [4, 'current'],
  ])
})

test('event-local validation accepts an absolute-sequence chunk that cannot be independently folded', () => {
  const native = session()
  append(native, 'first'); append(native, 'second'); append(native, 'third')
  const header = headerSchema.parse(native.header)
  const chunk = parseEvents(header, decoded(native.snapshotEvents().slice(2)))
  expect(chunk.map(e => e.seq)).toEqual([2])
  expect(() => buildSessionEventSearchDocuments(native.id, chunk)).toThrow(
    expect.objectContaining({ code: 'SESSION_QUERY_INVALID_SURFACE' }))
})

test('event-local validation cannot prove a replacement target was current in the prefix', () => {
  const native = session()
  append(native, 'original')
  replacement(native, 'first replacement', 0, 0, [0])
  replacement(native, 'second replacement', 1, 1, [1])
  const input = native.snapshotEvents().map(event => event.seq === 2
    ? { ...event, surfaceOp: { op: 'replace', startSeq: 0, endSeq: 0 }, sourceEventSeqs: [0] } : event)
  const adopted = parseEvents(headerSchema.parse(native.header), decoded(input))
  expect(adopted).toHaveLength(3)
  expect(() => buildSessionEventSearchDocuments(native.id, adopted)).toThrow(
    expect.objectContaining({ code: 'SESSION_QUERY_INVALID_SURFACE' }))
})

test('event-local vocabulary rejects unknown required events but preserves ignorable records', () => {
  const native = session(); append(native, 'visible')
  const future = { seq: 1, time: 1, type: 'future/native-search-review', data: { text: 'opaque' } }
  const header = headerSchema.parse(native.header)
  expect(() => parseEvents(header, [future])).toThrow()
  const adopted = parseEvents(header, [{ ...future, ignorable: true }])
  expect(adopted).toMatchObject([{ type: future.type, ignorable: true }])
  expect(adopted.map(extractSessionEventText)).toEqual([''])
})

test('official extraction uses assembled assistant content and retains unusual JSON text', () => {
  const native = session(), text = 'before\0after 😀 \uD800'
  const event = native.append('assistant/message', { turn: 1, step: 1, stream: [],
    message: createAssistantMessage({ content: [{ type: 'reasoning', text: 'private reasoning' }, { type: 'text', text }],
      source: { provider: 'fixture', model: 'fixture' } }) }, { surfaceOp: 'append' })
  const adopted = parseEvents(headerSchema.parse(native.header), decoded([event]))
  const texts = adopted.map(extractSessionEventText)
  expect(texts).toEqual([text])
  expect(texts.join('\n')).not.toContain('private reasoning')
  expect(adopted).toEqual([event])
})

test('official semantic extraction trims blocks and includes embedded tool-call data', () => {
  const native = session()
  const event = native.append('assistant/message', { turn: 1, step: 1, stream: [],
    message: createAssistantMessage({ content: [{ type: 'text', text: '  first  ' },
      { type: 'tool-call', id: ToolCallId('owned-review-call'), name: 'search', arguments: '{"q":"needle"}' },
      { type: 'text', text: ' second ' }], source: { provider: 'fixture', model: 'fixture' } }) },
  { surfaceOp: 'append' })
  expect(extractSessionEventText(event)).toBe('first\nsearch\n{"q":"needle"}\nsecond')
})

test('official literal filter uses flexible whitespace rather than exact substring spacing', () => {
  const pattern = compileSessionTextFilter('first second')
  expect(pattern.test('first\n\tsecond')).toBe(true)
  expect('first\n\tsecond'.toLowerCase().includes('first second'.toLowerCase())).toBe(false)
  expect(compileSessionTextFilter('100%_\\literal').test('100%_\\literal')).toBe(true)
  expect(compileSessionTextFilter('100%_\\literal').test('100X_\\literal')).toBe(false)
})
