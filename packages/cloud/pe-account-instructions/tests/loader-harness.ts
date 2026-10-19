/** Actual Loader/Agent consumers with component-only readers and a counted snapshot reservation. */
import { Context } from '@deepseek-ai/cordis'
import Loader from '@deepseek-ai/cordis-plugin-loader'
import Include from '@deepseek-ai/cordis-plugin-include'
import { auditRows } from '@deepseek-ai/dsh-agent-preset-registry'
import { mountAgentLoopTestDependencies, mountAgentLoopTestHarness } from '@deepseek-ai/dsh-agent-loop-testkit'
import { createUserMessage, LlmAdapter, ToolCallId } from '@deepseek-ai/dsh-llm'
import type { Agent } from '@deepseek-ai/dsh-agent'
import type { GenerateOptions, StreamChunk } from '@deepseek-ai/dsh-llm'
import { SessionId } from '@deepseek-ai/dsh-session'
import type { InstructionReadReaders } from '@deepseek-ai/dsh-pe-cloud-files'
import type { AccountBinding } from '@deepseek-ai/dsh-pe-cloud-runtime/types'
import type { InstructionMessage } from '../src/types.ts'
import * as instructions from '../src/session.ts'
import { identity, Reader } from './harness.ts'
import { mkdtemp, mkdir, realpath, rm } from 'node:fs/promises'
import { join } from 'node:path'
import { tmpdir } from 'node:os'

/** Deterministic external model; every request still travels through the native Agent. */
export class InstructionAdapter extends LlmAdapter {
  readonly requests: GenerateOptions[] = []
  toolFirst = false
  override async * stream(options: GenerateOptions): AsyncIterable<StreamChunk> {
    this.requests.push(options)
    if (this.toolFirst && this.requests.length === 1) {
      yield { type: 'block-start', index: 0, blockType: 'tool-call' }
      yield { type: 'block-end', index: 0, block: { type: 'tool-call', id: ToolCallId('source-change'),
        name: 'change_sources', arguments: '{}' } }
      yield { type: 'finish', reason: { kind: 'tool-calls' } }
    } else {
      yield { type: 'block-start', index: 0, blockType: 'text' }
      yield { type: 'block-end', index: 0, block: { type: 'text', text: 'done' } }
      yield { type: 'finish', reason: { kind: 'stop' } }
    }
  }
}

/**
 * Prepare the actual instructions/session Loader module before driving its native Agent.
 * @param ctx Test-owned Context; the caller disposes it even after a failed turn.
 * @param readers Restricted component fixtures; no Linux or account authorization is established.
 * @param cwd Existing canonical native working directory for the initial Session.
 * @param fixtureName Test-owned Loader configuration fixture.
 * @returns Native consumer and reservation observations, without a mirrored selection implementation.
 */
export async function mountInstructionConsumer(ctx: Context, readers: InstructionReadReaders, cwd: string, fixtureName = 'cordis.yml') {
  await mountAgentLoopTestDependencies(ctx, { workingDirectory: true })
  const native = await mountAgentLoopTestHarness(ctx)
  const errors: unknown[] = []
  ctx.on('agent/error', ({ error }) => { errors.push(error) })
  const adapter = new InstructionAdapter()
  ctx.llm.registerAdapter(['test'], adapter)
  const lifetime = new AbortController()
  const binding: AccountBinding = { accountId: identity.accountId, epoch: identity.epoch,
    recipeVersion: 'c09-loader-component', lifetime: lifetime.signal }
  ctx.provide('peAccount', binding)
  const reservations = { held: 0, peak: 0, prepared: 0, releases: 0 }
  const current = (agent: Agent): void => {
    lifetime.signal.throwIfAborted()
    if (ctx.agents.get(agent.id) !== agent || ctx.sessions.get(agent.id) !== agent.session) throw new Error('Foreign native Agent')
  }
  new instructions.AccountInstructionSources(ctx, {
    binding,
    assertInstalled(owner) {
      if (owner.root !== ctx.root) throw new Error('Foreign account graph')
    },
    assertCurrent: current,
    async withSources(agent, bytes, build, control) {
      current(agent)
      reservations.prepared++
      reservations.held += bytes
      reservations.peak = Math.max(reservations.peak, reservations.held)
      const release = (): void => { reservations.releases++; reservations.held -= bytes }
      try {
        const cwd = ctx.workingDirectory.get(agent.session)
        const value = await build(identity.workspaceId, readers, control, cwd)
        return { value, release }
      } catch (error) { release(); throw error }
    },
  })
  await ctx.plugin(Loader)
  ctx.loader.builtins.include = Include
  ctx.loader.builtins.instructions = instructions
  await ctx.loader.create({ name: 'cordis:include',
    config: { path: new URL(`./fixtures/${fixtureName}`, import.meta.url).href } })
  await ctx.loader.await()
  const failed = (await auditRows(ctx.loader)).failed
  if (failed.length !== 0) throw new Error(`Instruction Loader activation failed: ${failed.join('; ')}`)
  const agent = await native.create(SessionId('c09-instruction-consumer'), { provider: 'test', model: 'test' },
    { cwd })
  return { agent, adapter, reservations, lifetime, errors }
}

/**
 * Enter an ordinary native turn and join actual idle.
 * @param agent Original native Agent.
 * @returns Actual turn settlement, including rejected source preparation.
 */
export async function enterInstructionTurn(agent: Agent): Promise<void> {
  agent.followup(createUserMessage({ content: [{ type: 'text', text: 'start' }], source: { kind: 'user' } }))
  await agent.whenIdle()
}

/**
 * Inspect only instruction messages accepted into the original Session log.
 * @param agent Original native Agent.
 * @returns Native accepted instruction contexts, distinct from direct user input.
 */
export function acceptedInstructions(agent: Agent): InstructionMessage[] {
  return agent.session.deriveMessages().filter((message): message is InstructionMessage =>
    message.source.kind === 'pe-account-instructions')
}

/**
 * Own canonical temporary directories for the real native WorkingDirectory, with separate component content readers.
 * @returns One Context/tree owner whose close joins Context teardown before removing its own tree.
 */
export async function instructionFixture() {
  const temporary = await realpath(await mkdtemp(join(tmpdir(), 'c09-source-owner-')))
  const root = join(temporary, 'project'), preferences = join(temporary, 'preferences')
  try { await Promise.all([mkdir(root), mkdir(preferences)]) }
  catch (error) { await rm(temporary, { recursive: true, force: true }); throw error }
  const ctx = new Context(), project = new Reader(root), account = new Reader(preferences)
  return { ctx, root, preferences, project, account, temporary,
    close: async () => { await ctx.fiber.dispose(); await rm(temporary, { recursive: true, force: true }) } }
}
