/** Original Native argv handoff to the signed remote guardian. */
import type { Context } from '@deepseek-ai/cordis'
import { SandboxProvider, SandboxUnavailableError, type ConfinedArgv, type SandboxPolicy } from '@deepseek-ai/dsh-sandbox'
import type {} from '@deepseek-ai/dsh-sandbox-policy'
import type { Workspace } from '@deepseek-ai/dsh-workspace'
import type { NativeExecutionCalls } from './native-calls.ts'
import type { ExecutionScope } from './scopes.ts'
import type { NativeFilePolicy } from './agent-data/file-policy.ts'
import { selectNativeFilePolicy } from './native-file-policy.ts'
import { ExecutionStateError } from './errors.ts'

/** Root-owned actual guard/profile check; invocation admission remains with NativeExecutionCalls. Never serialized account config. */
export interface NativeConfinementProfile {
  /** @param scope Original currently admitted invocation. @param policy Exact Native per-call policy.
   * @returns Existing qualified profile's enforcement facts; omission keeps the candidate closed.
   */
  current(scope: ExecutionScope<Workspace>, policy: Readonly<SandboxPolicy>): Readonly<Omit<ConfinedArgv, 'argv'>> | undefined
}

/** Original signed prepare inputs after one exact-array consumption, not a new execution authority. */
export interface ConsumedNativeConfinement {
  readonly scope: ExecutionScope<Workspace>
  readonly argv: readonly string[]
  readonly filePolicy: NativeFilePolicy
  readonly policy: Readonly<SandboxPolicy>
}

interface Binding extends ConsumedNativeConfinement {
  readonly policy: Readonly<SandboxPolicy>
  readonly standingMode: 'read-only' | 'workspace-write' | 'danger-full-access'
  readonly signal: AbortSignal | undefined
}

/** Native service over one account's already-issued invocation scopes and Root's enforcing prepare path. */
export class CloudSandboxProvider extends SandboxProvider {
  private bindings = new WeakMap<readonly string[], Binding>()
  private open = true

  /** @param ctx Original account service scope. @param calls Original account's existing Native invocation issuer.
   * @param profile Root's actual qualified backend guard; no default or label can replace it.
   * @param limits Same finite argv limits enforced by the original command owner.
   */
  constructor(ctx: Context, private readonly calls: NativeExecutionCalls<Workspace>,
    private readonly profile: NativeConfinementProfile,
    private readonly limits: Readonly<{ maxArgvEntries: number; maxArgvBytes: number }>) {
    super(ctx)
    for (const value of Object.values(limits)) if (!Number.isSafeInteger(value) || value < 1) {
      throw new RangeError('Native confinement requires the original finite argv limits.')
    }
    ctx.effect(() => () => { this.close() }, 'pe-opensandbox: revoke Native argv handoffs')
  }

  // oxlint-disable-next-line typescript/require-await -- Admission failures reject through the asynchronous provider API.
  override async confine(argv: readonly string[], policy: SandboxPolicy, signal?: AbortSignal): Promise<ConfinedArgv> {
    this.assertOpen()
    const call = this.calls.capture(this.ctx)
    call.signal.throwIfAborted(); signal?.throwIfAborted()
    if (argv.length === 0 || argv.length > this.limits.maxArgvEntries || !argv.every(value => !value.includes('\0'))
      || argv.reduce((total, value) => total + Buffer.byteLength(value) + 1, 0) > this.limits.maxArgvBytes) throw this.refusal()
    const selected = Object.freeze({ mode: policy.mode, workspaceRoot: policy.workspaceRoot,
      ...policy.sessionId === undefined ? {} : { sessionId: policy.sessionId } })
    const standingMode = selectNativeFilePolicy(this.ctx, call.scope.agent.session, call.scope.project.path).mode
    const filePolicy = selectNativeFilePolicy(this.ctx, call.scope.agent.session, call.scope.project.path, selected)
    const facts = this.profile.current(call.scope, selected)
    if (facts === undefined) throw new SandboxUnavailableError(policy.mode, 'The remote guard/profile is not qualified.')
    call.signal.throwIfAborted(); signal?.throwIfAborted()
    const independent = [...argv]
    this.bindings.set(independent, { scope: call.scope, argv: Object.freeze([...argv]), filePolicy,
      policy: selected, standingMode, signal })
    return { argv: independent, enforcement: facts.enforcement,
      denialSignatures: [...facts.denialSignatures], runnerFailureRules: facts.runnerFailureRules.map(rule => ({ ...rule,
        fatalSignatures: [...rule.fatalSignatures],
        ...rule.allowedExitCodes === undefined ? {} : { allowedExitCodes: [...rule.allowedExitCodes] },
        ...rule.informationalLines === undefined ? {} : { informationalLines: [...rule.informationalLines] },
      })) }
  }

  /** Consume only within the original still-active Native invocation; Root must sign this same filePolicy before start.
   * @param caller Actual account subprocess service caller.
   * @param argv Original returned array, without copying.
   * @param signal Current Native spawn cancellation.
   * @returns Immutable original argv and policy for existing signed prepare.
   */
  consume(caller: Context, argv: readonly string[], signal?: AbortSignal): ConsumedNativeConfinement {
    this.assertOpen()
    const call = this.calls.capture(caller), held = this.bindings.get(argv)
    call.signal.throwIfAborted(); signal?.throwIfAborted()
    if (held === undefined || held.scope !== call.scope || argv.length !== held.argv.length
      || argv.some((value, index) => value !== held.argv[index])) throw this.refusal()
    held.signal?.throwIfAborted()
    if (selectNativeFilePolicy(caller, call.scope.agent.session, call.scope.project.path).mode !== held.standingMode) throw this.refusal()
    const current = selectNativeFilePolicy(caller, call.scope.agent.session, call.scope.project.path, held.policy)
    if (current.mode !== held.filePolicy.mode || this.profile.current(call.scope, held.policy) === undefined) throw this.refusal()
    this.bindings.delete(argv)
    return Object.freeze({ scope: held.scope, argv: held.argv, filePolicy: held.filePolicy, policy: held.policy })
  }

  /** Revoke pending handoffs only; existing process/terminal handles retain their original Root cleanup owner. */
  close(): void { this.open = false; this.bindings = new WeakMap() }
  private assertOpen(): void { if (!this.open) throw this.refusal() }
  private refusal(): Error { return new ExecutionStateError('cloud/execution-unavailable', 'Native confinement requires its original active invocation and argv handoff.') }
}
