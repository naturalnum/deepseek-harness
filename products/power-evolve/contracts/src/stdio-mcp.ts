/** STDIO v2 JSON and frozen invocation records; parsing supplies no resource or execution authority. */
import { z } from 'zod'
import { brandString, type Branded } from '@deepseek-ai/dsh-brand'
import { accountUserId } from './account.ts'
import { bindingGeneration, bindingWorkspaceId, workspaceStorageTarget } from './storage.ts'
import { fileDownloadPath } from './file-download.ts'
import { stdioCanonicalJsonV2, type StdioV2JsonLimits } from './stdio-mcp-json.ts'

/** Complete JSON data, including literal extension fields and escaped NUL. */
export type StdioJsonV2 = null | boolean | number | string | StdioJsonV2[] | StdioObjectV2
/** An original JSON object; fields are not normalized or projected. */
export interface StdioObjectV2 { [key: string]: StdioJsonV2 }
/** Original SDK tool descriptor including all schema, metadata and extension fields. */
export type StdioToolV2 = StdioObjectV2 & { name: string; inputSchema: StdioObjectV2 }
/** Stable generic connection identity, separate from legacy STDIO and remote MCP. */
export type StdioConnectionIdV2 = Branded<'PowerEvolveStdioConnectionIdV2'>
/** One irreversible discovery or call action. */
export type StdioActionIdV2 = Branded<'PowerEvolveStdioActionIdV2'>
/** One frozen, successfully discovered catalog. */
export type StdioCatalogIdV2 = Branded<'PowerEvolveStdioCatalogIdV2'>
/** Owner-scoped management retry key. */
export type StdioRequestIdV2 = Branded<'PowerEvolveStdioRequestIdV2'>
/** Exact existing product Session selected for the action. */
export type StdioSessionIdV2 = Branded<'PowerEvolveStdioSessionIdV2'>
/** Original Agent operation for a call; discovery has no operation. */
export type StdioOperationIdV2 = Branded<'PowerEvolveStdioOperationIdV2'>
/** Unique execution identity, shared across action and executor records. */
export type StdioExecutionIdV2 = Branded<'PowerEvolveStdioExecutionIdV2'>
/** Operator-defined executor deployment selection, never a model-selected image. */
export type StdioDeploymentIdV2 = Branded<'PowerEvolveStdioDeploymentIdV2'>
/** Lowercase SHA-256 value; its owning domain determines the hashed content. */
export type StdioDigestV2 = Branded<'PowerEvolveStdioDigestV2'>

function opaque<B extends Branded<string>>() { return z.uuid().transform(value => brandString<B>(value)) }
const connectionId = opaque<StdioConnectionIdV2>(), actionId = opaque<StdioActionIdV2>()
const catalogId = opaque<StdioCatalogIdV2>(), requestId = opaque<StdioRequestIdV2>()
const sessionId = opaque<StdioSessionIdV2>(), operationId = opaque<StdioOperationIdV2>()
const executionId = opaque<StdioExecutionIdV2>(), deploymentId = opaque<StdioDeploymentIdV2>()
/** Parse a lowercase SHA-256 digest without asserting its content or authorization domain. */
export const stdioDigestV2 = z.string().regex(/^[a-f0-9]{64}$/u).transform(value => brandString<StdioDigestV2>(value))
const digest = stdioDigestV2
const positive = z.number().int().positive()
const text = z.string().min(1).refine(value => !value.includes('\0'))
const cwd = z.union([z.literal('.'), fileDownloadPath])
const platform = z.object({ os: z.literal('linux'), architecture: z.enum(['amd64', 'arm64']) }).strict()
const dockerImageId = z.string().regex(/^sha256:[a-f0-9]{64}$/u)

