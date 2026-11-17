/** Project catalog, graph and policy registrations consumed by existing repository generators. */

import type { ToolPackage } from '../../scripts/gen-tool-catalog.ts'
import type { AccountBinding } from '@deepseek-ai/dsh-pe-cloud-runtime/types'

/** Subsystem pages for project services. */
export const UPSTREAM_SERVICE_PAGES: Record<string, string> = {
  cloudModelKey: 'cloud.md',
  cloudPlugins: 'cloud.md',
  cloudProjects: 'cloud.md',
  cloudSkills: 'cloud.md',
  cloudRemoteServers: 'cloud.md',
  peAccount: 'cloud.md',
  peAccountExecution: 'cloud.md',
  peAccountInstructions: 'cloud.md',
  peAccountRuntime: 'cloud.md',
  peAuth: 'cloud.md',
  peCloudApi: 'cloud.md',
  cloudMcpConnections: 'cloud.md',
  peCloudFiles: 'cloud.md',
  peExposure: 'cloud.md',
  peSandboxCoordinator: 'cloud.md',
}

/** Documented project values outside the Host service projection. */
export const UPSTREAM_SERVICE_WALK_EXEMPTIONS: Record<string, string> = {
  uiSkillCatalog: 'client-side skill cache invalidation — packages/client/ui-skill/README.md owns the API',
  workspaceFileManagement: 'client-side captured workspace HTTP callbacks — packages/client/ui-sidebar-files/README.md owns the API',
  sessionFeedbackIdentity: 'optional application-owned anonymous display identity callback, not a Service — packages/feedback/command-feedback/README.md owns its admission and no-fallback behavior',
  sessionLogDownloadIntegration: 'client-side captured authenticated download carrier, not a Service — packages/session-query/session-log-export/README.md owns its fetch and navigation API',
  modelsSettingsIntegration: 'client-side page-owned Models input value — packages/client/ui-settings-models/README.md owns the API',
  webSearchSettingsIntegration: 'client-side page-owned Web search credential editor — packages/client/ui-settings-web-search/README.md owns the API',
  pluginManagerIntegration: 'client-side account plugin inventory and controls — packages/client/ui-plugin-manager/README.md owns the API',
  subagentSettingsIntegration: 'client-side namespace and field binding — packages/client/ui-settings-subagent/README.md owns the API',
  shellSettingsCard: 'client-side scoped native Terminal component — packages/client/ui-settings-shell/README.md owns its read-only composition API',
  pluginInventory: 'original read-only Typert Remote gateway, outside the Service projection — packages/host/plugin-inventory/README.md owns the API',
  clientPersistence: 'client-side captured logical-key storage port — packages/client/store/README.md owns the API',
  peCloudPage: 'client-side pre-Cordis prepared page owner — packages/cloud/pe-cloud-client/README.md owns the lifecycle',
  peFilesPool: 'root-only LinuxFilesPool instance value, not a Cordis Service subclass — packages/cloud/pe-cloud-files/README.md owns pool startup, static storage and actual shutdown',
  appShutdown: 'not a service: launcher-provided required-close participation — packages/boot/cmdline/README.md owns the launcher contract',
  fileUploadHooks: 'client-side captured upload carrier — packages/client/file-upload/README.md owns installation and settlement',
}

/** Documented Client events outside the Host event projection. */
export const UPSTREAM_EVENT_WALK_EXEMPTIONS: Record<string, string> = {
  'file-upload/complete': 'client-side upload completion signal — packages/client/file-upload/README.md owns the API',
}

