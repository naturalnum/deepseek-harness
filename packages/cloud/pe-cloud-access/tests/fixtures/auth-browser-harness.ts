/** Opt-in loopback authentication fixture. It never creates an account Context, native Session or generation. */
import { randomBytes, randomUUID } from 'node:crypto'
import { readFile, writeFile } from 'node:fs/promises'
import { readFileSync, writeFileSync } from 'node:fs'
import { createServer, type IncomingMessage, type ServerResponse } from 'node:http'
import { resolve } from 'node:path'
import type { Socket } from 'node:net'
import pg from 'pg'
import type { Branded } from '@deepseek-ai/dsh-brand'
import { BetterAuthAccess } from '../../src/auth.ts'
import { AuthAccessError } from '../../src/auth-error.ts'
import { assertAuthTransport } from '../../src/auth-trust.ts'
import { assertExpectedAccount, RequestBindingError } from '../../src/schema.ts'
import type { AccessConfig } from '../../src/types.ts'

type RequestId = Branded<'pe-request-id'>
type WriteCallback = (error?: Error | null) => void
interface CleanupOutcome {
  readonly confirmed: boolean
  readonly usersBefore: number | null
  readonly usersAfter: number | null
  readonly schemaAbsent: boolean
}

const LIMITS = Object.freeze({
  maxRequestBodyBytes: 16_384, maxResponseBodyBytes: 65_536, maxRequests: 256, maxConcurrentRequests: 8,
  maxConnections: 8, requestMs: 5000, authMs: 4000, startupMs: 30_000, cleanupMs: 20_000, poolSize: 2,
  connectionMs: 1000, queryMs: 3000, statementMs: 2000, lockMs: 1000,
})

function databaseConfig(): pg.PoolConfig {
  const path = process.env['PE_ACCESS_POSTGRES_CONFIG']
  if (path === undefined) throw new Error('Dedicated access PostgreSQL configuration is required')
  const input: unknown = JSON.parse(requireText(path))
  if (input === null || typeof input !== 'object' || !('host' in input) || typeof input.host !== 'string'
    || !('port' in input) || typeof input.port !== 'number' || !('user' in input) || typeof input.user !== 'string'
    || !('password' in input) || typeof input.password !== 'string' || !('databases' in input)
    || input.databases === null || typeof input.databases !== 'object'
    || !('access' in input.databases) || typeof input.databases.access !== 'string') throw new Error('Invalid private access PG configuration')
  return { host: input.host, port: input.port, user: input.user, password: input.password, database: input.databases.access }
}

function requireText(path: string): string {
  // The configuration is read by main before any route can run; no secret enters diagnostics.
  return readFileSync(path, 'utf8')
}

function responseLimit(response: ServerResponse): void {
  let bytes = 0
  const write = response.write.bind(response)
  const end = response.end.bind(response)
  const count = (chunk: string | Uint8Array, encoding: BufferEncoding = 'utf8'): boolean => {
    bytes += typeof chunk === 'string' ? Buffer.byteLength(chunk, encoding) : chunk.byteLength
    if (bytes <= LIMITS.maxResponseBodyBytes) return true
    response.destroy()
    return false
  }
  response.write = (chunk: string | Uint8Array, encodingOrCallback?: BufferEncoding | WriteCallback, callback?: WriteCallback): boolean => {
    if (!count(chunk, typeof encodingOrCallback === 'string' ? encodingOrCallback : 'utf8')) return false
    return typeof encodingOrCallback === 'string' ? write(chunk, encodingOrCallback, callback) : write(chunk, encodingOrCallback)
  }
  response.end = (
    chunkOrCallback?: string | Uint8Array | (() => void), encodingOrCallback?: BufferEncoding | (() => void), callback?: () => void,
  ): ServerResponse => {
    if (typeof chunkOrCallback === 'function' || chunkOrCallback === undefined) return end(chunkOrCallback)
    if (!count(chunkOrCallback, typeof encodingOrCallback === 'string' ? encodingOrCallback : 'utf8')) return response
    return typeof encodingOrCallback === 'string' ? end(chunkOrCallback, encodingOrCallback, callback) : end(chunkOrCallback, encodingOrCallback)
  }
}

