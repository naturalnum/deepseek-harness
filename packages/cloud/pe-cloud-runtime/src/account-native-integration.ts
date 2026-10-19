/** Factory-owned native API/execution installation; files and storage authorization precede production boot. */
import { FiberState, symbols, type Context, type Fiber } from '@deepseek-ai/cordis'
import AgentLoop from '@deepseek-ai/dsh-agent-loop'
import AgentRegistry from '@deepseek-ai/dsh-agent'
import SessionPersistence from '@deepseek-ai/dsh-session-persistence'
import SessionController from '@deepseek-ai/dsh-api-session-controller'
import type { SessionSummary } from '@deepseek-ai/dsh-api-session-controller/types'
import LlmRuntime from '@deepseek-ai/dsh-llm'
import { CloudAccountApi, type ConfigSaveBarrier, type ConfigSaveCoordinator, type ConfigSaveReceipt,
  type ExposureService } from '@deepseek-ai/dsh-pe-cloud-api'
import * as ApiAccount from '@deepseek-ai/dsh-pe-cloud-api/account'
import { CloudAccountFiles, type AccountFilesPreparation } from '@deepseek-ai/dsh-pe-cloud-files'
import * as FilesAccount from '@deepseek-ai/dsh-pe-cloud-files/account'
import * as InstructionsSession from '@deepseek-ai/dsh-pe-account-instructions/session'
import { assertClosedAccountExecution, installAccountExecutionPort, type AccountExecutionPort, type SandboxCoordinator } from '@deepseek-ai/dsh-pe-opensandbox'
import * as ExecutionAccount from '@deepseek-ai/dsh-pe-opensandbox/account'
import * as RuntimeAccount from './account.ts'
import { AccountRuntimeError } from './errors.ts'
import type { SessionId } from '@deepseek-ai/dsh-session/types'
import type { AccountBinding } from './types.ts'

/** Shared approved project/model/Preset checks, supplied by the trusted fixed account composition. */
export interface AccountNativeGuards {
  readonly sessions: Omit<Parameters<CloudAccountApi['createController']>[1], 'projectDirectory'>
  readonly agents: Parameters<CloudAccountApi['createAgentLoop']>[1]
  readonly allowedModel: Parameters<CloudAccountApi['installLlmGuard']>[1]
  /** Original synchronous readonly Session metadata check; required only for first-screen selection. */
  readonly assertSessionRead?: (id: SessionId, summary?: SessionSummary) => void
  /** Read the same original project/Preset/default-model policy without creating business resources. */
  readonly assertBootstrapCurrent: (signal?: AbortSignal) => Promise<void>
}

/** Actual Root resources, retained by the factory; none is installed as an account Root service. */
export interface AccountNativePreparation {
  readonly saves: ConfigSaveCoordinator
  readonly exposure: ExposureService['policy']
  readonly execution: SandboxCoordinator
  readonly stopTimeoutMs: number
  /** Existing Root native.maxEntries bounds each bootstrap native inventory read. */
  readonly maxNativeInventoryEntries: number
  /** Optional fixed readonly first-screen composition; every limit and exact graph home is required when selected. */
  readonly firstScreen?: {
    readonly home: string
    readonly maxHomeBytes: number
    readonly maxCollectionItems: number
    readonly maxFrameBytes: number
    readonly maxQueuedEvents: number
    readonly maxQueuedBytes: number
  }
  /** Actual Root seal recheck for business dispatch and ready publication, independent of mounting. */
  readonly assertRootCurrent: () => void
  /** Existing restricted lane/grant issuer; absence cannot supply a native files owner. */
  readonly files?: (ctx: Context, binding: AccountBinding) => AccountFilesPreparation
  /** Actual files/project/Preset/model provider; absence rejects guarded native entry activation. */
  readonly guards?: (ctx: Context, binding: AccountBinding, files: CloudAccountFiles) => AccountNativeGuards
}

/** Fixed private builtin names for the native account recipe, not additional package Loader exports. */
export const ACCOUNT_NATIVE_ENTRIES = Object.freeze({
  runtime: 'pe-cloud-runtime-account', api: 'pe-cloud-api-account', files: 'pe-cloud-files-account', execution: 'pe-cloud-execution-account',
  instructions: 'pe-account-instructions-session',
  editor: 'pe-cloud-config-editor', credentials: 'pe-cloud-credentials',
  controller: 'pe-cloud-session-controller', agentLoop: 'pe-cloud-agent-loop', llm: 'pe-cloud-llm',
})

