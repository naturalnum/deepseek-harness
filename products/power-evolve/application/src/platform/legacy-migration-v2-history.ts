/** Explicit PG-logical/released-physical restoration through the maintained adjacent Session migrations. */
import { z } from 'zod'
import { brandString } from '@deepseek-ai/dsh-brand'
import { Session, SessionLogOffset, KNOWN_SESSION_EVENT_TYPES, type SessionId, type SessionHeader } from '@deepseek-ai/dsh-session'
import { parseEvents } from '../session-records.ts'
import { imageOffloadProjection } from '@deepseek-ai/dsh-compaction-image-offload/projection'
import { createSessionFormatCatalog, createSessionFormatChain, SessionFormatEventCollector, isSessionFormatJsonObject,
  type SessionFormatArtifact, type SessionFormatCodec, type SessionFormatEvent, type SessionFormatHeader,
  type SessionFormatMigration, type SessionFormatMigrationContext } from '@deepseek-ai/dsh-session-format'
import { releasedV0SessionFormatCodec, releasedV1SessionFormatCodec, sessionFormatV0ToV1 } from '@deepseek-ai/dsh-session-format-v0-to-v1'
import { releasedV2SessionFormatCodec, sessionFormatV1ToV2 } from '@deepseek-ai/dsh-session-format-v1-to-v2'
import { releasedV3SessionFormatCodec, sessionFormatV2ToV3, assertReleasedV3Header,
  restoreReleasedV3Artifact } from '@deepseek-ai/dsh-session-format-v2-to-v3'
import { releasedV4SessionFormatCodec, createSessionFormatV3ToV4, assertReleasedV4Header,
  restoreReleasedV4Artifact, historicalChildCatalogSource, RELEASED_V3_EVENT_TYPES } from '@deepseek-ai/dsh-session-format-v3-to-v4'
import { LegacyImportError, legacyDigest, legacyJson, legacyRowDigest, type LegacyImportLimits } from './legacy-import-codec.ts'
import type { LegacyMigrationCapture, LegacyMigrationCells } from './legacy-migration-v2-source.ts'

/** The source owner's explicit representation; a PG schema version never chooses a physical codec. */
export const legacyHistoryStorage = z.object({ sessionId: z.uuid(),
  encoding: z.enum(['pg-logical', 'released-physical']),
  inheritedEventCount: z.number().int().nonnegative().optional() }).strict()
/** Source representation declaration for one complete Session. */
export type LegacyHistoryStorage = z.infer<typeof legacyHistoryStorage>
/** Causal emitted coordinate ranges at one codec or adjacent migration stage. */
export interface LegacyHistoryCoordinate {
  readonly stage: string
  readonly input: readonly number[]
  readonly output: readonly number[]
}
/** Original archive identity and complete current artifact; original cells remain in the capture. */
export interface LegacyMigratedHistory {
  readonly sessionId: string
  readonly userId: string
  readonly sourceHeaderSha256: string
  readonly sourceRows: readonly string[]
  readonly sourceVersion: number
  readonly encoding: LegacyHistoryStorage['encoding']
  readonly header: SessionHeader
  readonly headerText: string
  readonly events: readonly SessionFormatEvent[]
  readonly eventTexts: readonly string[]
  readonly inheritedEventCount: number
  readonly eventBytes: string
  readonly coordinates: readonly LegacyHistoryCoordinate[]
  readonly targetSha256: string
}
const safeCount = z.number().int().nonnegative().max(Number.MAX_SAFE_INTEGER)
const storedHeader = z.object({ id: z.uuid(), version: safeCount, createdAt: safeCount, isSeeded: z.boolean(),
  parentSession: z.uuid().optional(), cwd: z.string().optional(), origin: z.literal('subagent').optional(),
  delegationDepth: safeCount.optional(), agentPreset: z.string().optional() }).strict()
