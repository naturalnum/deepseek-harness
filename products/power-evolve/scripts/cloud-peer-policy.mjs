/** Named cloud Host peers and source-independent protocol installation admission. */
import { isDeepStrictEqual } from 'node:util'

/** Named SDK exports resolved through the cloud Profile's shared providers. */
const CLOUD_SDK_PROVIDER_PEERS = Object.freeze({
  '@deepseek-ai/dsh-agent-instructions': Object.freeze(['apply']),
  '@deepseek-ai/dsh-fs': Object.freeze(['FileSystem', 'FsError', 'FsTargetKey', 'FsVersion']),
  '@deepseek-ai/dsh-fs-local': Object.freeze(['LocalFileSystem']),
  '@deepseek-ai/dsh-sandbox': Object.freeze(['SandboxProvider']),
  '@deepseek-ai/dsh-subprocess': Object.freeze(['SubprocessRuntime', 'SubprocessExecutableNotFoundError']),
  '@deepseek-ai/dsh-subprocess-local': Object.freeze(['LocalSubprocessRuntime']),
  '@deepseek-ai/dsh-subprocess-local/output': Object.freeze(['OutputCollector']),
  '@deepseek-ai/dsh-agent': Object.freeze([
    'foldConsumedWork',
    'resolveInboxTarget',
  ]),
  '@deepseek-ai/dsh-agent-preset-registry': Object.freeze([
    'agentPresetProjectionDefinition',
  ]),
  '@deepseek-ai/dsh-agent-loop': Object.freeze([
    'inboxProjectionDefinition',
    'planInboxCommand',
  ]),
  '@deepseek-ai/dsh-anonymous-user-id': Object.freeze([
    'getOrCreateAnonymousUserId',
  ]),
  '@deepseek-ai/dsh-api-gateway': Object.freeze([
    'RemoteStreamMuxServer',
    'rejectRemoteStreamUpgrade',
  ]),
  '@deepseek-ai/dsh-api-session-controller': Object.freeze([
    'modelSelectionProjection',
    'referencedSessionImage',
  ]),
  '@deepseek-ai/dsh-attachment': Object.freeze([
    'AttachmentError',
    'AttachmentId',
    'AttachmentStore',
    'isAttachmentError',
    'isImageAdmissionError',
  ]),
  '@deepseek-ai/dsh-attachment-local': Object.freeze([
    'DEFAULT_IMAGE_COMPRESSION_CONCURRENCY',
    'DEFAULT_MAX_IMAGES_PER_MESSAGE',
    'DEFAULT_MAX_IMAGE_BYTES',
    'DEFAULT_MAX_IMAGE_DIMENSION',
    'DEFAULT_MAX_IMAGE_PIXELS',
    'DEFAULT_MAX_MESSAGE_IMAGE_BYTES',
    'DEFAULT_NORMALIZED_IMAGE_MAX_BYTES',
    'DEFAULT_NORMALIZED_IMAGE_MAX_DIMENSION',
    'DEFAULT_NORMALIZED_IMAGE_MAX_PIXELS',
    'MAX_IMAGE_COMPRESSION_CONCURRENCY',
    'commitPreparedImageFile',
    'default',
    'fileLeafName',
    'readFileStreamVerbatim',
    'readImageFile',
    'readRequestImageFile',
    'saveFileStreamVerbatim',
    'storedFilePath',
  ]),
  '@deepseek-ai/dsh-client-ui-settings': Object.freeze([
    'Config',
  ]),
  '@deepseek-ai/dsh-client-ui-settings-general': Object.freeze([
    'Config',
  ]),
  '@deepseek-ai/dsh-compaction-image-offload/projection': Object.freeze([
    'imageOffloadProjection',
  ]),
  '@deepseek-ai/dsh-host-plugin-inventory': Object.freeze([
    'readPluginInventory',
  ]),
  '@deepseek-ai/dsh-llm': Object.freeze([
    'AssistantStreamAccumulator',
    'LlmAdapter',
    'LlmError',
    'attributionHeaders',
    'expandAssistantStream',
    'resolveImageAttachmentAccess',
  ]),
  '@deepseek-ai/dsh-llm-deepseek': Object.freeze([
    'DeepSeekAdapter',
    'catalogModelInfo',
    'resolveAdapterOptions',
  ]),
  '@deepseek-ai/dsh-mcp-client': Object.freeze([
    'createMcpToolDefinition',
  ]),
  '@deepseek-ai/dsh-shell': Object.freeze(['default']),
  '@deepseek-ai/dsh-shell-env': Object.freeze(['ShellEnvRegistry']),
  '@deepseek-ai/dsh-tool-bash': Object.freeze(['apply', 'inject', 'name', 'Config']),
  '@deepseek-ai/dsh-timeout': Object.freeze(['deadline', 'timeoutOf']),
  '@deepseek-ai/dsh-session': Object.freeze([
    'KNOWN_SESSION_EVENT_TYPES',
    'Session',
    'SessionLogOffset',
    'SessionSeq',
    'default',
    'isAppendSurfaceEvent',
    'interruptedTurnClosers',
  ]),
  '@deepseek-ai/dsh-session-format': Object.freeze([
    'SessionFormatEventCollector',
    'createSessionFormatCatalog',
    'createSessionFormatChain',
    'isSessionFormatJsonObject',
  ]),
  '@deepseek-ai/dsh-session-format-catalog/message-projections': Object.freeze([
    'currentSessionMessageProjections',
  ]),
  '@deepseek-ai/dsh-session-format-v0-to-v1': Object.freeze([
    'releasedV0SessionFormatCodec',
    'releasedV1SessionFormatCodec',
    'sessionFormatV0ToV1',
  ]),
  '@deepseek-ai/dsh-session-format-v1-to-v2': Object.freeze([
    'releasedV2SessionFormatCodec',
    'sessionFormatV1ToV2',
  ]),
  '@deepseek-ai/dsh-session-format-v2-to-v3': Object.freeze([
    'assertReleasedV3Header',
    'releasedV3SessionFormatCodec',
    'restoreReleasedV3Artifact',
    'sessionFormatV2ToV3',
  ]),
  '@deepseek-ai/dsh-session-format-v3-to-v4': Object.freeze([
    'RELEASED_V3_EVENT_TYPES',
    'assertReleasedV4Header',
    'createSessionFormatV3ToV4',
    'historicalChildCatalogSource',
    'releasedV4SessionFormatCodec',
    'restoreReleasedV4Artifact',
  ]),
  '@deepseek-ai/dsh-session-persistence': Object.freeze([
    'SessionAlreadyOwnedError',
    'SessionHandleClosedError',
    'SessionPersistence',
    'SessionReadOnlyError',
    'validateStoredEvents',
  ]),
  '@deepseek-ai/dsh-session-query-sqlite': Object.freeze([
    'default',
  ]),
  '@deepseek-ai/dsh-session-title': Object.freeze([
    'normalizeSessionTitle',
    'titleProjectionDefinition',
  ]),
  '@deepseek-ai/dsh-session/fork': Object.freeze([
    'buildForkSeed',
  ]),
  '@deepseek-ai/dsh-session/surface': Object.freeze([
    'deriveEventMessage',
  ]),
  '@deepseek-ai/dsh-skill': Object.freeze([
    'isSkillName',
  ]),
  '@deepseek-ai/dsh-skill-filesystem': Object.freeze([
    'FileSystemSkillProvider',
  ]),
  '@deepseek-ai/dsh-web-search-deepseek': Object.freeze([
    'DeepSeekSearchProvider',
    'DEEPSEEK_DEFAULT_API_VERSION',
    'DEEPSEEK_DEFAULT_MAX_TOKENS',
    'DEEPSEEK_DEFAULT_MAX_USES',
    'DEEPSEEK_DEFAULT_MODEL',
  ]),
  '@deepseek-ai/dsh-tools': Object.freeze([
    'defineTool',
  ]),
})

