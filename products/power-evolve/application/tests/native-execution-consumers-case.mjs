/** Actual native consumers over the original-Agent HTTP binding; no execution or filesystem mocks. */
import assert from 'node:assert/strict'
import { Context } from '@deepseek-ai/cordis'
import { AgentRegistry } from '@deepseek-ai/dsh-agent'
import { Session } from '@deepseek-ai/dsh-session'
import { SessionProjectionRegistry } from '@deepseek-ai/dsh-session-projection'
import { SandboxPolicyService } from '@deepseek-ai/dsh-sandbox-policy'
import { SandboxBashExecutor } from '@deepseek-ai/dsh-bash-sandbox'
import { NodePtcRuntime } from '@deepseek-ai/dsh-ptc-runtime-node'
import { TerminalSessionService } from '@deepseek-ai/dsh-terminal'
import * as BashTerminal from '@deepseek-ai/dsh-terminal-bash'
import { installNativeExecutionProviders } from '../lib/native-execution/providers.js'
import { createNativeExecutionHttpBinding } from '../lib/native-execution/http-client.js'

/** Exercise real native Fs/Bash/PTC and registered Terminal consumers.
 * @param inputs Original Agent world, bounded token/transport and actual Session header.
 * @returns Native PTC/Bash/Terminal results after consumer-owned joined teardown.
 */
export async function verifyNativeExecutionConsumers(inputs) {
  const ctx = new Context()
  try {
    const binding = createNativeExecutionHttpBinding(ctx, inputs.world, inputs.token, inputs.transport, { pollMs: 50, maxOutputBytes: 1048576 })
    installNativeExecutionProviders(ctx, { defaultMode: inputs.world.mode, resolve: () => binding })
    await ctx.plugin(SessionProjectionRegistry)
    await ctx.plugin(SandboxPolicyService, { mode: inputs.world.mode, workspaceRoot: '/workspace' })
    await ctx.plugin(SandboxBashExecutor, { cwd: '/workspace', timeoutMs: 30000, maxTimeoutMs: 60000, maxOutputBytes: 1048576, maxSpillBytes: 1048576, graceMs: 1000 })
    await ctx.plugin(NodePtcRuntime, { nodeExecutable: '/usr/local/bin/node', bootstrapPath: '/opt/power-evolve/native-ptc-process.mjs',
      timeoutMs: 30000, maxTimeoutMs: 60000, maxOutputBytes: 1048576, maxOldGenerationSizeMb: 128,
      maxMessageBytes: 1048576, maxPendingCalls: 8, graceMs: 1000 })
    const target = await ctx.fs.resolve('/workspace/native-consumer.txt')
    await ctx.fs.writeText(target, 'native consumer Fs\n')
    const bash = await ctx.shell.execute(ctx.shell.resolve({ command: 'cat native-consumer.txt; printf bash >> native-consumer.txt' }))
    const shell = await bash.result()
    assert.equal(shell.exitCode, 0); assert.match(shell.stdout.text, /native consumer Fs/)
    const ptc = await ctx.ptcRuntime.run(ctx.ptcRuntime.resolve({
      program: 'const fs = await import("node:fs/promises"); const data = await fs.readFile("native-consumer.txt", "utf8"); const result = await hostBindings.echo({data}); console.log(result); return result;',
      bindings: [{ global: 'hostBindings', functions: { echo: async args => ({ echoed: args.data, hostFs: await ctx.fs.readText(target) }) } }],
      sandboxPolicy: { mode: inputs.world.mode, workspaceRoot: '/workspace', sessionId: inputs.world.sessionId },
    }))
    assert.equal(ptc.error, undefined); assert.match(ptc.value.echoed, /bash$/); assert.equal(ptc.value.hostFs, ptc.value.echoed)
    await ctx.plugin(AgentRegistry)
    await ctx.plugin(TerminalSessionService)
    await ctx.plugin(BashTerminal, { timeoutMs: 30000, pollIntervalMs: 100, exactProbeAfterMs: 100,
      idleSilenceMs: 300, handoffGraceMs: 200, disposeGraceMs: 1000 })
    const ownerCtx = new Context(ctx), session = Session.create(inputs.header.id, undefined, inputs.header)
    const owner = { id: session.id, session, ctx: ownerCtx }
    await ctx.agents.register(owner)
    try {
      const terminal = await ctx.terminals.spawn(owner, { type: 'shell', cwd: '/workspace', name: 'native-physical' })
      const sent = ctx.terminals.startSend(owner, terminal.sessionId, { text: 'cat native-consumer.txt; printf "terminal\\n" > terminal-proof.txt', submit: true })
      const reply = await sent.done
      assert.match(reply.viewport, /native consumer Fs/)
      assert.match(await ctx.fs.readText(await ctx.fs.resolve('/workspace/terminal-proof.txt')), /terminal/)
      await ctx.terminals.kill(owner, terminal.sessionId)
      assert.deepEqual(ctx.terminals.list(owner), [])
      return { shell, ptc, terminal: { waitReason: reply.waitReason, terminated: true } }
    } finally { await ownerCtx.fiber.dispose() }
  } finally { await ctx.fiber.dispose() }
}