/** Additional fixed private builtins selected only with explicit first-screen inputs. */
export const ACCOUNT_FIRST_SCREEN_ENTRIES = Object.freeze({
  workspaceController: 'pe-cloud-workspace-controller', settingsController: 'pe-cloud-settings-controller',
  events: 'pe-cloud-first-screen-events',
})

/** One graph's real save barrier/API/execution ownership, including partially completed preparation. */
export class AccountNativeIntegration {
  private api: CloudAccountApi | undefined
  private saves: ConfigSaveBarrier | undefined
  private execution: AccountExecutionPort | undefined
  private prepared = false
  private stopping: Promise<ConfigSaveReceipt | undefined> | undefined
  private bootstrap: (() => Promise<void>) | undefined
  private bootstrapping: Promise<void> | undefined
  private loopFiber: Fiber | undefined
  private loop: AgentLoop | undefined
  private agents: Context['agents'] | undefined
  private persistence: Context['sessionPersistence'] | undefined
  private nativeDrain: Readonly<{ nativeIdle: true; persistenceFlushed: true }> | undefined

  /**
   * @param input Actual Root resources; storage approval is independently required before production boot.
   */
  constructor(private readonly input: AccountNativePreparation) {
    if (!Number.isSafeInteger(input.maxNativeInventoryEntries) || input.maxNativeInventoryEntries < 1) {
      throw new AccountRuntimeError('cloud/invalid-config', 'Native preparation requires its existing finite inventory limit')
    }
  }

