/** Factory-owned native API/execution installation; files and storage authorization precede production boot. */
import { FiberState, symbols, type Context, type Fiber } from '@deepseek-ai/cordis'
import AgentLoop from '@deepseek-ai/dsh-agent-loop'
import AgentRegistry from '@deepseek-ai/dsh-agent'
import type { Agent } from '@deepseek-ai/dsh-agent'
import SessionPersistence from '@deepseek-ai/dsh-session-persistence'
import SessionController from '@deepseek-ai/dsh-api-session-controller'
import WorkspaceFiles from '@deepseek-ai/dsh-api-workspace-files'
import type { SessionSummary } from '@deepseek-ai/dsh-api-session-controller/types'
import LlmRuntime from '@deepseek-ai/dsh-llm'
import { CloudAccountApi, CloudApiError, type ConfigSaveBarrier, type ConfigSaveCoordinator, type ConfigSaveReceipt,
  type ExposureService } from '@deepseek-ai/dsh-pe-cloud-api'
import * as ApiAccount from '@deepseek-ai/dsh-pe-cloud-api/account'
import { CloudAccountFiles, type AccountFilesPreparation, type ResolveAccountFileProject } from '@deepseek-ai/dsh-pe-cloud-files'
import type { Workspace } from '@deepseek-ai/dsh-workspace'
import type { Session, SessionHeader } from '@deepseek-ai/dsh-session'
import type {} from '@deepseek-ai/dsh-working-directory'
import * as FilesAccount from '@deepseek-ai/dsh-pe-cloud-files/account'
import * as InstructionsSession from '@deepseek-ai/dsh-pe-account-instructions/session'
import { assertClosedAccountExecution, installAccountExecutionPort, type AccountExecutionPort, type SandboxCoordinator } from '@deepseek-ai/dsh-pe-opensandbox'
import * as ExecutionAccount from '@deepseek-ai/dsh-pe-opensandbox/account'
import * as RuntimeAccount from './account.ts'
import { AccountRuntimeError } from './errors.ts'
import type { SessionId } from '@deepseek-ai/dsh-session/types'
import type { AccountBinding, AccountUse } from './types.ts'
import { AccountAttachments, type AccountAttachmentLimits } from './account-attachments.ts'
import { LocalAttachmentStore } from '@deepseek-ai/dsh-attachment-local'
import { FileUploads } from '@deepseek-ai/dsh-client-file-upload'

/** Shared approved project/model/Preset checks, supplied by the trusted fixed account composition. */
export interface AccountNativeGuards {
  /** Require an original currently registered Workspace in this exact graph, without I/O. */
  readonly assertWorkspace: (workspace: Workspace) => void
  /** Select from the exact published Agent/Session and committed project facts. */
  readonly projectForAgent: (agent: Agent) => Workspace
  /** Select from the exact published native Session, without resuming an Agent. */
  readonly projectForSession: (session: Session) => Workspace
  /** Private handoff from an actual native header observation; ids and paths grant no authority. */
  readonly projectForObservedHeader: (id: SessionId, header: SessionHeader) => Workspace
  /** Native Controller directory input after shared admission; never a model file target. */
  readonly projectForDirectory: (cwd: string) => Workspace
  /** Shared Agent or original file-RPC selection, with native cold observation when needed. */
  readonly getFileProject: ResolveAccountFileProject
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
  /** Omission keeps streamed uploads and attachment-path projection closed. */
  readonly attachments?: AccountAttachmentLimits
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
  /** Original factory borrow for the installed ready graph; required only for selected cloud project creation. */
  readonly borrowAccount?: (binding: AccountBinding) => Promise<AccountUse>
  /** Existing restricted lane/grant issuer; absence cannot supply a native files owner. */
  readonly files?: (ctx: Context, binding: AccountBinding, getFileProject: ResolveAccountFileProject) => AccountFilesPreparation
  /** Actual files/project/Preset/model provider; absence rejects guarded native entry activation. */
  readonly guards?: (ctx: Context, binding: AccountBinding, files: CloudAccountFiles) => AccountNativeGuards
}

