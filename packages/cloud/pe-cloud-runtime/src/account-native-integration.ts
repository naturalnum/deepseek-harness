/** Factory-owned native API/execution installation; files and storage authorization precede production boot. */
import SubagentRuntime from '@deepseek-ai/dsh-subagent'
import { FiberState, symbols, type Context, type Fiber } from '@deepseek-ai/cordis'
import AgentLoop from '@deepseek-ai/dsh-agent-loop'
import AgentRegistry from '@deepseek-ai/dsh-agent'
import type { Agent } from '@deepseek-ai/dsh-agent'
import SessionPersistence from '@deepseek-ai/dsh-session-persistence'
import SessionController from '@deepseek-ai/dsh-api-session-controller'
import WorkspaceFiles from '@deepseek-ai/dsh-api-workspace-files'
import OfficeToPdf from '@deepseek-ai/dsh-office-to-pdf'
import type { SessionSummary } from '@deepseek-ai/dsh-api-session-controller/types'
import LlmRuntime from '@deepseek-ai/dsh-llm'
import { CloudAccountApi, CloudApiError, type ConfigSaveBarrier, type ConfigSaveCoordinator, type ConfigSaveReceipt,
  type ExposureService, type ExactFetchExposure, type CloudModelKeyPreparation,
  type CloudSkillPreparation, type CloudSkillService, type ManagedSkillPreparation, type CloudPluginPreparation,
  type AccountOfficeLifecycle } from '@deepseek-ai/dsh-pe-cloud-api'
import * as ApiAccount from '@deepseek-ai/dsh-pe-cloud-api/account'
import { CloudAccountFiles, type AccountFilesPreparation, type ResolveAccountFileProject } from '@deepseek-ai/dsh-pe-cloud-files'
import type { Workspace } from '@deepseek-ai/dsh-workspace'
import type { Session, SessionHeader } from '@deepseek-ai/dsh-session'
import type {} from '@deepseek-ai/dsh-working-directory'
import * as FilesAccount from '@deepseek-ai/dsh-pe-cloud-files/account'
import * as InstructionsSession from '@deepseek-ai/dsh-pe-account-instructions/session'
import { assertAccountExecutionProviders, installAccountExecutionPort, type AccountExecutionPort, type SandboxCoordinator } from '@deepseek-ai/dsh-pe-opensandbox'
import * as ExecutionAccount from '@deepseek-ai/dsh-pe-opensandbox/account'
import * as RuntimeAccount from './account.ts'
import { AccountRuntimeError } from './errors.ts'
import { assertAccountPermissionAncestry } from './account-permissions.ts'
import type { SessionId } from '@deepseek-ai/dsh-session/types'
import type { AccountBinding, AccountUse, SubagentCapacityReservation } from './types.ts'
import { AccountAttachments, type AccountAttachmentLimits } from './account-attachments.ts'
import { LocalAttachmentStore } from '@deepseek-ai/dsh-attachment-local'
import { observeStartup, type StartupObserver } from './startup-observation.ts'
import { FileUploads } from '@deepseek-ai/dsh-client-file-upload'
import { prepareAccountSkillResources } from './account-skills.ts'
import GoalService from '@deepseek-ai/dsh-goal'
import * as SessionLogExport from '@deepseek-ai/dsh-session-log-export'
import PermissionPresetService from '@deepseek-ai/dsh-permission-presets'
import UserQuestions from '@deepseek-ai/dsh-user-questions'
import MessageFeedbackService from '@deepseek-ai/dsh-message-feedback'
import * as CommandFeedback from '@deepseek-ai/dsh-command-feedback'

