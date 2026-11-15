/** Original ZIP export registration with optional embedding admission before any Session read. */
import type { Context } from '@deepseek-ai/cordis'
import type { CommandDefinitionId } from '@deepseek-ai/dsh-commands/brand'
import type { CommandResult } from '@deepseek-ai/dsh-commands'
import type { SessionId } from '@deepseek-ai/dsh-session/types'
import { brandString } from '@deepseek-ai/dsh-brand'
import type { Config } from './index.ts'
import { SESSION_LOG_EXPORT_PATH } from './routes.ts'
import { DEFAULT_SESSION_LOG_COMPRESSION_LEVEL, flushLiveSessionLog, readSessionLogText,
  sessionLogExportDeps, sessionLogZipFilename, streamSessionLogZip,
  type SessionLogCompressionLevel, type SessionLogExportReady } from './archive.ts'

/** Prepare the original Session read before native export work.
 * @param sessionId Actual Session parsed from the native request.
 * @param request Original GET or HEAD request, including caller cancellation.
 * @returns Cancellation retained through reads and cleanup, optionally with a synchronous admission check after root reads.
 */
export type SessionLogExportAdmission = (sessionId: SessionId, request: Request) => Promise<AbortSignal | {
  readonly signal: AbortSignal
  readonly assertCurrent: () => void
}>

interface SessionLogConnection {
  readonly fetch: {
    register(route: {
      readonly path: string
      readonly methods: readonly ('GET' | 'HEAD')[]
      readonly requestBody: 'buffered'
      readonly fetch: (request: Request) => Promise<Response>
    }): () => Promise<void>
  }
}

const REQUESTED: CommandResult = {
  kind: 'success',
  text: 'Session log download requested.',
}

/** Register the original export command and ZIP route, leaving other export routes unregistered.
 * @param ctx Loader fiber owning the command, route, and in-flight response cleanup.
 * @param config Native compression configuration.
 * @param beforeRead Optional embedding admission after request parsing, before Session reads;
 * omission retains request cancellation.
 * @returns Synchronous registration check; it throws after the original owner withdraws.
 */
export function registerSessionLogExport(ctx: Context, config: Config = {}, beforeRead?: SessionLogExportAdmission): () => void {
  ctx.effect(() => ctx.commands.register({
    definitionId: brandString<CommandDefinitionId>('@deepseek-ai/dsh-session-log-export'),
    name: 'export',
    description: 'Download this Session log as a ZIP archive',
    handler: invocation => Promise.resolve(invocation.rawInput.trim() === ''
      ? REQUESTED
      : { kind: 'error', text: 'The Web /export command does not accept a path.' }),
  }), 'session-log-download: command')
  const unregister = connectionOf(ctx).fetch.register({
    path: SESSION_LOG_EXPORT_PATH,
    methods: ['GET', 'HEAD'],
    requestBody: 'buffered',
    fetch: async (request) => {
      const response = await sessionLogExportResponse(
        ctx,
        request,
        config.compressionLevel ?? DEFAULT_SESSION_LOG_COMPRESSION_LEVEL,
        beforeRead,
      )
      if (request.method === 'GET') return response
      await response.body?.cancel()
      return new Response(null, { status: response.status, headers: response.headers })
    },
  })
  let active = true
  ctx.effect(() => async () => { active = false; await unregister() }, 'session-log-download: ZIP registration')
  return () => {
    ctx.fiber.assertActive()
    if (!active) throw new Error('The original Session ZIP export registration ended')
  }
}

function connectionOf(ctx: Context): SessionLogConnection {
  return Reflect.get(ctx, 'connection') as SessionLogConnection
}

async function sessionLogExportResponse(
  ctx: Context,
  request: Request,
  compressionLevel: SessionLogCompressionLevel,
  beforeRead?: SessionLogExportAdmission,
): Promise<Response> {
  const url = new URL(request.url)
  const query = Object.fromEntries(url.searchParams)
  const sessionIdValue = query['sessionId']
  const descendantsValue = query['includeDescendants']
  if (sessionIdValue === undefined || sessionIdValue.length === 0
    || (descendantsValue !== undefined && descendantsValue !== 'true' && descendantsValue !== 'false')) {
    return new Response('missing or invalid sessionId query parameter', { status: 400 })
  }
  const sessionId = brandString<SessionId>(sessionIdValue)
  const admission = beforeRead === undefined ? request.signal : await beforeRead(sessionId, request)
  const signal = 'signal' in admission ? admission.signal : admission
  const check = (): void => {
    signal.throwIfAborted()
    if ('signal' in admission) admission.assertCurrent()
  }
  signal.throwIfAborted()
  const deps = sessionLogExportDeps(ctx)
  if (deps.sessionQuery === undefined
    || deps.sessionPersistence === undefined
    || deps.attachments === undefined) {
    return new Response(
      'session log export is unavailable: missing session-query, session-persistence, or attachments service',
      { status: 500 },
    )
  }
  const ready: SessionLogExportReady = {
    sessionQuery: deps.sessionQuery,
    sessionPersistence: deps.sessionPersistence,
    attachments: deps.attachments,
    sessions: deps.sessions,
  }
  let rootContent: string | undefined
  try {
    check()
    await flushLiveSessionLog(deps, sessionId, signal)
    check()
    rootContent = await readSessionLogText(deps.sessionPersistence, sessionId, signal)
    check()
  } catch {
    signal.throwIfAborted()
    // Root preparation failure (flush, open, or read): answer 500 without
    // echoing the error, which may carry absolute host paths into the
    // browser error bar.
    return new Response('session log export failed to read the stored log', { status: 500 })
  }
  if (rootContent === undefined) {
    return new Response('session not found', { status: 404 })
  }
  const response = new Response(
    streamSessionLogZip(
      ready,
      rootContent,
      sessionId,
      descendantsValue === 'true',
      compressionLevel,
      signal,
    ),
    {
      headers: {
        'content-type': 'application/zip',
        'content-disposition': `attachment; filename="${sessionLogZipFilename(sessionId)}"`,
      },
    },
  )
  return response
}