/** Documentation pages for project and optional public input types. */
export const UPSTREAM_TYPE_PAGES: Record<string, string> = {
  InvocationDescriptor: 'typert.md',
  CloudMcpConnectionRequest: 'cloud.md',
  CloudMcpConnectionReply: 'cloud.md',
  CloudMcpConnectionPreparation: 'cloud.md',
  CloudMcpConnectionService: 'cloud.md',
  AccountMcpConnectionStore: 'cloud.md',
  McpStoreLimits: 'cloud.md',
  AccountResearchStorage: 'cloud.md',
  StaticAccountAssignmentResolver: 'cloud.md',
  StaticAccountInventory: 'cloud.md',
  AccountAdministrationBudgets: 'cloud.md',
  RemoteServerReply: 'cloud.md#remote-server-management',
  RemoteServerRequest: 'cloud.md#remote-server-management',
  CloudRemoteServerPreparation: 'cloud.md#remote-server-management',
  CloudRemoteServerService: 'cloud.md#remote-server-management',
  AccountRemoteServerStore: 'cloud.md#remote-server-management',
  RemoteStoreLimits: 'cloud.md#remote-server-management',
  ConfigEditControl: 'boot.md#native-edit-controls',
  PluginSelectionGuard: 'boot.md#native-edit-controls',
  ProfileConfigUpdatePlan: 'boot.md#native-edit-controls',
  CloudPluginService: 'cloud.md#approved-plugin-controls',
  PluginCurrentRequest: 'cloud.md#approved-plugin-controls',
  PluginCurrentState: 'cloud.md#approved-plugin-controls',
  PluginManagerSnapshot: '../../packages/cloud/pe-cloud-api/README.md#understand-the-implementation',
  PluginChangeRequest: 'cloud.md#approved-plugin-controls',
  PluginChangeResult: 'cloud.md#approved-plugin-controls',
  ConfigurationPeerOperation: 'cloud.md#approved-plugin-controls',
  PluginRebuildIntent: 'cloud.md#approved-plugin-controls',
  PluginRebuildPersistence: 'cloud.md#approved-plugin-controls',
  PluginRebuildVerification: 'cloud.md#approved-plugin-controls',
  ConfigSaveBarrier: 'cloud.md#actual-work-and-capacity',
  AccountBinding: 'cloud.md',
  AccountExecutionPort: 'cloud.md',
  NativeAccountExecutionAuthority: 'cloud.md',
  AccountFilesProject: 'cloud.md',
  AccountId: 'cloud.md',
  AccountOwner: 'cloud.md',
  AccountUse: 'cloud.md',
  AgentLoop: 'core.md',
  AuthRootObservation: 'cloud.md',
  CloudModelKeyPreparation: '../../packages/cloud/pe-cloud-api/README.md#understand-the-implementation',
  CloudModelKeyService: '../../packages/cloud/pe-cloud-api/README.md#understand-the-implementation',
  CloudProjectCreateRequest: 'cloud.md',
  CloudProjectsPreparation: 'cloud.md',
  CloudProjectsService: 'cloud.md',
  BundledSkillResponseBorrow: '../../packages/cloud/pe-cloud-api/README.md#controlled-sample-publication',
  BundledSkillResponseSettlement: '../../packages/cloud/pe-cloud-api/README.md#controlled-sample-publication',
  CloudSkillPreparation: '../../packages/cloud/pe-cloud-api/README.md#controlled-sample-publication',
  CloudSkillService: '../../packages/cloud/pe-cloud-api/README.md#controlled-sample-publication',
  ManagedSkillDetails: '../../packages/cloud/pe-cloud-api/README.md#controlled-sample-publication',
  ManagedSkillDetailsRequest: '../../packages/cloud/pe-cloud-api/README.md#controlled-sample-publication',
  ManagedSkillDownload: '../../packages/cloud/pe-cloud-api/README.md#controlled-sample-publication',
  ManagedSkillDownloadRequest: '../../packages/cloud/pe-cloud-api/README.md#controlled-sample-publication',
  ManagedSkillReadFileRequest: '../../packages/cloud/pe-cloud-api/README.md#controlled-sample-publication',
  ManagedSkillFileContent: '../../packages/cloud/pe-cloud-api/README.md#controlled-sample-publication',
  ManagedSkillInstallRequest: '../../packages/cloud/pe-cloud-api/README.md#controlled-sample-publication',
  ManagedSkillMutationResult: '../../packages/cloud/pe-cloud-api/README.md#controlled-sample-publication',
  ManagedSkillUninstallRequest: '../../packages/cloud/pe-cloud-api/README.md#controlled-sample-publication',
  ManagedSkillUpdateRequest: '../../packages/cloud/pe-cloud-api/README.md#controlled-sample-publication',
  ManagedSkillsInstalled: '../../packages/cloud/pe-cloud-api/README.md#controlled-sample-publication',
  ManagedSkillsInstalledRequest: '../../packages/cloud/pe-cloud-api/README.md#controlled-sample-publication',
  SkillBundleInput: '../../packages/cloud/pe-cloud-files/README.md#use-this-package',
  SkillBundleOperationCopies: '../../packages/cloud/pe-cloud-files/README.md#use-this-package',
  SkillBundleSource: '../../packages/cloud/pe-cloud-files/README.md#use-this-package',
  SkillBundleVersion: '../../packages/cloud/pe-cloud-files/README.md#use-this-package',
  SkillBundleWorkingCopy: '../../packages/cloud/pe-cloud-files/README.md#use-this-package',
  SkillCatalog: '../../packages/cloud/pe-cloud-files/README.md#use-this-package',
  SkillCatalogChange: '../../packages/cloud/pe-cloud-files/README.md#use-this-package',
  SkillCatalogCommit: '../../packages/cloud/pe-cloud-files/README.md#use-this-package',
  SkillCurrentRequest: '../../packages/cloud/pe-cloud-api/README.md#controlled-sample-publication',
  SkillCurrentState: '../../packages/cloud/pe-cloud-api/README.md#controlled-sample-publication',
  SkillOperationCopies: '../../packages/cloud/pe-cloud-files/README.md#use-this-package',
  SkillProjectGrant: '../../packages/cloud/pe-cloud-files/README.md#use-this-package',
  SkillPublishRequest: '../../packages/cloud/pe-cloud-api/README.md#controlled-sample-publication',
  SkillPublishResult: '../../packages/cloud/pe-cloud-api/README.md#controlled-sample-publication',
  SkillVersion: '../../packages/cloud/pe-cloud-files/README.md#use-this-package',
  SkillVersionPort: '../../packages/cloud/pe-cloud-files/README.md#understand-the-implementation',
  SkillWorkingCopyGrant: '../../packages/cloud/pe-cloud-files/README.md#use-this-package',
  'ctx.peAccountInstructions:Config': '../../packages/cloud/pe-account-instructions/README.md#minimal-configuration',
  ConfigImpactGuard: '../../packages/boot/config-editor/README.md',
  ConfigSaveReceipt: 'cloud.md',
  ConfigSaveSubmissionHook: '../../packages/boot/config-editor/README.md',
  ConnectionDispatchGuard: '../../packages/client/connection/README.md',
  CredentialSaveSubmissionHook: '../../packages/credentials/credentials/README.md',
  DrainCapacityReservation: 'cloud.md',
  DrainParticipant: 'cloud.md',
  EndpointExposure: 'cloud.md',
  EnvironmentSessionId: 'cloud.md',
  ExactFetchExposure: 'cloud.md',
  ExecutionMountGrant: 'cloud.md',
  ExposureInventory: 'cloud.md',
  FileUploads: 'attachment.md',
  FirstScreenEventInput: 'cloud.md',
  FirstScreenEvents: 'cloud.md',
  FirstScreenNativeInput: 'cloud.md',
  InstructionReadReaders: 'cloud.md',
  LocalAttachmentStore: '../../packages/attachment/attachment-local/README.md',
  ModelKeyAccess: '../../packages/cloud/pe-cloud-api/README.md#understand-the-implementation',
  ModelKeyMetadata: '../../packages/cloud/pe-cloud-api/README.md#understand-the-implementation',
  ModelKeyProvider: '../../packages/cloud/pe-cloud-api/README.md#understand-the-implementation',
  ModelKeyReference: '../../packages/cloud/pe-cloud-api/README.md#understand-the-implementation',
  ModelKeySaved: '../../packages/cloud/pe-cloud-api/README.md#understand-the-implementation',
  ModelKeySet: '../../packages/cloud/pe-cloud-api/README.md#understand-the-implementation',
  ModelKeyState: '../../packages/cloud/pe-cloud-api/README.md#understand-the-implementation',
  ModelKeyUnset: '../../packages/cloud/pe-cloud-api/README.md#understand-the-implementation',
  MountCapacityReservation: 'cloud.md',
  NativeAgentFactoryGuards: 'cloud.md',
  ApprovedModelKeyConfiguration: 'cloud.md',
  NativeFirstScreen: 'cloud.md',
  NativePluginInventory: '../../packages/cloud/pe-cloud-api/README.md#understand-the-implementation',
  NativeSchedule: '../../packages/cloud/pe-cloud-api/README.md#understand-the-implementation',
  createNativeSchedule: '../../packages/cloud/pe-cloud-api/README.md#understand-the-implementation',
  NativeCommands: '../../packages/cloud/pe-cloud-api/README.md#understand-the-implementation',
  NativeGoals: '../../packages/cloud/pe-cloud-api/README.md#understand-the-implementation',
  NativePermissions: '../../packages/cloud/pe-cloud-api/README.md#understand-the-implementation',
  NativePresetGuards: '../../packages/cloud/pe-cloud-api/README.md#understand-the-implementation',
  NativePresets: '../../packages/cloud/pe-cloud-api/README.md#understand-the-implementation',
  createNativePresets: '../../packages/cloud/pe-cloud-api/README.md#understand-the-implementation',
  NativeUserQuestions: '../../packages/cloud/pe-cloud-api/README.md#understand-the-implementation',
  createNativeGoals: '../../packages/cloud/pe-cloud-api/README.md#understand-the-implementation',
  createNativeSessionExport: '../../packages/cloud/pe-cloud-api/README.md#understand-the-implementation',
  createNativePermissions: '../../packages/cloud/pe-cloud-api/README.md#understand-the-implementation',
  createNativeSessionFeedback: '../../packages/cloud/pe-cloud-api/README.md#understand-the-implementation',
  createNativeMessageFeedback: '../../packages/cloud/pe-cloud-api/README.md#understand-the-implementation',
  NativeSessionGuards: 'cloud.md',
  NativeUploadPreparation: 'cloud.md',
  SelectWorkspaceTransfer: 'cloud.md',
  WorkspaceTransferLimits: 'cloud.md',
  NodeStreamTransport: '../../packages/api/gateway/README.md',
  NodeStreamTransportOptions: '../../packages/api/gateway/README.md',
  ParticipantReceipt: 'cloud.md',
  PluginSaveSubmissionHook: '../../packages/boot/plugin-manager/README.md',
  RemoteEventQueueLimits: '../../packages/api/gateway/README.md',
  ResidentResult: 'cloud.md',
  RootIngressCloseOwner: 'cloud.md#actual-work-and-capacity',
  RootMetadataDatabase: 'cloud.md',
  RootRecipeInput: 'cloud.md',
  RootRecipeObservation: 'cloud.md',
  RuntimeControlObservation: 'cloud.md',
  WorkspaceUploadBorrow: '../../packages/cloud/pe-cloud-api/README.md#workspace-http-transfers',
  WorkspaceUploadSettlement: '../../packages/cloud/pe-cloud-api/README.md#workspace-http-transfers',
  StageFileResult: 'cloud.md',
  WorkspaceFiles: 'workspace.md',
  SessionController: 'session.md',
  FsDirectoryEnumeration: 'filesystem.md',
  FsDirectoryListing: 'filesystem.md',
  FsDirectoryPage: 'filesystem.md',
  FsDirectoryVersion: 'filesystem.md',
  ScheduleDispatchAdmission: '../../packages/schedule/schedule/README.md#understand-the-implementation',
  SkillCatalogInspection: 'skills.md',
  SubagentAdmission: 'subagent.md#capabilities-and-activation-requests',
  SubagentCapacityReservation: 'cloud.md#actual-work-and-capacity',
  WorkspaceDirectoryControl: 'workspace.md',
  WorkspaceDirectoryCursor: 'workspace.md',
  WorkspaceDirectoryFrame: 'workspace.md',
}