function metadata(value: z.infer<typeof storedHeader>) {
  return { ...(value.cwd === undefined ? {} : { cwd: value.cwd }),
    ...(value.origin === undefined ? {} : { origin: value.origin }),
    ...(value.delegationDepth === undefined ? {} : { delegationDepth: value.delegationDepth }),
    ...(value.agentPreset === undefined ? {} : { agentPreset: value.agentPreset }) }
}
const currentHeader = storedHeader.extend({ id: z.uuid().transform(brandString<SessionId>), version: z.literal(4),
  parentSession: z.uuid().transform(brandString<SessionId>).optional() }).transform((value): SessionHeader => ({
  id: value.id, version: value.version, createdAt: value.createdAt, isSeeded: value.isSeeded, ...metadata(value),
  ...(value.parentSession === undefined ? {} : { parentSession: value.parentSession }),
}))
const logicalEvent = z.object({ seq: safeCount, time: safeCount, type: z.string(), data: z.json() }).catchall(z.json())
const range = (first: number, count: number, maximum: number): number[] => {
  if (!Number.isSafeInteger(first) || first < 0 || !Number.isSafeInteger(count) || count < 0
    || first + count > maximum) throw new LegacyImportError('history_target_event_budget')
  return Array.from({ length: count }, (_value, index) => first + index)
}

function outputRecorder(context: SessionFormatMigrationContext, output: number[],
  maximum: number, emitted: { count: number }): SessionFormatMigrationContext {
  return {
    emitEvent(event) {
      if (++emitted.count > maximum || event.seq >= maximum) throw new LegacyImportError('history_target_event_budget')
      output.push(event.seq); context.emitEvent(event)
    },
    emitRun(run) {
      emitted.count += run.eventCount
      if (emitted.count > maximum) throw new LegacyImportError('history_target_event_budget')
      output.push(...range(run.firstSeq, run.eventCount, maximum)); context.emitRun(run)
    },
  }
}
function tracedMigration(migration: SessionFormatMigration, ledger: LegacyHistoryCoordinate[], maximum: number): SessionFormatMigration {
  return { ...migration, createStage(input) {
    const stage = migration.createStage(input), emitted = { count: 0 }
    return { ...(stage.headerInheritedEventCount === undefined ? {} : { headerInheritedEventCount: stage.headerInheritedEventCount }),
      transformEvent(event, context) {
        const output: number[] = []
        stage.transformEvent(event, outputRecorder(context, output, maximum, emitted))
        ledger.push({ stage: `${migration.fromVersion}->${migration.toVersion}`, input: [event.seq], output })
      },
      transformRun(run, context) {
        const output: number[] = []
        stage.transformRun(run, outputRecorder(context, output, maximum, emitted))
        ledger.push({ stage: `${migration.fromVersion}->${migration.toVersion}`,
          input: range(run.firstSeq, run.eventCount, maximum), output })
      },
      finish(context) {
        const output: number[] = []
        const cut = stage.finish(outputRecorder(context, output, maximum, emitted))
        ledger.push({ stage: `${migration.fromVersion}->${migration.toVersion}:finish`, input: [], output })
        return cut
      },
    }
  } }
}
function tracedCodec(codec: SessionFormatCodec, ledger: LegacyHistoryCoordinate[], maximum: number): SessionFormatCodec {
  return { ...codec, createDecoder(header, recovery) {
    const decoder = codec.createDecoder(header, recovery), emitted = { count: 0 }
    let row = 0
    return { ...decoder, decodeRow(value, context) {
      const output: number[] = []
      decoder.decodeRow(value, outputRecorder(context, output, maximum, emitted))
      ledger.push({ stage: `decode-v${codec.version}`, input: [row++], output })
    } }
  } }
}
function nativeArtifact(artifact: SessionFormatArtifact): SessionFormatArtifact {
  const header = currentHeader.parse(artifact.header)
  const events = parseEvents(header, artifact.events)
  Session.fromRestore(header.id, events, header, SessionLogOffset(artifact.inheritedEventCount), 'detached', [imageOffloadProjection])
  return artifact
}
function currentOptions(children: readonly ReturnType<typeof historicalChildCatalogSource>[], ledger: LegacyHistoryCoordinate[],
  maximum: number) {
  return { currentVersion: 4,
    migrations: [sessionFormatV0ToV1, sessionFormatV1ToV2, sessionFormatV2ToV3, createSessionFormatV3ToV4(children)]
      .map(migration => tracedMigration(migration, ledger, maximum)),
    restoreCurrentHeader(header: SessionFormatHeader) { assertReleasedV4Header(header); return header },
    restoreCurrent(artifact: SessionFormatArtifact) {
      return nativeArtifact(restoreReleasedV4Artifact(artifact, KNOWN_SESSION_EVENT_TYPES))
    },
  }
}
function logicalArtifact(headerValue: unknown, events: readonly SessionFormatEvent[], declaration: LegacyHistoryStorage,
  target: 3 | 4, children: readonly ReturnType<typeof historicalChildCatalogSource>[], ledger: LegacyHistoryCoordinate[],
  maximum: number): SessionFormatArtifact {
  const source = storedHeader.parse(headerValue)
  if (source.version > target || source.version < 4 && source.delegationDepth === undefined) {
    throw new LegacyImportError('history_logical_header_unqualified')
  }
  const header: SessionFormatHeader = { id: source.id, version: source.version, createdAt: source.createdAt,
    isSeeded: source.isSeeded, ...metadata(source), delegationDepth: source.delegationDepth ?? 0,
    ...(source.parentSession === undefined ? {} : { parentSession: source.parentSession }) }
  const marker = events.findLast(event => event.type === 'session/end-seed'
    && isSessionFormatJsonObject(event.data) && event.data['inherited'] === true)
  const sourceCut = declaration.inheritedEventCount ?? (source.isSeeded ? marker?.seq : 0)
  if (sourceCut === undefined || sourceCut > events.length || !source.isSeeded && sourceCut !== 0
    || marker && sourceCut !== marker.seq) throw new LegacyImportError('history_inherited_cut')
  if (source.version === target) {
    const artifact = { header, inheritedEventCount: sourceCut, events }
    return target === 4 ? nativeArtifact(restoreReleasedV4Artifact(artifact, KNOWN_SESSION_EVENT_TYPES))
      : restoreReleasedV3Artifact(artifact, RELEASED_V3_EVENT_TYPES)
  }
  const options = target === 4 ? currentOptions(children, ledger, maximum) : { currentVersion: 3,
    migrations: [sessionFormatV0ToV1, sessionFormatV1ToV2, sessionFormatV2ToV3]
      .map(migration => tracedMigration(migration, ledger, maximum)),
    restoreCurrentHeader(value: SessionFormatHeader) { assertReleasedV3Header(value); return value },
  }
  const collector = new SessionFormatEventCollector()
  const stream = createSessionFormatChain(options).createStream(header, sourceCut, collector)
  for (const event of events) stream.emitEvent(event)
  const artifact = { header: stream.header, inheritedEventCount: stream.finish(), events: collector.values }
  return target === 4 ? nativeArtifact(restoreReleasedV4Artifact(artifact, KNOWN_SESSION_EVENT_TYPES))
    : restoreReleasedV3Artifact(artifact, RELEASED_V3_EVENT_TYPES)
}

