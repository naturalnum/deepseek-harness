/** Original account question service, bounded Remote source and HTTP result loop; no Target calls. */
import { expect, it, onTestFinished } from 'vitest'
import { apply as applyConnection, inject as connectionInject } from '@deepseek-ai/dsh-client-connection'
import { SessionId } from '@deepseek-ai/dsh-session'
import { ToolCallId, createToolResultMessage, type ToolSchema } from '@deepseek-ai/dsh-llm'
import { brandString } from '@deepseek-ai/dsh-brand'
import type { PeerId, PeerScope } from '@deepseek-ai/dsh-typert-protocol'
import { TIMED_WAIT_PARAMETER, type AskUserQuestionAnswer, type AskUserQuestionItem } from '@deepseek-ai/dsh-user-questions'
import type { EndpointExposure } from '../src/types.ts'
import { policyFixture } from '../../pe-cloud-runtime/tests/account-policy-fixture.ts'

const bounds = { maxHomeBytes: 4096, maxCollectionItems: 16, maxFrameBytes: 65536,
  maxQueuedEvents: 8, maxQueuedBytes: 131072 }
const rpc: readonly EndpointExposure[] = [
  { endpoint: 'userQuestions/answer', handlerId: 'native:userQuestions', guard: 'account-session' },
  { endpoint: '$events/result', handlerId: 'native:typertGateway', guard: 'authenticated-account' },
]
const streams: readonly EndpointExposure[] = [
  { endpoint: 'userQuestions/attachWait', handlerId: 'native:userQuestions', guard: 'account-session' },
]
const questions: AskUserQuestionItem[] = [{ id: 'plan', question: 'Approve this plan?', detail: 'Create hello.py in this workspace.',
  options: [{ label: 'Approve' }, { label: 'Revise' }], intent: { kind: 'plan-review', approve: 'Approve' } }]
const answer: AskUserQuestionAnswer = { answers: [{ id: 'plan', selected: ['Approve'] }] }

function field(value: unknown, key: string): unknown {
  if (value === null || typeof value !== 'object') throw new Error('Original Remote frame is not an object')
  return Reflect.get(value, key)
}
function text(value: unknown, key: string): string {
  const result = field(value, key)
  if (typeof result !== 'string') throw new Error('Original Remote frame omitted ' + key)
  return result
}

async function fixture(id: string, selectedBounds = bounds) {
  const native = policyFixture(rpc, selectedBounds, id, undefined, undefined, undefined, undefined, undefined, streams)
  const graph = await native.start()
  await graph.ctx.plugin({ inject: [...connectionInject], apply: applyConnection })
  const sessionId = SessionId('same-account-local-plan-session')
  await graph.ctx.sessionController.create({ sessionId })
  const agent = graph.ctx.agents.get(sessionId)
  if (agent === undefined || graph.events === undefined) throw new Error('Original question Agent or event source absent')
  const abort = new AbortController(), peer: PeerScope = { id: brandString<PeerId>('plan-peer-' + id), ctx: graph.ctx,
    principal: { kind: 'owner' }, interactions: 'answer', signal: abort.signal, dispose: async () => { abort.abort() } }
  const pending: Promise<unknown>[] = [], controls: AbortController[] = []
  const opened: AsyncIterator<unknown>[] = []
  onTestFinished(async () => {
    for (const control of controls) control.abort()
    abort.abort()
    for (const source of opened) await source.return?.()
    await graph.close()
    await Promise.allSettled(pending)
  })
  const track = <T>(operation: Promise<T>): Promise<T> => {
    pending.push(operation)
    void operation.catch(() => {})
    return operation
  }
  const ask = (callId: string, timed = false, detail = questions): Promise<unknown> => {
    const control = new AbortController(); controls.push(control)
    return track(timed
      ? graph.ctx.userQuestions.askTimed({ agent, questions: detail, signal: control.signal }, ToolCallId(callId), 120000)
      : graph.ctx.userQuestions.ask({ agent, questions: detail, signal: control.signal }))
  }
  const open = async () => {
    const source = (await graph.ctx.typertGateway.wireStream.open('$events', { args: {} }, (async function* () {})(), peer, abort.signal))[Symbol.asyncIterator]()
    opened.push(source)
    const first = await source.next()
    expect(first).toMatchObject({ done: false, value: { type: 'ready' } })
    return { source, clientId: text(first.value, 'clientId') }
  }
  const nextQuestion = async (source: AsyncIterator<unknown>): Promise<unknown> => {
    for (let index = 0; index < selectedBounds.maxQueuedEvents; index++) {
      const next = await source.next()
      if (next.done) throw new Error('Original event stream ended before its question')
      if (field(next.value, 'type') === 'waterfall') return next.value
    }
    throw new Error('Original question did not arrive inside its finite event window')
  }
  const result = async (clientId: string, eventId: string, outcome: object, actualPeer = peer) => {
    const route = graph.ctx.connection.createSharedFetchHandler('/api', (target) => {
      if (target.kind !== 'rpc') throw new Error('A question result must use original native RPC')
      graph.api.requireRpc(target.endpoint)
    })
    const response = await route.fetch(new Request('http://account.invalid/api/$events/result', {
      method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify({ type: 'client-request',
        rpcId: 'plan-result', method: '$events/result', payload: { args: { clientId, eventId, outcome } } }),
    }), actualPeer)
    const value: unknown = await response.json()
    return value
  }
  const attach = async (callId: string, actual = agent) => {
    const control = new AbortController(); controls.push(control)
    const source = (await graph.ctx.typertGateway.stream({ namespace: 'userQuestions', method: 'attachWait',
      args: { agentId: actual.id, callId }, peer, signal: control.signal }))[Symbol.asyncIterator]()
    opened.push(source)
    return source
  }
  return { ...graph, agent, peer, ask, open, nextQuestion, result, attach, controls, track, native }
}