/** Standard-library types used by project signatures without a repository page. */
export const UPSTREAM_FOUNDATION_TYPE_NAMES = ["ArrayBuffer","ConstructorParameters","Parameters"]

/** Project service roles added to the existing capability graph. */
export const UPSTREAM_SERVICE_ROLES = [
  {
    key: 'cloudModelKey', pkg: 'pe-cloud-api', title: 'Account model-key editing', mode: 'service' as const,
    consumers: ['pe-cloud-api'],
    note: 'Exposes the approved account model-key RPCs through the original Peer Use and native configuration save owner.',
  },
  {
    key: 'cloudPlugins', pkg: 'pe-cloud-api', title: 'Approved account plugin controls', mode: 'service' as const,
    consumers: ['pe-cloud-client', 'pe-cloud-runtime'],
    note: 'Adapts fixed plugin edits to original Peer admission, account saves and native profile application.',
  },
  {
    key: 'cloudProjects', pkg: 'pe-cloud-api', title: 'Account project metadata', mode: 'service' as const,
    consumers: ['pe-cloud-api', 'pe-cloud-runtime'],
    note: 'Adapts native Workspace operations to the installed account files owner and approved project roots.',
  },
  {
    key: 'cloudRemoteServers', pkg: 'pe-cloud-api', title: 'Account remote-server management', mode: 'service' as const,
    consumers: ['pe-cloud-client', 'pe-cloud-runtime'],
    note: 'Uses the original authenticated Peer, private files/credentials and save owner; execution remains with native Session tools.',
  },
  {
    key: 'cloudMcpConnections', pkg: 'pe-cloud-api', title: 'Account HTTP MCP management', mode: 'service' as const,
    consumers: ['pe-cloud-client', 'pe-cloud-runtime'],
    note: 'Uses the original account Peer, private credentials and official native MCP client with explicit HTTP and discovery limits.',
  },
  {
    key: 'cloudSkills', pkg: 'pe-cloud-api', title: 'Account skill installation management', mode: 'service' as const,
    consumers: ['pe-cloud-api', 'pe-cloud-client', 'pe-cloud-runtime'],
    note: 'Manages account skill installations and complete packages through original Peer admission, account saves '
      + 'and files-owned catalog/version CAS.',
  },
  {
    key: 'peAccount', pkg: 'pe-cloud-runtime', title: 'Installed account generation', mode: 'core' as const,
    consumers: ['pe-cloud-api', 'pe-cloud-files', 'pe-opensandbox', 'pe-account-instructions'],
    note: 'Carries the immutable account binding and lifetime for one independent account Context.',
  },
  {
    key: 'peAccountExecution', pkg: 'pe-opensandbox', title: 'Account execution port', mode: 'service' as const,
    consumers: ['pe-cloud-api', 'pe-cloud-runtime'],
    note: 'Exposes only the original Root-issued account capability; closed mode refuses native execution.',
  },
  {
    key: 'peAccountInstructions', pkg: 'pe-account-instructions', title: 'Account instruction sources', mode: 'service' as const,
    consumers: ['pe-account-instructions'],
    note: 'Reads bounded private and project instruction snapshots through the original account files owner.',
  },
  {
    key: 'peAccountRuntime', pkg: 'pe-cloud-runtime', title: 'Account Context lifecycle', mode: 'core' as const,
    consumers: ['pe-cloud-access', 'pe-cloud-api'],
    note: 'Owns account mounting, current-generation admission and retained participant cleanup.',
  },
  {
    key: 'peAuth', pkg: 'pe-cloud-access', title: 'Cloud account authentication', mode: 'service' as const,
    consumers: ['pe-cloud-access', 'pe-cloud-runtime'],
    note: 'Resolves authenticated requests through the Root-owned BetterAuth and account-owner selection.',
  },
  {
    key: 'peCloudApi', pkg: 'pe-cloud-api', title: 'Account native API assembly', mode: 'service' as const,
    consumers: ['pe-cloud-access', 'pe-cloud-runtime'],
    note: 'Audits and invokes native endpoints on the exact installed account graph under the exposure manifest.',
  },
  {
    key: 'peCloudFiles', pkg: 'pe-cloud-files', title: 'Account file operations', mode: 'service' as const,
    consumers: ['pe-cloud-api', 'pe-cloud-runtime', 'pe-opensandbox', 'pe-account-instructions'],
    note: 'Owns scoped project and private-file access, bounded worker requests and session environment banks.',
  },
  {
    key: 'peExposure', pkg: 'pe-cloud-api', title: 'Cloud endpoint exposure policy', mode: 'service' as const,
    consumers: ['pe-cloud-access', 'pe-cloud-runtime'],
    note: 'Validates the explicit native endpoint manifest and exact HTTP route declarations before account publication.',
  },
  {
    key: 'peSandboxCoordinator', pkg: 'pe-opensandbox', title: 'Cloud session execution ownership', mode: 'seam' as const,
    implementations: ['pe-opensandbox'], consumers: ['pe-cloud-runtime', 'pe-cloud-api'],
    note: 'Owns allocation metadata, issued account ports, process ranges and actual stop evidence; providers retain unknown work.',
  },
]

