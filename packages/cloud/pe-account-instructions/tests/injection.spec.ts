import { expect, it } from 'vitest'
import { mkdirSync, readFileSync, writeFileSync } from 'node:fs'
import { createHash } from 'node:crypto'
import { Context } from '@deepseek-ai/cordis'
import { createUserMessage, LlmAdapter, ToolCallId } from '@deepseek-ai/dsh-llm'
import type { GenerateOptions, RequestMessage, StreamChunk } from '@deepseek-ai/dsh-llm'
import { Session, SessionId, SESSION_FORMAT_VERSION } from '@deepseek-ai/dsh-session'
import type { SessionEvent, SessionHeader, UserMessage } from '@deepseek-ai/dsh-session'
import { sessionFormatCatalog } from '@deepseek-ai/dsh-session-format-catalog'
import { snapshotSessionFormatJson } from '@deepseek-ai/dsh-session-format'
import { normalizeSessionLog, redactSessionSnapshotIds } from '@deepseek-ai/dsh-session-snapshot'
import { FsError } from '@deepseek-ai/dsh-fs'
import { prepareInstructionSnapshot } from '../src/snapshot.ts'
import { Reader, limits, directory, identity, signal } from './harness.ts'
import { mountAgentLoopTestDependencies, mountAgentLoopTestHarness } from '@deepseek-ai/dsh-agent-loop-testkit'
import { defineContentToolFixture } from '@deepseek-ai/dsh-tools'
import { installInstructionInjection } from '../src/injection.ts'
import type { PreparedInstruction } from '../src/injection.ts'

async function context(text: string): Promise<PreparedInstruction> {
  const reader = new Reader()
  reader.files.set('/project/AGENTS.md', { chunks: [text] })
  return {
    message: await prepareInstructionSnapshot([directory(reader, 'project', '/project', '.')], identity, limits, signal()),
    release() {},
  }
}
function prompt(): UserMessage {
  return createUserMessage({ content: [{ type: 'text', text: 'start' }], source: { kind: 'user' } })
}
function isInstruction(message: RequestMessage): boolean {
  return message.source?.kind === 'pe-account-instructions'
}

class Adapter extends LlmAdapter {
  readonly requests: GenerateOptions[] = []
  constructor(private readonly firstTool: boolean, private readonly failFirst = false) { super() }
  override async * stream(options: GenerateOptions): AsyncIterable<StreamChunk> {
    this.requests.push(options)
    if (this.failFirst && this.requests.length === 1) {
      yield { type: 'finish', reason: { kind: 'error', failure: { message: 'retry once', code: 'SERVICE_UNAVAILABLE' } } }
      return
    }
    if (this.firstTool && this.requests.length === 1) {
      yield { type: 'block-start', index: 0, blockType: 'tool-call' }
      yield { type: 'block-end', index: 0, block: { type: 'tool-call', id: ToolCallId('mutate'), name: 'mutate', arguments: '{}' } }
      yield { type: 'finish', reason: { kind: 'tool-calls' } }
    } else {
      yield { type: 'block-start', index: 0, blockType: 'text' }
      yield { type: 'block-end', index: 0, block: { type: 'text', text: 'done' } }
      yield { type: 'finish', reason: { kind: 'stop' } }
    }
  }
}

