/** Pure source classification and required typed JSON/table owners never read source databases or start work. */
import { randomUUID, scryptSync } from 'node:crypto'
import { expect, test } from 'vitest'
import { LEGACY_SOURCE_LAYOUT, LEGACY_SQL_DIGESTS } from '../src/platform/legacy-import-layout.ts'
import { LegacyImportError, legacyDigest, legacyLimits, legacyRowDigest, parseLegacyBundle, type LegacyBundle, type LegacyImportLimits, type LegacyJson, type LegacySourceRow } from '../src/platform/legacy-import-codec.ts'
import { preflightLegacyImport, type LegacyImportOwners, type LegacyJsonReference } from '../src/platform/legacy-import-preflight.ts'
import { exportLegacyDetached, type LegacyDetachedExportInput } from '../src/platform/legacy-import-export.ts'
import { createLegacyImportOwners, LEGACY_IMPORT_OWNER_TABLES, type LegacyRowOwner } from '../src/platform/legacy-import-owners.ts'
import { legacyMcpJsonReferences, legacyResolutionJsonReferences } from '../src/platform/legacy-import-owner-references.ts'

const limits: LegacyImportLimits = { maxBundleBytes: 2_097_152, maxRows: 1000, maxCellBytes: 65_536,
  maxJsonDepth: 32, maxJsonNodes: 20_000, maxFiles: 100, maxFileBytes: 65_536, maxStorageBytes: 262_144 }
const time = '2025-01-02T03:04:05.123456Z'
const cut = '2025-02-02T03:04:05.123456Z'
const payload = Buffer.from('旧包文件 😀\0\n')
const passwordSalt = '01'.repeat(16)
const passwordHash = `${passwordSalt}:${scryptSync('owned-fixture-password', passwordSalt, 64).toString('hex')}`

const ids = () => ({ user: randomUUID(), workspace: randomUUID(), session: randomUUID(), operation: randomUUID() })

function records(bundle: LegacyBundle, table: string): LegacySourceRow[] {
  const rows = bundle.tables[table]
  if (!rows) throw new Error('Fixture source table missing')
  return rows
}