  /**
   * Issue from the exact installed binding and fix native constructors before Include activation.
   * @param ctx Independent native prepare scope, never the shared Root context.
   * @param binding Exact runtime-installed generation.
   * @param mountCurrent Factory's preparation/current check.
   * @param businessCurrent Factory's separate ready-publication check.
   * @param unpublished Factory's actual mounting-only registration window.
   */
  prepare(
    ctx: Context, binding: AccountBinding,
    mountCurrent: (binding: AccountBinding) => void, businessCurrent: (binding: AccountBinding) => void,
    unpublished: () => void,
  ): void {
    if (this.prepared || this.stopping !== undefined) {
      throw new AccountRuntimeError('cloud/account-unavailable', 'Native account preparation is already owned or closing')
    }
    this.prepared = true
    mountCurrent(binding)
    this.saves = this.input.saves.createAccount(binding)
    const api = new CloudAccountApi(ctx, {
      binding, saves: this.saves, rootExposure: this.input.exposure, selected: this.input.exposure.manifest,
      assertMountCurrent: mountCurrent,
      assertBusinessCurrent: (current) => { this.input.assertRootCurrent(); businessCurrent(current) },
      assertBootstrapCurrent: signal => requireGuards(ctx).assertBootstrapCurrent(signal),
      maxNativeInventoryEntries: this.input.maxNativeInventoryEntries,
      assertUnpublished: unpublished,
    })
    this.api = api
    this.execution = this.input.execution.bindAccount(ctx, binding, () => { mountCurrent(binding) })
    installAccountExecutionPort(ctx, this.execution)
    let filesOwner: CloudAccountFiles | undefined
    if (this.input.files !== undefined) {
      const files = this.input.files(ctx, binding)
      if (files.binding !== binding) {
        throw new AccountRuntimeError('cloud/stale-generation', 'Files preparation requires the exact installed graph binding')
      }
      filesOwner = new CloudAccountFiles(ctx, { ...files,
        assertMountCurrent: (current) => { mountCurrent(current); files.assertMountCurrent(current) },
        assertUnpublished: () => { unpublished(); files.assertUnpublished() },
      })
    }
    const input = this.input
    let guards: AccountNativeGuards | undefined
    const requireGuards = (owner: Context): AccountNativeGuards => {
      api.assertInstalled(owner)
      if (filesOwner === undefined) {
        throw new AccountRuntimeError('cloud/account-unavailable', 'The actual account files owner is not connected')
      }
      filesOwner.assertInstalled(owner)
      guards ??= input.guards?.(ctx, binding, filesOwner)
      if (guards === undefined) {
        throw new AccountRuntimeError('cloud/account-unavailable', 'Native account project, model and Preset guards are not connected')
      }
      return guards
    }
    const project = (owner: Context) => {
      requireGuards(owner)
      const entries: NonNullable<Fiber['entry']>[] = []
      let visited = 0
      for (const entry of owner.loader.entries()) {
        if (++visited > input.maxNativeInventoryEntries) {
          throw new AccountRuntimeError('cloud/account-unavailable', 'Native files inventory exceeds its explicit limit')
        }
        if (entry.moduleNamespace === FilesAccount) entries.push(entry)
        if (entries.length > 1) throw new AccountRuntimeError('cloud/account-unavailable', 'Native files account entry is duplicated')
      }
      if (entries.length !== 1 || entries[0]?.fiber?.state !== FiberState.ACTIVE) {
        throw new AccountRuntimeError('cloud/account-unavailable', 'The actual files account entry is not uniquely active')
      }
      if (filesOwner === undefined) {
        throw new AccountRuntimeError('cloud/account-unavailable', 'The actual account files owner is not connected')
      }
      const installed = filesOwner.project()
      if (installed.binding !== binding || installed.projectDirectory.binding !== binding) {
        throw new AccountRuntimeError('cloud/stale-generation', 'Native project directory belongs to another graph binding')
      }
      return installed
    }
    // Files may expose native dependencies before its final directory verification settles.
    // API business admission precedes this fixed-binding projection; construction never reads a partial project.
    const projectDirectory = Object.freeze({ binding, prepare: async (cwd: string) => {
      const installed = project(ctx)
      await installed.projectDirectory.prepare(cwd)
      if (project(ctx) !== installed) {
        throw new AccountRuntimeError('cloud/stale-generation', 'The account files project changed during directory preparation')
      }
    } })
    if (filesOwner !== undefined) {
      const sources = filesOwner
      const active = (agent: Parameters<AccountNativeGuards['sessions']['assertActiveScope']>[0]): void => {
        this.input.assertRootCurrent()
        businessCurrent(binding)
        sources.assertInstalled(agent.ctx)
        requireGuards(agent.ctx).sessions.assertActiveScope(agent)
      }
      new InstructionsSession.AccountInstructionSources(ctx, {
        binding,
        assertInstalled: (owner) => { api.assertInstalled(owner); sources.assertInstalled(owner) },
        assertCurrent: active,
        async withSources(agent, bytes, build, signal) {
          active(agent)
          const installed = project(agent.ctx)
          return sources.withInstructionReaders(installed.workspace, bytes, async (readers, control) => {
            active(agent)
            const value = await build(installed.workspace.id, readers, control)
            active(agent)
            if (project(agent.ctx) !== installed) {
              throw new AccountRuntimeError('cloud/stale-generation', 'The native instruction project changed during preparation')
            }
            return value
          }, signal)
        },
      })
    }
    const readSession = (id: SessionId, summary?: SessionSummary): void => {
      const approved = requireGuards(ctx), check = approved.assertSessionRead
      if (check === undefined) {
        throw new AccountRuntimeError('cloud/account-unavailable', 'The original shared readonly Session metadata check is absent')
      }
      check(id, summary)
    }
    const firstScreenInput = input.firstScreen
    const firstScreen = firstScreenInput === undefined ? undefined : api.prepareFirstScreen(ctx, {
      project: () => project(ctx), assertSessionRead: readSession,
      maxInventoryEntries: input.maxNativeInventoryEntries,
      maxCollectionItems: firstScreenInput.maxCollectionItems, maxFrameBytes: firstScreenInput.maxFrameBytes,
    })
    const controller = {
      inject: [...SessionController.inject, 'peCloudApi'], Config: SessionController.Config,
      apply(owner: Context, config: ConstructorParameters<typeof SessionController>[1]) {
        api.createController(owner, { ...requireGuards(owner).sessions, projectDirectory,
          ...firstScreenInput === undefined ? {} : { firstScreen: {
            assertSessionRead: readSession, maxCollectionItems: firstScreenInput.maxCollectionItems,
            maxFrameBytes: firstScreenInput.maxFrameBytes,
            maxQueuedEvents: firstScreenInput.maxQueuedEvents, maxQueuedBytes: firstScreenInput.maxQueuedBytes,
          } },
        }, config)
      },
    }
    const agentLoop = {
      inject: [...AgentLoop.inject, 'peCloudApi'], Config: AgentLoop.Config,
      apply: (owner: Context, config: ConstructorParameters<typeof AgentLoop>[1]) => {
        this.loop = api.createAgentLoop(owner, requireGuards(owner).agents, config)
        this.loopFiber = owner.fiber
        const agents = owner.get('agents'), persistence = owner.get('sessionPersistence')
        const rawAgents: unknown = agents === undefined ? undefined : Reflect.get(agents, symbols.original) ?? agents
        const rawPersistence: unknown = persistence === undefined ? undefined : Reflect.get(persistence, symbols.original) ?? persistence
        this.agents = rawAgents instanceof AgentRegistry ? rawAgents : undefined
        this.persistence = rawPersistence instanceof SessionPersistence ? rawPersistence : undefined
      },
    }
    const llm = {
      inject: ['peCloudApi', 'peCloudFiles', 'fs', 'workspaceRegistry'],
      apply(owner: Context) {
        const approved = requireGuards(owner)
        new LlmRuntime(owner)
        api.installLlmGuard(owner, approved.allowedModel)
      },
    }
    const builtins = ctx.loader.builtins
    const entries = {
      [ACCOUNT_NATIVE_ENTRIES.runtime]: RuntimeAccount,
      [ACCOUNT_NATIVE_ENTRIES.api]: ApiAccount,
      [ACCOUNT_NATIVE_ENTRIES.files]: FilesAccount,
      [ACCOUNT_NATIVE_ENTRIES.instructions]: InstructionsSession,
      [ACCOUNT_NATIVE_ENTRIES.execution]: ExecutionAccount,
      [ACCOUNT_NATIVE_ENTRIES.editor]: api.providers.configEditor,
      [ACCOUNT_NATIVE_ENTRIES.credentials]: api.providers.credentials,
      [ACCOUNT_NATIVE_ENTRIES.controller]: controller,
      [ACCOUNT_NATIVE_ENTRIES.agentLoop]: agentLoop,
      [ACCOUNT_NATIVE_ENTRIES.llm]: llm,
    }
    let eventOwner: Context | undefined
    const firstScreenEntries = firstScreen === undefined || firstScreenInput === undefined ? {} : {
      [ACCOUNT_FIRST_SCREEN_ENTRIES.workspaceController]: firstScreen.workspaceController,
      [ACCOUNT_FIRST_SCREEN_ENTRIES.settingsController]: firstScreen.settingsController,
      [ACCOUNT_FIRST_SCREEN_ENTRIES.events]: {
        inject: ['peCloudApi', 'workspaceController', 'settingsController', 'remoteAccess', 'typertGateway'],
        apply(owner: Context) {
          api.assertInstalled(owner)
          if (eventOwner !== undefined) {
            throw new AccountRuntimeError('cloud/account-unavailable', 'The original first-screen registration entry is duplicated')
          }
          eventOwner = owner
        },
      },
    }
    for (const key of [...Object.keys(entries), ...Object.keys(firstScreenEntries)]) {
      if (Object.hasOwn(builtins, key)) {
        throw new AccountRuntimeError('cloud/invalid-config', 'A fixed native account builtin has already been installed')
      }
    }
    Object.assign(builtins, entries, firstScreenEntries)
    this.bootstrap = async () => {
      this.input.assertRootCurrent()
      mountCurrent(binding)
      unpublished()
      const installed = project(ctx)
      if (this.agents === undefined || this.persistence === undefined || this.loopFiber?.state !== FiberState.ACTIVE) {
        throw new AccountRuntimeError('cloud/account-unavailable', 'Native Agent lifecycle and persistence owners are missing')
      }
      assertClosedAccountExecution(ctx)
      const saves = await api.pauseAccountChanges(Date.now() + input.stopTimeoutMs, binding.lifetime)
      if (saves.status !== 'confirmed') {
        throw new AccountRuntimeError('cloud/stop-unconfirmed', 'Original native startup configuration saves have not settled')
      }
      this.input.assertRootCurrent()
      mountCurrent(binding)
      unpublished()
      for (const provider of [api.providers.configEditor, api.providers.credentials]) {
        let count = 0, visited = 0
        for (const entry of ctx.loader.entries()) {
          if (++visited > input.maxNativeInventoryEntries) {
            throw new AccountRuntimeError('cloud/account-unavailable', 'Native writer inventory exceeds its explicit limit')
          }
          if (entry.moduleNamespace !== provider) continue
          if (++count !== 1 || entry.fiber?.state !== FiberState.ACTIVE || entry.fiber.runtime?.callback !== provider) {
            throw new AccountRuntimeError('cloud/account-unavailable', 'The original guarded native writer is inactive or replaced')
          }
        }
        if (count !== 1) throw new AccountRuntimeError('cloud/account-unavailable', 'The original guarded native writer is missing')
      }
      if (firstScreenInput !== undefined) {
        if (requireGuards(ctx).assertSessionRead === undefined) {
          throw new AccountRuntimeError('cloud/account-unavailable', 'The original shared readonly Session metadata check is absent')
        }
        if (eventOwner?.fiber.state !== FiberState.ACTIVE) {
          throw new AccountRuntimeError('cloud/account-unavailable', 'The original first-screen registration entry is absent')
        }
        api.installFirstScreenEvents(eventOwner, { ...firstScreenInput, maxInventoryEntries: input.maxNativeInventoryEntries })
      }
      await api.auditPrepared(ctx)
      this.input.assertRootCurrent()
      mountCurrent(binding)
      unpublished()
      if (project(ctx) !== installed) throw new AccountRuntimeError('cloud/stale-generation', 'Prepared files project changed')
      assertClosedAccountExecution(ctx)
      api.resumeAccountChanges()
    }
    ctx.effect(() => () => { api.invalidate(); this.execution?.close() }, 'pe-cloud-runtime: revoke prepared API and execution')
    mountCurrent(binding)
  }