/** Per-action SDK limits, frozen from validated trusted deployment configuration. */
export const stdioLimitsV2 = z.object({
  runtimeMs: positive.max(2_147_483_647), requestMs: positive.max(2_147_483_647),
  stdinGraceMs: z.number().int().nonnegative().max(2_147_483_647),
  terminateGraceMs: z.number().int().nonnegative().max(2_147_483_647),
  killGraceMs: positive.max(2_147_483_647),
  maxInputBytes: positive, maxMessageBytes: positive, maxProtocolBytes: positive, maxProtocolMessages: positive,
  maxJsonDepth: positive, maxJsonNodes: positive, maxPages: positive, maxTools: positive,
  maxCatalogBytes: positive, maxToolBytes: positive, maxResultBytes: positive, maxStderrBytes: positive,
}).strict()
/** Validated SDK budgets; cleanup remains independent of the operation's abort signal. */
export type StdioLimitsV2 = z.infer<typeof stdioLimitsV2>

/** Parse complete raw JSON with explicit budgets, preserving the original object and all fields.
 * @param limits Required deployment depth, node and encoded-byte budgets.
 * @returns Validator rejecting non-JSON or over-budget data without coercion or truncation.
 */
export function stdioJsonV2(limits: StdioV2JsonLimits): z.ZodType<StdioJsonV2, StdioJsonV2> {
  stdioCanonicalJsonV2(null, limits)
  return z.custom<StdioJsonV2>((value) => {
    try { stdioCanonicalJsonV2(value, limits); return true }
    catch (_invalidJson) { return false }
  })
}

/** Parse an original object after complete JSON validation.
 * @param limits Required deployment JSON budgets.
 * @returns Validator retaining every original object field, including escaped NUL.
 */
export function stdioObjectV2(limits: StdioV2JsonLimits): z.ZodType<StdioObjectV2, StdioObjectV2> {
  const json = stdioJsonV2(limits)
  return z.custom<StdioObjectV2>(value => json.safeParse(value).success
    && value !== null && typeof value === 'object' && !Array.isArray(value))
}

/** Validate a whole raw catalog; descriptor order and all original fields remain intact.
 * @param limits Frozen SDK budgets covering directory, descriptor and JSON sizes.
 * @returns Validator rejecting duplicate names, malformed schemas and exceeded budgets.
 */
export function stdioCatalogV2(limits: StdioLimitsV2): z.ZodType<StdioToolV2[], StdioToolV2[]> {
  const budget = stdioLimitsV2.parse(limits)
  const jsonLimits = { maxDepth: budget.maxJsonDepth, maxNodes: budget.maxJsonNodes, maxBytes: budget.maxCatalogBytes }
  const object = stdioObjectV2({ ...jsonLimits, maxBytes: budget.maxToolBytes })
  return z.custom<StdioToolV2[]>((value) => {
    if (!Array.isArray(value) || value.length > budget.maxTools) return false
    try { stdioCanonicalJsonV2(value, jsonLimits) }
    catch (_invalidCatalog) { return false }
    const names = new Set<string>()
    for (const raw of value) {
      const tool = object.safeParse(raw)
      if (!tool.success || typeof tool.data.name !== 'string' || !tool.data.name || names.has(tool.data.name)) return false
      const schema = object.safeParse(tool.data.inputSchema)
      if (!schema.success || schema.data.type !== 'object') return false
      names.add(tool.data.name)
    }
    return true
  })
}

/** Literal invocation; cwd resolves only inside the selected authorized writable scope. */
export const stdioInvocationV2 = z.object({ program: text, argv: z.array(z.string().refine(value => !value.includes('\0'))), cwd }).strict()
/** Explicit user target; it carries no executable, image, physical root or user identity. */
export const stdioTargetV2 = z.discriminatedUnion('kind', [
  z.object({ kind: z.literal('cloud') }).strict(),
])
/** A check explicitly selects an existing Session; it never follows the latest operation. */
export const stdioCheckRequestV2 = z.object({ requestId, connectionId, expectedRevision: positive,
  sessionId, target: stdioTargetV2 }).strict()
/** Read-only receipt lookup after uncertain management admission. */
export const stdioReceiptRequestV2 = z.object({ requestId }).strict()
/** Original action selector, with no replacement task or result. */
export const stdioActionRequestV2 = z.object({ actionId }).strict()
/** Independent approval binds the exact prepared action fingerprint. */
export const stdioApprovalRequestV2 = z.object({ actionId, fingerprint: digest, decision: z.enum(['once', 'reject']) }).strict()

