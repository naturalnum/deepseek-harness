/** Actual frozen native schemas extend authorization while external catalogs retain their exact definitions. */
import { expect, test } from 'vitest'
import { assertModelToolDeclarations, compileMcpModelTool, type McpModelTool } from '../src/mcp-model-tools.ts'

const native: McpModelTool = { name: 'new_native_consumer', description: 'Native consumer '.repeat(100),
  parameters: { type: 'object', properties: { value: { type: 'string' } }, required: ['value'], additionalProperties: false } }
const declaration = { name: native.name, description: native.description, input_schema: native.parameters }

test('authorizes the exact scoped native schema without adding its name to the legacy product list', () => {
  expect(() =>{  assertModelToolDeclarations([declaration], [], [native]) }).not.toThrow()
  expect(() =>{  assertModelToolDeclarations([declaration], []) }).toThrow('model_tool_not_authorized')
  expect(() =>{  assertModelToolDeclarations([{ ...declaration, description: 'changed' }], [],
    [native]) }).toThrow('model_tool_not_authorized')
  expect(() =>{  assertModelToolDeclarations([{ ...declaration, input_schema: {} }], [], [native]) }).toThrow('model_tool_not_authorized')
  expect(() =>{  assertModelToolDeclarations([declaration, declaration], [], [native]) }).toThrow('model_tool_duplicate')
})

test('rejects collisions between native registrations and original MCP snapshots at compilation and model dispatch', () => {
  const tool = { publicName: native.name, raw: { name: 'remote', inputSchema: { type: 'object' } } }
  const limits = { maxToolBytes: 1024, maxDescriptionBytes: 4096 }
  expect(() => compileMcpModelTool(tool, limits, undefined, [native.name])).toThrow('mcp_tool_name_conflict')
  expect(() =>{  assertModelToolDeclarations([declaration], [native], [native]) }).toThrow('mcp_snapshot_conflict')
  const external = compileMcpModelTool({ ...tool, publicName: 'mcp__original__remote' }, limits)
  const exact = { name: external.name, description: external.description, input_schema: external.parameters }
  expect(() =>{  assertModelToolDeclarations([declaration, exact], [external], [native]) }).not.toThrow()
  expect(() =>{  assertModelToolDeclarations([{ ...exact, input_schema: { type: 'object',
    additionalProperties: true } }], [external], [native]) })
    .toThrow('model_tool_not_authorized')
})