/** Project tool schema recipes; execution and persistence remain unavailable during collection. */
export const UPSTREAM_TOOL_PACKAGES: ToolPackage[] = [
  {
    pkg: '@deepseek-ai/dsh-remote-server-cloud', dir: 'remote-server', source: 'packages/community/remote-server/src/tools.ts',
    requires: ['ctx.tools', 'original account binding, approval and managed execution'],
    writes: ['native tool result', 'approval audit events', 'actual probe observations'],
    async mount(ctx) {
      const [{ brandString }, { AccountRemoteServers, installRemoteServerTools }] = await Promise.all([
        import('@deepseek-ai/dsh-brand'), import('@deepseek-ai/dsh-remote-server-cloud'),
      ])
      // Schema harvest registers the production consumer but cannot execute or issue account readiness.
      const binding: AccountBinding = { accountId: brandString<AccountBinding['accountId']>('tool-catalog'),
        epoch: brandString<AccountBinding['epoch']>('1'), recipeVersion: 'schema-harvest', lifetime: new AbortController().signal }
      ctx.provide('peAccount', binding)
      const collection = new AccountRemoteServers(ctx, binding, { maxServers: 4, maxCommandBytes: 4096,
        policy: { alwaysAsk: true, readOnlyAllowlist: [] }, assertCurrent() { ctx.fiber.assertActive() }, read: () => [],
        write: () => Promise.reject(new Error('Schema harvest cannot persist remote servers')),
        deleteCredential: () => Promise.reject(new Error('Schema harvest cannot mutate credentials')) })
      installRemoteServerTools(ctx, collection, { maxReplyBytes: 65536, assertCurrent() { ctx.fiber.assertActive() },
        approval: () => undefined, run: () => Promise.reject(new Error('Schema harvest cannot execute SSH')) })
    },
    note: 'Optional cloud integration only; native never policy refuses mandatory approval. Local SSH cleanup does not certify remote descendant termination.',
  },
]