/** Concrete runtime exports used by managed cloud Hosts; browser bundles have separate instances. */
export const CLOUD_PEER_REQUIRED_HOST_EXPORTS = Object.freeze({
  ...CLOUD_SDK_PROVIDER_PEERS,
  '@power-evolve/connector-runner/stdio-v2-digest': Object.freeze([
    'stdioApprovalFingerprintV2',
    'stdioCatalogFingerprintV2',
    'stdioSha256V2',
  ]),
  '@power-evolve/connector-runner/stdio-v2-dispatch': Object.freeze([
    'parseStdioStartV2',
    'validateStdioStartV2',
  ]),
  '@power-evolve/contracts/account': Object.freeze([
    'ACCOUNT_ERROR_CODES',
    'ACCOUNT_MAX_MODELS_PER_USER',
    'ACCOUNT_MAX_PAGE_ITEMS',
    'ACCOUNT_PAGE_PATH',
    'ACCOUNT_PASSWORD_MAX_BYTES',
    'ACCOUNT_PASSWORD_MIN_BYTES',
    'ACCOUNT_ROUTES',
    'accountAudience',
    'accountBearerToken',
    'accountCapabilitiesValue',
    'accountChangePasswordRequest',
    'accountCreateRequest',
    'accountEmptyRequest',
    'accountListRequest',
    'accountListValue',
    'accountLoginRequest',
    'accountLoginValue',
    'accountMeValue',
    'accountModelCatalogValue',
    'accountMutationReceipt',
    'accountNewPassword',
    'accountNewUsername',
    'accountReceiptRequest',
    'accountReceiptValue',
    'accountRole',
    'accountSecretMutationValue',
    'accountTargetMutationRequest',
    'accountUpdateRequest',
    'accountUserId',
    'accountValue',
  ]),
  '@power-evolve/contracts/execution-resolution': Object.freeze([
    'resolutionExecutionId',
    'EXECUTION_RESOLUTION_APPROVAL_ROUTES',
    'EXECUTION_RESOLUTION_ROUTES',
    'executionResolutionInspectRequest',
    'executionResolutionInspection',
    'executionResolutionReceipt',
    'executionResolutionRequest',
    'executionResolutionStatus',
    'executionResolutionStatusRequest',
    'executionResolutionsList',
    'executionResolutionsListRequest',
  ]),
  '@power-evolve/contracts/file-download': Object.freeze([
    'FILE_DOWNLOAD_CONTENT_PATH',
    'FILE_DOWNLOAD_MAX_FILES',
    'FILE_DOWNLOAD_MAX_FILE_BYTES',
    'FILE_DOWNLOAD_MAX_SOURCE_BYTES',
    'FILE_DOWNLOAD_MAX_URL_BYTES',
    'FILE_DOWNLOAD_PLATFORM_PATH',
    'fileDownloadContentRequest',
    'fileDownloadPath',
    'fileDownloadPrepareRequest',
    'fileDownloadUrl',
    'fileDownloadView',
  ]),
  '@power-evolve/contracts/office-preview': Object.freeze([
    'OFFICE_PREVIEW_MAX_INPUT_BYTES',
    'OFFICE_PREVIEW_ROUTES',
    'officePreviewCancelRequest',
    'officePreviewContentView',
    'officePreviewErrorCode',
    'officePreviewFailureSchema',
    'officePreviewGenerationView',
    'officePreviewJobSchema',
    'officePreviewJobView',
    'officePreviewLimits',
    'officePreviewPrepareRequest',
    'officePreviewRefRequest',
    'officePreviewResultSchema',
    'officePreviewSourcePrepareRequest',
  ]),
  '@power-evolve/contracts/stdio-management': Object.freeze([
    'stdioActionSchemasV2',
    'stdioManagementLimitsV2',
    'stdioManagementSchemasV2',
    'stdioPublicConfigV2',
  ]),
  '@power-evolve/contracts/stdio-mcp': Object.freeze([
    'stdioActionRequestV2',
    'stdioApprovalBindingV2',
    'stdioApprovalRequestV2',
    'stdioCaptureV2',
    'stdioCatalogV2',
    'stdioCheckRequestV2',
    'stdioCloudDeploymentV2',
    'stdioDeploymentV2',
    'stdioDigestV2',
    'stdioDispatchV2',
    'stdioExecutionRefV2',
    'stdioExecutorImageV2',
    'stdioExecutorOwnerV2',
    'stdioImageMatchesDeploymentV2',
    'stdioInvocationV2',
    'stdioJsonV2',
    'stdioLimitsV2',
    'stdioObjectV2',
    'stdioPreparedV2',
    'stdioReceiptRequestV2',
    'stdioScopeV2',
    'stdioStartAuthorizationV2',
    'stdioStartPermitV2',
    'stdioTaskSchemasV2',
  ]),
  '@power-evolve/contracts/stdio-mcp-json': Object.freeze([
    'stdioCanonicalJsonV2',
  ]),
  '@power-evolve/contracts/stdio-runtime': Object.freeze([
    'stdioActionLeaseV2',
    'stdioCloudStopEvidenceV2',
    'stdioOutcomeV2',
    'stdioRuntimeViewV2',
    'stdioWorkerIdV2',
  ]),
  '@power-evolve/contracts/storage': Object.freeze([
    'bindingGeneration',
    'bindingWorkspaceId',
    'storageRelativePath',
    'workspaceStorageTarget',
  ]),
})