it('keeps one native context across tool steps and reloads for the next turn', async () => {
  const ctx = new Context()
  try {
    await mountAgentLoopTestDependencies(ctx)
    const harness = await mountAgentLoopTestHarness(ctx)
    const adapter = new Adapter(true)
    ctx.llm.registerAdapter(['test'], adapter)
    let text = 'first snapshot'
    let loads = 0
    await ctx.plugin((owner) => {
      installInstructionInjection(owner, new AbortController().signal, () => {}, async () => {
        loads++
        return context(text)
      })
    })
    ctx.tools.register(defineContentToolFixture({
      name: 'mutate', description: 'change the next-turn source', parameters: {},
      async execute() {
        text = 'second snapshot'
        return [{ type: 'text', text: 'changed' }]
      },
    }))
    const agent = await harness.create(SessionId('350db41d-c3c2-4ab0-b53b-2178f2ff1aa9'), { provider: 'test', model: 'test' })
    expect(loads).toBe(0)
    agent.followup(prompt())
    await agent.whenIdle()
    expect(adapter.requests).toHaveLength(2)
    expect(loads).toBe(1)
    const requestText = (request: GenerateOptions): string => request.messages.flatMap(message => message.content)
      .filter(block => block.type === 'text').map(block => block.text).join('\n')
    expect(requestText(adapter.requests[1]!)).toContain('first snapshot')
    expect(requestText(adapter.requests[1]!)).not.toContain('second snapshot')
    agent.followup(prompt())
    await agent.whenIdle()
    expect(loads).toBe(2)
    expect(requestText(adapter.requests[2]!)).toContain('second snapshot')
    const instructions = agent.session.snapshotEvents().filter(event =>
      event.type === 'user/message' && event.data.source.kind === 'pe-account-instructions')
    expect(instructions).toHaveLength(2)

    // Native codec output is the replay input and oracle for this bounded reader fixture.
    // This does not boot a shipped profile or exercise the real files authorization port.
    const rows = [
      sessionFormatCatalog.encodeCurrentHeader({ ...agent.session.header, delegationDepth: 0 }, agent.session.inheritedEventCount),
      ...agent.session.snapshotEvents().map(event => sessionFormatCatalog.encodeCurrentEvent({
        ...event, data: snapshotSessionFormatJson(event.data),
      })),
    ]
    const rawLog = rows.map(row => JSON.stringify(row)).join('\n') + '\n'
    const redacted = redactSessionSnapshotIds([rawLog])[0]
    if (redacted === undefined) throw new Error('Missing native log fixture')
    const recorded = normalizeSessionLog(redacted, { sessionIds: [], cwd: '' }, { identityMode: 'preserve' })
    const fixture = new URL('./fixtures/recorded/session.v4.jsonl', import.meta.url)
    if (process.env['DSH_SNAPSHOT'] === 'record') {
      mkdirSync(new URL('./fixtures/recorded/', import.meta.url), { recursive: true })
      writeFileSync(fixture, recorded)
    }
    const committed = readFileSync(fixture, 'utf8')
    expect(recorded).toBe(committed)
    const lines: unknown[] = committed.trimEnd().split('\n').map((line) => {
      const row: unknown = JSON.parse(line)
      return row
    })
    const restore = sessionFormatCatalog.createRestore(lines[0], { recovery: 'strict', validation: 'current' })
    for (const line of lines.slice(1)) restore.decodeRow(line)
    const restored = restore.finish()
    expect(restored.header.version).toBe(SESSION_FORMAT_VERSION)
    const { parentSession, ...metadata } = restored.header
    const header: SessionHeader = {
      ...metadata, version: SESSION_FORMAT_VERSION, id: SessionId(metadata.id),
      ...parentSession === undefined ? {} : { parentSession: SessionId(parentSession) },
    }
    const rebuilt = Session.create(header.id, restored.events as readonly SessionEvent[], header)
    const restoredContexts = rebuilt.deriveMessages().filter(message => message.source.kind === 'pe-account-instructions')
    expect(restoredContexts.map(message => message.content)).toEqual(instructions.map((event) => {
      if (event.type !== 'user/message') throw new Error('Expected native instruction message')
      return event.data.content
    }))
    for (const message of restoredContexts) {
      if (message.source.kind !== 'pe-account-instructions') throw new Error('Expected instruction source')
      expect(message.source.snapshot.totalBytes).toBe(Buffer.byteLength(message.source.snapshot.text, 'utf8'))
      expect(message.source.snapshot).toMatchObject(identity)
      for (const entry of message.source.snapshot.sources) {
        expect(entry.hash).toBe(createHash('sha256').update(entry.text, 'utf8').digest('hex'))
      }
    }
    expect(restoredContexts[0]?.content).toEqual(adapter.requests[0]?.messages.find(isInstruction)?.content)
    expect(restoredContexts[1]?.content).toEqual(adapter.requests[2]?.messages.findLast(isInstruction)?.content)
  } finally {
    await ctx.fiber.dispose()
  }
})

it('reoffers a dropped decision context at the next native step until the log accepts it', async () => {
  const ctx = new Context()
  try {
    await mountAgentLoopTestDependencies(ctx)
    const harness = await mountAgentLoopTestHarness(ctx)
    const adapter = new Adapter(true)
    ctx.llm.registerAdapter(['test'], adapter)
    let loads = 0
    ctx.on('agent/pre-step', async ({ step }, next) => {
      const decision = await next()
      if (step !== 1 || decision.kind === 'reject') return decision
      return { ...decision, messages: decision.messages.filter(message => message.source.kind !== 'pe-account-instructions') }
    })
    await ctx.plugin((owner) => {
      installInstructionInjection(owner, signal(), () => {}, async () => {
        loads++
        return context('one immutable snapshot')
      })
    })
    ctx.tools.register(defineContentToolFixture({
      name: 'mutate', description: 'continue the native turn', parameters: {},
      async execute() { return [{ type: 'text', text: 'continue' }] },
    }))
    const agent = await harness.create(SessionId('dropped-context'), { provider: 'test', model: 'test' })
    agent.followup(prompt())
    await agent.whenIdle()
    expect(loads).toBe(1)
    expect(adapter.requests).toHaveLength(2)
    expect(adapter.requests[0]?.messages.some(isInstruction)).toBe(false)
    expect(adapter.requests[1]?.messages.some(isInstruction)).toBe(true)
    expect(agent.session.deriveMessages().filter(message => message.source.kind === 'pe-account-instructions')).toHaveLength(1)
  } finally {
    await ctx.fiber.dispose()
  }
})