it('round-trips the original plan intent and timed claim through native Remote framing and result settlement', async () => {
  const f = await fixture('roundtrip'), client = await f.open(), waiting = f.ask('plan-call', true)
  const question = await f.nextQuestion(client.source)
  expect(question).toMatchObject({ type: 'waterfall', event: 'user-questions/request', agentId: f.agent.id,
    request: { questions, wait: { callId: 'plan-call', timed: true } } })
  expect(field(question, 'request')).not.toHaveProperty('agent')
  expect(field(question, 'request')).not.toHaveProperty('signal')
  expect(f.events?.inspect()).toMatchObject({ resultEndpoint: '$events/result', queuedEvents: 1 })
  expect(f.events?.inspect().queuedBytes).toBeGreaterThan(0)
  const claim = await f.attach('plan-call')
  const remaining = await claim.next()
  expect(remaining.done).toBe(false)
  expect(field(remaining.value, 'remainingMs')).toBeGreaterThan(0)
  await expect(f.result(client.clientId, text(question, 'eventId'), { kind: 'result', value: answer }))
    .resolves.toMatchObject({ result: { ok: true } })
  await expect(waiting).resolves.toEqual(answer)
  await expect(claim.next()).resolves.toMatchObject({ done: true })
  expect(f.events?.inspect()).toMatchObject({ queuedEvents: 0, queuedBytes: 0 })
  expect(f.api.requireRpc('userQuestions/answer')).toMatchObject({ handlerId: 'native:userQuestions', guard: 'account-session' })
  expect(f.api.requireStream('userQuestions/attachWait')).toMatchObject({ handlerId: 'native:userQuestions', guard: 'account-session' })
})

it('keeps same-id accounts separate and refuses foreign Agent answers, claims and event results', async () => {
  const [a, b] = await Promise.all([fixture('a'), fixture('b')])
  expect(a.agent.id).toBe(b.agent.id)
  expect(() => a.ctx.userQuestions.answer(b.agent, ToolCallId('none'), answer)).toThrow(expect.objectContaining({ code: 'cloud/forbidden' }))
  await expect(a.ctx.userQuestions.attachWait(b.agent, ToolCallId('none'), a.peer.signal)[Symbol.asyncIterator]().next())
    .rejects.toMatchObject({ code: 'cloud/forbidden' })
  const client = await a.open(), waiting = a.ask('foreign-result'), question = await a.nextQuestion(client.source)
  await expect(a.result(client.clientId, text(question, 'eventId'), { kind: 'result', value: answer }, b.peer))
    .resolves.toMatchObject({ result: { ok: false, error: { code: 'gateway/interactions-forbidden' } } })
  expect(a.events?.inspect().queuedEvents).toBe(1)
  await a.result(client.clientId, text(question, 'eventId'), { kind: 'result', value: answer })
  await expect(waiting).resolves.toEqual(answer)
  expect(b.events?.inspect()).toMatchObject({ queuedEvents: 0, queuedBytes: 0 })
})