/** Logical writable scope; actual absolute paths are private executor observations. */
export const stdioScopeV2 = z.discriminatedUnion('kind', [
  z.object({ kind: z.literal('cloud'), userId: accountUserId, workspaceId: bindingWorkspaceId,
    bindingGeneration, target: workspaceStorageTarget, home: z.object({ kind: z.literal('user'), userId: accountUserId }).strict(),
  }).strict().refine(value => value.userId === value.home.userId),
])
/** Cloud pin requires one single-platform manifest and exact runtime image IDs reviewed by the operator. */
export const stdioCloudDeploymentV2 = z.object({
  kind: z.literal('cloud'), deploymentId, protocolVersion: z.literal(2), platform,
  imageReference: z.string().regex(/^[a-z0-9][a-z0-9./:_-]*@sha256:[a-f0-9]{64}$/u),
  configImageId: dockerImageId, runtimeImageIds: z.array(text).min(1),
}).strict().refine(value => new Set(value.runtimeImageIds).size === value.runtimeImageIds.length)
/** Device capabilities can select only a Platform-approved immutable Docker image descriptor. */

/** Trusted deployment mapping; parsing does not validate the manifest bytes or attest a Device OS. */
export const stdioDeploymentV2 = z.discriminatedUnion('kind', [stdioCloudDeploymentV2 ])
/** Actual image identity; different digest kinds or raw prefixes are never interchangeable. */
export const stdioExecutorImageV2 = z.discriminatedUnion('kind', [
  z.object({ kind: z.literal('cloud'), platform, imageReference: stdioCloudDeploymentV2.shape.imageReference,
    runtimeImageId: text }).strict(),
])

/** Compare validated image observations with the original trusted descriptor without normalizing IDs.
 * @param pin Operator-approved deployment mapping fixed before task admission.
 * @param image Actual original executor image, including its platform and raw runtime ID.
 * @returns Whether the image kind, platform and exact same-kind IDs match; no live authority is inferred.
 */
export function stdioImageMatchesDeploymentV2(pin: StdioDeploymentV2, image: StdioExecutorImageV2): boolean {
  return pin.platform.architecture === image.platform.architecture
    && pin.imageReference === image.imageReference
    && pin.runtimeImageIds.includes(image.runtimeImageId)
}
/** Immutable original discovery origin; it never owns a model continuation. */
export const stdioDiscoveryOriginV2 = z.object({ kind: z.literal('stdio_discovery'), requestId }).strict()
/** Immutable original call origin; the Platform separately validates its live Agent lease. */
export const stdioCallOriginV2 = z.object({ kind: z.literal('operation'), operationId, rootOperationId: operationId,
  callKey: text }).strict()
/** One execution belongs to the same action, owner, Session and target throughout recovery. */
export const stdioExecutionRefV2 = z.discriminatedUnion('kind', [
  z.object({ kind: z.literal('cloud'), executionId }).strict(),
])

/** Create task and selection validators using the original validated deployment budgets.
 * @param limits Frozen SDK budgets; validation does not load credentials or start a program.
 * @returns Strict discovery/call validators retaining complete raw catalog and argument JSON.
 */
export function stdioTaskSchemasV2(limits: StdioLimitsV2): ReturnType<typeof taskSchemas> {
  return taskSchemas(limits)
}

