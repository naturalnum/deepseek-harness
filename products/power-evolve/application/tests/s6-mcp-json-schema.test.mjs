/** Real SDK catalogs and native ToolRuntime preserve schemas while product validation bounds untrusted work. */
import assert from 'node:assert/strict'
import { randomUUID } from 'node:crypto'
import test from 'node:test'
import { Context } from '@deepseek-ai/cordis'
import SystemPrompt from '@deepseek-ai/dsh-system-prompt'
import ToolRuntime from '@deepseek-ai/dsh-tools'
import { Client, InMemoryTransport } from '@modelcontextprotocol/client'
import { McpServer } from '@modelcontextprotocol/server'
import { z } from 'zod'
import { compileMcpJsonSchema, validateMcpJsonSchemaValue } from '../lib/mcp-json-schema.js'
import { assertMcpToolArguments, assertModelToolDeclarations, compileMcpModelTool } from '../lib/mcp-model-tools.js'
import { installRemoteMcpTools } from '../lib/host/mcp.js'

const dialect = 'https://json-schema.org/draft/2020-12/schema'
const limits = { maxToolBytes: 65_536, maxDescriptionBytes: 8192 }
const admit = raw => compileMcpModelTool({ publicName: `mcp__fixture__${raw.name}`, raw }, limits)
const execution = { signal: new AbortController().signal, callId: 'schema-call' }

async function sdkCatalog(t) {
  const server = new McpServer({ name: 'schema-fixture', version: '1.0.0' })
  server.registerTool('lookup_item', { inputSchema: z.object({ sku: z.enum(['notebook', 'pencil']) }) },
    async () => ({ content: [{ type: 'text', text: 'lookup fixture' }] }))
  server.registerTool('calculate_quote', {
    inputSchema: z.object({ quoteCode: z.string(), quantity: z.number().int().min(1).max(100) }),
    outputSchema: z.object({ amount: z.number().min(1).max(1000) }),
  }, async () => ({ content: [{ type: 'text', text: 'quote fixture' }], structuredContent: { amount: 10 } }))
  const client = new Client({ name: 'schema-client', version: '1.0.0' })
  t.after(async () => { await client.close(); await server.close() })
  const [clientTransport, serverTransport] = InMemoryTransport.createLinkedPair()
  await Promise.all([client.connect(clientTransport), server.connect(serverTransport)])
  return (await client.listTools()).tools
}

test('standard SDK catalog retains its exact 2020-12 schema and constraints through native registration', async t => {
  const rawTools = await sdkCatalog(t)
  assert.deepEqual(rawTools.map(tool => tool.name), ['lookup_item', 'calculate_quote'])
  const [lookup, quote] = rawTools
  assert.equal(lookup.inputSchema.$schema, dialect)
  assert.deepEqual(lookup.inputSchema.properties.sku.enum, ['notebook', 'pencil'])
  assert.deepEqual(quote.inputSchema.properties.quantity, { type: 'integer', minimum: 1, maximum: 100 })
  const models = rawTools.map(admit)
  const ctx = new Context()
  t.after(() => ctx.fiber.dispose())
  await ctx.plugin(SystemPrompt); await ctx.plugin(ToolRuntime)
  const calls = []
  installRemoteMcpTools({ ctx }, { target: { kind: 'cloud' }, token: 'operation-grant',
    remoteMcpTools: rawTools.map((raw, index) => ({ raw, model: models[index] })) },
  { async call(path, token, body) {
    calls.push({ path, token, body })
    return { actionId: randomUUID(), state: 'pending', fingerprint: 'a'.repeat(64), errorCode: null }
  } }, 'https://platform.example.test')
  for (let index = 0; index < models.length; index++) {
    const definition = ctx.tools.get(models[index].name)
    assert.deepEqual(definition.parameters, rawTools[index].inputSchema)
    assertModelToolDeclarations([{ name: definition.name, description: definition.description,
      input_schema: definition.parameters }], [models[index]])
  }
  const tool = ctx.tools.get(models[1].name)
  for (const quantity of [1, 100]) {
    const args = Object.freeze({ quoteCode: 'QUOTE-1', quantity })
    const result = await ctx.tools.execute({ name: tool.name, arguments: args, ...execution })
    assert.equal(result.isError, false)
    assert.equal(JSON.parse(result.value.content[0].text).state, 'pending')
    assert.deepEqual(calls.at(-1).body.arguments, args)
  }
  const acceptedCalls = calls.length
  for (const args of [{ quoteCode: 'QUOTE-1', quantity: 0 }, { quoteCode: 'QUOTE-1', quantity: 101 },
    { quoteCode: 'QUOTE-1', quantity: 1.5 }, { quoteCode: 'QUOTE-1', quantity: '2' }, { quantity: 1 }, null, []]) {
    assert.throws(() => assertMcpToolArguments(quote, args), { code: 'mcp_arguments_invalid' })
    const denied = await ctx.tools.execute({ name: tool.name, arguments: args, ...execution })
    assert.equal(denied.isError, true)
  }
  assert.equal(calls.length, acceptedCalls)
  assertMcpToolArguments(lookup, { sku: 'notebook' })
  assert.throws(() => assertMcpToolArguments(lookup, { sku: 'eraser' }), { code: 'mcp_arguments_invalid' })
  assert.equal(validateMcpJsonSchemaValue(quote.outputSchema, { amount: 10 }), true)
  for (const value of [{ amount: 0 }, { amount: 1001 }, { amount: '10' }, {}, undefined]) {
    assert.equal(validateMcpJsonSchemaValue(quote.outputSchema, value), false)
  }
})

