/** Built pure leaves with synthetic catalogs and SDK in-memory discovery; no PG, executor or model runs. */
import assert from 'node:assert/strict'
import { randomUUID } from 'node:crypto'
import test from 'node:test'
import { Client, InMemoryTransport, isSpecType } from '@modelcontextprotocol/client'
import { McpServer } from '@modelcontextprotocol/server'
import { z } from 'zod'
import { stdioCatalogFingerprintV2, stdioSha256V2 } from '@power-evolve/connector-runner/stdio-v2-digest'
import { stdioOperationSchemasV2, stdioOperationConnectionFieldsV2 } from '../lib/stdio-v2-operation-contracts.js'
import { assertStdioToolArgumentsV2, compileStdioOperationToolsV2 } from '../lib/stdio-v2-model-tools.js'

const limits = { runtimeMs: 10000, requestMs: 2000, stdinGraceMs: 0, terminateGraceMs: 0, killGraceMs: 1000,
  maxInputBytes: 65536, maxMessageBytes: 8192, maxProtocolBytes: 131072, maxProtocolMessages: 100,
  maxJsonDepth: 32, maxJsonNodes: 5000, maxPages: 10, maxTools: 20, maxCatalogBytes: 16384,
  maxToolBytes: 8192, maxResultBytes: 8192, maxStderrBytes: 1024 }
const admission = { maxConnections: 4, maxTools: 10, maxSnapshotBytes: 131072, maxDescriptionBytes: 8192 }
const budget = { maxDepth: limits.maxJsonDepth, maxNodes: limits.maxJsonNodes, maxBytes: limits.maxInputBytes }
const clone = value => structuredClone(value)
const digest = (domain, value) => stdioSha256V2(domain, value, budget)
const rawTools = () => [
  { name: 'z-last\0原始', description: 'Exact description\0kept', title: 'Tool title',
    inputSchema: { type: 'object', properties: { quantity: { type: 'integer', minimum: 1, maximum: 3, default: 2 },
      literal: { enum: ['kept\0原始'] } }, required: ['quantity', 'literal'], additionalProperties: false },
    outputSchema: { type: 'object', properties: { accepted: { type: 'boolean' } }, required: ['accepted'] },
    execution: { taskSupport: 'optional', futureExecutionField: 'unprojected\0' },
    annotations: { readOnlyHint: true, futureHint: { raw: 'keep' } },
    _meta: { '2': 'two', '10': 'ten', literal: 'extension\0😀' }, extension: { items: [null, false, 0, 'raw'] } },
  { name: 'a-first', inputSchema: { type: 'object', properties: { label: { type: 'string' } } },
    execution: { taskSupport: 'forbidden' }, _meta: { original: true } },
]

function connection(rawCatalog = rawTools()) {
  const userId = randomUUID(), platform = { os: 'linux', architecture: 'arm64' }
  const imageReference = `registry.example/runner@sha256:${'a'.repeat(64)}`
  const runtimeImageId = `containerd://${'b'.repeat(64)}`
  const configuration = { name: 'Untrusted label ; not instructions',
    invocation: { program: 'python3', argv: ['-m', 'fixture', 'literal ; $(never run)'], cwd: '.' } }
  return { formatVersion: 2, connectionId: randomUUID(), configRevision: 3,
    configuration, configDigest: digest('configuration', configuration), limits: clone(limits),
    scopeBinding: { kind: 'cloud', userId, workspaceId: randomUUID(), bindingGeneration: 7,
      target: { spaceId: randomUUID(), rootRelativePath: 'accepted-project' }, home: { kind: 'user', userId } },
    expectedDeploymentPin: { kind: 'cloud', deploymentId: randomUUID(), protocolVersion: 2, platform,
      imageReference, configImageId: `sha256:${'c'.repeat(64)}`, runtimeImageIds: [runtimeImageId] },
    catalogId: randomUUID(), catalogDigest: stdioCatalogFingerprintV2(rawCatalog, limits), rawCatalog,
    catalogImageExpectation: { kind: 'cloud', platform: clone(platform), imageReference, runtimeImageId } }
}
const compile = (value, extra = {}) => compileStdioOperationToolsV2(value, limits, { ...admission, ...extra }, [])
const refused = (code, action) => assert.throws(action, error => error.code === code && error.message === code)