/** Add named product peers while retaining the official policy's other fields and entries.
 * @param officialPolicy Unmodified repository dependency policy.
 * @returns Independent cloud policy with the original SAFE and duplicate-safe references.
 */
export function createCloudPeerPolicy(officialPolicy) {
  const peerRequiredHostExports = { ...officialPolicy.peerRequiredHostExports }
  for (const [specifier, names] of Object.entries(CLOUD_PEER_REQUIRED_HOST_EXPORTS)) {
    peerRequiredHostExports[specifier] = [...new Set([
      ...officialPolicy.peerRequiredHostExports[specifier] ?? [], ...names,
    ])]
  }
  return { ...officialPolicy, peerRequiredHostExports }
}

/** Validate cloud additions against actual product managed Host uses.
 * @param policy Candidate cloud policy.
 * @param officialPolicy Unmodified repository policy.
 * @param managedHostExportUses Actual flat export uses from product managed Host facts.
 * @param workspaceNames Actual official and product provider names.
 * @returns Rejecting diagnostics; the combined official collector must also run.
 */
export function cloudPeerPolicyErrors(policy, officialPolicy, managedHostExportUses, workspaceNames) {
  const failures = []
  for (const field of new Set([...Object.keys(officialPolicy), ...Object.keys(policy)])) {
    if (field !== 'peerRequiredHostExports' && !isDeepStrictEqual(policy[field], officialPolicy[field])) {
      failures.push('Cloud peer policy must preserve official ' + field)
    }
  }
  for (const [specifier, names] of Object.entries(officialPolicy.peerRequiredHostExports)) {
    const expected = [...new Set([...names, ...CLOUD_SDK_PROVIDER_PEERS[specifier] ?? []])]
    if (!isDeepStrictEqual(policy.peerRequiredHostExports?.[specifier], expected)) {
      failures.push('Cloud peer policy must preserve official peer entries for ' + specifier)
    }
  }
  for (const [specifier, names] of Object.entries(policy.peerRequiredHostExports ?? {})) {
    if (Object.hasOwn(officialPolicy.peerRequiredHostExports, specifier)
      && !Object.hasOwn(CLOUD_SDK_PROVIDER_PEERS, specifier)) continue
    const provider = specifier.split('/').slice(0, 2).join('/')
    const sdkExports = Object.hasOwn(CLOUD_SDK_PROVIDER_PEERS, specifier)
      ? CLOUD_SDK_PROVIDER_PEERS[specifier] : undefined
    if ((!specifier.startsWith('@power-evolve/') && sdkExports === undefined) || !workspaceNames.has(provider)) {
      failures.push('Cloud peer policy names unknown private provider ' + specifier)
    }
    if (!Array.isArray(names) || names.length === 0) {
      failures.push('Cloud peer policy lists no named exports for ' + specifier)
      continue
    }
    const expectedSdkExports = sdkExports === undefined ? undefined : [...new Set([
      ...officialPolicy.peerRequiredHostExports[specifier] ?? [], ...sdkExports,
    ])]
    if (sdkExports !== undefined && !isDeepStrictEqual(names, expectedSdkExports)) {
      failures.push('Cloud peer policy must preserve reviewed SDK provider exports for ' + specifier)
    }
    const seen = new Set()
    for (const name of sdkExports ?? names) {
      if (typeof name !== 'string' || !/^(?:[A-Za-z_$][\w$]*|default)$/u.test(name)) {
        failures.push('Cloud peer policy cannot classify unbounded ' + specifier + '#' + name)
        continue
      }
      if (seen.has(name)) failures.push('Cloud peer policy repeats ' + specifier + '#' + name)
      seen.add(name)
      if (!managedHostExportUses.some(use => use.specifier === specifier && use.exportName === name
        && use.sourcePath.startsWith('products/power-evolve/'))) {
        failures.push('Cloud peer policy lists unused product Host export ' + specifier + '#' + name)
      }
      if (officialPolicy.safeHostDependencyExports[specifier]?.includes(name)) {
        failures.push('Cloud peer policy overlaps official SAFE export ' + specifier + '#' + name)
      }
    }
  }
  return failures
}