function detached(bundle: LegacyBundle): LegacyDetachedExportInput {
  return { source: bundle.source, tables: Object.fromEntries(Object.entries(bundle.tables).map(([table, rows]) =>
    [table, rows.map(row => ({ ...row.values }))])), files: bundle.files, cutProof: bundle.cutProof, stops: bundle.stops }
}
test('detached classification retains all 77 tables, original cells and global/per-table four-way counts', () => {
  const { bundle, alice } = packet()
  const excluded = sourceRow('pe_artifacts'); excluded.disposition = 'excluded'
  records(bundle, 'pe_artifacts').push(excluded)
  records(bundle, 'pe_file_mutations').push(sourceRow('pe_file_mutations', { user_id: alice.user,
    workspace_id: alice.workspace, request_id: randomUUID(), path: 'old.txt', digest: legacyDigest('old'),
    size: '3', mime: 'text/plain', binding_generation: '9' }))
  const before = JSON.stringify(bundle), reviewed: string[] = []
  const result = exportLegacyDetached(detached(bundle), limits, { reviewRow: ({ row }) => {
    reviewed.push(row.sha256); return { accepted: true }
  } })
  const parsed = parseLegacyBundle(result.text, legacyLimits(limits))
  expect(Object.keys(parsed.tables)).toHaveLength(77)
  expect(Object.keys(result.tableCounts)).toHaveLength(77)
  expect(result.tableCounts.pe_schema).toEqual({ preserve: 0, convert: 1, excluded: 0, rejected: 0 })
  expect(result.tableCounts.pe_file_mutations?.convert).toBe(1)
  expect(result.counts.excluded).toBe(1)
  expect(result.counts.rejected).toBe(0)
  expect(result.rows).toHaveLength(reviewed.length)
  expect(new Set(reviewed).size).toBe(reviewed.length)
  expect(parsed.tables.pe_events?.[1]?.values.event).toContain('1e0')
  expect(JSON.stringify(bundle)).toBe(before)
})
for (const version of [0, 1, 2, 3, 5]) {
  test(`detached V${version} Session history is rejected with its original values, never excluded`, () => {
    const { bundle } = packet(), session = records(bundle, 'pe_sessions')[0]
    if (!session) throw new Error('Fixture Session missing')
    session.values.header = JSON.stringify({ id: session.values.id, version, createdAt: 1, isSeeded: false })
    const header = session.values.header
    const result = exportLegacyDetached(detached(bundle), limits, { reviewRow: () => ({ accepted: true }) })
    expect(result.rows.find(row => row.sha256 === legacyRowDigest('pe_sessions', session.values))).toMatchObject({
      disposition: 'rejected', rejection: 'source_session_header_unqualified' })
    expect(result.counts.excluded).toBe(0)
    expect(parseLegacyBundle(result.text, legacyLimits(limits)).tables.pe_sessions?.[0]?.values.header).toBe(header)
    expect(() => preflightLegacyImport(result.text, limits, owners(result.text))).toThrow('source_rows_rejected')
  })
}
for (const lineage of ['seed', 'parent', 'extra metadata'] as const) {
  test(`detached ${lineage} facts cannot receive excluded disposition`, () => {
    const { bundle } = packet(), session = records(bundle, 'pe_sessions')[0]
    if (!session) throw new Error('Fixture Session missing')
    session.values.header = JSON.stringify({ id: session.values.id, version: 4, createdAt: 1,
      isSeeded: lineage === 'seed', ...(lineage === 'parent' ? { parentSession: randomUUID() }
        : lineage === 'extra metadata' ? { cwd: '/original/cwd', delegationDepth: 2 } : {}) })
    const result = exportLegacyDetached(detached(bundle), limits, { reviewRow: () => ({ accepted: true }) })
    const digest = legacyRowDigest('pe_sessions', session.values)
    if (lineage === 'extra metadata') {
      expect(result.rows.find(row => row.sha256 === digest)?.disposition).toBe('preserve')
      expect(result.counts.rejected).toBe(0)
      expect(parseLegacyBundle(result.text, legacyLimits(limits)).tables.pe_sessions?.[0])
        .toEqual({ ...session, sha256: digest })
      const plan = preflightLegacyImport(result.text, limits, owners(result.text))
      expect(plan.rows.find(row => row.table === 'pe_sessions' && row.sourceSha256 === digest)?.values)
        .toEqual(session.values)
    } else {
      expect(result.rows.find(row => row.sha256 === digest)?.disposition).toBe('rejected')
    }
    expect(result.counts.excluded).toBe(0)
  })
}
test('unqualified historical attachments and private owner failures remain rejected backup rows with bounded reasons', () => {
  const { bundle } = packet()
  const result = exportLegacyDetached(detached(bundle), limits, { reviewRow: ({ table }) => {
    if (table === 'pe_events') return { accepted: false, reason: 'historical_attachment_unqualified' }
    if (table === 'pe_users') throw new Error('fixture-private-secret-must-not-escape')
    return { accepted: true }
  } })
  expect(result.rows.filter(row => row.table === 'pe_events').every(row => row.disposition === 'rejected')).toBe(true)
  expect(result.rows.filter(row => row.table === 'pe_users').every(row => row.rejection === 'owner_validation_failed')).toBe(true)
  expect(result.counts.excluded).toBe(0)
  expect(JSON.stringify(result)).not.toContain('fixture-private-secret-must-not-escape')
})
for (const defect of ['missing table', 'extra table', 'duplicate source row', 'wrong schema', 'row budget'] as const) {
  test(`detached exporter refuses ${defect} rather than omitting facts`, () => {
    const input = detached(packet().bundle)
    const tables = { ...input.tables }
    if (defect === 'missing table') delete tables.pe_events
    if (defect === 'extra table') tables.unknown = []
    if (defect === 'duplicate source row') tables.pe_users = [...tables.pe_users ?? [], ...tables.pe_users ?? []]
    if (defect === 'wrong schema') tables.pe_schema = [{ version: '36' }]
    expect(() => exportLegacyDetached({ ...input, tables }, defect === 'row budget' ? { ...limits, maxRows: 1 } : limits,
      { reviewRow: () => ({ accepted: true }) })).toThrow(LegacyImportError)
  })
}
test('all 68 retained tables require explicit row and semantic-reference providers', () => {
  const { bundle } = packet(), text = seal(bundle), fixture = owners(text)
  const provider: LegacyRowOwner = { validateRow: fixture.validateRow, references: fixture.references }
  const rows = Object.fromEntries(Object.values(LEGACY_IMPORT_OWNER_TABLES).flat().map(table => [table, provider]))
  expect(Object.keys(rows)).toHaveLength(68)
  const configured = createLegacyImportOwners({ ...fixture, rows })
  expect(preflightLegacyImport(text, limits, configured).rows).toHaveLength(planned(bundle).rows.length)
  expect(Object.isFrozen(configured)).toBe(true)
  const missing = { ...rows }; delete missing.pe_mcp_catalog_versions
  expect(() => createLegacyImportOwners({ ...fixture, rows: missing })).toThrow('row_owner_inventory')
  expect(() => createLegacyImportOwners({ ...fixture, rows: { ...rows, pe_native_file_receipts: provider } })).toThrow('row_owner_inventory')
  expect(() => createLegacyImportOwners({ ...fixture, rows: { ...rows, pe_events: undefined } })).toThrow('row_owner_missing')
})
test('a missing required JSON reference owner refuses even a row whose payload has no identity fields', () => {
  const { bundle } = packet(), text = seal(bundle), fixture = owners(text)
  Reflect.deleteProperty(fixture, 'references')
  expect(() => preflightLegacyImport(text, limits, fixture)).toThrow('json_reference_owner_missing')
})
function workspaceReference(): LegacyJsonReference {
  return { column: 'event', targetTable: 'pe_workspaces', ownership: 'same',
    fields: [{ targetColumn: 'id', value: { kind: 'json', path: ['data', 'workspaceId'] } }] }
}
for (const defect of ['foreign owner', 'missing parent', 'missing path', 'object value', 'SQL identity changed', 'invalid declaration'] as const) {
  test(`typed semantic references reject ${defect}, independently of arbitrary JSON examples`, () => {
    const { bundle, alice, bob } = packet()
    const event = records(bundle, 'pe_events')[1], session = records(bundle, 'pe_sessions')[0]
    if (!event || !session) throw new Error('Fixture native history missing')
    const target = defect === 'foreign owner' ? bob.workspace : defect === 'missing parent' ? randomUUID() : alice.workspace
    event.values.event = JSON.stringify({ seq: 1, time: 2, type: 'employee5/retained', ignorable: true,
      data: { workspaceId: defect === 'object value' ? { nested: target } : target } })
    session.values.event_bytes = String(records(bundle, 'pe_events').filter(row => row.values.session_id === session.values.id)
      .reduce((sum, row) => sum + Buffer.byteLength(JSON.stringify(JSON.parse(row.values.event ?? ''))), 0))
    const reference: LegacyJsonReference = defect === 'missing path' ? {
      ...workspaceReference(), fields: [{ targetColumn: 'id', value: { kind: 'json', path: ['data', 'absent'] } }],
    } : defect === 'SQL identity changed' ? {
      ...workspaceReference(), fields: [{ targetColumn: 'id', value: { kind: 'json', path: ['data', 'workspaceId'], equalsRowColumn: 'session_id' } }],
    } : defect === 'invalid declaration' ? { ...workspaceReference(), fields: [] } : workspaceReference()
    expect(() => planned(bundle, limits, { references: context => context.row.table === 'pe_events'
      && context.row.values.seq === '1' ? [reference] : [] })).toThrow(LegacyImportError)
  })
}
test('typed MCP and captured storage examples declare only owned schema paths and preserve historical generations', () => {
  const { bundle, alice } = packet(), plan = planned(bundle)
  const operation = plan.rows.find(row => row.table === 'pe_operations')
  if (!operation) throw new Error('Fixture Operation missing')
  const context = { row: operation, rows: plan.rows, source: plan.source, limits, owner: alice.user,
    json: { remote_mcp_selection: [] } }
  expect(legacyMcpJsonReferences(context)).toEqual([])
  expect(() => legacyMcpJsonReferences({ ...context, row: { ...operation, table: 'pe_events' } }))
    .toThrow('json_reference_owner_unsupported')
  const binding = { workspaceId: alice.workspace, spaceId: alice.workspace, rootKey: alice.workspace,
    rootRelativePath: '', generation: 8 }
  const resolution = { ...context, row: { ...operation, table: 'pe_cloud_execution_resolutions',
    values: { workspace_id: alice.workspace, mount_generation: '8' } }, json: { binding_snapshot: binding } }
  const references = legacyResolutionJsonReferences(resolution)
  expect(references.map(reference => reference.targetTable)).toEqual(['pe_workspaces', 'pe_storage_spaces'])
  expect(() => legacyResolutionJsonReferences({ ...resolution,
    row: { ...resolution.row, values: { ...resolution.row.values, mount_generation: '9' } } })).toThrow('json_identity_changed')
})
function sourceRow(table: string, patch: Record<string, string | null> = {}): LegacySourceRow {
  const columns = LEGACY_SOURCE_LAYOUT[table]
  if (!columns) throw new Error('Fixture source table missing')
  const values: Record<string, string | null> = {}
  for (const [column, definition] of Object.entries(columns)) {
    if (definition.nullable) { values[column] = null; continue }
    switch (definition.kind) {
      case 'uuid': values[column] = randomUUID(); break
      case 'text': values[column] = ''; break
      case 'boolean': values[column] = 'false'; break
      case 'json':
      case 'jsonb': values[column] = '{}'; break
      case 'timestamptz': values[column] = time; break
      case 'integer':
      case 'bigint': values[column] = '0'; break
      case 'bytea': values[column] = '\\x'; break
    }
  }
  Object.assign(values, patch)
  return { disposition: table === 'pe_schema' || table === 'pe_file_mutations' ? 'convert' : 'preserve',
    values, sha256: legacyRowDigest(table, values) }
}
function seal(bundle: LegacyBundle): string {
  const counts = { preserve: 0, convert: 0, excluded: 0, rejected: 0 }
  for (const [table, rows] of Object.entries(bundle.tables)) for (const row of rows) {
    row.sha256 = legacyRowDigest(table, row.values); counts[row.disposition]++
  }
  bundle.counts = counts
  return JSON.stringify(bundle)
}
function packet() {
  const alice = ids(), bob = ids()
  const bundle: LegacyBundle = { format: 'power-evolve-legacy-offline', version: 1,
    source: { schema: 37, ddlSha256: LEGACY_SQL_DIGESTS.source37, snapshotId: randomUUID(), codeId: 'reviewed-fixed-fixture', stoppedAt: time, cut },
    tables: Object.fromEntries(Object.keys(LEGACY_SOURCE_LAYOUT).map(table => [table, []])),
    counts: { preserve: 0, convert: 0, excluded: 0, rejected: 0 }, files: [], cutProof: '{"kind":"owned-fixture-cut"}', stops: [] }
  records(bundle, 'pe_schema').push(sourceRow('pe_schema', { version: '37' }))
  for (const [index, id] of [alice, bob].entries()) {
    records(bundle, 'pe_users').push(sourceRow('pe_users', { id: id.user, username: index ? 'import-bob' : 'import-alice',
      password_hash: passwordHash, display_name: index ? 'Bob' : 'Alice', role: 'USER', enabled: 'true',
      account_revision: '7', credential_version: '3', password_change_required: 'false',
      settings: '{ "model": "trial-model", "maxTokens": 1000, "revision": 7 }' }))
    records(bundle, 'pe_workspaces').push(sourceRow('pe_workspaces', { id: id.workspace, user_id: id.user,
      title: index ? 'Bob Home' : 'Alice Home', is_default: 'true', create_request_id: randomUUID(),
      binding_generation: '9', binding_state: 'ready' }))
    records(bundle, 'pe_storage_spaces').push(sourceRow('pe_storage_spaces', { id: id.workspace, user_id: id.user,
      root_key: id.workspace, title: 'retained cloud root', is_default: 'true', root_state: 'ready' }))
    records(bundle, 'pe_workspace_bindings').push(sourceRow('pe_workspace_bindings', { workspace_id: id.workspace,
      user_id: id.user, space_id: id.workspace, root_relative_path: '' }))
    const event = JSON.stringify({ seq: 0, time: 1, type: 'session/title', data: { title: index ? 'Bob old title' : 'Alice old title',
      messageSeqs: [], source: { kind: 'user' } } })
    const ignored = '{ "seq":1, "time":2, "type":"employee5/retained", "ignorable":true, "data":{"value":1e0,"emoji":"\\uD83D\\uDE00"} }'
    const events = index ? [event] : [event, ignored]
    records(bundle, 'pe_sessions').push(sourceRow('pe_sessions', { id: id.session, user_id: id.user, workspace_id: id.workspace,
      create_request_id: randomUUID(), header: JSON.stringify({ id: id.session, version: 4, createdAt: 1, isSeeded: false }),
      event_count: String(events.length),
      event_bytes: String(events.reduce((sum, text) => sum + Buffer.byteLength(JSON.stringify(JSON.parse(text))), 0)),
      lease_epoch: '13' }))
    for (const [seq, text] of events.entries()) records(bundle, 'pe_events').push(sourceRow('pe_events', {
      session_id: id.session, seq: String(seq), event: text }))
    records(bundle, 'pe_operations').push(sourceRow('pe_operations', { id: id.operation, session_id: id.session,
      request_id: randomUUID(), input: index ? 'old bob prompt' : 'old alice prompt', state: 'completed', attempts: '1', completed_at: time,
      settings: '{"model":"trial-model","maxTokens":1000,"revision":7}', source: 'user', execution_target: '{"kind":"cloud"}',
      skill_selection: '[]', mcp_selection: '[]', stdio_mcp_selection: '[]', ssh_selection: '[]', remote_mcp_selection: '[]', stdio_v2_selection: '[]' }))
    records(bundle, 'pe_attempts').push(sourceRow('pe_attempts', { operation_id: id.operation, epoch: '13', worker_id: randomUUID(), ended_at: time }))
    records(bundle, 'pe_credentials').push(sourceRow('pe_credentials', { user_id: id.user, audience: 'agent',
      digest: legacyDigest(`expired-token-${id.user}`), expires_at: time, credential_version: '3' }))
    for (const area of ['workspace', 'home'] as const) bundle.files.push({ area, owner: id.user,
      resource: area === 'workspace' ? id.workspace : id.user, path: '', kind: 'directory', sourcePath: null,
      bytes: null, sha256: null, mode: 0o750, uid: 1000, gid: 1000 })
  }
  bundle.files.push({ area: 'workspace', owner: alice.user, resource: alice.workspace, path: '旧文件.txt', kind: 'file',
    sourcePath: 'payload.bin', bytes: String(payload.length), sha256: legacyDigest(payload), mode: 0o640, uid: 1000, gid: 1000 })
  seal(bundle)
  return { bundle, alice, bob }
}
function jsonObject(value: LegacyJson | undefined): value is Readonly<Record<string, LegacyJson>> {
  return value !== null && value !== undefined && typeof value === 'object' && !Array.isArray(value)
}
function owners(text: string, overrides: Partial<LegacyImportOwners> = {}): LegacyImportOwners {
  const expected = legacyDigest(text)
  return { verifyCut: (source, proof, packetSha256) => {
    if (packetSha256 !== expected || source.codeId !== 'reviewed-fixed-fixture' || proof === null
      || typeof proof !== 'object' || !('kind' in proof) || proof.kind !== 'owned-fixture-cut') throw new Error('unverified cut')
  }, validateRow: () => {}, references: ({ row, json }) => {
    const event = json.event
    if (row.table !== 'pe_events' || !jsonObject(event)
      || event.type !== 'employee5/retained' || !jsonObject(event.data) || !Object.hasOwn(event.data, 'workspaceId')) return []
    return [{ column: 'event', targetTable: 'pe_workspaces', ownership: 'same',
      fields: [{ targetColumn: 'id', value: { kind: 'json', path: ['data', 'workspaceId'] } }] }]
  }, verifyStopped: () => { throw new Error('This fixture supplies no physical stop adapter') },
  verifyFiles: () => {}, ...overrides }
}
function planned(bundle: LegacyBundle, configuration = limits, adapters: Partial<LegacyImportOwners> = {}) {
  const text = seal(bundle)
  return preflightLegacyImport(text, configuration, owners(text, adapters))
}