function json(response: ServerResponse, status: number, value: object): void {
  if (response.destroyed || response.writableEnded) return
  response.writeHead(status, { 'content-type': 'application/json; charset=utf-8', 'cache-control': 'no-store' })
  response.end(JSON.stringify(value))
}

async function main(): Promise<void> {
  if (process.env['PE_ACCESS_BROWSER_HARNESS'] !== '1') throw new Error('Set PE_ACCESS_BROWSER_HARNESS=1 to opt in')
  const duration = Number(process.argv.find(arg => arg.startsWith('--duration-ms='))?.slice('--duration-ms='.length))
  if (!Number.isSafeInteger(duration) || duration < 10_000 || duration > 3_600_000) throw new Error('Explicit finite --duration-ms required')
  const runId = randomUUID().replaceAll('-', '')
  const schema = `pe_access_browser_${runId}`
  const reportPath = resolve(import.meta.dirname, '../../../../../../dsh-cloud-delivery/reports/m3-worker1-harness.json')
  const schemaSql = `"${schema}"` // Generated lowercase hex/underscore identifier, never browser input.
  const pool = new pg.Pool({ ...databaseConfig(), max: LIMITS.poolSize, connectionTimeoutMillis: LIMITS.connectionMs,
    query_timeout: LIMITS.queryMs, statement_timeout: LIMITS.statementMs, lock_timeout: LIMITS.lockMs,
    idleTimeoutMillis: 1000, allowExitOnIdle: true, options: `-c search_path=${schema}`, application_name: schema,
  })
  const sockets = new Set<Socket>()
  const actualRequests = new Set<Promise<void>>()
  const stopped = Promise.withResolvers<undefined>()
  let auth: BetterAuthAccess | undefined
  let settings: AccessConfig | undefined
  let stopping: Promise<void> | undefined
  let initializing: Promise<void> | undefined
  let schemaAttempted = false
  let url: string | null = null
  let acceptedRequests = 0
  let businessCalls = 0
  let accountChecks = 0
  let mismatches = 0
  let lifetime: NodeJS.Timeout | undefined
  let startupTimer: NodeJS.Timeout | undefined
  let cleanup: CleanupOutcome | null = null
  let report: Record<string, unknown> = {}
  const expiresAt = new Date(Date.now() + duration).toISOString()
  const saveReport = async (): Promise<void> => {
    try {
      const existing: unknown = JSON.parse(await readFile(reportPath, 'utf8'))
      if (typeof existing === 'object' && existing !== null && 'handoff' in existing) report.handoff = existing.handoff
    } catch (error) {
      // A first run has no report; every other read/parse failure remains a visible startup/shutdown failure.
      if (!(error instanceof Error && 'code' in error && error.code === 'ENOENT')) throw error
    }
    await writeFile(reportPath, JSON.stringify(report, null, 2) + '\n')
  }
  const server = createServer({ maxHeaderSize: 16_384 }, (request, response) => {
    responseLimit(response)
    if (stopping !== undefined || auth === undefined || settings === undefined) {
      json(response, 503, { componentOnly: true, code: 'fixture/unavailable' }); return
    }
    if (actualRequests.size >= LIMITS.maxConcurrentRequests || acceptedRequests >= LIMITS.maxRequests) {
      json(response, 429, { componentOnly: true, code: 'fixture/capacity' }); return
    }
    acceptedRequests++
    const id = randomUUID() as RequestId
    const timer = setTimeout(() => { request.destroy(); response.destroy() }, LIMITS.requestMs)
    const actual = route(request, response, id).catch((error: unknown) => {
      if (response.headersSent) { response.destroy(); return }
      if (error instanceof AuthAccessError || error instanceof RequestBindingError) json(response, error.status, error.toJSON())
      else json(response, 503, { componentOnly: true, code: 'fixture/unavailable', requestId: id })
    }).finally(() => { clearTimeout(timer); actualRequests.delete(actual) })
    actualRequests.add(actual)
  })
  server.maxConnections = LIMITS.maxConnections
  server.headersTimeout = 3000
  server.requestTimeout = LIMITS.requestMs
  server.keepAliveTimeout = 1000
  server.maxRequestsPerSocket = 16
  server.on('connection', (socket) => { sockets.add(socket); socket.once('close', () => { sockets.delete(socket) }) })
  server.on('clientError', (_error: Error, socket) => { socket.destroy() })

  const pageTemplate = await readFile(new URL('./auth-browser-page.html', import.meta.url), 'utf8')
  const nonce = randomBytes(24).toString('base64url')
  const page = pageTemplate.replaceAll('__NONCE__', nonce).replace('__FIXTURE_DATA__', JSON.stringify({
    emailA: `m3-${runId}-a@component.example.test`, emailB: `m3-${runId}-b@component.example.test`,
  }))

  async function route(request: IncomingMessage, response: ServerResponse, requestId: RequestId): Promise<void> {
    if (auth === undefined || settings === undefined) throw new AuthAccessError('cloud/account-unavailable', requestId)
    assertAuthTransport(request.headers, request.rawHeaders, request.socket.remoteAddress, false, settings, requestId)
    if (request.url?.includes('?') === true || request.url?.length === undefined || request.url.length > 256) {
      json(response, 400, { code: 'fixture/request-invalid' }); return
    }
    const declaredLength = request.headers['content-length']
    if (request.headers['transfer-encoding'] !== undefined || (declaredLength !== undefined
      && (!/^\d+$/u.test(declaredLength) || Number(declaredLength) > LIMITS.maxRequestBodyBytes))) {
      json(response, 413, { code: 'fixture/body-limit' }); request.resume(); return
    }
    if (request.method === 'GET' && request.url === '/') {
      response.writeHead(200, { 'content-type': 'text/html; charset=utf-8', 'cache-control': 'no-store',
        'content-security-policy': `default-src 'none'; script-src 'nonce-${nonce}'; style-src 'nonce-${nonce}'; connect-src 'self'; base-uri 'none'; frame-ancestors 'none'`,
      })
      response.end(page); return
    }
    if (request.method === 'GET' && request.url === '/probe/status') {
      json(response, 200, { componentOnly: true, businessCalls, accountChecks, mismatches, pendingAuthOperations: auth.pendingOperations })
      return
    }
    if (request.method === 'POST' && ['/cloud/auth/sign-up/email', '/cloud/auth/sign-in/email', '/cloud/auth/sign-out'].includes(request.url)) {
      if (request.headers.origin !== settings.publicOrigin || declaredLength === undefined) {
        json(response, 403, { code: 'fixture/auth-request-invalid' }); return
      }
      await auth.handleNodeRequest(request, response, requestId); return
    }
    if (request.method === 'GET' && request.url === '/probe/principal') {
      const principal = await auth.authenticate(request, requestId)
      json(response, 200, { componentOnly: true, principal }); return
    }
    if (request.method === 'POST' && request.url === '/probe/account-only') {
      if (request.headers.origin !== settings.publicOrigin) throw new AuthAccessError('cloud/forbidden', requestId)
      const principal = await auth.authenticate(request, requestId)
      const values = request.headersDistinct['x-probe-expected-account']
      const expected = values?.[0]
      if (values?.length !== 1 || expected === undefined || expected.length === 0 || expected.length > 256) {
        json(response, 400, { code: 'fixture/expected-account-required' }); return
      }
      accountChecks++
      try { assertExpectedAccount({ accountId: expected }, principal.accountId, requestId) }
      catch (error) { if (error instanceof RequestBindingError) mismatches++; throw error }
      businessCalls++
      json(response, 200, { componentOnly: true, matched: true, businessCalls, authenticatedAccountId: principal.accountId }); return
    }
    json(response, 404, { code: 'fixture/not-found' })
  }

  const stop = (reason: string): Promise<void> => stopping ??= (async () => {
    clearTimeout(lifetime)
    clearTimeout(startupTimer)
    const hardDeadline = setTimeout(() => {
      // Unknown cleanup is visible and never reported as data removal; coordinator owns recovery of this named schema.
      report = { ...report, lifecycle: 'cleanup-unconfirmed', stopReason: reason, cleanup: { confirmed: false, schema }, url: null }
      console.error(JSON.stringify({ event: 'cleanup-unconfirmed', componentOnly: true, schema, runId, reportPath }))
      try { writeFileSync(reportPath, JSON.stringify(report, null, 2) + '\n') }
      finally { process.exit(1) }
    }, LIMITS.cleanupMs)
    try {
      const closed = new Promise<void>((resolveClose) => { server.close(() => { resolveClose() }) })
      for (const socket of sockets) socket.destroy()
      server.closeAllConnections()
      await closed
      await Promise.allSettled(initializing === undefined ? [] : [initializing])
      await Promise.allSettled([...actualRequests])
      await auth?.close()
      if (schemaAttempted) {
        const exists = await pool.query<{ present: boolean }>('SELECT EXISTS (SELECT 1 FROM pg_namespace WHERE nspname = $1) AS present', [schema])
        if (exists.rows[0]?.present === true) {
          let usersBefore: number | null = null
          try {
            const before = await pool.query<{ count: string }>(`SELECT COUNT(*) AS count FROM ${schemaSql}."user"`)
            usersBefore = Number(before.rows[0]?.count)
            await pool.query(`DELETE FROM ${schemaSql}."user"`)
            await pool.query(`DELETE FROM ${schemaSql}."verification"`)
          } catch (_error: unknown) {
            // Partial migration may lack a table; removal of the entire owned schema below remains mandatory.
          }
          await pool.query(`DROP SCHEMA ${schemaSql} CASCADE`)
          const absent = await pool.query<{ present: boolean }>('SELECT EXISTS (SELECT 1 FROM pg_namespace WHERE nspname = $1) AS present', [schema])
          cleanup = { confirmed: absent.rows[0]?.present === false, usersBefore,
            usersAfter: absent.rows[0]?.present === false ? 0 : null, schemaAbsent: absent.rows[0]?.present === false }
        } else cleanup = { confirmed: true, usersBefore: 0, usersAfter: 0, schemaAbsent: true }
      } else cleanup = { confirmed: true, usersBefore: 0, usersAfter: 0, schemaAbsent: true }
    } catch (_error: unknown) {
      // Root receives only cleanup disposition and the owned schema; no driver cause/credentials are printed.
      cleanup = { confirmed: false, usersBefore: null, usersAfter: null, schemaAbsent: false }
    } finally {
      await pool.end()
      report = { ...report, lifecycle: cleanup?.confirmed === true ? 'stopped-clean' : 'cleanup-unconfirmed',
        stoppedAt: new Date().toISOString(), stopReason: reason, cleanup, url: null,
        counters: { acceptedRequests, accountChecks, mismatches, businessCalls },
      }
      await saveReport()
      clearTimeout(hardDeadline)
      console.log(JSON.stringify({ event: 'stopped', componentOnly: true, runId, cleanup, reportPath }))
      if (cleanup?.confirmed !== true) process.exitCode = 1
      stopped.resolve(undefined)
    }
  })()
  const signalStop = (reason: string): void => { void stop(reason).catch((_error: unknown) => {
    // A failed final report cannot turn cleanup into success or disclose the raw failure.
    console.error('M3 authentication fixture shutdown/report failed; inspect the owned schema.')
    process.exitCode = 1
    stopped.resolve(undefined)
  }) }
  process.once('SIGTERM', () => { signalStop('SIGTERM') })
  process.once('SIGINT', () => { signalStop('SIGINT') })
  pool.on('error', (_error: Error) => { signalStop('pool-error') })

  const initialize = async (): Promise<void> => {
    await new Promise<void>((resolveListen, reject) => {
      server.once('error', reject)
      server.listen(0, '127.0.0.1', () => { server.off('error', reject); resolveListen() })
    })
    const address = server.address()
    if (address === null || typeof address === 'string') throw new Error('No loopback fixture address')
    url = `http://127.0.0.1:${address.port}`
    settings = { publicOrigin: url, deploymentMode: 'development', trustedProxyAddresses: [], authSecretRef: 'ephemeral-fixture-secret',
      sessionRecheckMs: 1000, authCheckTimeoutMs: LIMITS.authMs, maxPeers: 1, maxPeersPerAccount: 1,
      maxPeerWaiters: 1, maxPeerWaitersPerAccount: 1, maxPeerCarriers: 1, maxPeerCarriersPerAccount: 1, maxPeerCarriersPerLogin: 1,
      peerCloseTimeoutMs: 1000, maxAuthOperations: 4, maxTrackedLogins: 16, maxTrackedLoginsPerAccount: 8, maxAuthInvalidations: 16,
      bindingFields: { accountHeader: 'x-probe-account', generationHeader: 'x-unused-generation', accountQuery: 'probeAccount', generationQuery: 'unusedGeneration' },
    }
    schemaAttempted = true
    await pool.query(`CREATE SCHEMA ${schemaSql}`)
    if (stopping !== undefined) throw new Error('Fixture startup stopped')
    await pool.query(await readFile(new URL('../../migrations/better-auth-1.7.10.sql', import.meta.url), 'utf8'))
    if (stopping !== undefined) throw new Error('Fixture startup stopped')
    auth = await BetterAuthAccess.create(settings, pool, randomBytes(48).toString('base64url'), async (_loginId) => {
      // This fixture creates no Peers, so successful library deletion has no native invalidation work.
    })
    if (stopping !== undefined) { await auth.close(); throw new Error('Fixture startup stopped') }
    clearTimeout(startupTimer)
    report = { workingDirectory: resolve(import.meta.dirname, '../../../../..'), componentOnly: true, lifecycle: 'running', pid: process.pid, runId, schema, url,
      startedAt: new Date().toISOString(), expiresAt, limits: LIMITS,
      label: '认证组件测试，无账户Context/Session', accountReady: false, nativeContextsCreated: 0,
      generationTested: false, wsTested: false, exposureManifestEntry: false, S1: false, S2: false,
      startCommand: 'PE_ACCESS_BROWSER_HARNESS=1 PE_ACCESS_POSTGRES_CONFIG=/Users/jingchao/agent_work/main_agent/dsh-cloud-delivery/private/m1-postgres.json node --import tsx/esm packages/cloud/pe-cloud-access/tests/fixtures/auth-browser-harness.ts --duration-ms=1200000',
      stopCommand: `kill -TERM ${process.pid}`, cleanupOwner: 'harness single-flight stop; coordinator verifies final report',
      browserOwner: 'root coordinator; worker does not drive a browser',
    }
    await saveReport()
    if (stopping !== undefined) throw new Error('Fixture startup stopped')
    console.log(JSON.stringify({ event: 'listening', componentOnly: true, runId, url, pid: process.pid, expiresAt, reportPath }))
    lifetime = setTimeout(() => { signalStop('duration-expired') }, Math.max(1, Date.parse(expiresAt) - Date.now()))
  }
  try {
    startupTimer = setTimeout(() => { signalStop('startup-deadline') }, LIMITS.startupMs)
    initializing = initialize()
    await initializing
    await stopped.promise
  } catch (_error: unknown) {
    // Startup never exposes secrets or a product-ready claim; cleanup still owns any attempted schema.
    process.exitCode = 1
    await stop('startup-failed')
  }
}

await main().catch((_error: unknown) => {
  // Fail closed before startup; configuration and credential contents remain off stdout/stderr.
  console.error('M3 authentication fixture failed before startup; verify opt-in and the private configuration.')
  process.exitCode = 1
})