/** Shared approved project/model/Preset checks, supplied by the trusted fixed account composition. */
export interface AccountNativeGuards {
  /** Same native provider/parent/project/model/Preset checks used by the sole factory; absence closes child wiring. */
  readonly admitSubagent?: import('@deepseek-ai/dsh-subagent').SubagentAdmission
  /** Require the original native runtime and approved provider before selecting child wiring. */
  readonly assertSubagentsInstalled?: () => void
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
  /** Resolve only an original member Session before Gateway can read its persisted header. */
  readonly resolveFileScope: (id: SessionId) => Promise<{ sessionId: SessionId; workspaceRoot: string }>
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
  /** Original Root capacity closure; unknown must retain its slot and synchronously close original business admission.
   * Omission keeps child factory and native admission wiring closed. It is never provided by a Peer or Settings. */
  readonly reserveSubagent?: (binding: AccountBinding, depth: number) => SubagentCapacityReservation
  readonly modelKey?: CloudModelKeyPreparation
  readonly skills?: Omit<CloudSkillPreparation, 'files' | 'resources' | 'managed'> & {
    readonly managed: Omit<ManagedSkillPreparation, 'assertWorkspace' | 'resources'>
  }
  readonly plugins?: CloudPluginPreparation
  readonly settingsWrites?: import('@deepseek-ai/dsh-pe-cloud-api').NativeSettingsWritePolicy
  readonly saves: ConfigSaveCoordinator
  readonly exposure: ExposureService['policy']
  readonly execution: SandboxCoordinator
  readonly stopTimeoutMs: number
  /** Existing Root native.maxEntries bounds each bootstrap native inventory read. */
  readonly maxNativeInventoryEntries: number
  /**
   * Read original shared-Web exact registrations; absent producers cannot certify selected Root routes.
   * @returns Actual currently registered Root Fetch entries within the original inventory budget.
   */
  readonly inspectRootFetch?: () => readonly ExactFetchExposure[]
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
  instructions: 'pe-account-instructions-session', modelKey: 'pe-cloud-model-key', skills: 'pe-cloud-skills', plugins: 'pe-cloud-plugins', manager: 'pe-cloud-plugin-manager',
  editor: 'pe-cloud-config-editor', credentials: 'pe-cloud-credentials',
  controller: 'pe-cloud-session-controller', agentLoop: 'pe-cloud-agent-loop', llm: 'pe-cloud-llm',
  commands: 'pe-cloud-commands',
  goals: 'pe-cloud-goals',
  sessionExport: 'pe-cloud-session-export',
  permissions: 'pe-cloud-permissions', userQuestions: 'pe-cloud-user-questions',
  sessionFeedback: 'pe-cloud-session-feedback', messageFeedback: 'pe-cloud-message-feedback',
  commandFeedback: 'pe-cloud-command-feedback',
  workspaceFiles: 'pe-cloud-workspace-files', officeToPdf: 'pe-cloud-office-to-pdf',
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
  private skills: CloudSkillService | undefined
  private office: AccountOfficeLifecycle | undefined