/** Require explicit production providers and matching consumer declarations.
 * @param manifests Package-name map from the actual product manifests.
 * @returns Rejecting declaration diagnostics; runtime path admission remains mandatory.
 */
export function cloudProtocolManifestErrors(manifests) {
  const failures = []
  for (const name of ['@power-evolve/application', '@power-evolve/connector-runner']) {
    const manifest = manifests[name]
    if (manifest?.peerDependencies?.['@power-evolve/contracts'] !== 'workspace:~'
      || manifest?.devDependencies?.['@power-evolve/contracts'] !== 'workspace:~'
      || Object.hasOwn(manifest?.dependencies ?? {}, '@power-evolve/contracts')) {
      failures.push(name + ': Contracts requires matching peer + dev workspace:~ declarations')
    }
    if (manifest?.dependencies?.zod !== '^4.4.3') failures.push(name + ': Zod must remain a production dependency')
  }
  for (const name of ['@power-evolve/host', '@power-evolve/platform']) {
    for (const provider of ['@power-evolve/contracts', '@power-evolve/connector-runner']) {
      if (manifests[name]?.dependencies?.[provider] !== 'workspace:~') {
        failures.push(name + ': missing explicit production provider ' + provider)
      }
    }
    if (manifests[name]?.dependencies?.zod !== '4.4.3') failures.push(name + ': missing pinned production Zod provider')
  }
  return failures
}