it('settles original continued answers from the Session projection and denies duplicate or malformed replies', async () => {
  const f = await fixture('continued'), callId = ToolCallId('continued-call')
  const timedTool: ToolSchema = { name: 'ask_user_question', description: 'Ask brief questions.', parameters: {
    type: 'object', properties: { questions: { type: 'array' }, [TIMED_WAIT_PARAMETER]: { type: 'integer' } },
  } }
  const session = f.agent.session
  const inserted: unknown[] = []
  f.ctx.on('session/event', (actual, event) => {
    if (actual === session && event.type === 'agent/inbox/spliced') inserted.push(...event.data.inserted)
  })
  session.append('turn/start', { turn: 1 }); session.append('step/start', { turn: 1, step: 1 })
  session.append('request/header', { header: { config: { provider: 'local-text', model: 'plain-text' }, tools: [timedTool] }, reason: 'initial' })
  session.append('tool/call', { turn: 1, step: 1, callId, name: 'ask_user_question', arguments: JSON.stringify({ questions }) })
  session.append('tool/result', { turn: 1, step: 1, message: createToolResultMessage({ callId,
    content: [{ type: 'text', text: JSON.stringify({ pending: true, callId }) }], isError: false }) }, { surfaceOp: 'append' })
  const invoke = (batch: AskUserQuestionAnswer) => f.ctx.typertGateway.invoke({ namespace: 'userQuestions', method: 'answer',
    args: { agentId: f.agent.id, callId, answer: batch }, peer: f.peer })
  await expect(invoke({ answers: [{ id: 'foreign-question', selected: ['Approve'] }] })).rejects.toMatchObject({ code: 'BAD_ANSWER' })
  await expect(invoke(answer)).resolves.toBe(true)
  await expect(invoke(answer)).rejects.toMatchObject({ code: 'REPLY_QUEUED' })
  expect(inserted).toContainEqual(expect.objectContaining({ source: { kind: 'user-question-reply', callId, outcome: 'answered' } }))
})

it('rejects an already delivered unanswered question when the original account source is withdrawn', async () => {
  const f = await fixture('withdraw'), client = await f.open(), waiting = f.ask('withdraw-call')
  await f.nextQuestion(client.source)
  const rejected = expect(waiting).rejects.toBeDefined()
  await f.events?.dispose()
  await rejected
  expect(() => f.events?.inspect()).toThrow()
})

it.each(['next', 'rejected'] as const)('releases retained question capacity after the native Client sends %s', async (kind) => {
  const f = await fixture('outcome-' + kind), client = await f.open(), waiting = f.ask('outcome-call')
  const question = await f.nextQuestion(client.source)
  const rejected = expect(waiting).rejects.toMatchObject({ code: kind === 'next' ? 'NO_PROVIDER' : 'ASK_CANCELLED' })
  const outcome = kind === 'next' ? { kind: 'next' } : { kind: 'rejected', error: {
    name: 'UserQuestionError', message: 'The user cancelled plan approval.', code: 'ASK_CANCELLED',
  } }
  await expect(f.result(client.clientId, text(question, 'eventId'), outcome)).resolves.toMatchObject({ result: { ok: true } })
  await rejected
  expect(f.events?.inspect()).toMatchObject({ queuedEvents: 0, queuedBytes: 0 })
})

it('cancels an enqueued question before the Gateway consumes it and forwards no stale question', async () => {
  const f = await fixture('enqueue-abort'), waiting = f.ask('enqueue-call')
  expect(f.events?.inspect().queuedEvents).toBe(1)
  const rejected = expect(waiting).rejects.toMatchObject({ code: 'ASK_ABORTED' })
  f.controls.at(-1)?.abort()
  expect(f.events?.inspect()).toMatchObject({ queuedEvents: 0, queuedBytes: 0 })
  await rejected
  const client = await f.open()
  f.ctx.emit('settings/document-updated', brandString<import('@deepseek-ai/dsh-settings/types').SettingsNamespace>('locale'), 1)
  await expect(client.source.next()).resolves.toMatchObject({ value: { type: 'emit', event: 'settings/document-updated' } })
})

