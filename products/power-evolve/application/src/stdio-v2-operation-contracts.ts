/** Frozen STDIO operation selections retain complete catalog JSON; they grant no execution authority. */
import { z } from 'zod'
import { stdioSavedConfigurationV2 } from '@power-evolve/contracts/stdio-management'
import { brandString } from '@deepseek-ai/dsh-brand'
import { stdioCatalogV2, stdioCheckRequestV2, stdioDeploymentV2, stdioDigestV2, stdioExecutorImageV2,
  stdioImageMatchesDeploymentV2, stdioJsonV2, stdioLimitsV2, stdioObjectV2,
  stdioScopeV2, type StdioCatalogIdV2, type StdioLimitsV2, type StdioObjectV2,
  type StdioToolV2 } from '@power-evolve/contracts/stdio-mcp'
import { stdioCanonicalJsonV2 } from '@power-evolve/contracts/stdio-mcp-json'

/** Admission budgets for the complete selection and each model-visible description. */
export const stdioOperationAdmissionLimitsV2 = z.object({
  maxConnections: z.number().int().positive(), maxTools: z.number().int().positive(),
  maxSnapshotBytes: z.number().int().positive(), maxDescriptionBytes: z.number().int().positive(),
}).strict()
/** Validated trusted admission limits, separate from each connection's frozen SDK limits. */
export type StdioOperationAdmissionLimitsV2 = z.infer<typeof stdioOperationAdmissionLimitsV2>

// These structural carriers return original JSON; the owner factory validates the whole value first.
const object = z.custom<StdioObjectV2>(value => value !== null && typeof value === 'object' && !Array.isArray(value))
const rawTool = z.custom<StdioToolV2>((value) => {
  const parsed = object.safeParse(value)
  return parsed.success && Object.hasOwn(parsed.data, 'name') && typeof parsed.data.name === 'string'
    && parsed.data.name.length > 0 && Object.hasOwn(parsed.data, 'inputSchema') && object.safeParse(parsed.data.inputSchema).success
})
const model = z.object({ name: z.string().regex(/^[A-Za-z0-9_-]{1,64}$/u),
  description: z.string(), parameters: object }).strict()
const tool = z.object({ rawName: z.string().min(1), model, modelDigest: stdioDigestV2 }).strict()

/** Structural fields for Grant composition; callers must apply the owner's whole-JSON budget first. */
export const stdioOperationConnectionFieldsV2 = {
  formatVersion: z.literal(2), connectionId: stdioCheckRequestV2.shape.connectionId,
  configRevision: stdioCheckRequestV2.shape.expectedRevision, configDigest: stdioDigestV2,
  configuration: stdioSavedConfigurationV2,
  limits: stdioLimitsV2, scopeBinding: stdioScopeV2, expectedDeploymentPin: stdioDeploymentV2,
  catalogId: z.uuid().transform(value => brandString<StdioCatalogIdV2>(value)), catalogDigest: stdioDigestV2,
  rawCatalog: z.array(rawTool), catalogImageExpectation: stdioExecutorImageV2,
  tools: z.array(tool),
}

/**
 * Validate complete operation selections using trusted SDK and admission budgets before structural parsing.
 * @param limits SDK limits fixed by the deployment, never selected by raw connection JSON.
 * @param admission Trusted selection-count, snapshot and description limits.
 * @returns Strict input, compiled connection and complete selection validators without resource authorization.
 */
export function stdioOperationSchemasV2(limits: StdioLimitsV2,
  admission: StdioOperationAdmissionLimitsV2): ReturnType<typeof operationSchemas> {
  return operationSchemas(limits, admission)
}

function operationSchemas(limits: StdioLimitsV2, admission: StdioOperationAdmissionLimitsV2) {
  const sdk = stdioLimitsV2.parse(limits), accepted = stdioOperationAdmissionLimitsV2.parse(admission)
  const jsonLimits = { maxDepth: sdk.maxJsonDepth, maxNodes: sdk.maxJsonNodes, maxBytes: sdk.maxInputBytes }
  const raw = stdioObjectV2(jsonLimits), catalog = stdioCatalogV2(sdk)
  const modelTool = tool.extend({ model: model.extend({ parameters: raw,
    description: z.string().refine(value => new TextEncoder().encode(value).byteLength <= accepted.maxDescriptionBytes),
  }).strict() }).strict()
  const fields = { ...stdioOperationConnectionFieldsV2, rawCatalog: catalog, tools: z.array(modelTool).max(accepted.maxTools) }
  const base = z.object(fields).strict().omit({ tools: true }).superRefine((value, ctx) => {
    if (stdioCanonicalJsonV2(value.limits, jsonLimits) !== stdioCanonicalJsonV2(sdk, jsonLimits)
      || !stdioImageMatchesDeploymentV2(value.expectedDeploymentPin, value.catalogImageExpectation)) {
      ctx.addIssue({ code: 'custom', message: 'stdio_v2_operation_binding_invalid' })
    }
  })
  const bounded = stdioJsonV2(jsonLimits)
  const input = bounded.transform((value): unknown => value).pipe(base)
  const connectionSchema = base.safeExtend({ tools: fields.tools }).strict().superRefine((value, ctx) => {
    if (value.tools.length !== value.rawCatalog.length || value.tools.some((entry, index) => {
      const descriptor = value.rawCatalog[index]
      return !descriptor || descriptor.name !== entry.rawName
        || stdioCanonicalJsonV2(descriptor.inputSchema, jsonLimits) !== stdioCanonicalJsonV2(entry.model.parameters, jsonLimits)
    })) ctx.addIssue({ code: 'custom', message: 'stdio_v2_operation_model_map_invalid' })
  })
  const connection = bounded.transform((value): unknown => value).pipe(connectionSchema)
  const selection = stdioJsonV2({ ...jsonLimits, maxBytes: accepted.maxSnapshotBytes })
    .pipe(z.array(connection).max(accepted.maxConnections).superRefine((value, ctx) => {
      const ids = new Set(value.map(entry => entry.connectionId))
      const names = value.flatMap(entry => entry.tools.map(selected => selected.model.name))
      if (ids.size !== value.length || names.length > accepted.maxTools || new Set(names).size !== names.length) {
        ctx.addIssue({ code: 'custom', message: 'stdio_v2_operation_selection_conflict' })
      }
    }))
  const inputs = stdioJsonV2({ ...jsonLimits, maxBytes: accepted.maxSnapshotBytes })
    .pipe(z.array(input).max(accepted.maxConnections))
  return { input, inputs, connection, selection }
}

/** Complete connection configuration and discovery facts selected before any model arguments exist. */
export type StdioOperationConnectionInputV2 = z.infer<ReturnType<typeof stdioOperationSchemasV2>['input']>
/** A frozen raw-name to model-declaration map; public names never encode execution authority. */
export type StdioOperationToolV2 = z.infer<ReturnType<typeof stdioOperationSchemasV2>['connection']>['tools'][number]
/** Complete ordered raw catalog stored once alongside the original configuration, scope and deployment. */
export type StdioOperationConnectionV2 = z.infer<ReturnType<typeof stdioOperationSchemasV2>['connection']>
