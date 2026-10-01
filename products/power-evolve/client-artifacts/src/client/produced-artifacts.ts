/** Native history supplies execution references; only Platform queries supply produced file versions. */
import type { ConversationNodeDefinition } from '@deepseek-ai/dsh-client-ui-conversation/client'
import type { TurnTailOwnerProps } from '@deepseek-ai/dsh-client-ui-chat/client'
import { executionFilesRequest } from '@power-evolve/contracts/execution-files'
import type { ExecutionProducedFile } from '@power-evolve/contracts/execution-files'

/** A durable receipt or trusted continuation; a loaded receipt supplies its native call and turn. */
export interface ExecutionReference {
  readonly executionId: string
  readonly callId: string | undefined
  readonly turn: number | undefined
  readonly seq: number
}

/** References owned by this turn and references named by its trusted continuation. */
export interface ArtifactTurnData {
  readonly executions: readonly ExecutionReference[]
  readonly associated: readonly ExecutionReference[]
}

declare module '@deepseek-ai/dsh-client-ui-conversation/client' {
  interface ConversationTurnDataMap {
    powerEvolveArtifacts: ArtifactTurnData
    powerEvolveArtifactAssociations: readonly ExecutionReference[]
  }
}

interface ArtifactState extends ArtifactTurnData {
  readonly turn: number | undefined
  readonly known: readonly ExecutionReference[]
  readonly calls: ReadonlySet<string>
  readonly associationTurn: number | undefined
}

/** Data-only Conversation definition; it publishes no files from tool arguments, receipts or prose. */
export const artifactDefinition: ConversationNodeDefinition<ArtifactState> = {
  kind: 'powerEvolveArtifacts',
  match: event => {
    if (event.type === 'user/message' && event.surfaceOp === 'append') return { id: `input:${event.seq}`, role: 'start' }
    if (event.type === 'turn/start') return { id: String(event.data.turn), role: 'start' }
    if (event.type === 'tool/call' || (event.type === 'tool/result' && event.surfaceOp === 'append')) {
      return { id: String(event.data.turn), role: 'update' }
    }
    return null
  },
  start: (_context, match, reader) => {
    const previous = reader.previous<ArtifactState>('powerEvolveArtifacts')?.state
    const known = previous?.known ?? []
    if (match.event.type === 'user/message') {
      const source: unknown = match.event.data.source
      const executionId = isRecord(source) && source.kind === 'power-evolve-execution' && typeof source.executionId === 'string'
        ? source.executionId : undefined
      const valid = executionFilesRequest.shape.executionIds.element.safeParse(executionId)
      const reference = known.find(item => item.executionId === executionId)
      const associationTurn = match.location.kind === 'turn' || match.location.kind === 'step' ? match.location.turn.turn : undefined
      const associated = associationTurn !== undefined && previous?.associationTurn === associationTurn ? previous.associated : []
      return { turn: undefined, known, calls: new Set(), executions: [], associationTurn,
        associated: !valid.success ? associated : [...associated.filter(item => item.executionId !== valid.data),
          { executionId: valid.data, callId: reference?.callId, turn: reference?.turn, seq: match.event.seq }] }
    }
    if (match.event.type !== 'turn/start') throw new Error('Execution references require native turn/start')
    const associated = previous !== undefined && previous.turn === undefined && previous.associationTurn === undefined ? previous.associated : []
    return { turn: match.event.data.turn, known, calls: new Set(), executions: [], associated,
      associationTurn: associated.length === 0 ? undefined : match.event.data.turn }
  },
  update: (context, match) => {
    if (match.event.type === 'tool/call') {
      if (match.event.data.name !== 'cloud_exec') return context.state
      const calls = new Set(context.state.calls)
      calls.add(String(match.event.data.callId))
      return { ...context.state, calls }
    }
    if (match.event.type !== 'tool/result' || context.state.turn === undefined) return context.state
    const result = match.event.data.message
    const callId = String(result.source.callId)
    if (result.isError === true || String(result.toolCallId) !== callId || !context.state.calls.has(callId)) return context.state
    const text = result.content.length === 1 && result.content[0]?.type === 'text' ? result.content[0].text : undefined
    if (text === undefined || text.length > 16 * 1024) return context.state
    let value: unknown
    try { value = JSON.parse(text) }
    catch (_error) { return context.state }
    if (!isRecord(value) || typeof value.executionId !== 'string' || typeof value.state !== 'string'
      || typeof value.command !== 'string' || typeof value.cwd !== 'string') return context.state
    // Reuse the wire parser's UUID rule without inventing a second execution-id format.
    if (!executionFilesRequest.shape.executionIds.element.safeParse(value.executionId).success) return context.state
    if (context.state.executions.some(item => item.callId === callId)) return context.state
    const reference = { executionId: value.executionId, callId, turn: context.state.turn, seq: match.event.seq }
    return { ...context.state, executions: [...context.state.executions, reference], known: [...context.state.known, reference] }
  },
  buildLocationData: (context, scope) => {
    if (scope !== 'turn' || context.state?.turn === undefined) return null
    return { kind: 'turn', turn: context.state.turn, key: 'powerEvolveArtifacts',
      value: { executions: context.state.executions, associated: context.state.associated } }
  },
}

