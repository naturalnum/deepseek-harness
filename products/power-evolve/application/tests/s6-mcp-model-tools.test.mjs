/** Admission and provider declarations use the same native DSH tool definition; no network fixture. */
import assert from 'node:assert/strict'
import test from 'node:test'
import { createMcpToolDefinition } from '@deepseek-ai/dsh-mcp-client'
import { assertMcpToolArguments, assertModelToolDeclarations, compileMcpModelTool,
  modelMessageTool } from '../lib/mcp-model-tools.js'

const limits = { maxToolBytes: 65_536, maxDescriptionBytes: 8192 }
const raw = { name: 'sum', description: 'Add two numbers.\0Retain this text.', inputSchema: {
  type: 'object', properties: { left: { type: 'number' }, right: { type: 'number' } },
  required: ['left', 'right'], additionalProperties: false,
}, outputSchema: { type: 'object', properties: { total: { type: 'number' } }, required: ['total'] } }
const tool = { publicName: 'mcp__connection_a__sum', raw }
const model = compileMcpModelTool(tool, limits)
const messagesTool = definition => modelMessageTool.parse({ name: definition.name,
  description: definition.description, input_schema: definition.parameters })

test('native MCP bridge preserves the admitted declaration and renders an acceptance receipt', async () => {
  const receipt = { actionId: 'durable-action', state: 'pending', approvalUrl: 'https://approval.example/approval' }
  let args
  const definition = createMcpToolDefinition({}, {
    name: model.name, rawName: raw.name, description: model.description, inputSchema: model.parameters,
    // An asynchronous acceptance receipt is distinct from the remote structured result.
    call: async value => { args = value; return { content: [{ type: 'text', text: JSON.stringify(receipt) }] } },
  })
  assertModelToolDeclarations([messagesTool(definition)], [model])
  const result = await definition.execute({ left: 2, right: 3 }, { signal: new AbortController().signal })
  assert.deepEqual(args, { left: 2, right: 3 })
  assert.deepEqual(result, { content: [{ type: 'text', text: JSON.stringify(receipt) }] })
  assert.match(model.description, /not completion/u)
  assert.ok(model.description.includes('\0'))
  assert.notEqual(model.parameters, raw.inputSchema)
  assert.deepEqual(model.parameters, raw.inputSchema)
  assert.deepEqual(definition.output.render({}, result), [{ type: 'text', text: JSON.stringify(receipt) }])
})

test('Platform checks exact names, descriptions and schemas, rather than admitting an MCP name prefix', () => {
  const declared = messagesTool(model)
  assertModelToolDeclarations([declared], [model])
  const attempts = [
    { ...declared, name: 'mcp__connection_b__sum' },
    { ...declared, description: 'silently changed by Host' },
    { ...declared, input_schema: { type: 'object' } },
    { ...declared, defer_loading: true },
  ]
  for (const attempted of attempts) assert.throws(() => assertModelToolDeclarations([attempted], [model]),
    { code: 'model_tool_not_authorized' })
  assert.throws(() => assertModelToolDeclarations([declared], []), { code: 'model_tool_not_authorized' })
  assert.throws(() => assertModelToolDeclarations([declared, declared], [model]), { code: 'model_tool_duplicate' })
  assert.throws(() => assertModelToolDeclarations([], [model, model]), { code: 'mcp_snapshot_conflict' })
  assertModelToolDeclarations([], [model])
})

test('two connections may expose the same raw tool without sharing model routing or mutable schemas', () => {
  const second = compileMcpModelTool({ ...tool, publicName: 'mcp__connection_b__sum' }, limits)
  assertModelToolDeclarations([messagesTool(model), messagesTool(second)], [model, second])
  const changed = structuredClone(second)
  changed.parameters.required = []
  assert.throws(() => assertModelToolDeclarations([messagesTool(changed)], [second]),
    { code: 'model_tool_not_authorized' })
  assert.deepEqual(second.parameters.required, ['left', 'right'])
})

test('unsupported schemas, required MCP tasks and oversize descriptions fail explicitly', () => {
  for (const inputSchema of [{ type: 'string' }, { type: 'object', properties: { value: { $ref: 'https://remote/schema' } } }]) {
    assert.throws(() => compileMcpModelTool({ ...tool, raw: { ...raw, inputSchema } }, limits),
      { code: 'mcp_schema_unsupported' })
  }
  assert.throws(() => compileMcpModelTool({ ...tool, raw: { ...raw, outputSchema: { $ref: '#/missing' } } }, limits),
    { code: 'mcp_schema_unsupported' })
  assert.throws(() => compileMcpModelTool({ ...tool, raw: { ...raw, execution: { taskSupport: 'required' } } }, limits),
    { code: 'mcp_tasks_unsupported' })
  assert.throws(() => compileMcpModelTool(tool, { ...limits, maxDescriptionBytes: 16 }),
    { code: 'mcp_description_size_limit' })
  assert.throws(() => compileMcpModelTool(tool, { ...limits, maxToolBytes: 16 }), { code: 'mcp_tool_size_limit' })
  assert.throws(() => compileMcpModelTool({ ...tool, publicName: 'cloud_exec' }, limits),
    { code: 'mcp_tool_name_conflict' })
})

test('actual arguments are independently validated against original requirements and property policy', () => {
  assertMcpToolArguments(raw, { left: 2, right: 3 })
  for (const args of [{ left: 2 }, { left: '2', right: 3 }, { left: 2, right: 3, token: 'private' }, null]) {
    assert.throws(() => assertMcpToolArguments(raw, args), { code: 'mcp_arguments_invalid' })
  }
})