/** Convert complete source histories without changing their archived rows or deriving storage format from table names.
 * @param capture Original consistent source packet, retaining every header and event cell.
 * @param declarations Complete source-owned representation/cut declarations, exactly one per Session.
 * @param limits Maintenance JSON and original-cell budgets.
 * @returns Current native artifacts, exact count/bytes and per-stage emitted-coordinate ledgers.
 */
export function migrateLegacyHistories(capture: LegacyMigrationCapture, declarations: readonly LegacyHistoryStorage[],
  limits: LegacyImportLimits): readonly LegacyMigratedHistory[] {
  const sessions = capture.tables.pe_sessions ?? [], allEvents = capture.tables.pe_events ?? []
  const declared = new Map<string, LegacyHistoryStorage>()
  for (const input of declarations) {
    const item = legacyHistoryStorage.parse(input)
    if (declared.has(item.sessionId)) throw new LegacyImportError('history_storage_duplicate')
    declared.set(item.sessionId, item)
  }
  if (declared.size !== sessions.length || sessions.some(row => !row.id || !declared.has(row.id))) {
    throw new LegacyImportError('history_storage_inventory')
  }
  const artifacts = new Map<string, {
    row: LegacyMigrationCells
    declaration: LegacyHistoryStorage
    rawHeader: unknown
    rows: readonly LegacyMigrationCells[]
    rawEvents: readonly unknown[]
    version: number
  }>()
  for (const row of sessions) {
    const id = z.uuid().parse(row.id), declaration = declared.get(id)
    if (!declaration) throw new LegacyImportError('history_storage_missing')
    const headerValue = legacyJson(row.header ?? '', limits)
    const version = z.object({ id: z.literal(id), version: safeCount }).loose().parse(headerValue).version
    if (version > 4) throw new LegacyImportError('history_future_version')
    const rows = allEvents.filter(event => event.session_id === id).sort((a, b) => Number(a.seq) - Number(b.seq))
    if (BigInt(row.event_count ?? '') !== BigInt(rows.length)
      || rows.some((event, index) => event.seq !== String(index))) throw new LegacyImportError('history_source_gap')
    const rawEvents = rows.map(event => legacyJson(event.event ?? '', limits))
    if (BigInt(row.event_bytes ?? '') !== rawEvents.reduce((sum, event) => sum + BigInt(Buffer.byteLength(JSON.stringify(event))), 0n)) {
      throw new LegacyImportError('history_source_bytes')
    }
    artifacts.set(id, { row, declaration, rawHeader: headerValue, rows, rawEvents, version })
  }
  if (allEvents.some(event => !event.session_id || !artifacts.has(event.session_id))) throw new LegacyImportError('history_orphan_event')
  const historical = new Map<string, SessionFormatArtifact>()
  for (const [id, source] of artifacts) {
    if (source.version === 4) continue
    if (source.declaration.encoding === 'pg-logical') {
      historical.set(id, logicalArtifact(source.rawHeader, z.array(logicalEvent).parse(source.rawEvents),
        source.declaration, 3, [], [], limits.maxRows))
    } else {
      const options = { currentVersion: 3, migrations: [sessionFormatV0ToV1, sessionFormatV1ToV2, sessionFormatV2ToV3]
        .map(migration => tracedMigration(migration, [], limits.maxRows)),
      restoreCurrentHeader(header: SessionFormatHeader) { assertReleasedV3Header(header); return header },
      restoreCurrent(artifact: SessionFormatArtifact) { return restoreReleasedV3Artifact(artifact, RELEASED_V3_EVENT_TYPES) } }
      const catalog = createSessionFormatCatalog({ ...options,
        codecs: [releasedV0SessionFormatCodec, releasedV1SessionFormatCodec, releasedV2SessionFormatCodec, releasedV3SessionFormatCodec]
          .map(codec => tracedCodec(codec, [], limits.maxRows)), currentEncoder: releasedV3SessionFormatCodec,
        restoreTransformedCurrent(artifact) { return options.restoreCurrent(artifact) } })
      const restore = catalog.createRestore(source.rawHeader, { recovery: 'strict', validation: 'current' })
      for (const value of source.rawEvents) restore.decodeRow(value)
      historical.set(id, restore.finish())
    }
  }
  const result: LegacyMigratedHistory[] = []
  for (const [id, source] of artifacts) {
    const coordinates: LegacyHistoryCoordinate[] = []
    const children: ReturnType<typeof historicalChildCatalogSource>[] = []
    for (const [childId, child] of artifacts) {
      const meta = z.object({ parentSession: z.string().optional(), origin: z.string().optional() }).loose().parse(child.rawHeader)
      if (meta.parentSession !== id || meta.origin !== 'subagent') continue
      if (child.row.user_id !== source.row.user_id) throw new LegacyImportError('history_child_owner')
      let artifact = historical.get(childId)
      if (!artifact && child.version === 4 && child.declaration.encoding === 'pg-logical') {
        artifact = logicalArtifact(child.rawHeader, z.array(logicalEvent).parse(child.rawEvents),
          child.declaration, 4, [], [], limits.maxRows)
      }
      if (!artifact && child.version === 4 && child.declaration.encoding === 'released-physical') {
        const options = currentOptions([], [], limits.maxRows)
        const catalog = createSessionFormatCatalog({ ...options, codecs: [tracedCodec(releasedV4SessionFormatCodec, [], limits.maxRows)],
          currentEncoder: releasedV4SessionFormatCodec,
          restoreTransformedCurrent(artifact) { return options.restoreCurrent(artifact) } })
        const restore = catalog.createRestore(child.rawHeader, { recovery: 'strict', validation: 'current' })
        for (const value of child.rawEvents) restore.decodeRow(value)
        artifact = restore.finish()
      }
      if (!artifact) throw new LegacyImportError('history_child_facts_missing')
      children.push(historicalChildCatalogSource(artifact))
    }
    let artifact: SessionFormatArtifact
    if (source.declaration.encoding === 'pg-logical') {
      artifact = logicalArtifact(source.rawHeader, z.array(logicalEvent).parse(source.rawEvents),
        source.declaration, 4, children, coordinates, limits.maxRows)
    } else {
      const options = currentOptions(children, coordinates, limits.maxRows)
      const catalog = createSessionFormatCatalog({ ...options,
        codecs: [releasedV0SessionFormatCodec, releasedV1SessionFormatCodec, releasedV2SessionFormatCodec,
          releasedV3SessionFormatCodec, releasedV4SessionFormatCodec].map(codec => tracedCodec(codec, coordinates, limits.maxRows)),
        currentEncoder: releasedV4SessionFormatCodec,
        restoreTransformedCurrent(artifact) { return options.restoreCurrent(artifact) } })
      const restore = catalog.createRestore(source.rawHeader, { recovery: 'strict', validation: 'current' })
      for (const value of source.rawEvents) restore.decodeRow(value)
      artifact = restore.finish()
    }
    const header = currentHeader.parse(artifact.header)
    if (header.parentSession !== undefined) {
      const parent = artifacts.get(header.parentSession)
      if (!parent || parent.row.user_id !== source.row.user_id || header.parentSession === id) {
        throw new LegacyImportError('history_parent_owner')
      }
      const visited = new Set([id])
      let ancestor: string | undefined = header.parentSession
      while (ancestor !== undefined) {
        if (visited.has(ancestor)) throw new LegacyImportError('history_parent_cycle')
        visited.add(ancestor)
        const original = artifacts.get(ancestor)
        if (!original || original.row.user_id !== source.row.user_id) throw new LegacyImportError('history_parent_owner')
        ancestor = z.object({ parentSession: z.string().optional() }).loose().parse(original.rawHeader).parentSession
      }
    }
    const unchanged = source.version === 4 && source.declaration.encoding === 'pg-logical'
    if (unchanged) for (const event of artifact.events) coordinates.push({ stage: 'v4-identity', input: [event.seq], output: [event.seq] })
    const headerText = unchanged ? source.row.header ?? '' : JSON.stringify(header)
    const eventTexts = unchanged ? source.rows.map(row => row.event ?? '') : artifact.events.map(event => JSON.stringify(event))
    const eventBytes = artifact.events.reduce((sum, event) => sum + BigInt(Buffer.byteLength(JSON.stringify(event))), 0n).toString()
    result.push(Object.freeze({ sessionId: id, userId: z.uuid().parse(source.row.user_id),
      sourceHeaderSha256: legacyDigest(source.row.header ?? ''),
      sourceRows: Object.freeze(source.rows.map(row => legacyRowDigest('pe_events', row))), sourceVersion: source.version,
      encoding: source.declaration.encoding, header, headerText, events: Object.freeze([...artifact.events]),
      eventTexts: Object.freeze(eventTexts), inheritedEventCount: artifact.inheritedEventCount, eventBytes,
      coordinates: Object.freeze(coordinates), targetSha256: legacyDigest(JSON.stringify({ headerText, eventTexts, eventBytes })) }))
  }
  for (const history of result) {
    if (history.events.length > limits.maxRows || Buffer.byteLength(JSON.stringify(history)) > limits.maxBundleBytes) {
      throw new LegacyImportError('history_target_budget')
    }
    if (history.header.parentSession !== undefined && history.inheritedEventCount > 0) {
      const parent = result.find(item => item.sessionId === history.header.parentSession)
      if (!parent || history.inheritedEventCount > parent.events.length
        || JSON.stringify(history.events.slice(0, history.inheritedEventCount))
        !== JSON.stringify(parent.events.slice(0, history.inheritedEventCount))) throw new LegacyImportError('history_parent_prefix')
    }
  }
  return Object.freeze(result)
}