/** Project development dependencies consumed through application configuration. */
export const UPSTREAM_CONFIGURATION_DEV_DEPENDENCIES = {
  '@deepseek-ai/dsh-pe-cloud-client': [
    '@deepseek-ai/dsh-api-gateway',
    '@deepseek-ai/dsh-api-remote-access',
    '@deepseek-ai/dsh-api-session-controller',
    '@deepseek-ai/dsh-api-workspace-controller',
    '@deepseek-ai/dsh-api-remotes',
    '@deepseek-ai/dsh-client-file-upload',
    '@deepseek-ai/dsh-typert-registry',
  ],
} as const satisfies Readonly<Record<string, readonly string[]>>

/** The additional bilingual Cloud guide accepted by the existing pairing corpus. */
export const UPSTREAM_TRANSLATION_PAIR = /^integrations\/epri-research\/CLOUD(?:\.md|\.zh\.md|\.i18n\.yaml)$/u

/** Project PRODUCT_PACKAGE_POLICY registrations checked by the existing repository policy. */
export const UPSTREAM_PRODUCT_PACKAGE_POLICY = {
  'packages/cloud/pe-cloud-web': { category: 'web-distribution', reason: 'Static Cloud login presentation selected by the Web shell.' },
  'packages/community/remote-server': { category: 'optional', reason: 'Private upstream-derived cloud library; activation requires explicit account and managed-execution policy.' },
  'packages/cloud/pe-account-instructions': { category: 'optional', reason: 'Account instruction snapshots selected only by an explicit cloud composition.' },
  'packages/cloud/pe-cloud-access': { category: 'optional', reason: 'Cloud ingress requires explicit database-backed authentication and routing configuration.' },
  'packages/cloud/pe-cloud-api': { category: 'optional', reason: 'Cloud endpoint policy is selected by an audited cloud composition.' },
  'packages/cloud/pe-cloud-client': { category: 'optional', reason: 'Cloud browser binding is selected with the cloud ingress composition.' },
  'packages/cloud/pe-cloud-files': { category: 'optional', reason: 'Cloud filesystem activation requires an explicitly verified storage backend.' },
  'packages/cloud/pe-cloud-runtime': { category: 'optional', reason: 'Cloud account ownership and lifecycle require an explicit deployment composition.' },
  'packages/cloud/pe-opensandbox': { category: 'optional', reason: 'Remote execution requires an explicitly configured and verified OpenSandbox backend.' },
} as const

