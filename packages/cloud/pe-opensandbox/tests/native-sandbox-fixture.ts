/** Real Native policy/Agents/Registry with a deliberately unqualified external-profile fixture. */
import { expect, onTestFinished } from 'vitest'
import SandboxPolicyService from '@deepseek-ai/dsh-sandbox-policy'
import { defineTool } from '@deepseek-ai/dsh-tools'
import { ToolCallId } from '@deepseek-ai/dsh-llm'
import { NativeExecutionCalls } from '@deepseek-ai/dsh-pe-opensandbox/src/native-calls.ts'
import { policyFixture } from '../../pe-cloud-runtime/tests/account-policy-fixture.ts'
import { CloudSandboxProvider, type NativeConfinementProfile } from '../src/native-sandbox.ts'

export async function fixture(accountId = 'native-sandbox-candidate') {
  const f = policyFixture([], undefined, accountId), graph = await f.start()
  await graph.ctx.plugin(SandboxPolicyService, { mode: 'workspace-write', workspaceRoot: f.project })
  const { sessionId } = await graph.ctx.sessionController.create({})
  const agent = graph.ctx.agents.get(sessionId)
  if (agent === undefined) throw new Error('Original Native Agent absent')
  const workspace = graph.guards.projectForAgent(agent)
  const calls = new NativeExecutionCalls(graph.ctx, { binding: graph.binding, maxScopes: 8,
    allowedTools: ['candidate_confinement', 'candidate_ptc', 'candidate_terminal'],
    getAgent: id => graph.ctx.agents.get(id), projectForAgent: current => graph.guards.projectForAgent(current),
    assertCurrent: (scope) => {
      if (graph.guards.projectForAgent(scope.agent) !== scope.project
        || graph.guards.projectForSession(scope.agent.session) !== scope.project) throw new Error('Original Native scope changed')
    }, released() {},
  })
  const state = { fixtureProfile: true }
  // This scripted profile is for handoff tests only. It is never installed as Root readiness or a product capability.
  const facts = Object.freeze({ enforcement: 'partial' as const,
    denialSignatures: ['Read-only file system'], runnerFailureRules: [] })
  const profile: NativeConfinementProfile = { current(_scope) {
    return state.fixtureProfile ? facts : undefined
  } }
  const sandbox = new CloudSandboxProvider(graph.ctx, calls, profile, { maxArgvEntries: 32, maxArgvBytes: 16384 })
  onTestFinished(() => { calls.close(); sandbox.close() })
  let sequence = 0
  const run = async <T>(name: string, operation: (signal: AbortSignal) => Promise<T>,
    selected = agent, signal?: AbortSignal): Promise<T> => {
    let value: T | undefined, failure: unknown
    const unregister = graph.ctx.tools.register(defineTool({ name, description: 'Candidate-only Native handoff composition', parameters: {},
      output: { schema: { type: 'null' }, render: () => [] },
      async execute(_args, exec) {
        try { value = await operation(exec.signal) } catch (error) { failure = error; throw error }
        return null
      } }))
    try {
      const result = await graph.ctx.tools.execute({ callId: ToolCallId(`candidate-${++sequence}`), name, arguments: {}, agent: selected,
        signal: signal ?? new AbortController().signal })
      if (failure !== undefined) throw failure
      if (result.isError) throw new Error(JSON.stringify(result.content))
      return value as T
    } finally { unregister() }
  }
  const policy = () => {
    const resolved = graph.ctx.sandboxPolicy.resolve({ session: agent.session })
    expect(resolved.mode).not.toBe('danger-full-access')
    if (resolved.mode === 'danger-full-access') throw new Error('Expected confined policy')
    return { ...resolved, mode: resolved.mode }
  }
  return { ...f, graph, agent, workspace, calls, sandbox, profile, state, run, policy }
}