  /**
   * @param input Actual Root resources; storage approval is independently required before production boot.
   * @param startupObserver Private original startup owner; phase notifications cannot affect admission.
   */
  constructor(private readonly input: AccountNativePreparation, private readonly startupObserver?: StartupObserver) {
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
   * @param containSaveFailure Original synchronous factory closure; required for selected mutable capabilities and never throws.
   * @param assertReconfiguring Original factory check for its same-generation exclusive configuration window.
   */
  prepare(
    ctx: Context, binding: AccountBinding,
    mountCurrent: (binding: AccountBinding) => void, businessCurrent: (binding: AccountBinding) => void,
    unpublished: () => void, containSaveFailure?: () => void, assertReconfiguring?: () => void,
  ): void {
    if (this.prepared || this.stopping !== undefined) {
      throw new AccountRuntimeError('cloud/account-unavailable', 'Native account preparation is already owned or closing')
    }
    this.prepared = true
    mountCurrent(binding)
    const modelKey = this.input.modelKey
    const mutable = modelKey !== undefined || this.input.skills !== undefined
      || this.input.settingsWrites !== undefined || this.input.plugins !== undefined
    if (mutable && containSaveFailure === undefined) {
      throw new AccountRuntimeError('cloud/account-unavailable', 'Mutable account preparation requires original factory containment')
    }
    this.saves = this.input.saves.createAccount(binding, modelKey === undefined ? undefined : {
      references: [...new Set(modelKey.limits.bindings.map(binding => binding.ref))], maxReferences: modelKey.limits.bindings.length,
      maxReferenceBytes: Math.max(...modelKey.limits.bindings.map(binding => Buffer.byteLength(binding.ref))),
    }, mutable ? () => { containSaveFailure?.() } : undefined)
    const api = new CloudAccountApi(ctx, {
      ...this.input.plugins === undefined ? {} : { plugins: this.input.plugins },
      binding, saves: this.saves, rootExposure: this.input.exposure, selected: this.input.exposure.manifest,
      assertMountCurrent: mountCurrent,
      assertBusinessCurrent: (current) => { this.input.assertRootCurrent(); businessCurrent(current) },
      assertBootstrapCurrent: signal => requireGuards(ctx).assertBootstrapCurrent(signal),
      maxNativeInventoryEntries: this.input.maxNativeInventoryEntries,
      retainOfficeLifecycle: (office) => {
        if (this.office !== undefined) throw new AccountRuntimeError('cloud/account-unavailable', 'Office lifecycle is already retained')
        this.office = office
      },
      ...this.input.inspectRootFetch === undefined ? {} : { inspectRootFetch: this.input.inspectRootFetch },
      assertUnpublished: unpublished,
      ...assertReconfiguring === undefined ? {} : { assertReconfiguring },
      observeStartupPhase: (phase) => { observeStartup(this.startupObserver, { phase }) },
    })
    this.api = api
    this.execution = this.input.execution.bindAccount(ctx, binding, () => { mountCurrent(binding) }, {
      assertBusinessCurrent: () => { this.input.assertRootCurrent(); businessCurrent(binding) },
      getAgent: id => ctx.get('agents')?.get(id),
      projectForAgent: agent => requireGuards(ctx).projectForAgent(agent),
      projectForSession: session => requireGuards(ctx).projectForSession(session),
      files: () => requireFiles(ctx),
    })
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
          if (invocation?.service === 'officeToPdf' || invocation?.request.namespace === 'officeToPdf') {
            if (invocation.service !== 'officeToPdf' || invocation.request.namespace !== 'officeToPdf'
              || invocation.request.method !== 'render') {
              throw new CloudApiError('cloud/forbidden', 'The native Office file invocation is not selected.')
            }
            api.requireRpc('officeToPdf/render')
          }
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
        const mutation = selected.assertMutationPolicy
        return { workspace: selected.workspace, assertCurrent,
          ...mutation === undefined ? {} : { assertMutationPolicy: (policy: Parameters<typeof mutation>[0]) => {
            assertCurrent()
            mutation(policy)
          } },
          ...selected.directoryPreparation === undefined ? {} : { directoryPreparation: selected.directoryPreparation } }
      })
      if (files.binding !== binding) {
        throw new AccountRuntimeError('cloud/stale-generation', 'Files preparation requires the exact installed graph binding')
      }
      filesOwner = new CloudAccountFiles(ctx, { ...files,
        enforceSessionFilePolicy: this.execution.enforcesSessionFilePolicy === true,
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
      ...input.settingsWrites === undefined ? {} : { settingsWrites: input.settingsWrites },
      project: () => project(ctx),
      assertWorkspace: (workspace) => { requireGuards(ctx).assertWorkspace(workspace) }, assertSessionRead: readSession,
      maxInventoryEntries: input.maxNativeInventoryEntries,
      maxCollectionItems: firstScreenInput.maxCollectionItems, maxFrameBytes: firstScreenInput.maxFrameBytes,
    })
    const sessionGuards = (owner: Context): Parameters<CloudAccountApi['createController']>[1] => ({
      ...requireGuards(owner).sessions, projectDirectory,
      ...attachments === undefined ? {} : { preparePromptFiles: attachments.preparePromptFiles.bind(attachments) },
      ...firstScreenInput === undefined ? {} : { firstScreen: {
        assertSessionRead: readSession, maxCollectionItems: firstScreenInput.maxCollectionItems,
        maxFrameBytes: firstScreenInput.maxFrameBytes,
        maxQueuedEvents: firstScreenInput.maxQueuedEvents, maxQueuedBytes: firstScreenInput.maxQueuedBytes,
      } },
    })
    const controller = {
      inject: [...SessionController.inject, 'peCloudApi'], Config: SessionController.Config,
      apply(owner: Context, config: ConstructorParameters<typeof SessionController>[1]) {
        api.createController(owner, sessionGuards(owner), config)
      },
    }
    const commands = {
      inject: ['peCloudApi', 'agents'],
      apply(owner: Context) { api.createCommands(owner, sessionGuards(owner)) },
    }
    const goals = {
      inject: [...GoalService.inject, 'peCloudApi'], Config: GoalService.Config,
      apply(owner: Context, config: ConstructorParameters<typeof GoalService>[1]) {
        api.createGoals(owner, sessionGuards(owner), config)
      },
    }
    const sessionExport = {
      inject: [...SessionLogExport.inject, 'peCloudApi', 'sessionQuery', 'sessionPersistence', 'attachments', 'sessions'],
      Config: SessionLogExport.Config,
      apply(owner: Context, config: SessionLogExport.Config) {
        api.createSessionExport(owner, sessionGuards(owner), config)
      },
    }
    const permissions = {
      inject: [...PermissionPresetService.inject, 'peCloudApi', 'peAccountExecution', 'fs'], Config: PermissionPresetService.Config,
      apply: (owner: Context, config: ConstructorParameters<typeof PermissionPresetService>[1]) => {
        if (firstScreenInput === undefined) throw new CloudApiError('cloud/invalid-config', 'Permissions require the native read limits.')
        const enforcement = (): void => {
          api.assertInstalled(owner)
          const port = this.execution
          if (port === undefined || owner.get('peAccountExecution') !== port || port.enforcesSessionFilePolicy !== true
            || typeof port.assertSessionFilePolicyChange !== 'function') {
            throw new CloudApiError('cloud/account-unavailable', 'The original Session policy enforcement is unavailable.')
          }
          port.assertCurrent(owner)
          assertAccountExecutionProviders(owner)
          if (owner.get('fs')?.sandboxMode === undefined || owner.get('shell')?.sandboxMode === undefined) {
            throw new CloudApiError('cloud/account-unavailable', 'Permissions require both native enforcing providers.')
          }
        }
        api.createPermissions(owner, config, firstScreenInput.maxFrameBytes, enforcement, (session, mode) => {
          enforcement()
          if (owner.get('sessions')?.get(session.id) !== session) {
            throw new CloudApiError('cloud/forbidden', 'Permissions require the original Session in this account.')
          }
          const port = this.execution
          if (port === undefined || typeof port.assertSessionFilePolicyChange !== 'function') {
            throw new CloudApiError('cloud/account-unavailable', 'The original execution owner is unavailable.')
          }
          port.assertSessionFilePolicyChange(owner, session)
          assertAccountPermissionAncestry(owner, session, mode)
          const agents = owner.get('agents'), parent = agents?.get(session.id)
          if (parent !== undefined && agents?.list().some(agent => agents.isOwnedBy(agent.id, parent))) {
            throw new CloudApiError('cloud/config-busy', 'Stop this Session\'s live child agents before changing permissions.')
          }
        })
      },
    }
    const userQuestions = {
      inject: ['peCloudApi', 'agents', 'sessionProjections'], Config: UserQuestions.Config,
      apply(owner: Context) { api.createUserQuestions(owner, sessionGuards(owner)) },
    }
    const sessionFeedback = {
      inject: [...CommandFeedback.SessionFeedbackService.inject, 'peCloudApi'],
      apply(owner: Context) { api.createSessionFeedback(owner, sessionGuards(owner)) },
    }
    const messageFeedback = {
      inject: [...MessageFeedbackService.inject, 'peCloudApi'], Config: MessageFeedbackService.Config,
      apply(owner: Context, config: ConstructorParameters<typeof MessageFeedbackService>[1]) {
        api.createMessageFeedback(owner, sessionGuards(owner), config)
      },
    }
    const commandFeedback = {
      inject: ['commands', 'sessionFeedback', 'peCloudApi'],
      apply(owner: Context) {
        owner.provide('sessionFeedbackIdentity', api.createFeedbackIdentity(owner))
        CommandFeedback.apply(owner)
      },
    }
    const agentLoop = {
      inject: [...AgentLoop.inject, 'peCloudApi'], Config: AgentLoop.Config,
      apply: (owner: Context, config: ConstructorParameters<typeof AgentLoop>[1]) => {
        const reserveSubagent = input.reserveSubagent
        this.loop = api.createAgentLoop(owner, requireGuards(owner).agents, config,
          reserveSubagent === undefined ? undefined : depth => reserveSubagent(binding, depth))
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
    const assertRootCurrent = (): void => { this.input.assertRootCurrent() }
    const builtins = ctx.loader.builtins
    const pluginManager = api.providers.pluginManager
    const entries = {
      [ACCOUNT_NATIVE_ENTRIES.runtime]: RuntimeAccount,
      [ACCOUNT_NATIVE_ENTRIES.api]: ApiAccount,
      ...modelKey === undefined ? {} : { [ACCOUNT_NATIVE_ENTRIES.modelKey]: {
        inject: ['peCloudApi', 'typert', 'credentials', 'settings', 'llm'],
        apply(owner: Context) { api.prepareCloudModelKey(owner, modelKey) },
      } },
      ...input.skills === undefined ? {} : { [ACCOUNT_NATIVE_ENTRIES.skills]: {
        inject: ['peCloudApi', 'skills', 'typert', 'agents', 'workingDirectory'],
        apply: (owner: Context) => {
          if (filesOwner === undefined || input.skills === undefined || this.skills !== undefined) {
            throw new AccountRuntimeError('cloud/account-unavailable', 'The selected account skill preparation is unavailable')
          }
          const resources = prepareAccountSkillResources(ctx, binding, requireFiles, requireGuards, (caller) => {
            this.input.assertRootCurrent(); businessCurrent(binding); api.assertInstalled(caller)
          })
          this.skills = api.prepareCloudSkills(owner, { ...input.skills, files: filesOwner, resources,
            managed: { ...input.skills.managed, resources, assertWorkspace: (workspace) => {
              api.assertInstalled(owner); this.input.assertRootCurrent(); businessCurrent(binding)
              requireGuards(owner).assertWorkspace(workspace)
            } },
          })
        },
      } },
      ...pluginManager === undefined ? {} : {
        [ACCOUNT_NATIVE_ENTRIES.manager]: pluginManager,
        [ACCOUNT_NATIVE_ENTRIES.plugins]: {
          inject: ['peCloudApi', 'typert', 'pluginManager', 'configEditor'],
          apply(owner: Context) { api.prepareCloudPlugins(owner) },
        },
      },
      [ACCOUNT_NATIVE_ENTRIES.files]: FilesAccount,
      [ACCOUNT_NATIVE_ENTRIES.instructions]: InstructionsSession,
      [ACCOUNT_NATIVE_ENTRIES.execution]: ExecutionAccount,
      [ACCOUNT_NATIVE_ENTRIES.editor]: api.providers.configEditor,
      [ACCOUNT_NATIVE_ENTRIES.credentials]: api.providers.credentials,
      [ACCOUNT_NATIVE_ENTRIES.controller]: controller,
      [ACCOUNT_NATIVE_ENTRIES.commands]: commands,
      [ACCOUNT_NATIVE_ENTRIES.goals]: goals,
      [ACCOUNT_NATIVE_ENTRIES.sessionExport]: sessionExport,
      [ACCOUNT_NATIVE_ENTRIES.permissions]: permissions,
      [ACCOUNT_NATIVE_ENTRIES.userQuestions]: userQuestions,
      [ACCOUNT_NATIVE_ENTRIES.sessionFeedback]: sessionFeedback,
      [ACCOUNT_NATIVE_ENTRIES.messageFeedback]: messageFeedback,
      [ACCOUNT_NATIVE_ENTRIES.commandFeedback]: commandFeedback,
      [ACCOUNT_NATIVE_ENTRIES.agentLoop]: agentLoop,
      [ACCOUNT_NATIVE_ENTRIES.llm]: llm,
      [ACCOUNT_NATIVE_ENTRIES.workspaceFiles]: {
        inject: [...WorkspaceFiles.inject, 'peCloudApi'], Config: WorkspaceFiles.Config,
        apply(owner: Context, nativeConfig: ConstructorParameters<typeof WorkspaceFiles>[1]) {
          api.createWorkspaceFiles(owner, nativeConfig)
          ctx.typert.lookups.configure('workspaceFileScope', async (id) => {
            assertRootCurrent()
            businessCurrent(binding)
            api.assertInstalled(owner)
            const selected = await requireGuards(owner).resolveFileScope(id)
            assertRootCurrent()
            businessCurrent(binding)
            api.assertInstalled(owner)
            return selected
          })
        },
      },
      [ACCOUNT_NATIVE_ENTRIES.officeToPdf]: {
        inject: ['peCloudApi', 'workspaceFiles', 'fs', 'typert'], Config: OfficeToPdf.Config,
        apply: (owner: Context, nativeConfig: ConstructorParameters<typeof OfficeToPdf>[1]) => {
          if (this.office === undefined) throw new AccountRuntimeError('cloud/account-unavailable', 'Office lifecycle is unavailable')
          this.office.install(owner, nativeConfig)
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
      assertAccountExecutionProviders(ctx)
      if (input.skills !== undefined) {
        if (this.skills === undefined) {
          throw new AccountRuntimeError('cloud/account-unavailable', 'The selected native skill entry is missing')
        }
        await this.skills.restore()
      }
      if (input.plugins !== undefined) await api.restoreApprovedPlugins()
      const saves = await api.pauseAccountChanges(Date.now() + input.stopTimeoutMs, binding.lifetime)
      if (saves.status !== 'confirmed') {
        throw new AccountRuntimeError('cloud/stop-unconfirmed', 'Original native startup configuration saves have not settled')
      }
      this.input.assertRootCurrent()
      mountCurrent(binding)
      unpublished()
      for (const provider of [api.providers.configEditor, api.providers.credentials,
        ...api.providers.pluginManager === undefined ? [] : [api.providers.pluginManager]]) {
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
      if (input.reserveSubagent !== undefined) {
        const subagents = ctx.get('subagents'), check = requireGuards(ctx).admitSubagent, installed = requireGuards(ctx).assertSubagentsInstalled
        if (!(subagents instanceof SubagentRuntime) || check === undefined || installed === undefined) {
          throw new AccountRuntimeError('cloud/account-unavailable', 'Original subagents and shared child policy are required')
        }
        installed()
        subagents.registerAdmission(check)
      }
      await api.auditPrepared(ctx)
      this.input.assertRootCurrent()
      mountCurrent(binding)
      unpublished()
      if (project(ctx) !== installed) throw new AccountRuntimeError('cloud/stale-generation', 'Prepared files project changed')
      assertAccountExecutionProviders(ctx)
      api.resumeAccountChanges()
    }
    ctx.effect(() => () => { api.invalidate(); this.execution?.close() }, 'pe-cloud-runtime: revoke prepared API and execution')
    mountCurrent(binding)
  }

  /**
   * Verify actual original native owners and handlers before the factory's ready CAS.
   * @param verify Optional replacement-intent check, supplied before the first audit starts.
   * @returns The retained unpublished audit including verification; failure grants no business admission.
   */
  finishBootstrap(verify?: (api: CloudAccountApi) => Promise<void>): Promise<void> {
    if (this.stopping !== undefined || this.bootstrap === undefined) {
      return Promise.reject(new AccountRuntimeError('cloud/account-unavailable', 'Native bootstrap audit is absent or closing'))
    }
    if (verify !== undefined && this.bootstrapping !== undefined) {
      return Promise.reject(new AccountRuntimeError('cloud/account-unavailable', 'Replacement verification arrived after bootstrap started'))
    }
    const bootstrap = this.bootstrap
    this.bootstrapping ??= (async () => {
      await bootstrap()
      if (verify !== undefined) {
        if (this.api === undefined || this.stopping !== undefined) throw new AccountRuntimeError('cloud/account-unavailable', 'Replacement API is unavailable')
        this.api.assertInstalled()
        await verify(this.api)
      }
    })()
    return this.bootstrapping
  }

  /**
   * Read only the original native lifecycle and persistence settlement.
   * @returns Actual joined observations, absent until both original native owners have settled.
   */
  observeNativeDrain(): Readonly<{ nativeIdle: true; persistenceFlushed: true }> | undefined { return this.nativeDrain }

  /** Observe original native phase/inbox/startup work, persistence I/O and configuration responsibility.
   * @returns True only for the live original owners with no actual work or unknown save outcome.
   */
  isQuiescent(): boolean {
    if (this.stopping !== undefined || this.api === undefined || this.office === undefined
      || this.loop === undefined || this.persistence === undefined
      || this.loopFiber?.state !== FiberState.ACTIVE || this.bootstrapping === undefined) return false
    const saves = this.api.inspectConfigurationSaves()
    return saves.admission !== 'stopped' && saves.pending.length === 0 && saves.failures.length === 0 && this.office.isIdle()
      && this.loop.isQuiescent(this.input.maxNativeInventoryEntries)
      && this.persistence.isQuiescent(this.input.maxNativeInventoryEntries)
  }

  /** Pause only the original save owner; this is not an idle certificate.
   * @returns Actual save-settlement evidence under the existing runtime deadline.
   */
  pauseConfiguration(): Promise<ConfigSaveReceipt> {
    if (this.api === undefined) throw new AccountRuntimeError('cloud/account-unavailable', 'Original native API owner is absent')
    return this.api.pauseAccountChanges(Date.now() + this.input.stopTimeoutMs)
  }

  /** Execute the original native plugin writer through its existing paused save owner.
   * @param submit Original native plugin persistence/application.
 * @returns Actual same-barrier settlement. */
  withPausedPluginChange<T>(submit: () => Promise<T>): Promise<T> {
    if (this.api === undefined) throw new AccountRuntimeError('cloud/account-unavailable', 'Original native API owner is absent')
    return this.api.withPausedPluginChange(submit)
  }

  /** Re-audit the original native inventory inside the actual exclusive window.
   * @param ctx Original independent account root.
 * @returns Original inventory audit in the factory's exclusive window. */
  auditReconfigured(ctx: Context): Promise<void> {
    if (this.api === undefined) throw new AccountRuntimeError('cloud/account-unavailable', 'Original native API owner is absent')
    return this.api.auditReconfigured(ctx)
  }

  /** Resume only after factory/native audit; the underlying barrier refuses unknown or terminal work. */
  resumeConfiguration(): void {
    if (this.api === undefined) throw new AccountRuntimeError('cloud/account-unavailable', 'Original native API owner is absent')
    this.api.resumeAccountChanges()
  }

  /** Release the original save slot only after factory-owned complete drain and owner commit. */
  releaseAfterActualDrain(): void {
    if (this.nativeDrain === undefined || this.saves === undefined) {
      throw new AccountRuntimeError('cloud/stop-unconfirmed', 'Original native drain evidence is absent')
    }
    this.input.saves.releaseAccount(this.saves)
  }

  /**
   * Close new API/execution work before native disposal; unknown saves retain their hooks and graph.
   * @param beforeWithdraw Optional factory drain hook; omission performs ordinary shutdown. The hook first
   * confirms original file/execution drain, then consumes its local commit capability once on this stopped owner.
   * @returns Actual existing save evidence, including terminal commit; undefined means no barrier was issued.
   */
  stop(beforeWithdraw?: (commit: (submit: (api: CloudAccountApi) => Promise<void>) => Promise<void>) => Promise<void>):
  Promise<ConfigSaveReceipt | undefined> {
    if (this.stopping !== undefined && beforeWithdraw !== undefined) {
      throw new AccountRuntimeError('cloud/stop-unconfirmed', 'Original native shutdown already owns its terminal hook')
    }
    this.api?.invalidate()
    this.execution?.close()
    this.stopping ??= (async () => {
      let receipt = await this.saves?.stopConfigSaves(Date.now() + this.input.stopTimeoutMs)
      if (receipt?.status === 'confirmed') {
        // The original audit may still own a native metadata read; joining is not a successful audit.
        try { await this.bootstrapping } catch (_cause) { /* factory retains the original assembly failure */ }
        await this.api?.stopFirstScreenEvents()
        if (this.api !== undefined && this.office === undefined) {
          throw new AccountRuntimeError('cloud/stop-unconfirmed', 'Office lifecycle is unavailable')
        }
        await this.office?.stop(Date.now() + this.input.stopTimeoutMs)
        await this.loop?.stop()
        if (this.agents !== undefined && this.agents.list().length !== 0) {
          throw new AccountRuntimeError('cloud/stop-unconfirmed', 'Native Agent lifecycle work has not settled')
        }
        await this.persistence?.flush()
        if (this.loopFiber !== undefined && this.agents !== undefined && this.persistence !== undefined) {
          this.nativeDrain = Object.freeze({ nativeIdle: true, persistenceFlushed: true })
        }
        if (beforeWithdraw !== undefined) {
          const api = this.api, saves = this.saves, agents = this.agents, persistence = this.persistence
          if (api === undefined || saves === undefined || agents === undefined
            || persistence === undefined || this.nativeDrain === undefined) {
            throw new AccountRuntimeError('cloud/stop-unconfirmed', 'Original native terminal commit lacks drain ownership')
          }
          let active = true
          const assertTerminalCurrent = (): void => {
            if (!active) throw new AccountRuntimeError('cloud/stale-generation', 'The original terminal hook has settled')
          }
          try {
            await beforeWithdraw(async (submit) => {
              assertTerminalCurrent()
              await persistence.flush()
              assertTerminalCurrent()
              api.assertInstalled()
              return this.input.saves.commitStoppedConfiguration(saves, () => submit(api))
            })
          } finally { active = false }
          receipt = await saves.stopConfigSaves(Date.now() + this.input.stopTimeoutMs)
          if (receipt.status !== 'confirmed') return receipt
          if (agents.list().length !== 0) {
            throw new AccountRuntimeError('cloud/stop-unconfirmed', 'Native work changed during terminal configuration')
          }
          await persistence.flush()
        }
        await this.api?.withdraw()
      }
      return receipt
    })()
    return this.stopping
  }
}