it('starts a fresh snapshot next turn after cancellation between pre-step and native acceptance', async () => {
  const ctx = new Context()
  try {
    await mountAgentLoopTestDependencies(ctx)
    const harness = await mountAgentLoopTestHarness(ctx)
    const adapter = new Adapter(false)
    ctx.llm.registerAdapter(['test'], adapter)
    let loads = 0
    let cancelOnce = true
    await ctx.plugin((owner) => {
      installInstructionInjection(owner, signal(), () => {}, async () => {
        loads++
        return context(`snapshot ${String(loads)}`)
      })
    })
    ctx.on('agent/request', async ({ agent }, next) => {
      const config = await next()
      if (cancelOnce) {
        cancelOnce = false
        agent.cancel({ kind: 'user' })
      }
      return config
    })
    const agent = await harness.create(SessionId('cancel-before-context'), { provider: 'test', model: 'test' })
    agent.followup(prompt())
    await agent.whenIdle()
    expect(loads).toBe(1)
    expect(adapter.requests).toEqual([])
    expect(agent.session.deriveMessages().some(message => message.source.kind === 'pe-account-instructions')).toBe(false)
    agent.followup(prompt())
    await agent.whenIdle()
    expect(loads).toBe(2)
    const contexts = agent.session.deriveMessages().filter(message => message.source.kind === 'pe-account-instructions')
    expect(contexts).toHaveLength(1)
    const block = contexts[0]?.content[0]
    if (block?.type !== 'text') throw new Error('Missing next-turn instruction text')
    expect(block.text).toContain('snapshot 2')
  } finally {
    await ctx.fiber.dispose()
  }
})

it('reuses accepted native context during a request retry without another preparation', async () => {
  const ctx = new Context()
  try {
    await mountAgentLoopTestDependencies(ctx)
    const harness = await mountAgentLoopTestHarness(ctx)
    const adapter = new Adapter(false, true)
    ctx.llm.registerAdapter(['test'], adapter)
    let loads = 0
    await ctx.plugin((owner) => {
      installInstructionInjection(owner, signal(), () => {}, async () => {
        loads++
        return context('same retry snapshot')
      })
    })
    ctx.on('agent/request-error', async (_payload, next) => {
      await next()
      return { kind: 'retry' }
    })
    const agent = await harness.create(SessionId('snapshot-request-retry'), { provider: 'test', model: 'test' })
    agent.followup(prompt())
    await agent.whenIdle()
    expect(loads).toBe(1)
    expect(adapter.requests).toHaveLength(2)
    expect(agent.session.deriveMessages().filter(message => message.source.kind === 'pe-account-instructions')).toHaveLength(1)
    const firstId = adapter.requests[0]?.messages.find(isInstruction)?.id
    expect(firstId).toBeDefined()
    expect(adapter.requests[1]?.messages.find(isInstruction)?.id).toBe(firstId)
  } finally {
    await ctx.fiber.dispose()
  }
})

it('logs an explicit empty snapshot on the next turn after optional sources disappear', async () => {
  const ctx = new Context()
  try {
    await mountAgentLoopTestDependencies(ctx)
    const harness = await mountAgentLoopTestHarness(ctx)
    const adapter = new Adapter(false)
    ctx.llm.registerAdapter(['test'], adapter)
    const reader = new Reader()
    reader.files.set('/project/AGENTS.md', { chunks: ['initial instructions'] })
    await ctx.plugin((owner) => {
      installInstructionInjection(owner, signal(), () => {}, async (_agent, control) => ({
        message: await prepareInstructionSnapshot([directory(reader, 'project', '/project', '.')], identity, limits, control),
        release() {},
      }))
    })
    const agent = await harness.create(SessionId('empty-next-turn'), { provider: 'test', model: 'test' })
    agent.followup(prompt())
    await agent.whenIdle()
    reader.files.clear()
    agent.followup(prompt())
    await agent.whenIdle()
    const contexts = agent.session.deriveMessages().filter(message => message.source.kind === 'pe-account-instructions')
    expect(adapter.requests).toHaveLength(2)
    expect(contexts).toHaveLength(2)
    const final = contexts.at(-1)
    if (final?.source.kind !== 'pe-account-instructions') throw new Error('Missing empty instruction snapshot')
    expect(final.source.snapshot.sources).toEqual([])
    expect(final.source.snapshot.text).toContain('No optional instruction files are present.')
  } finally {
    await ctx.fiber.dispose()
  }
})