interface AssociationClosing { readonly turn: number; readonly associated: readonly ExecutionReference[] }

/** Native inputs are logged after turn/start; collect their trusted associations once the closing is known. */
export const artifactAssociationsDefinition: ConversationNodeDefinition<AssociationClosing> = {
  kind: 'powerEvolveArtifactAssociations',
  match: event => event.type === 'turn/end' ? { id: String(event.data.turn), role: 'start' } : null,
  start: (_context, match, reader) => {
    if (match.event.type !== 'turn/end') throw new Error('Execution associations require native turn/end')
    const turn = match.event.data.turn
    const previous = reader.previous<ArtifactState>('powerEvolveArtifacts')?.state
    return { turn, associated: previous?.associationTurn === turn ? previous.associated : [] }
  },
  update: context => context.state,
  buildLocationData: (context, scope) => scope !== 'turn' || context.state === undefined ? null : {
    kind: 'turn', turn: context.state.turn, key: 'powerEvolveArtifactAssociations', value: context.state.associated,
  },
}

/** Select only native receipts present at this closing, optionally including a trusted continuation.
 * @param owner - native closing turn and its sequence.
 * @param associated - include continuation references for prose, never for the original output row.
 * @returns call-bound execution identities to verify with the Platform.
 */
export function referencesForClosing(owner: TurnTailOwnerProps, associated = false): readonly ExecutionReference[] {
  const data = owner.turn.data.get('powerEvolveArtifacts')
  const through = associated ? owner.seq : owner.turn.end?.seq ?? owner.seq
  const references = associated
    ? [...data?.executions ?? [], ...data?.associated ?? [], ...owner.turn.data.get('powerEvolveArtifactAssociations') ?? []]
    : data?.executions ?? []
  return [...new Map(references.map(item => [JSON.stringify([item.executionId, item.callId, item.seq]), item])).values()]
    .filter(item => item.seq <= through).sort((left, right) => left.seq - right.seq)
}

/** Resolve exact verified paths or one unambiguous verified basename; arbitrary authored paths stay unclaimed.
 * @param files - versions already verified for this viewed Session and closing.
 * @param value - inline code exactly as authored.
 * @returns matching verified version, or absence for unknown and ambiguous mentions.
 */
export function resolveArtifactMention<T extends ExecutionProducedFile>(files: readonly T[], value: string): T | undefined {
  const relative = value.startsWith('/workspace/') ? value.slice('/workspace/'.length) : value
  const exact = files.filter(file => file.path === relative)
  if (exact.length > 0) return exact.at(-1)
  if (value.includes('/') || value.includes('\\')) return undefined
  const latest = new Map(files.map(file => [file.path, file]))
  const matches = [...latest.values()].filter(file => basename(file.path) === value)
  return matches.length === 1 ? matches[0] : undefined
}

/** File label retains the full relative path in its title.
 * @param path - canonical Workspace-relative path.
 * @returns its final segment.
 */
export function basename(path: string): string { return path.split('/').at(-1)! }

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value)
}