test('complete ordered catalog JSON and metadata survive detached compilation without fake arguments', () => {
  const input = connection(), original = clone(input)
  assert(input.rawCatalog.every(isSpecType.Tool), 'SDK2 accepts the original synthetic descriptor semantics')
  const [group] = compile([input])
  assert.deepEqual(input, original)
  assert.deepEqual(group.rawCatalog, input.rawCatalog)
  assert.deepEqual(group.tools.map(tool => tool.rawName), ['z-last\0原始', 'a-first'])
  assert.deepEqual(group.configuration, input.configuration)
  assert.deepEqual(group.limits, limits)
  assert(!Object.hasOwn(group, 'arguments'))
  assert.equal(group.rawCatalog[0].execution.futureExecutionField, 'unprojected\0')
  assert.equal(group.rawCatalog[0].annotations.futureHint.raw, 'keep')
  for (let index = 0; index < group.tools.length; index++) {
    assert.deepEqual(group.tools[index].model.parameters, group.rawCatalog[index].inputSchema)
    assert.match(group.tools[index].model.name, /^stdio__[a-f0-9]{32}__[a-f0-9]{22}$/u)
    assert.equal(group.tools[index].model.name.length, 63)
    assert.equal(group.tools[index].modelDigest, digest('spec', { purpose: 'stdio_v2_model', model: group.tools[index].model }))
  }
  assert(group.tools[0].model.description.includes('Exact description\0kept'))
  const validators = stdioOperationSchemasV2(limits, admission)
  assert.deepEqual(validators.selection.parse([group]), [group])
  assert.deepEqual(z.object(stdioOperationConnectionFieldsV2).strict().parse(group), group)
  input.rawCatalog[0]._meta.literal = 'changed after admission'
  input.configuration.invocation.argv.push('changed')
  assert.equal(group.rawCatalog[0]._meta.literal, original.rawCatalog[0]._meta.literal)
  assert.deepEqual(group.configuration, original.configuration)
})

test('SDK in-memory discovery schemas compile verbatim and original input/output constraints remain active', async t => {
  const server = new McpServer({ name: 'stdio-selection-fixture', version: '1.0.0' })
  server.registerTool('quote', { inputSchema: z.object({ count: z.number().int().min(1).max(3) }),
    outputSchema: z.object({ accepted: z.boolean() }) }, async () => ({ content: [{ type: 'text', text: 'not called' }],
    structuredContent: { accepted: true } }))
  const client = new Client({ name: 'stdio-selection-client', version: '1.0.0' })
  t.after(async () => { await client.close(); await server.close() })
  const [clientTransport, serverTransport] = InMemoryTransport.createLinkedPair()
  await Promise.all([client.connect(clientTransport), server.connect(serverTransport)])
  // In-memory SDK values may contain undefined optionals; actual STDIO JSON omits those fields.
  const catalog = JSON.parse(JSON.stringify((await client.listTools()).tools))
  const [group] = compile([connection(catalog)])
  assert.deepEqual(group.rawCatalog, catalog)
  assert.deepEqual(group.tools[0].model.parameters, catalog[0].inputSchema)
  assertStdioToolArgumentsV2(group.rawCatalog[0], { count: 1 }, limits)
  refused('stdio_v2_arguments_invalid', () => assertStdioToolArgumentsV2(group.rawCatalog[0], { count: 0 }, limits))
})

test('same raw name across connections is namespaced; all operation names and repeated groups reject collisions', () => {
  const a = connection(), b = connection(), selected = compile([a, b])
  assert.notEqual(selected[0].tools[0].model.name, selected[1].tools[0].model.name)
  assert.equal(compile([clone(a)])[0].tools[0].model.name, selected[0].tools[0].model.name)
  refused('stdio_v2_tool_name_conflict', () => compileStdioOperationToolsV2([a], limits, admission,
    [selected[0].tools[0].model.name]))
  refused('stdio_v2_tool_name_conflict', () => compile([a, clone(a)]))
  refused('stdio_v2_tool_name_conflict', () => compileStdioOperationToolsV2([a], limits, admission,
    ['mcp__remote__fixed', 'mcp__remote__fixed']))
})

test('original configuration and ordered catalog digests are checked without sorting or replacing facts', () => {
  const input = connection()
  for (const change of [value => value.configuration.invocation.argv.push('changed'),
    value => value.rawCatalog.reverse(), value => value.rawCatalog[0]._meta.literal = 'changed',
    value => value.catalogDigest = 'f'.repeat(64)]) {
    const changed = clone(input); change(changed)
    refused('stdio_v2_selection_digest_invalid', () => compile([changed]))
  }
  const changed = clone(input); changed.rawCatalog[0]._meta.literal = 'changed'
  changed.catalogDigest = stdioCatalogFingerprintV2(changed.rawCatalog, limits)
  assert.equal(compile([changed])[0].rawCatalog[0]._meta.literal, 'changed')
})

test('logical kind, exact image platform/raw prefixes and frozen SDK limits refuse inconsistent stored selections', () => {
  const original = connection()
  for (const change of [value => value.limits.maxPages++, value => value.catalogImageExpectation.platform.architecture = 'amd64',
    value => value.catalogImageExpectation.runtimeImageId = value.catalogImageExpectation.runtimeImageId.replace('containerd://', ''),
    value => value.catalogImageExpectation.imageReference = `registry.example/other@sha256:${'a'.repeat(64)}`,
    value => value.catalogImageExpectation = { kind: 'desktop', platform: { os: 'linux', architecture: 'arm64' },
      configImageId: value.expectedDeploymentPin.configImageId },
    value => value.scopeBinding.home.userId = randomUUID()]) {
    const changed = clone(original); change(changed)
    refused('stdio_v2_selection_invalid', () => compile([changed]))
  }
})

