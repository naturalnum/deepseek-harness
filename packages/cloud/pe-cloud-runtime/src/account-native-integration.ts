/** Factory-owned native API/execution installation; files and storage authorization precede production boot. */
import { FiberState, type Context } from '@deepseek-ai/cordis'
import AgentLoop from '@deepseek-ai/dsh-agent-loop'
import SessionController from '@deepseek-ai/dsh-api-session-controller'
import LlmRuntime from '@deepseek-ai/dsh-llm'
import { CloudAccountApi, type ConfigSaveBarrier, type ConfigSaveCoordinator, type ConfigSaveReceipt,
  type ExposureService } from '@deepseek-ai/dsh-pe-cloud-api'
import * as ApiAccount from '@deepseek-ai/dsh-pe-cloud-api/account'
import { CloudAccountFiles, type AccountFilesPreparation } from '@deepseek-ai/dsh-pe-cloud-files'
import * as FilesAccount from '@deepseek-ai/dsh-pe-cloud-files/account'
import { installAccountExecutionPort, type AccountExecutionPort, type SandboxCoordinator } from '@deepseek-ai/dsh-pe-opensandbox'
import * as ExecutionAccount from '@deepseek-ai/dsh-pe-opensandbox/account'
import * as RuntimeAccount from './account.ts'
import { AccountRuntimeError } from './errors.ts'
import type { AccountBinding } from './types.ts'

/** Shared approved project/model/Preset checks, supplied by the trusted fixed account composition. */
export interface AccountNativeGuards {
  readonly sessions: Omit<Parameters<CloudAccountApi['createController']>[1], 'projectDirectory'>
  readonly agents: Parameters<CloudAccountApi['createAgentLoop']>[1]
  readonly allowedModel: Parameters<CloudAccountApi['installLlmGuard']>[1]
}

/** Actual Root resources, retained by the factory; none is installed as an account Root service. */
export interface AccountNativePreparation {
  readonly saves: ConfigSaveCoordinator
  readonly exposure: ExposureService['policy']
  readonly execution: SandboxCoordinator
  readonly stopTimeoutMs: number
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
  editor: 'pe-cloud-config-editor', credentials: 'pe-cloud-credentials',
  controller: 'pe-cloud-session-controller', agentLoop: 'pe-cloud-agent-loop', llm: 'pe-cloud-llm',
})

/** One graph's real save barrier/API/execution ownership, including partially completed preparation. */
export class AccountNativeIntegration {
  private api: CloudAccountApi | undefined
  private saves: ConfigSaveBarrier | undefined
  private execution: AccountExecutionPort | undefined
  private prepared = false
  private stopping: Promise<ConfigSaveReceipt | undefined> | undefined

  /**
   * @param input Actual Root resources; storage approval is independently required before production boot.
   */
  constructor(private readonly input: AccountNativePreparation) {}

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
      const entries = [...owner.loader.entries()].filter(entry => entry.moduleNamespace === FilesAccount)
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
    const controller = {
      inject: [...SessionController.inject, 'peCloudApi'], Config: SessionController.Config,
      apply(owner: Context, config: ConstructorParameters<typeof SessionController>[1]) {
        api.createController(owner, { ...requireGuards(owner).sessions, projectDirectory }, config)
      },
    }
    const agentLoop = {
      inject: [...AgentLoop.inject, 'peCloudApi'], Config: AgentLoop.Config,
      apply(owner: Context, config: ConstructorParameters<typeof AgentLoop>[1]) {
        api.createAgentLoop(owner, requireGuards(owner).agents, config)
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
      [ACCOUNT_NATIVE_ENTRIES.execution]: ExecutionAccount,
      [ACCOUNT_NATIVE_ENTRIES.editor]: api.providers.configEditor,
      [ACCOUNT_NATIVE_ENTRIES.credentials]: api.providers.credentials,
      [ACCOUNT_NATIVE_ENTRIES.controller]: controller,
      [ACCOUNT_NATIVE_ENTRIES.agentLoop]: agentLoop,
      [ACCOUNT_NATIVE_ENTRIES.llm]: llm,
    }
    for (const key of Object.keys(entries)) {
      if (Object.hasOwn(builtins, key)) {
        throw new AccountRuntimeError('cloud/invalid-config', 'A fixed native account builtin has already been installed')
      }
    }
    Object.assign(builtins, entries)
    ctx.effect(() => () => { api.invalidate(); this.execution?.close() }, 'pe-cloud-runtime: revoke prepared API and execution')
    mountCurrent(binding)
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
      if (receipt?.status === 'confirmed') await this.api?.withdraw()
      return receipt
    })()
    return this.stopping
  }
}