/** Admit a complete observed Node ESM protocol graph in one fresh isolate.
 * @param input Actual provider entries, consumer peers, linked roots, expected uses and loaded ESM observations.
 * @returns Rejecting diagnostics for missing routes, differing versions, paths or runtime identities.
 */
export function cloudProtocolResolutionErrors(input) {
  const failures = []
  const providerFor = specifier => input.providers[specifier.startsWith('@power-evolve/contracts/')
    ? '@power-evolve/contracts' : specifier]
  for (const name of ['@power-evolve/contracts', 'zod']) {
    const provider = input.providers[name]
    if (!provider?.mapped || !provider.declarer || !provider.packageDir || !provider.version) {
      failures.push('Missing formal runtime provider ' + name)
    }
  }
  for (const consumer of input.consumers) {
    if (!consumer.needsContractsPeer) continue
    if (consumer.peer !== 'workspace:~' || consumer.dev !== 'workspace:~' || consumer.dependency) {
      failures.push('Missing matching Contracts peer for ' + consumer.name)
    }
    if (!input.linkedRoots.includes(consumer.root)) failures.push('Missing linkedRoot for ' + consumer.name)
  }
  if (input.expectedUses.length === 0) failures.push('Empty protocol import corpus')
  for (const expected of input.expectedUses) {
    const rows = input.observations.filter(row => row.sourcePath === expected.sourcePath
      && row.specifier === expected.specifier)
    if (rows.length !== 1) failures.push('Missing or duplicate ESM observation ' + expected.sourcePath + '#' + expected.specifier)
  }
  for (const row of input.observations) {
    const provider = providerFor(row.specifier)
    if (!provider) { failures.push('Unknown protocol provider ' + row.specifier); continue }
    const target = provider.modules?.[row.specifier]
    if (row.version !== provider.version) failures.push('Protocol version conflict at ' + row.sourcePath + '#' + row.specifier)
    if (row.packageDir !== provider.packageDir || row.url !== provider.urls?.[row.specifier]) {
      failures.push('Private protocol copy or differing ESM entry at ' + row.sourcePath + '#' + row.specifier)
    }
    if (!target || !row.module || !isDeepStrictEqual(Object.keys(row.module).sort(), Object.keys(target).sort())) {
      failures.push('Missing or differing runtime exports at ' + row.sourcePath + '#' + row.specifier)
      continue
    }
    for (const [name, value] of Object.entries(target)) {
      if (row.module[name] !== value) failures.push('Protocol runtime identity differs at ' + row.sourcePath + '#' + name)
    }
  }
  return failures
}