test('numeric, string, array and compound constraints are enforced without coercion, defaults or removal', () => {
  const schema = { type: 'object', $schema: dialect, properties: {
    count: { type: 'integer', exclusiveMinimum: 0, maximum: 10, multipleOf: 2, default: 2 },
    label: { type: 'string', minLength: 2, maxLength: 4 },
    rows: { type: 'array', minItems: 1, maxItems: 2, items: { anyOf: [{ const: 'yes' }, { const: null }] } },
  }, required: ['count', 'label', 'rows'], additionalProperties: false }
  const before = structuredClone(schema), validate = compileMcpJsonSchema(schema, true)
  const args = Object.freeze({ count: 2, label: 'ok', rows: Object.freeze(['yes', null]) })
  assert.equal(validate(args), true)
  for (const change of [{ count: 0 }, { count: 3 }, { count: 12 }, { count: '2' }, { label: 'x' },
    { label: 'longer' }, { rows: [] }, { rows: ['no'] }, { rows: ['yes', null, 'yes'] }, { extra: true }]) {
    assert.equal(validate({ ...args, ...change }), false)
  }
  const missing = { label: 'ok', rows: ['yes'] }
  assert.equal(validate(missing), false); assert.equal(Object.hasOwn(missing, 'count'), false)
  assert.deepEqual(schema, before)
  assert.equal(validate({ ...args, count: Infinity }), false)
  assert.equal(validate({ ...args, label: undefined }), false)
  const overlapping = compileMcpJsonSchema({ type: 'object', properties: { x: {
    oneOf: [{ type: 'number' }, { type: 'integer' }] } }, required: ['x'] }, true)
  assert.equal(overlapping({ x: 1 }), false); assert.equal(overlapping({ x: 1.5 }), true)
})

test('native empty-object MCP tools reject non-objects before the upstream adapter can substitute arguments', async () => {
  const raw = { name: 'empty', inputSchema: { type: 'object' } }, model = admit(raw)
  let definition, calls = 0
  const ctx = { effect(start) { start() }, tools: { register(tool) { definition = tool; return () => {} } } }
  installRemoteMcpTools({ ctx }, { target: { kind: 'cloud' }, token: 'grant', remoteMcpTools: [{ raw, model }] },
  { async call() { calls++; return { actionId: randomUUID(), state: 'pending', fingerprint: 'a'.repeat(64), errorCode: null } } },
  'https://platform.example.test')
  for (const args of [null, [], 'value', 1, true]) {
    await assert.rejects(definition.execute(args, execution), { code: 'mcp_arguments_invalid' })
  }
  assert.equal(calls, 0)
  await definition.execute({}, execution)
  assert.equal(calls, 1)
})

