/** Canonical tool identities, extension preservation and Platform-private credential boundaries. */
import test from 'node:test'
import assert from 'node:assert/strict'
import { randomBytes, randomUUID } from 'node:crypto'
import { mcpDiscoveredTool, mcpResourceId, mcpToolId } from '../lib/mcp-contracts.js'
import { mcpCatalogDigest, mcpCatalogTools, mcpDescriptorDigest } from '../lib/platform/mcp-catalog.js'
import { McpCredentialCipher, mcpCanonicalJson, normalizeMcpConfiguration,
  normalizeMcpUpload } from '../lib/platform/mcp-credentials.js'

test('catalog identities retain unknown MCP JSON fields and tolerate ordering without losing tools', () => {
  const resource = mcpResourceId.parse(randomUUID())
  const raw = { name: 'lookup', inputSchema: { type: 'object', properties: { q: { type: 'string' } } },
    description: 'untrusted\u0000description', icons: [{ src: 'data:image/png;base64,AAAA', mimeType: 'image/png' }],
    futureField: { nested: [true, null, '\u0000'] } }
  assert.deepEqual(mcpDiscoveredTool.parse(raw), raw)
  const second = { name: 'write', inputSchema: { type: 'object' }, annotations: { readOnlyHint: true } }
  const tools = mcpCatalogTools(resource, [raw, second])
  assert.equal(tools.length, 2)
  assert.equal(tools[0].publicName.length, 63)
  assert.equal(mcpToolId.parse(tools[0].toolId), tools[0].toolId)
  assert.deepEqual(tools[0].raw, raw)
  assert.deepEqual(mcpCatalogTools(resource, [second, raw]), tools)
  assert.equal(mcpCatalogDigest([raw, second]), mcpCatalogDigest([second, raw]))
  assert.equal(mcpDescriptorDigest(raw), mcpDescriptorDigest({ ...raw, inputSchema: {
    properties: { q: { type: 'string' } }, type: 'object' } }))
  assert.notEqual(mcpDescriptorDigest(raw), mcpDescriptorDigest({ ...raw, futureField: { changed: true } }))
  const changed = mcpCatalogTools(resource, [{ ...raw, description: 'changed' }])[0]
  assert.equal(changed.toolId, tools[0].toolId)
  assert.equal(changed.publicName, tools[0].publicName)
  assert.notEqual(changed.descriptorDigest, tools[0].descriptorDigest)
  assert.notEqual(mcpCatalogTools(mcpResourceId.parse(randomUUID()), [raw])[0].publicName, tools[0].publicName)
  assert.throws(() => mcpCatalogTools(resource, [raw, raw]), { code: 'mcp_tool_duplicate' })
  assert.deepEqual(mcpCatalogTools(resource, []), [])
  assert.throws(() => mcpDiscoveredTool.parse({ ...raw, futureField: { notJson: undefined } }))
})

test('canonical JSON rejects non-JSON/deep values and header normalization blocks transport overrides', () => {
  assert.equal(mcpCanonicalJson({ z: 1, a: { z: 2, a: '\u0000' } }), '{"a":{"a":"\\u0000","z":2},"z":1}')
  for (const value of [NaN, Infinity, new Date(), undefined]) assert.throws(() => mcpCanonicalJson(value))
  let deep = {}; for (let i = 0; i < 66; i++) deep = { next: deep }
  assert.throws(() => mcpCanonicalJson(deep), { code: 'mcp_json_depth' })
  const configuration = { displayName: 'Test', serverUrl: 'https://MCP.example/mcp', enabled: true,
    authentication: { kind: 'headers', headers: [{ name: 'X-API-Key', action: 'replace' }] } }
  assert.equal(normalizeMcpConfiguration(configuration).authentication.headers[0].name, 'x-api-key')
  for (const name of ['Host', 'Cookie', 'Mcp-Session-Id', 'Content-Length', 'Proxy-Authorization',
    'Sec-Fetch-Site', 'X-Forwarded-Host', 'bad\r\nname']) {
    assert.throws(() => normalizeMcpConfiguration({ ...configuration,
      authentication: { kind: 'headers', headers: [{ name, action: 'replace' }] } }), { code: 'mcp_header_invalid' })
  }
  assert.throws(() => normalizeMcpConfiguration({ ...configuration, authentication: { kind: 'headers',
    headers: [{ name: 'X-Key', action: 'retain' }, { name: 'x-key', action: 'replace' }] } }),
  { code: 'mcp_header_duplicate' })
  for (const serverUrl of ['file:///etc/passwd', 'https://u:p@example.com/mcp', 'https://example.com/mcp#secret'])
    assert.throws(() => normalizeMcpConfiguration({ ...configuration, serverUrl }), { code: 'mcp_url_invalid' })
  assert.throws(() => normalizeMcpUpload({ formatVersion: 1, headers: [{ name: 'X-Key', value: 'value\nInjected' }] }),
    { code: 'mcp_credential_invalid' })
  assert.throws(() => normalizeMcpUpload({ formatVersion: 1, bearerToken: 'token value' }), { code: 'mcp_credential_invalid' })
  assert.throws(() => normalizeMcpUpload({ formatVersion: 1, unexpected: 'secret' }))
})

test('credential ciphertext binds owner/resource/configuration/credential and replay fingerprints are keyed', () => {
  const key = randomBytes(32).toString('base64url'), cipher = new McpCredentialCipher(key)
  const identity = { kind: 'connection', userId: randomUUID(), resourceId: randomUUID(),
    configurationRevision: 1, credentialRevision: 1 }
  const secret = normalizeMcpUpload({ formatVersion: 1, bearerToken: 'test-only-secret' })
  const sealed = cipher.seal(identity, secret)
  assert.equal(sealed.includes(Buffer.from(secret.bearerToken)), false)
  assert.deepEqual(cipher.open(identity, sealed), secret)
  for (const change of [{ kind: 'draft' }, { userId: randomUUID() }, { resourceId: randomUUID() },
    { configurationRevision: 2 }, { credentialRevision: 2 }])
    assert.throws(() => cipher.open({ ...identity, ...change }, sealed), { code: 'mcp_credential_unavailable' })
  assert.throws(() => new McpCredentialCipher(randomBytes(32).toString('base64url')).open(identity, sealed),
    { code: 'mcp_credential_unavailable' })
  assert.notEqual(cipher.fingerprint('metadata', secret), cipher.fingerprint('secret', secret))
  assert.notEqual(cipher.fingerprint('secret', secret), new McpCredentialCipher(randomBytes(32).toString('base64url'))
    .fingerprint('secret', secret))
  assert.throws(() => new McpCredentialCipher('wrong'))
})