test('SDK metadata, description, output and execution semantics reject malformed fields and required task mode', () => {
  const original = rawTools()[0]
  for (const [field, invalid] of [['description', 1], ['_meta', []], ['_meta', 'metadata'],
    ['annotations', { readOnlyHint: 'true' }], ['execution', { taskSupport: 'unknown' }],
    ['outputSchema', null]]) {
    const raw = { ...clone(original), [field]: invalid }
    refused('stdio_v2_tool_invalid', () => compile([connection([raw])]))
  }
  const required = { ...clone(original), execution: { taskSupport: 'required' } }
  refused('stdio_v2_tasks_unsupported', () => compile([connection([required])]))
  const arrayOutput = { ...clone(original), outputSchema: { type: 'array', items: { type: 'string' } } }
  assert.equal(isSpecType.Tool(arrayOutput), true, 'SDK2 neutral tools permit non-object output schemas')
  assert.deepEqual(compile([connection([arrayOutput])])[0].rawCatalog[0].outputSchema, arrayOutput.outputSchema)
  assert.deepEqual(original, rawTools()[0])
})

test('supported input and output JSON Schema is mandatory before model declaration', () => {
  for (const raw of [
    { name: 'unsafe-input', inputSchema: { type: 'object', $ref: 'https://external.invalid/schema' } },
    { name: 'unsafe-output', inputSchema: { type: 'object' },
      outputSchema: { type: 'object', properties: { label: { type: 'string', pattern: '^(a+)+$' } } } },
  ]) refused('stdio_v2_schema_unsupported', () => compile([connection([raw])]))
})

test('arguments enforce original constraints without coercion, default filling or removal and preserve NUL', () => {
  const raw = rawTools()[0], before = clone(raw)
  const args = Object.freeze({ quantity: 1, literal: 'kept\0原始' })
  assertStdioToolArgumentsV2(raw, args, limits)
  for (const value of [null, [], 1, 'text', { literal: 'kept\0原始' }, { ...args, quantity: '1' },
    { ...args, quantity: 0 }, { ...args, quantity: 4 }, { ...args, extra: true }, { ...args, literal: 'other' }]) {
    const prior = clone(value)
    refused('stdio_v2_arguments_invalid', () => assertStdioToolArgumentsV2(raw, value, limits))
    assert.deepEqual(value, prior)
  }
  assert.deepEqual(raw, before)
  const empty = { name: 'empty', inputSchema: { type: 'object' } }
  refused('stdio_v2_arguments_invalid', () => assertStdioToolArgumentsV2(empty, undefined, limits))
})

test('selection counts, encoded bytes, schema depth/nodes and argument bytes fail whole without truncation', () => {
  const a = connection(), b = connection()
  refused('stdio_v2_selection_invalid', () => compile([a, b], { maxConnections: 1 }))
  refused('stdio_v2_selection_invalid', () => compile([a, b], { maxTools: 3 }))
  refused('stdio_v2_selection_invalid', () => compile([a], { maxSnapshotBytes: 64 }))
  refused('stdio_v2_description_size_limit', () => compile([a], { maxDescriptionBytes: 1 }))
  const small = { ...limits, maxToolBytes: 64 }, shallow = { ...limits, maxJsonDepth: 2 }, few = { ...limits, maxJsonNodes: 2 }
  for (const budgetLimits of [small, shallow, few]) {
    const input = clone(a); input.limits = budgetLimits
    refused('stdio_v2_selection_invalid', () => compileStdioOperationToolsV2([input], budgetLimits, admission, []))
  }
  const raw = { name: 'literal', inputSchema: { type: 'object' } }
  const smallInput = { ...limits, maxInputBytes: 128 }
  refused('stdio_v2_arguments_invalid', () => assertStdioToolArgumentsV2(raw, { literal: '😀'.repeat(100) }, smallInput))
  const before = clone(a)
  refused('stdio_v2_selection_invalid', () => compile([a], { maxTools: 1 }))
  assert.deepEqual(a, before)
})

test('compiled DTO map is strict, ordered and linked to complete original parameter schemas', () => {
  const [group] = compile([connection()]), validators = stdioOperationSchemasV2(limits, admission)
  for (const change of [value => value.tools.reverse(), value => value.tools.pop(),
    value => value.tools[0].model.parameters.properties.quantity.maximum++,
    value => value.tools[1].model.name = value.tools[0].model.name,
    value => value.arguments = {}, value => value.configuration.secret = 'forbidden']) {
    const changed = clone(group); change(changed)
    assert.equal(validators.selection.safeParse([changed]).success, false)
  }
  assert.equal(validators.input.safeParse(group).success, false, 'Input has no model map or argument placeholder')
  assert.equal(validators.selection.safeParse([group, clone(group)]).success, false)
  assert.equal(validators.selection.safeParse([]).success, true, 'Desktop or an empty Cloud selection remains representable')
})