/** Project cloudLoaderEntries registrations checked by the existing repository policy. */
export const UPSTREAM_LOADER_ENTRIES = {
  '@deepseek-ai/dsh-pe-cloud-access': ['root', 'frontend', 'applications'],
  '@deepseek-ai/dsh-pe-cloud-runtime': ['root', 'account'],
  '@deepseek-ai/dsh-pe-cloud-api': ['root', 'account'],
  '@deepseek-ai/dsh-pe-cloud-files': ['root', 'account'],
  '@deepseek-ai/dsh-pe-opensandbox': ['root', 'account'],
  '@deepseek-ai/dsh-pe-account-instructions': ['session'],
  '@deepseek-ai/dsh-pe-cloud-client': ['client', 'web-copy'],
} as const

/** Project packageFileExtras registrations checked by the existing repository policy. */
export const UPSTREAM_PACKAGE_FILES = {
  '@deepseek-ai/dsh-pe-cloud-web': ['lib/**/*.css'],
  '@deepseek-ai/dsh-pe-opensandbox': ['runtime/agent/*.py', 'runtime/bootstrap/*.py', 'assets'],
} as const

/** Non-model-facing static product libraries in the existing README audit. */
export const UPSTREAM_MODEL_EXPERIENCE = {
  'packages/cloud/pe-cloud-web': { kind: 'none', reason: 'The static login entry registers no model-facing capability.' },
} as const

/** Static product libraries classified by the existing documentation standard. */
export const UPSTREAM_PACKAGE_LIBRARIES = {
  'packages/cloud/pe-cloud-web': 'Static Cloud Web entry with a class API; no Cordis plugin export.',
} as const