test('2020-12 tuples, conditions, dependent and unevaluated properties retain their dialect semantics', () => {
  const schema = { type: 'object', $schema: dialect, properties: {
    kind: { enum: ['single', 'batch'] }, rows: { type: 'array', prefixItems: [{ type: 'string' }], items: false },
    trigger: { type: 'boolean' }, acknowledgement: { type: 'boolean' },
  }, required: ['kind', 'rows'], dependentRequired: { trigger: ['acknowledgement'] },
  if: { properties: { kind: { const: 'single' } } }, then: { properties: { rows: { maxItems: 1 } } },
  unevaluatedProperties: false }
  const validate = compileMcpJsonSchema(schema, true)
  assert.equal(validate({ kind: 'single', rows: ['yes'] }), true)
  for (const value of [{ kind: 'single', rows: ['yes', 'no'] }, { kind: 'single', rows: [1] },
    { kind: 'single', rows: [], trigger: true }, { kind: 'single', rows: [], extra: 1 }]) {
    assert.equal(validate(value), false)
  }
  assert.equal(validate({ kind: 'single', rows: [], trigger: true, acknowledgement: true }), true)
})

test('local references are isolated, acyclic and bounded; annotation JSON and property names remain data', () => {
  const schema = { $id: 'https://fixture.example/schema', type: 'object', $schema: dialect,
    $defs: { count: { $anchor: 'count', type: 'integer', minimum: 1, maximum: 100 } },
    properties: { quantity: { $ref: '#/$defs/count' }, alternative: { $ref: '#count' },
      $ref: { type: 'string' } }, required: ['quantity'],
    default: { $ref: 'https://annotation.example/data' } }
  const before = structuredClone(schema), validate = compileMcpJsonSchema(schema, true)
  assert.equal(validate({ quantity: 1, alternative: 100, $ref: 'ordinary property' }), true)
  assert.equal(validate({ quantity: 0 }), false)
  assert.deepEqual(schema, before)
  const changed = structuredClone(schema); changed.$defs.count.minimum = 50
  assert.equal(compileMcpJsonSchema(changed, true)({ quantity: 1 }), false)
  assert.equal(validate({ quantity: 1 }), true)
  for (const declared of ['https://json-schema.org/draft/2019-09/schema', 'http://json-schema.org/draft-07/schema#']) {
    const other = { ...structuredClone(schema), $schema: declared }; delete other.$defs.count.$anchor
    delete other.properties.alternative
    assert.equal(compileMcpJsonSchema(other, true)({ quantity: 1 }), true)
  }
})

test('unsafe or unknown schema features fail at admission, including unused reference definitions', () => {
  const unsafe = [
    { properties: { x: { pattern: '^(a+)+$' } } }, { patternProperties: { '^(a+)+$': { type: 'string' } } },
    { properties: { x: { format: 'email' } } }, { properties: { x: { unknownConstraint: 1 } } },
    { $ref: 'https://schema.example/remote' }, { $defs: { unused: { $ref: 'file:///private/schema' } } },
    { $ref: '#' }, { $defs: { a: { $ref: '#/$defs/b' }, b: { $ref: '#/$defs/a' } } },
    { $dynamicRef: '#node' }, { $recursiveRef: '#' }, { $async: true }, { $vocabulary: {} },
    { properties: { x: { minimum: { $data: '1/minimum' } } } },
    { properties: { x: { type: 'array', uniqueItems: true } } },
    { $schema: 'https://schema.example/custom-dialect' }, { properties: { x: { $id: 'nested.json' } } },
    { properties: { x: { type: 'integer', minimum: '1' } } },
    { $defs: { unused: { unknownConstraint: 1 } } },
  ]
  for (const value of unsafe) {
    const inputSchema = { type: 'object', ...value }
    assert.throws(() => admit({ name: 'unsafe', inputSchema }), { code: 'mcp_schema_unsupported' })
    assert.equal(validateMcpJsonSchemaValue(inputSchema, {}), false)
  }
})