function taskSchemas(limits: StdioLimitsV2) {
  const budget = stdioLimitsV2.parse(limits)
  const raw = stdioObjectV2({ maxDepth: budget.maxJsonDepth, maxNodes: budget.maxJsonNodes, maxBytes: budget.maxInputBytes })
  const catalog = stdioCatalogV2(budget)
  const base = z.object({ formatVersion: z.literal(2), actionId, userId: accountUserId, sessionId,
    connectionId, configRevision: positive, configDigest: digest, scopeBinding: stdioScopeV2,
    expectedDeploymentPin: stdioDeploymentV2, invocation: stdioInvocationV2, limits: stdioLimitsV2,
  }).strict()
  const selection = z.object({ catalogId, catalogDigest: digest, rawCatalog: catalog,
    catalogImageExpectation: stdioExecutorImageV2, rawName: z.string().min(1),
    rawDescriptor: stdioObjectV2({ maxDepth: budget.maxJsonDepth, maxNodes: budget.maxJsonNodes,
      maxBytes: budget.maxToolBytes }), arguments: raw,
  }).strict().superRefine((value, ctx) => {
    const descriptor = value.rawCatalog.find(tool => tool.name === value.rawName)
    if (!descriptor || stdioCanonicalJsonV2(descriptor, { maxDepth: budget.maxJsonDepth, maxNodes: budget.maxJsonNodes,
      maxBytes: budget.maxToolBytes }) !== stdioCanonicalJsonV2(value.rawDescriptor, { maxDepth: budget.maxJsonDepth,
      maxNodes: budget.maxJsonNodes, maxBytes: budget.maxToolBytes })) {
      ctx.addIssue({ code: 'custom', message: 'stdio_v2_descriptor_mismatch' })
    }
  })
  const task = z.discriminatedUnion('phase', [
    base.extend({ phase: z.literal('discover'), origin: stdioDiscoveryOriginV2 }).strict(),
    base.extend({ phase: z.literal('call'), origin: stdioCallOriginV2, selection }).strict(),
  ]).superRefine((value, ctx) => {
    if (value.userId !== value.scopeBinding.userId
      || value.phase === 'call' && !stdioImageMatchesDeploymentV2(value.expectedDeploymentPin, value.selection.catalogImageExpectation)
      || stdioCanonicalJsonV2(value.limits, { maxDepth: budget.maxJsonDepth, maxNodes: budget.maxJsonNodes,
        maxBytes: budget.maxInputBytes }) !== stdioCanonicalJsonV2(budget, { maxDepth: budget.maxJsonDepth,
        maxNodes: budget.maxJsonNodes, maxBytes: budget.maxInputBytes })) ctx.addIssue({ code: 'custom', message: 'stdio_v2_task_binding_mismatch' })
  })
  const boundedTask = stdioJsonV2({ maxDepth: budget.maxJsonDepth, maxNodes: budget.maxJsonNodes,
    maxBytes: budget.maxInputBytes }).pipe(task)
  return { task: boundedTask, selection }
}
/** Validated frozen task; whole raw fields require PG json, not jsonb. */
export type StdioTaskV2 = z.infer<ReturnType<typeof stdioTaskSchemasV2>['task']>
/** Validated accepted tool selection; it is never rebuilt from a later catalog. */
export type StdioSelectionV2 = z.infer<ReturnType<typeof stdioTaskSchemasV2>['selection']>
/** Logical cloud or enrolled-Device writable scope. */
export type StdioScopeV2 = z.infer<typeof stdioScopeV2>
/** Operator-approved caller image selection. */
export type StdioDeploymentV2 = z.infer<typeof stdioDeploymentV2>
/** Actual observed image identity, retained without prefix or digest-kind normalization. */
export type StdioExecutorImageV2 = z.infer<typeof stdioExecutorImageV2>
/** Original unique execution reference. */
export type StdioExecutionRefV2 = z.infer<typeof stdioExecutionRefV2>

/** Private Prepared observations; none is an authorization claim from a browser or model. */
export const stdioCaptureV2 = z.discriminatedUnion('kind', [
  z.object({ kind: z.literal('cloud'), podUid: opaque<Branded<'PowerEvolveStdioPodUidV2'>>(), podName: text,
    namespace: text, nodeName: text, runnerInstanceId: opaque<Branded<'PowerEvolveStdioRunnerInstanceV2'>>(),
    containerId: text, restartCount: z.number().int().nonnegative(), mountGeneration: z.string().regex(/^(0|[1-9][0-9]*)$/u),
    workspaceMount: z.object({ claimName: text, subPath: text, mountPath: z.literal('/workspace'), readOnly: z.literal(false) }).strict(),
    homeMount: z.object({ claimName: text, subPath: text, mountPath: z.literal('/home/agent'), readOnly: z.literal(false) }).strict(),
  }).strict(),
])
/** One write-once preparation, bound to the original task and exact execution observations. */
export const stdioPreparedV2 = z.object({ formatVersion: z.literal(2), actionId, executionRef: stdioExecutionRefV2,
  taskDigest: digest, scopeBinding: stdioScopeV2, fullScopeDigest: digest, expectedDeploymentPin: stdioDeploymentV2,
  actualExecutorImage: stdioExecutorImageV2, capture: stdioCaptureV2, specDigest: digest,
}).strict().superRefine((value, ctx) => {
  // Every nested target is parsed by its strict Cloud schema before this identity refinement.
  if (!stdioImageMatchesDeploymentV2(value.expectedDeploymentPin, value.actualExecutorImage)) {
    ctx.addIssue({ code: 'custom', message: 'stdio_v2_prepared_image_mismatch' })
  }
})
/** Validated private preparation; consumers still compare current resource observations before dispatch. */
export type StdioPreparedV2 = z.infer<typeof stdioPreparedV2>