it.each(['events', 'bytes'] as const)('retains the original pending %s budget after delivery and rejects overflow with all continuations settled', async (limit) => {
  const f = await fixture('overflow-' + limit, { ...bounds, maxQueuedEvents: limit === 'events' ? 4 : 8,
    maxQueuedBytes: limit === 'bytes' ? 8192 : bounds.maxQueuedBytes })
  const client = await f.open()
  const detail = [{ ...questions[0]!, detail: 'p'.repeat(limit === 'bytes' ? 3000 : 350) }]
  const accepted: Promise<unknown>[] = []
  let bytes = 0
  for (let index = 0; index < (limit === 'events' ? 4 : 2); index++) {
    accepted.push(f.ask('retained-call-' + String(index), false, detail))
    const frame = await f.nextQuestion(client.source)
    bytes += Buffer.byteLength(JSON.stringify(frame), 'utf8')
    expect(f.events?.inspect()).toMatchObject({ queuedEvents: index + 1, queuedBytes: bytes })
  }
  const overflow = f.ask('overflow-call', false, detail)
  const error: unknown = await overflow.catch((cause: unknown) => cause)
  expect(error).toMatchObject({ code: 'cloud/account-unavailable' })
  f.expectEventDisposalFailure(error)
  for (const waiting of accepted) await expect(waiting).rejects.toBe(error)
  await expect(f.events?.dispose()).rejects.toBe(error)
  expect(() => f.events?.inspect()).toThrow()
})

it('counts the complete native multibyte waterfall envelope against its explicit frame budget', async () => {
  const f = await fixture('frame-bytes', { ...bounds, maxFrameBytes: 4096 })
  const value = f.ask('oversized-call', false, [{ ...questions[0]!, detail: '汉'.repeat(1500) }])
  const error: unknown = await value.catch((cause: unknown) => cause)
  expect(error).toMatchObject({ code: 'cloud/account-unavailable' })
  f.expectEventDisposalFailure(error)
  await expect(f.events?.dispose()).rejects.toBe(error)
  expect(() => f.events?.inspect()).toThrow()
})

it('withdraws a native timed claim on Client cancellation while preserving the unanswered plan', async () => {
  const f = await fixture('claim-cancel'), client = await f.open(), waiting = f.ask('cancelled-claim', true)
  const question = await f.nextQuestion(client.source), claim = await f.attach('cancelled-claim')
  const remaining = await claim.next()
  expect(remaining.done).toBe(false)
  expect(field(remaining.value, 'remainingMs')).toBeGreaterThan(0)
  f.controls.at(-1)?.abort()
  await expect(claim.next()).rejects.toBeDefined()
  expect(f.events?.inspect().queuedEvents).toBe(1)
  await f.result(client.clientId, text(question, 'eventId'), { kind: 'result', value: answer })
  await expect(waiting).resolves.toEqual(answer)
  expect(f.events?.inspect()).toMatchObject({ queuedEvents: 0, queuedBytes: 0 })
})

it('keeps unselected question services, result admission and timed claims closed', async () => {
  const graph = await policyFixture([], bounds, 'unselected-plan').start()
  expect(graph.ctx.get('userQuestions')).toBeUndefined()
  expect(graph.events?.inspect()).not.toHaveProperty('resultEndpoint')
  expect(() => graph.api.requireRpc('userQuestions/answer')).toThrow()
  expect(() => graph.api.requireRpc('$events/result')).toThrow()
  expect(() => graph.api.requireStream('userQuestions/attachWait')).toThrow()
})

it('refuses native answer and wait dispatch after original account business admission closes', async () => {
  const f = await fixture('closed-business')
  f.closeBusiness()
  expect(() => f.ctx.userQuestions.answer(f.agent, ToolCallId('no-longer-admitted'), answer))
    .toThrow('Original component business admission is closed')
  await expect(f.ctx.userQuestions.attachWait(f.agent, ToolCallId('no-longer-admitted'), f.peer.signal)[Symbol.asyncIterator]().next())
    .rejects.toThrow('Original component business admission is closed')
})