it('does not call the model or log partial instruction context when the reader fails', async () => {
  const ctx = new Context()
  try {
    await mountAgentLoopTestDependencies(ctx)
    const harness = await mountAgentLoopTestHarness(ctx)
    const adapter = new Adapter(false)
    ctx.llm.registerAdapter(['test'], adapter)
    const reader = new Reader()
    reader.files.set('/project/AGENTS.md', { chunks: [], error: new FsError('unavailable', 'FS_IO_ERROR') })
    await ctx.plugin((owner) => {
      installInstructionInjection(owner, signal(), () => {}, async (_agent, control) => ({
        message: await prepareInstructionSnapshot([directory(reader, 'project', '/project', '.')], identity, limits, control),
        release() {},
      }))
    })
    const agent = await harness.create(SessionId('reader-failure'), { provider: 'test', model: 'test' })
    agent.followup(prompt())
    await agent.whenIdle()
    expect(adapter.requests).toEqual([])
    expect(agent.session.deriveMessages().some(message => message.source.kind === 'pe-account-instructions')).toBe(false)
    reader.files.set('/project/AGENTS.md', { chunks: ['recovered instructions'] })
    agent.followup(prompt())
    await agent.whenIdle()
    expect(adapter.requests).toHaveLength(1)
    expect(agent.session.deriveMessages().filter(message => message.source.kind === 'pe-account-instructions')).toHaveLength(1)
  } finally {
    await ctx.fiber.dispose()
  }
})

it('aborts on disposal and waits for observable preparation to settle', async () => {
  const ctx = new Context()
  try {
    await mountAgentLoopTestDependencies(ctx)
    const harness = await mountAgentLoopTestHarness(ctx)
    const adapter = new Adapter(false)
    ctx.llm.registerAdapter(['test'], adapter)
    const started = Promise.withResolvers<undefined>()
    const aborted = Promise.withResolvers<undefined>()
    const release = Promise.withResolvers<PreparedInstruction>()
    const fiber = await ctx.plugin((owner) => {
      installInstructionInjection(owner, new AbortController().signal, () => {}, async (_agent, control) => {
        control.addEventListener('abort', () => { aborted.resolve(undefined) }, { once: true })
        started.resolve(undefined)
        return release.promise
      })
    })
    const agent = await harness.create(SessionId('pending'), { provider: 'test', model: 'test' })
    agent.followup(prompt())
    await started.promise
    let disposed = false
    const closing = fiber.dispose().then(() => { disposed = true })
    await aborted.promise
    expect(disposed).toBe(false)
    release.resolve(await context('too late'))
    await closing
    await agent.whenIdle()
    expect(adapter.requests).toEqual([])
    expect(agent.session.snapshotEvents().some(event =>
      event.type === 'user/message' && event.data.source.kind === 'pe-account-instructions')).toBe(false)
  } finally {
    await ctx.fiber.dispose()
  }
})

it('rejects a generation that ends during preparation without admitting its message', async () => {
  const ctx = new Context()
  try {
    await mountAgentLoopTestDependencies(ctx)
    const harness = await mountAgentLoopTestHarness(ctx)
    const adapter = new Adapter(false)
    ctx.llm.registerAdapter(['test'], adapter)
    const account = new AbortController()
    const ready = Promise.withResolvers<undefined>()
    const release = Promise.withResolvers<PreparedInstruction>()
    await ctx.plugin((owner) => {
      installInstructionInjection(owner, account.signal, () => {
        account.signal.throwIfAborted()
      }, async () => {
        ready.resolve(undefined)
        return release.promise
      })
    })
    const agent = await harness.create(SessionId('old-generation'), { provider: 'test', model: 'test' })
    agent.followup(prompt())
    await ready.promise
    account.abort(new Error('generation drained'))
    release.resolve(await context('old instructions'))
    await agent.whenIdle()
    expect(adapter.requests).toEqual([])
    expect(agent.session.snapshotEvents().some(event =>
      event.type === 'user/message' && event.data.source.kind === 'pe-account-instructions')).toBe(false)
  } finally {
    await ctx.fiber.dispose()
  }
})