/** Immutable first-epoch approval input; rejection or expiry requires a new action, never a renewed epoch. */
export const stdioApprovalBindingV2 = z.object({ actionId, taskDigest: digest, preparedDigest: digest,
  approvalEpoch: z.literal(1), expiresAt: z.iso.datetime() }).strict()
/** Unique process/instance authorized to consume the original start reply. */
export const stdioExecutorOwnerV2 = z.discriminatedUnion('kind', [
  z.object({ kind: z.literal('cloud'), runnerInstanceId: stdioCaptureV2.options[0].shape.runnerInstanceId }).strict(),
])
/** Exact original Runner instance or enrolled Device process; parsing does not authenticate it. */
export type StdioExecutorOwnerV2 = z.infer<typeof stdioExecutorOwnerV2>
/** Durable once-only authorization receipt; querying it never recreates permission to start. */
export const stdioStartPermitV2 = stdioApprovalBindingV2.extend({
  permitId: opaque<Branded<'PowerEvolveStdioPermitIdV2'>>(), authorizationRequestId: requestId,
  executionRef: stdioExecutionRefV2, executorOwner: stdioExecutorOwnerV2,
  approvalFingerprint: digest, issuedAt: z.iso.datetime(),
}).strict().superRefine((value, ctx) => {
  if (Date.parse(value.issuedAt) >= Date.parse(value.expiresAt)) {
    ctx.addIssue({ code: 'custom', message: 'stdio_v2_permit_binding_invalid' })
  }
})
/** Only the original authorization response may contain true; stored/query receipts contain false. */
export const stdioStartAuthorizationV2 = z.object({ grantOnce: z.boolean(), permit: stdioStartPermitV2 }).strict()
/** Frozen once-only permit; a cold executor cannot inherit the original reply's start authority. */
export type StdioStartPermitV2 = z.infer<typeof stdioStartPermitV2>

/** Validate a dispatch envelope against the original task and same-action once permit.
 * @param limits Frozen deployment SDK budgets, never supplied by the model.
 * @returns Strict whole-envelope validator; stateful once consumption belongs to the trusted Platform.
 */
export function stdioDispatchV2(limits: StdioLimitsV2): ReturnType<typeof dispatchSchema> {
  return dispatchSchema(limits)
}

function dispatchSchema(limits: StdioLimitsV2) {
  const budget = stdioLimitsV2.parse(limits)
  const task = stdioTaskSchemasV2(budget).task
  const envelope = z.object({ formatVersion: z.literal(2), task, taskDigest: digest,
    executionRef: stdioExecutionRefV2, preparedDigest: digest, permit: stdioStartPermitV2 }).strict()
    .superRefine((value, ctx) => {
      const p = value.permit
      if (value.task.actionId !== p.actionId || value.taskDigest !== p.taskDigest || value.preparedDigest !== p.preparedDigest
        || value.executionRef.executionId !== p.executionRef.executionId) {
        ctx.addIssue({ code: 'custom', message: 'stdio_v2_dispatch_binding_invalid' })
      }
    })
  return stdioJsonV2({ maxDepth: budget.maxJsonDepth, maxNodes: budget.maxJsonNodes,
    maxBytes: budget.maxInputBytes }).pipe(envelope)
}
/** Validated immutable dispatch; a matching digest does not establish live grant or cleanup. */
export type StdioDispatchV2 = z.infer<ReturnType<typeof stdioDispatchV2>>