/** Fixed private builtin names for the native account recipe, not additional package Loader exports. */
export const ACCOUNT_NATIVE_ENTRIES = Object.freeze({
  runtime: 'pe-cloud-runtime-account', api: 'pe-cloud-api-account', files: 'pe-cloud-files-account', execution: 'pe-cloud-execution-account',
  instructions: 'pe-account-instructions-session',
  editor: 'pe-cloud-config-editor', credentials: 'pe-cloud-credentials',
  controller: 'pe-cloud-session-controller', agentLoop: 'pe-cloud-agent-loop', llm: 'pe-cloud-llm',
  workspaceFiles: 'pe-cloud-workspace-files',
  attachments: 'pe-cloud-attachment-store', uploads: 'pe-cloud-file-uploads',
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
    const attachmentLimits = this.input.attachments
    const attachments = attachmentLimits === undefined ? undefined : new AccountAttachments(
      ctx, binding, attachmentLimits,
      () => requireFiles(ctx), agent => requireGuards(agent.ctx).projectForAgent(agent),
      (caller) => { api.assertInstalled(caller); this.input.assertRootCurrent(); businessCurrent(binding) },
    )
    if (this.input.files !== undefined) {
      const files = this.input.files(ctx, binding, async (caller, signal) => {
        const admit = (): void => {
          this.input.assertRootCurrent()
          businessCurrent(binding)
          const invocation = caller.invocation
          if (invocation?.service === 'workspaceFiles' || invocation?.request.namespace === 'workspaceFiles') {
            if (invocation.service !== 'workspaceFiles' || invocation.request.namespace !== 'workspaceFiles') {
              throw new CloudApiError('cloud/forbidden', 'The native file invocation namespace is not selected.')
            }
            const endpoint = `workspaceFiles/${invocation.request.method}`, manifest = this.input.exposure.manifest
            if (manifest.rpcEndpoints.some(row => row.endpoint === endpoint)) api.requireRpc(endpoint)
            else if (manifest.streamEndpoints.some(row => row.endpoint === endpoint)) api.requireStream(endpoint)
            else throw new CloudApiError('cloud/forbidden', 'The native file endpoint is not selected.')
          }
        }
        admit()
        const selected = await requireGuards(caller).getFileProject(caller, signal)
        const assertCurrent = (): void => {
          admit()
          selected.assertCurrent()
          requireGuards(ctx).assertWorkspace(selected.workspace)
        }
        assertCurrent()
        return { workspace: selected.workspace, assertCurrent }
      })
      if (files.binding !== binding) {
        throw new AccountRuntimeError('cloud/stale-generation', 'Files preparation requires the exact installed graph binding')
      }
      filesOwner = new CloudAccountFiles(ctx, { ...files,
        ...attachments === undefined ? {} : { attachmentProjection: attachments },
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
    const requireFiles = (owner: Context): CloudAccountFiles => {
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
      return filesOwner
    }
    const project = (owner: Context) => {
      const installed = requireFiles(owner).project()
      if (installed.binding !== binding || installed.projectDirectory.binding !== binding) {
        throw new AccountRuntimeError('cloud/stale-generation', 'Native project directory belongs to another graph binding')
      }
      return installed
    }
    if (input.exposure.manifest.rpcEndpoints.some(row => row.endpoint === 'cloudProjects/create')) {
      const borrow = input.borrowAccount
      if (borrow === undefined) {
        throw new AccountRuntimeError('cloud/account-unavailable', 'Cloud project creation requires the original ready-account borrow.')
      }
      api.prepareCloudProjects(ctx, { createProject: async (title, signal) => {
        this.input.assertRootCurrent()
        businessCurrent(binding)
        signal.throwIfAborted()
        const use = await borrow(binding)
        try {
          use.assertCurrent()
          if (use.binding !== binding || use.context !== ctx) {
            throw new AccountRuntimeError('cloud/stale-generation', 'Project creation requires the original installed account borrow.')
          }
          signal.throwIfAborted()
          const workspace = await requireFiles(ctx).createProject(use, title, signal)
          requireGuards(ctx).assertWorkspace(workspace)
          use.assertCurrent()
          this.input.assertRootCurrent()
          businessCurrent(binding)
          return { workspace: { workspaceId: workspace.id, path: workspace.path, title: workspace.title,
            sessionIds: [...workspace.sessionIds], createdAt: workspace.createdAt, updatedAt: workspace.updatedAt } }
        } finally { use.release() }
      } })
    }
    // Files may expose native dependencies before its final directory verification settles.
    // API business admission precedes this fixed-binding projection; construction never reads a partial project.
    const projectDirectory = Object.freeze({ binding, prepare: async (cwd: string) => {
      this.input.assertRootCurrent()
      businessCurrent(binding)
      const approved = requireGuards(ctx), workspace = approved.projectForDirectory(cwd)
      const source = requireFiles(ctx)
      const installed = await source.projectFor(workspace, binding.lifetime)
      this.input.assertRootCurrent()
      businessCurrent(binding)
      approved.assertWorkspace(workspace)
      await installed.projectDirectory.prepare(cwd)
      this.input.assertRootCurrent()
      businessCurrent(binding)
      approved.assertWorkspace(workspace)
      const checked = await requireFiles(ctx).projectFor(workspace, binding.lifetime)
      this.input.assertRootCurrent()
      businessCurrent(binding)
      approved.assertWorkspace(workspace)
      if (checked.binding !== binding || checked.workspace !== workspace || checked.projectDirectory.binding !== binding) {
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
          const approved = requireGuards(agent.ctx), workspace = approved.projectForAgent(agent)
          const directory = ctx.get('workingDirectory')
          if (directory === undefined) {
            throw new AccountRuntimeError('cloud/account-unavailable', 'Native instruction sources require the original WorkingDirectory provider')
          }
          const originalDirectory: unknown = Reflect.get(directory, symbols.original) ?? directory
          const currentCwd = (): string => {
            const local = agent.ctx.get('workingDirectory'), account = ctx.get('workingDirectory'), root = ctx.root.get('workingDirectory')
            if (local === undefined || account === undefined || root === undefined
              || [local, account, root].some(value => (Reflect.get(value, symbols.original) ?? value) !== originalDirectory)) {
              throw new AccountRuntimeError('cloud/stale-generation', 'The native instruction WorkingDirectory provider changed')
            }
            return local.get(agent.session)
          }
          const cwd = currentCwd()
          const current = (): void => {
            active(agent)
            if (approved.projectForAgent(agent) !== workspace || currentCwd() !== cwd) {
              throw new AccountRuntimeError('cloud/stale-generation', 'The native instruction project or current directory changed during preparation')
            }
          }
          current()
          const installed = await sources.projectFor(workspace, signal)
          current()
          const held = await sources.withInstructionReaders(installed.workspace, bytes, async (readers, control) => {
            current()
            const value = await build(installed.workspace.id, readers, control, currentCwd())
            current()
            return value
          }, signal)
          try { current(); return held }
          catch (error) { held.release(); throw error }
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
      project: () => project(ctx),
      assertWorkspace: (workspace) => { requireGuards(ctx).assertWorkspace(workspace) }, assertSessionRead: readSession,
      maxInventoryEntries: input.maxNativeInventoryEntries,
      maxCollectionItems: firstScreenInput.maxCollectionItems, maxFrameBytes: firstScreenInput.maxFrameBytes,
    })
    const controller = {
      inject: [...SessionController.inject, 'peCloudApi'], Config: SessionController.Config,
      apply(owner: Context, config: ConstructorParameters<typeof SessionController>[1]) {
        api.createController(owner, { ...requireGuards(owner).sessions, projectDirectory,
          ...attachments === undefined ? {} : { preparePromptFiles: attachments.preparePromptFiles.bind(attachments) },
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
      [ACCOUNT_NATIVE_ENTRIES.workspaceFiles]: {
        inject: [...WorkspaceFiles.inject, 'peCloudApi'], Config: WorkspaceFiles.Config,
        apply(owner: Context, nativeConfig: ConstructorParameters<typeof WorkspaceFiles>[1]) {
          api.createWorkspaceFiles(owner, nativeConfig)
        },
      },
      ...attachments === undefined || attachmentLimits === undefined ? {} : {
        [ACCOUNT_NATIVE_ENTRIES.attachments]: {
          inject: ['peCloudFiles'], Config: LocalAttachmentStore.Config,
          apply(owner: Context, config: ConstructorParameters<typeof LocalAttachmentStore>[1]) {
            if (filesOwner === undefined) throw new AccountRuntimeError('cloud/account-unavailable', 'The original account files owner is unavailable')
            const Store = filesOwner.attachmentStore()
            new Store(owner, config)
          },
        },
        [ACCOUNT_NATIVE_ENTRIES.uploads]: {
          inject: [...FileUploads.inject, 'peCloudApi'],
          apply(owner: Context) {
            api.createFileUploads(owner, { maxPendingReceipts: attachmentLimits.maxPendingReceipts,
              storeFileStream: attachments.storeFileStream.bind(attachments) })
          },
        },
      },
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