  /**
   * Verify actual original native owners and handlers before the factory's ready CAS.
   * @returns The retained unpublished audit; failure grants no business admission.
   */
  finishBootstrap(): Promise<void> {
    if (this.stopping !== undefined || this.bootstrap === undefined) {
      return Promise.reject(new AccountRuntimeError('cloud/account-unavailable', 'Native bootstrap audit is absent or closing'))
    }
    this.bootstrapping ??= this.bootstrap()
    return this.bootstrapping
  }

  /**
   * Read only the original native lifecycle and persistence settlement.
   * @returns Actual joined observations, absent until both original native owners have settled.
   */
  observeNativeDrain(): Readonly<{ nativeIdle: true; persistenceFlushed: true }> | undefined { return this.nativeDrain }

  /** Release the original save slot only after factory-owned complete drain and owner commit. */
  releaseAfterActualDrain(): void {
    if (this.nativeDrain === undefined || this.saves === undefined) {
      throw new AccountRuntimeError('cloud/stop-unconfirmed', 'Original native drain evidence is absent')
    }
    this.input.saves.releaseAccount(this.saves)
  }

  /**
   * Close new API/execution work before native disposal; unknown saves retain their hooks and graph.
   * @returns Actual existing save evidence; undefined means preparation never issued a barrier.
   */
  stop(): Promise<ConfigSaveReceipt | undefined> {
    this.api?.invalidate()
    this.execution?.close()
    this.stopping ??= (async () => {
      const receipt = await this.saves?.stopConfigSaves(Date.now() + this.input.stopTimeoutMs)
      if (receipt?.status === 'confirmed') {
        // The original audit may still own a native metadata read; joining is not a successful audit.
        try { await this.bootstrapping } catch (_cause) { /* factory retains the original assembly failure */ }
        await this.api?.stopFirstScreenEvents()
        await this.loop?.stop()
        if (this.agents !== undefined && this.agents.list().length !== 0) {
          throw new AccountRuntimeError('cloud/stop-unconfirmed', 'Native Agent lifecycle work has not settled')
        }
        await this.persistence?.flush()
        if (this.loopFiber !== undefined && this.agents !== undefined && this.persistence !== undefined) {
          this.nativeDrain = Object.freeze({ nativeIdle: true, persistenceFlushed: true })
        }
        await this.api?.withdraw()
      }
      return receipt
    })()
    return this.stopping
  }
}