test('schema depth, reference expansion and value work limits reject before expensive validation', () => {
  let deep = { type: 'string' }
  for (let index = 0; index < 40; index++) deep = { type: 'array', items: deep }
  assert.throws(() => compileMcpJsonSchema(deep), { code: 'mcp_schema_unsupported' })
  const definitions = { d0: { type: 'string' } }
  for (let index = 1; index < 12; index++) definitions[`d${index}`] = {
    allOf: [{ $ref: `#/$defs/d${index - 1}` }, { $ref: `#/$defs/d${index - 1}` }] }
  assert.throws(() => compileMcpJsonSchema({ $defs: definitions, $ref: '#/$defs/d11' }),
    { code: 'mcp_schema_unsupported' })
  const validate = compileMcpJsonSchema({ type: 'object', properties: { value: { type: 'string' } } }, true)
  assert.equal(validate({ value: 'x'.repeat(1_000_000) }), false)
  const cycle = {}; cycle.value = cycle
  assert.equal(validate(cycle), false)
  assert.equal(validate({ value: 'small' }), true)
  for (const dependencies of [
    { required: ['value'] }, { dependentRequired: { value: ['value'] } }, { dependencies: { value: ['value'] } },
  ]) {
    const weighted = compileMcpJsonSchema({ type: 'object', ...dependencies,
      properties: { value: { type: 'string' } } }, true)
    assert.equal(weighted({ value: 'x'.repeat(200_000) }), false)
    assert.equal(weighted({ value: 'small' }), true)
  }
})

test('unsupported named __proto__ constraints refuse explicitly; ordinary annotation and data keys stay supported', () => {
  for (const unsupported of [
    JSON.parse('{"type":"object","properties":{"__proto__":{"type":"integer","minimum":2}}}'),
    JSON.parse('{"type":"object","properties":{"nested":{"type":"object","properties":{"__proto__":{"enum":["exact"]}}}}}'),
    JSON.parse('{"type":"object","$schema":"http://json-schema.org/draft-07/schema#","dependencies":{"__proto__":["acknowledgement"]}}'),
    JSON.parse('{"type":"object","$schema":"http://json-schema.org/draft-07/schema#","dependencies":{"__proto__":{"required":["acknowledgement"]}}}'),
  ]) assert.throws(() => compileMcpJsonSchema(unsupported, true), { code: 'mcp_schema_unsupported' })
  const schema = JSON.parse('{"type":"object","default":{"__proto__":{"annotation":true}},"properties":{"nested":{"type":"object","additionalProperties":{"enum":["exact"]}}},"required":["nested"],"additionalProperties":{"type":"integer","minimum":2}}')
  const before = structuredClone(schema), validate = compileMcpJsonSchema(schema, true)
  const valid = JSON.parse('{"__proto__":2,"nested":{"__proto__":"exact"}}')
  assert.equal(validate(valid), true)
  for (const invalid of [JSON.parse('{"__proto__":1,"nested":{"__proto__":"exact"}}'),
    JSON.parse('{"__proto__":2,"nested":{"__proto__":"other"}}'),
    JSON.parse('{"__proto__":2}')]) assert.equal(validate(invalid), false)
  assert.deepEqual(schema, before)
  schema.additionalProperties.minimum = 3
  assert.equal(compileMcpJsonSchema(schema, true)(valid), false)
  assert.equal(validate(valid), true, 'Previously compiled constraints are detached from later input mutation')
  assert(Object.hasOwn(valid, '__proto__'))
  assert.equal(Object.prototype.minimum, undefined)
  const invalidJson = structuredClone(before); invalidJson.default.__proto__.annotation = undefined
  assert.throws(() => compileMcpJsonSchema(invalidJson, true), { code: 'mcp_schema_unsupported' })
})
