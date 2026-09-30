/** Platform-admitted MCP tool declarations and argument checks shared with the native Host adapter. */
import { isDeepStrictEqual } from 'node:util'
import { assertObjectJsonSchema, assertSupportedJsonSchema, validateJsonSchemaValue } from '@deepseek-ai/dsh-tools'
import { z } from 'zod'
import type { McpCatalogTool, McpDiscoveredTool } from './mcp-contracts.ts'

/** Native model declaration persisted with an accepted Operation, before any approval decision. */
export const mcpModelTool = z.object({
  name: z.string().regex(/^[A-Za-z0-9_-]{1,64}$/u), description: z.string(),
  parameters: z.record(z.string(), z.json()),
}).strict()

/** DeepSeek Messages tool declaration; whole-request byte limits apply before parsing. */
export const modelMessageTool = z.object({
  name: z.string().regex(/^[A-Za-z0-9_-]{1,64}$/u), description: z.string(),
  input_schema: z.record(z.string(), z.json()), defer_loading: z.literal(true).optional(),
}).strict()

/** Trusted persisted definition, independent of mutable connection metadata. */
export type McpModelTool = z.infer<typeof mcpModelTool>
/** Parsed provider declaration, still untrusted until compared with Platform state. */
export type ModelMessageTool = z.infer<typeof modelMessageTool>
/** Admission budgets are explicit deployment inputs. */
export interface McpToolAdmissionLimits { maxToolBytes: number; maxDescriptionBytes: number }

const receiptGuidance = 'This tool proposes an external MCP action. A receipt records acceptance, not completion. '
  + 'If approval is required, give the user the trusted approval link and wait. '
  + 'The Platform will deliver the outcome in this conversation. Do not repeat a pending or uncertain action.'

const fixedTools = new Set(['trial_notes_list', 'trial_notes_append', 'cloud_exec', 'desktop_exec',
  'mcp__personal__whoami', 'mcp__stdio__whoami', 'ssh_execute_propose', 'skill', 'skill_resource', 'office'])

/** Stable refusals contain no remote descriptions, arguments, credentials, or schema diagnostics. */
export class McpToolAdmissionError extends Error {
  constructor(readonly code: string) { super(code) }
}

/**
 * Admit one complete tool without weakening its input/output schema or hiding task requirements.
 * @param tool Raw discovered tool with a Platform-generated public name.
 * @param limits Deployment-owned descriptor and model-description budgets.
 * @returns A detached native declaration suitable for durable admission and Host registration.
 */
export function compileMcpModelTool(tool: Pick<McpCatalogTool, 'publicName' | 'raw'>,
  limits: McpToolAdmissionLimits): McpModelTool {
  if (Buffer.byteLength(JSON.stringify(tool.raw)) > limits.maxToolBytes) {
    throw new McpToolAdmissionError('mcp_tool_size_limit')
  }
  if (fixedTools.has(tool.publicName) || !/^[A-Za-z0-9_-]{1,64}$/u.test(tool.publicName)) {
    throw new McpToolAdmissionError('mcp_tool_name_conflict')
  }
  if (tool.raw.execution?.taskSupport === 'required') {
    throw new McpToolAdmissionError('mcp_tasks_unsupported')
  }
  try {
    assertObjectJsonSchema(tool.raw.inputSchema)
    if (tool.raw.outputSchema !== undefined) assertSupportedJsonSchema(tool.raw.outputSchema)
  } catch (_unsupportedSchema) { throw new McpToolAdmissionError('mcp_schema_unsupported') }
  const description = `${receiptGuidance}\n\nRemote tool description:\n${tool.raw.description ?? ''}`
  if (Buffer.byteLength(description) > limits.maxDescriptionBytes) {
    throw new McpToolAdmissionError('mcp_description_size_limit')
  }
  return mcpModelTool.parse({ name: tool.publicName, description, parameters: tool.raw.inputSchema })
}

/**
 * Revalidate model arguments against the original catalog schema before creating an action.
 * @param tool Immutable original descriptor selected by the Platform.
 * @param args Parsed model arguments, before any network request.
 * @returns Nothing when the original schema accepts the value; otherwise a redacted refusal.
 */
export function assertMcpToolArguments(tool: McpDiscoveredTool, args: unknown): void {
  try { assertObjectJsonSchema(tool.inputSchema) }
  catch (_unsupportedSchema) { throw new McpToolAdmissionError('mcp_schema_unsupported') }
  if (validateJsonSchemaValue(tool.inputSchema, args).length !== 0) {
    throw new McpToolAdmissionError('mcp_arguments_invalid')
  }
}

/**
 * Check Host declarations against the operation's Platform-owned MCP definitions.
 * @param declared Parsed Messages tools submitted by the shared Host.
 * @param admitted Exact MCP definitions loaded from the durable operation, never from Host input.
 * @returns Nothing for a valid subset; undeclared, changed, or duplicate tools are refused.
 */
export function assertModelToolDeclarations(declared: readonly ModelMessageTool[],
  admitted: readonly McpModelTool[]): void {
  const known = new Map(admitted.map(tool => [tool.name, tool]))
  if (known.size !== admitted.length || admitted.some(tool => fixedTools.has(tool.name))) {
    throw new McpToolAdmissionError('mcp_snapshot_conflict')
  }
  const seen = new Set<string>()
  for (const tool of declared) {
    if (seen.has(tool.name)) throw new McpToolAdmissionError('model_tool_duplicate')
    seen.add(tool.name)
    if (fixedTools.has(tool.name)) {
      if (tool.description.length > 1000) throw new McpToolAdmissionError('model_tool_not_authorized')
      continue
    }
    const expected = known.get(tool.name)
    if (!expected || tool.description !== expected.description || tool.defer_loading !== undefined
      || !isDeepStrictEqual(tool.input_schema, expected.parameters)) {
      throw new McpToolAdmissionError('model_tool_not_authorized')
    }
  }
}
