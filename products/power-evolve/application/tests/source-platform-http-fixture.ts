/** Owned schema6 fixture for current-source Platform HTTP through the shipped CLI and Loader. */
import assert from 'node:assert/strict'
import { spawn } from 'node:child_process'
import { createHash, randomBytes, randomUUID } from 'node:crypto'
import { realpathSync } from 'node:fs'
import { lstat, mkdir, readFile, readdir, symlink, writeFile } from 'node:fs/promises'
import { dirname, join, resolve } from 'node:path'
import { fileURLToPath, pathToFileURL } from 'node:url'
import { Pool } from 'pg'
import type { TestContext } from 'vitest'
import { z } from 'zod'
import { accountLoginValue, type AccountValue } from '../src/account-contracts.ts'
import { identity } from '../src/contracts.ts'
import { seedModel, seedNewUser } from '../src/platform/account-settings.ts'
import { hashPassword } from '../src/platform/identity.ts'
import { cloudFixture } from './cloud-fixture.ts'

const sourceFile = 'products/power-evolve/application/src/platform/index.ts'
const sourcePath = realpathSync(fileURLToPath(new URL('../src/platform/index.ts', import.meta.url)))
const repo = resolve(dirname(sourcePath), '../../../../..')
const sha = (bytes: string | Buffer): string => createHash('sha256').update(bytes).digest('hex')
const sourceEnvironment = z.object({ PE_CLOUD_COVERAGE_INPUT: z.string().min(1),
  NODE_V8_COVERAGE: z.string().min(1), NODE_OPTIONS: z.string().min(1) }).strict()
const nativeInput = z.object({ directory: z.string(), executionDirectory: z.string().optional(),
  hashes: z.record(z.string(), z.string()) }).loose()
const collectedCode = z.object({ pid: z.number(), threadId: z.number(), inputHash: z.string(), errors: z.array(z.string()),
  scripts: z.record(z.string(), z.object({ url: z.string(), code: z.string(), hash: z.string(),
    originalHash: z.string(), sourceMapURL: z.string() }).loose()) }).loose()
const rawCoverage = z.object({ result: z.array(z.object({ scriptId: z.string(), url: z.string(),
  functions: z.array(z.object({ functionName: z.string(),
    ranges: z.array(z.object({ count: z.number() }).loose()) }).loose()) }).loose()) }).loose()

/** Private browser credentials and the public identity they authenticate. */
export interface SourceHttpActor { account: string; agent: string; user: AccountValue }
/** An HTTP response whose JSON is validated by the route's existing consumer. */
export interface SourceHttpReply { status: number; value: unknown }
/** Original bounded bytes and consumed headers for the two real HTTP carrier cases. */
export interface SourceHttpBinaryReply { status: number; headers: Readonly<Record<string, string>>; bytes: Buffer }
/** Reuse the existing credential, Origin and method options; vary only the binary media type. */
export type SourceHttpBinaryOptions = Omit<SourceHttpOptions, 'rawBody'> & { contentType?: string }
/** Owned storage metadata and content digests, excluding access times and absolute paths. */
export type SourceHttpStorageSnapshot = Record<string, {
  kind: 'directory' | 'file'
  mode: number
  uid: number
  gid: number
  bytes?: number
  sha256?: string
}>
/** Explicit header and raw-body variations for authentication and JSON rejection cases. */
export interface SourceHttpOptions { token?: string; origin?: string | null; rawBody?: string; method?: 'GET' | 'POST' }
/** Public fields and table cardinalities; credential values and digests are never selected. */
export interface SourceHttpSnapshot { counts: Record<string, number>; publicRows: Record<string, unknown> }
/** Exact current-source execution in one actual CLI process. */
export interface SourceHttpWitness {
  pid: number
  url: string
  scriptId: string
  originalHash: string
  executedHash: string
  sourceMapHash: string
  applyCount: number
  codeFile: string
  rawFile: string
}
/** Settled CLI, database connections and owned storage for one HTTP case. */
export interface SourceHttpLifetime {
  pid: number
  database: string
  port: number
  stop: { code: number | null; signal: NodeJS.Signals | null; elapsedMs: number; ownedPgConnections: number }
  source: SourceHttpWitness
  temporaryRootRemoved: boolean
  ownedDatabaseRemoved: boolean
  requests: { path: string; status: number }[]
}
/** Real account and metadata routes against one owned PostgreSQL database. */
export interface SourceHttpFixture {
  pool: Pool
  url: string
  actors: { admin: SourceHttpActor; alice: SourceHttpActor; bob: SourceHttpActor }
  /** Actual owned Platform attachment root; used only to inspect the accepted upload. */
  attachmentRoot: string
  /** Consume one binary HTTP response under the existing case signal and request deadline.
   * @param path Actual Platform route and its credential-free query.
   * @param bytes Original POST bytes; omit for a GET response.
   * @param options Explicit credential, Origin, method and media type variations.
   * @returns Status, consumed headers and complete original response bytes.
   */
  binaryHttp(path: string, bytes?: Uint8Array, options?: SourceHttpBinaryOptions): Promise<SourceHttpBinaryReply>
  /** Inventory only this fixture's two owned file roots to detect persistent writes on refusal.
   * @returns Relative entry metadata and content digests for the owned workspace and attachment trees.
   */
  storageSnapshot(): Promise<SourceHttpStorageSnapshot>
  /** Send an owned request without retaining its body or bearer in evidence.
   * @param path Actual Platform route.
   * @param body JSON submitted to the route.
   * @param options Explicit authentication, Origin and JSON variations.
   * @returns Status and parsed response JSON.
   */
  http(path: string, body?: unknown, options?: SourceHttpOptions): Promise<SourceHttpReply>
  /** Read cardinalities and public account, preference and Session records in one read-only snapshot.
   * @returns Stable public records for mutation and rejection assertions.
   */
  snapshot(): Promise<SourceHttpSnapshot>
}

type Outcome<T> = { ok: true; value: T } | { ok: false; error: unknown }
const observe = <T>(promise: Promise<T>): Promise<Outcome<T>> =>
  promise.then<Outcome<T>, Outcome<T>>(value => ({ ok: true, value }), (error: unknown) => ({ ok: false, error }))
/** Per-case runner budget; the global source configuration keeps its existing default. */
export const sourceHttpTestTimeout = 120_000
const budgets = { preflight: 5000, setup: 20_000, profile: 10_000, readiness: 20_000, body: 20_000,
  cancelJoin: 10_000, graceful: 8000, escalation: 5000, capture: 5000, cleanup: 10_000, audit: 2000,
  abortToQuiescence: 40_000, hook: 45_000, test: sourceHttpTestTimeout } as const
let fileUnsafe: { error: unknown } | undefined

class CaseLifetime {
  readonly controller = new AbortController()
  readonly signal = this.controller.signal
  readonly records: { name: string; settled: boolean; delivered: boolean; outcome: Promise<Outcome<unknown>> }[] = []
  private joinRemaining: number = budgets.cancelJoin
  readonly phases: { phase: string; state: string; elapsedMs: number }[] = []
  private timer: ReturnType<typeof setTimeout> | undefined
  private releaseDeadline!: (outcome: Outcome<never>) => void
  readonly deadline = new Promise<Outcome<never>>((resolve) => { this.releaseDeadline = resolve })
  private readonly abortExternal = (): void => { this.abort(this.external.reason) }
  private readonly external: AbortSignal
  constructor(external: AbortSignal) {
    this.external = external
    if (external.aborted) this.abortExternal()
    else external.addEventListener('abort', this.abortExternal, { once: true })
  }
  unsafe(error: unknown): void { fileUnsafe ??= { error }; this.abort(error) }
  abort(reason: unknown): void {
    if (this.signal.aborted) return
    // Start the one tail deadline before abort listeners begin cancelling owned resources.
    this.timer = setTimeout(() => {
      const error = new Error('Source HTTP abort-to-quiescence deadline exceeded')
      this.unsafe(error)
      this.releaseDeadline({ ok: false, error })
    }, budgets.abortToQuiescence)
    this.controller.abort(reason)
  }
  async phase<T>(name: string, milliseconds: number, run: () => Promise<T>, cancellable = true): Promise<T> {
    if (cancellable) this.signal.throwIfAborted()
    const started = Date.now()
    this.phases.push({ phase: name, state: 'start', elapsedMs: 0 })
    const record = { name, settled: false, delivered: false,
      outcome: observe(Promise.resolve().then(() => {
        if (cancellable) this.signal.throwIfAborted()
        return run()
      })) }
    this.records.push(record)
    const result = record.outcome.then((outcome) => { record.settled = true; return outcome })
    let timer: ReturnType<typeof setTimeout> | undefined
    let abortPhase: (() => void) | undefined
    try {
      const deadline = new Promise<Outcome<never>>((resolve) => {
        timer = setTimeout(() => {
          const error = new Error('Source HTTP phase deadline exceeded: ' + name)
          if (cancellable) this.abort(error)
          else this.unsafe(error)
          resolve({ ok: false, error })
        }, milliseconds)
        if (cancellable) {
          abortPhase = (): void => { resolve({ ok: false, error: this.signal.reason }) }
          this.signal.addEventListener('abort', abortPhase, { once: true })
          if (this.signal.aborted) abortPhase()
        }
      })
      const outcome = await Promise.race([result, deadline])
      record.delivered = record.settled
      this.phases.push({ phase: name, state: outcome.ok ? 'complete' : 'failed', elapsedMs: Date.now() - started })
      if (!outcome.ok) throw outcome.error
      return outcome.value
    } finally {
      if (timer) clearTimeout(timer)
      if (abortPhase) this.signal.removeEventListener('abort', abortPhase)
    }
  }
  async drain(): Promise<unknown[]> {
    const records = [...this.records]
    const started = Date.now()
    const waiting = records.some(record => !record.settled)
    if (waiting && this.joinRemaining <= 0) {
      const error = new Error('Owned source HTTP phases exhausted their shared cancellation join')
      this.unsafe(error); throw error
    }
    let timer: ReturnType<typeof setTimeout> | undefined
    try {
      const outcomes = await Promise.race([Promise.all(records.map(record => record.outcome)),
        new Promise<never>((_resolve, reject) => { timer = setTimeout(() => {
          const error = new Error('Owned source HTTP phase promises did not drain')
          this.unsafe(error); this.abort(error); reject(error)
        }, Math.max(1, this.joinRemaining)) })])
      const failures: unknown[] = []
      for (let index = 0; index < records.length; index++) {
        const record = records[index], outcome = outcomes[index]
        if (record && outcome && !record.delivered && !outcome.ok) failures.push(outcome.error)
        if (record) record.delivered = true
      }
      return failures
    } finally {
      if (timer) clearTimeout(timer)
      if (waiting) this.joinRemaining -= Date.now() - started
    }
  }
  finish(): void {
    this.external.removeEventListener('abort', this.abortExternal)
    if (this.records.some(record => !record.settled)) {
      this.unsafe(new Error('Source HTTP completed with an unsettled owned phase'))
    } else if (this.timer) clearTimeout(this.timer)
  }
}

async function pause(): Promise<void> { await new Promise<void>(resolve => setTimeout(resolve, 50)) }

async function publicSnapshot(pool: Pool): Promise<SourceHttpSnapshot> {
  const client = await pool.connect()
  const failures: unknown[] = []
  let result: SourceHttpSnapshot | undefined
  try {
    await client.query('BEGIN ISOLATION LEVEL REPEATABLE READ READ ONLY')
    const tables = (await client.query<{ name: string }>(
      "SELECT table_name AS name FROM information_schema.tables WHERE table_schema='public' AND table_type='BASE TABLE' ORDER BY table_name")).rows
    for (const { name } of tables) {
      assert.match(name, /^[a-z_][a-z0-9_]*$/u)
    }
    const counted = (await client.query<{ name: string; count: string }>(tables.map(({ name }) =>
      `SELECT '${name}' AS name,count(*) AS count FROM "${name}"`).join(' UNION ALL '))).rows
    const counts = Object.fromEntries(counted.map(row => [row.name, Number(row.count)]))
    const selections = {
      users: 'SELECT id,username,display_name,role,enabled,account_revision,credential_version,password_change_required,deleted_at,settings,created_at,updated_at FROM pe_users ORDER BY id',
      models: 'SELECT user_id,model_id,label,max_tokens,enabled FROM pe_user_models ORDER BY user_id,model_id',
      preferences: 'SELECT user_id,namespace,value,revision,updated_at FROM pe_native_preferences ORDER BY user_id,namespace',
      settingsReceipts: 'SELECT user_id,request_id,result_settings,created_at FROM pe_settings_mutations ORDER BY user_id,request_id',
      accountReceipts: 'SELECT actor_user_id,request_id,receipt,created_at FROM pe_account_mutations ORDER BY actor_user_id,request_id',
      workspaces: 'SELECT id,user_id,title,is_default,created_at FROM pe_workspaces ORDER BY id',
      sessions: 'SELECT id,user_id,workspace_id,create_request_id,header,event_count,event_bytes,created_at,updated_at FROM pe_sessions ORDER BY id',
      events: 'SELECT session_id,seq,event FROM pe_events ORDER BY session_id,seq',
    }
    const publicRows: Record<string, unknown> = {}
    for (const [name, sql] of Object.entries(selections)) {
      const rows = (await client.query<{ value: unknown }>(`SELECT COALESCE(jsonb_agg(to_jsonb(row) ORDER BY to_jsonb(row)::text COLLATE "C"), '[]'::jsonb) AS value FROM (${sql}) row`)).rows
      publicRows[name] = z.json().parse(rows[0]?.value)
    }
    await client.query('COMMIT')
    result = { counts, publicRows }
  } catch (error) {
    failures.push(error)
    try { await client.query('ROLLBACK') } catch (rollbackError) { failures.push(rollbackError) }
  } finally {
    try { client.release() } catch (releaseError) { failures.push(releaseError) }
  }
  if (failures.length) throw new AggregateError(failures, 'Public snapshot or rollback failed')
  assert(result)
  return result
}

async function ownedStorageSnapshot(root: string): Promise<SourceHttpStorageSnapshot> {
  const entries: SourceHttpStorageSnapshot = {}
  const visit = async (path: string, relative: string): Promise<void> => {
    const stat = await lstat(path)
    assert(!stat.isSymbolicLink(), 'Source HTTP file fixture must remain physical')
    const metadata = { mode: stat.mode & 0o777, uid: stat.uid, gid: stat.gid }
    if (stat.isDirectory()) {
      entries[relative] = { kind: 'directory', ...metadata }
      for (const name of (await readdir(path)).sort()) await visit(join(path, name), relative + '/' + name)
    } else {
      assert(stat.isFile(), 'Source HTTP file fixture contains an unexpected entry')
      entries[relative] = { kind: 'file', ...metadata, bytes: stat.size, sha256: sha(await readFile(path)) }
    }
  }
  for (const name of ['workspaces', 'attachments']) await visit(join(root, 'private', name), name)
  return entries
}

async function loadedSource(inputPath: string, pid: number): Promise<SourceHttpWitness> {
  const bytes = await readFile(inputPath), input = nativeInput.parse(JSON.parse(bytes.toString('utf8')))
  const directory = input.executionDirectory ?? input.directory
  const codeFile = join(directory, 'code', `${pid}-0.json`)
  const capture = collectedCode.parse(JSON.parse(await readFile(codeFile, 'utf8')))
  assert.deepEqual({ pid: capture.pid, threadId: capture.threadId, inputHash: capture.inputHash, errors: capture.errors },
    { pid, threadId: 0, inputHash: sha(bytes), errors: [] })
  const url = pathToFileURL(sourcePath).href
  const selected = Object.entries(capture.scripts).find(([_id, script]) => script.url === url)
  assert(selected, 'Current Platform source was not captured in the actual CLI process')
  const [scriptId, script] = selected
  const originalHash = sha(await readFile(sourcePath))
  assert.equal(script.originalHash, originalHash)
  assert.equal(input.hashes[sourceFile], originalHash)
  assert.equal(script.hash, sha(script.code))
  assert.match(script.sourceMapURL, /^data:application\/json;.*base64,/u)
  const sourceMapBytes = Buffer.from(script.sourceMapURL.slice(script.sourceMapURL.indexOf(',') + 1), 'base64')
  const sourceMap = z.object({ sourcesContent: z.array(z.string().nullable()) }).loose().parse(JSON.parse(sourceMapBytes.toString('utf8')))
  assert(sourceMap.sourcesContent.some(content => content !== null && sha(content) === originalHash))
  const rawName = (await readdir(join(directory, 'raw'))).find(name => name.startsWith(`coverage-${pid}-`) && name.endsWith('-0.json'))
  assert(rawName, 'Actual CLI V8 coverage was not flushed after shutdown')
  const rawFile = join(directory, 'raw', rawName)
  const raw = rawCoverage.parse(JSON.parse(await readFile(rawFile, 'utf8')))
  const executed = raw.result.find(item => item.scriptId === scriptId && item.url === url)
  const applyCount = executed?.functions.find(fn => fn.functionName === 'apply')?.ranges[0]?.count ?? 0
  assert(applyCount > 0, 'Current source apply was loaded without execution')
  return { pid, url, scriptId, originalHash, executedHash: script.hash, sourceMapHash: sha(sourceMapBytes),
    applyCount, codeFile, rawFile }
}

async function runSourcePlatformHttpFixture(run: (fixture: SourceHttpFixture) => Promise<void>,
  control: CaseLifetime): Promise<SourceHttpLifetime> {
  const failures: unknown[] = []
  let ownedRoot = '', ownedDatabase = '', cleanupConfirmed = false
  let lifetime: SourceHttpLifetime | undefined
  let coverage: z.infer<typeof sourceEnvironment> | undefined
  let sourceBefore = ''
  try {
    await control.phase('source-preflight', budgets.preflight, async () => {
      if (fileUnsafe) throw new AggregateError([fileUnsafe.error], 'Source HTTP file is quarantined before resource acquisition')
      const encoded = process.env.PE_CLOUD_SOURCE_SUBPROCESS_ENV
      if (!encoded || !process.env.PE_CLOUD_COVERAGE_INPUT) throw new Error('Source Platform HTTP requires the official native subprocess coverage environment')
      coverage = sourceEnvironment.parse(JSON.parse(encoded))
      assert.equal(coverage.PE_CLOUD_COVERAGE_INPUT, process.env.PE_CLOUD_COVERAGE_INPUT)
      sourceBefore = sha(await readFile(sourcePath))
      control.signal.throwIfAborted()
    })
    assert(coverage)
    const coverageEnvironment = coverage
    await cloudFixture(async ({ pool, root }) => {
      const checked = async <T>(run: () => Promise<T>): Promise<T> => {
        control.signal.throwIfAborted()
        const value = await run()
        control.signal.throwIfAborted()
        return value
      }
      let prepared: {
        seeds: {
          username: string
          password: string
          settings: { model: string; maxTokens: number; revision: number }
          models: { id: string; label: string; maxTokens: number }[]
        }[]
        secrets: string[]
        applicationName: string
        environment: NodeJS.ProcessEnv
        profileName: string
        readyPath: string
      } | undefined
      try { prepared = await control.phase('profile-preparation', budgets.profile, async () => {
        const actualDatabase = (await pool.query<{ name: string }>('SELECT current_database() AS name')).rows[0]?.name
        assert.equal(actualDatabase, ownedDatabase)
        const privateDir = join(root, 'private'), bundle = join(root, 'source-platform-bundle')
        const profileName = 'source-platform-http-' + randomUUID(), home = join(root, 'dsh-home')
        const profile = join(home, 'profiles', profileName), bundleName = '@power-evolve/source-platform-http-fixture'
        await checked(() => mkdir(privateDir, { mode: 0o700 }))
        await checked(() => mkdir(bundle, { mode: 0o700 }))
        await checked(() => mkdir(join(profile, 'node_modules', '@power-evolve'), { recursive: true }))
        const secrets: string[] = []
        const save = async (path: string, value: unknown): Promise<void> => {
          control.signal.throwIfAborted()
          await checked(() => writeFile(path, typeof value === 'string' ? value : JSON.stringify(value) + '\n', { mode: 0o600, flag: 'wx' }))
        }
        const settings = { model: 'trial-model', maxTokens: 1000, revision: 1 }
        const models = [{ id: 'trial-model', label: 'Trial', maxTokens: 2000 }]
        const seeds = ['admin', 'alice', 'bob'].map(name => ({ username: 'source-http-' + name,
          password: randomBytes(24).toString('base64url'), settings, models }))
        const administrator = seeds[0]
        assert(administrator)
        secrets.push(...seeds.map(seed => seed.password))
        const adminHash = await checked(() => hashPassword(administrator.password))
        await checked(() => seedNewUser(pool, administrator.username, adminHash,
          settings, models.map(model => seedModel.parse(model))))
        const adminId = (await pool.query<{ id: string }>('SELECT id FROM pe_users WHERE username=$1', [administrator.username])).rows[0]?.id
        assert(adminId)
        await save(join(privateDir, 'account-bootstrap.json'), { mode: 'existing', userId: adminId, username: administrator.username })
        const applicationName = 'source_platform_http_' + randomUUID().replaceAll('-', '')
        const connectionString = pool.options.connectionString
        assert(connectionString)
        const address = new URL(connectionString)
        address.searchParams.set('application_name', applicationName)
        address.searchParams.set('options', '-c statement_timeout=5000 -c lock_timeout=3000 -c idle_in_transaction_session_timeout=5000')
        secrets.push(address.href)
        await save(join(privateDir, 'database-url'), address.href + '\n')
        for (const name of ['worker-token', 'model-key', 'connector-key', 'native-intent-key']) {
          const key = randomBytes(32).toString('base64url')
          secrets.push(key)
          await save(join(privateDir, name), key + '\n')
        }
        await save(join(privateDir, 'users.json'), seeds)
        await save(join(privateDir, 'account-management.json'), { maxUsers: 10,
          models: [...models, { id: 'second-model', label: 'Second', maxTokens: 512 }],
          initialSettings: { model: 'trial-model', maxTokens: 1000 } })
        const replace = (text: string, before: string, after: string): string => {
          assert.equal(text.split(before).length, 2, 'Official Platform Profile template changed')
          return text.replace(before, after)
        }
        let patch = await checked(() => readFile(join(repo, 'products/power-evolve/platform/cordis.patch.yml'), 'utf8'))
        for (const [before, after] of [
          ["name: '@power-evolve/application/platform'", `name: '${bundleName}/platform'`],
          ['port: 18881', 'port: 0'],
          ['platformOrigin: http://127.0.0.1:18881', 'platformOrigin: !!js "\'http://\' + webServer.host + \':\' + webServer.port"'],
          ['hostOrigin: http://127.0.0.1:18880', 'hostOrigin: http://127.0.0.1:9'],
          ['modelUrl: https://api.deepseek.com/anthropic/v1/messages', 'modelUrl: http://127.0.0.1:9/anthropic/v1/messages'],
          ['connectorUrl: http://127.0.0.1:18884', 'connectorUrl: http://127.0.0.1:9'],
          ['preinstalledSkills:\n          - builtin.pdf', 'preinstalledSkills: []'],
          ['enabledBuiltinSkills:\n          - builtin.pdf', 'enabledBuiltinSkills: []'],
          ["readyFile: !!js dshHomePath('ready.json')", 'readyFile: !!js process.env.PE_SOURCE_HTTP_READY_FILE'],
        ]) {
          assert(before !== undefined && after !== undefined)
          patch = replace(patch, before, after)
        }
        await save(join(bundle, 'cordis.patch.yml'), patch)
        await save(join(bundle, 'platform.ts'), `export { name, inject, Config, apply } from ${JSON.stringify(sourcePath)}\n`)
        await save(join(bundle, 'package.json'), { name: bundleName, version: '0.0.0-private', private: true, type: 'module',
          exports: { './platform': './platform.ts', './package.json': './package.json', './cordis.patch.yml': './cordis.patch.yml' },
          dsh: { bundle: { patch: './cordis.patch.yml' } }, dependencies: {
            '@deepseek-ai/cordis-plugin-logger-console': 'workspace:~', '@deepseek-ai/dsh-host-webserver': 'workspace:*' } })
        await checked(() => symlink(join(repo, 'products/power-evolve/platform/node_modules'), join(bundle, 'node_modules'), 'dir'))
        await checked(() => symlink(bundle, join(profile, 'node_modules', bundleName), 'dir'))
        await checked(() => symlink(join(repo, 'products/power-evolve/platform/node_modules/@deepseek-ai'), join(profile, 'node_modules', '@deepseek-ai'), 'dir'))
        await save(join(profile, 'package.json'), { name: profileName, private: true, type: 'module',
          dependencies: { [bundleName]: '0.0.0-private' }, dsh: { profile: { bundles: [bundleName] } } })
        await save(join(profile, 'cordis.patch.yml'), '[]\n')
        const runtimeConfig = join(root, 'runtime-tsconfig.json')
        await save(runtimeConfig, { extends: join(repo, 'tsconfig.base.json'), compilerOptions: {
          paths: {}, noEmit: true, composite: false, incremental: false } })
        const environment = Object.fromEntries(Object.entries(process.env).filter(([name]) => !name.startsWith('PE_') && ![
          'NODE_OPTIONS', 'NODE_V8_COVERAGE', 'NODE_PATH', 'TSX_TSCONFIG_PATH', 'DSH_HOME', 'DSH_PROFILE',
          'npm_config_node_options', 'NPM_CONFIG_NODE_OPTIONS', 'pnpm_config_node_options', 'PNPM_CONFIG_NODE_OPTIONS',
        ].includes(name)))
        control.signal.throwIfAborted()
        const readyPath = join(root, 'source-platform-ready.json')
        Object.assign(environment, coverageEnvironment, { DSH_HOME: home, PE_PRIVATE_DIR: privateDir,
          PE_ACCOUNT_BOOTSTRAP_FILE: join(privateDir, 'account-bootstrap.json'), PE_SOURCE_HTTP_READY_FILE: readyPath,
          TSX_TSCONFIG_PATH: runtimeConfig, DSH_TELEMETRY_DISABLED: '1' })

        return { seeds, secrets, applicationName, environment, profileName, readyPath }
      }) } catch (error) {
        const setupFailures: unknown[] = [error]
        control.abort(error)
        try { setupFailures.push(...await control.drain()) } catch (drainError) { setupFailures.push(drainError) }
        throw new AggregateError(setupFailures, 'Private Profile setup or cancellation failed')
      }
      assert(prepared)
      const { seeds, secrets, applicationName, environment, profileName, readyPath } = prepared
      const connections = async (): Promise<number> => {
        const observer = new Pool({ connectionString: pool.options.connectionString, max: 1,
          connectionTimeoutMillis: 1000, statement_timeout: 1000, query_timeout: 1500,
          application_name: ownedDatabase + '_observer', options: '-c lock_timeout=1000 -c idle_in_transaction_session_timeout=1000' })
        const observedFailures: unknown[] = []
        observer.on('error', (error: unknown) => { observedFailures.push(error) })
        let count: number | undefined
        try { count = Number((await observer.query<{ count: string }>(
          'SELECT count(*) AS count FROM pg_stat_activity WHERE datname=$1 AND application_name=$2',
          [ownedDatabase, applicationName])).rows[0]?.count) }
        catch (error) { observedFailures.push(error) }
        try { await observer.end() } catch (error) { observedFailures.push(error) }
        if (observedFailures.length) throw new AggregateError(observedFailures, 'Owned CLI PostgreSQL observation failed')
        assert(count !== undefined)
        return count
      }
      try { assert.equal(await control.phase('cli-preflight', 3000, connections), 0) }
      catch (error) {
        const preflightFailures: unknown[] = [error]
        control.abort(error)
        try { preflightFailures.push(...await control.drain()) } catch (drainError) { preflightFailures.push(drainError) }
        throw new AggregateError(preflightFailures, 'Owned CLI preflight failed')
      }
      control.signal.throwIfAborted()
      const child = spawn(process.execPath, [join(repo, 'apps/cli/lib/bin.js'), '--profile', profileName],
        { cwd: repo, env: environment, stdio: ['ignore', 'pipe', 'pipe'] })
      const pid = child.pid ?? 0
      let childLog = '', processError: Error | undefined
      let exit: { code: number | null; signal: NodeJS.Signals | null } | undefined
      for (const stream of [child.stdout, child.stderr]) stream.on('data', (bytes: Buffer) => {
        if (childLog.length < 200_000) childLog += bytes.toString('utf8')
      })
      const done = new Promise<{ code: number | null; signal: NodeJS.Signals | null }>((resolve) => {
        child.once('error', (error) => { processError = error })
        child.once('close', (code, signal) => { exit = { code, signal }; resolve(exit) })
      })
      // close is observed from spawn until disposal; an outer timeout cannot abandon it.
      const closed = observe(done)
      const sanitizeLog = (): string => {
        let text = childLog
        for (const secret of secrets) text = text.replaceAll(secret, '[private]')
        return text.replace(/postgres(?:ql)?:\/\/[^\s"']+/gu, '[private-database-url]')
      }
      const requests: { path: string; status: number }[] = []
      const caseFailures: unknown[] = []
      let port = 0
      try {
        assert(pid > 0)
        const platformUrl = await control.phase('cli-readiness', budgets.readiness, async () => {
          let ready: { pid: number; url: string } | undefined
          while (!ready) {
            control.signal.throwIfAborted()
            if (processError) throw processError
            if (exit) throw new Error('CLI exited before source Platform readiness: ' + sanitizeLog())
            try { ready = z.object({ pid: z.number(), url: z.url() }).loose().parse(JSON.parse(await readFile(readyPath, 'utf8'))) }
            catch (error) {
              if (!(error instanceof Error) || !('code' in error) || error.code !== 'ENOENT') throw error
              await pause()
            }
          }
          assert.equal(ready.pid, pid)
          const platformUrl = ready.url
          const server = new URL(platformUrl)
          assert.equal(server.hostname, '127.0.0.1')
          port = Number(server.port)
          assert(port > 0)

          return platformUrl
        })
        const binaryHttp = async (path: string, bytes?: Uint8Array,
          options: SourceHttpBinaryOptions = {}): Promise<SourceHttpBinaryReply> => {
          control.signal.throwIfAborted()
          const method = options.method ?? (bytes === undefined ? 'GET' : 'POST')
          const origin = options.origin === undefined ? platformUrl : options.origin
          const response = await fetch(new URL(path, platformUrl), { method, headers: {
            'content-type': options.contentType ?? 'application/octet-stream',
            ...(options.token ? { authorization: 'Bearer ' + options.token } : {}),
            ...(origin === null ? {} : { origin }),
          }, ...(method === 'POST' && bytes !== undefined ? { body: new Uint8Array(bytes) } : {}),
          signal: AbortSignal.any([control.signal, AbortSignal.timeout(10_000)]) })
          const received = Buffer.from(await response.arrayBuffer())
          control.signal.throwIfAborted()
          requests.push({ path, status: response.status })
          return { status: response.status, headers: Object.fromEntries(response.headers), bytes: received }
        }
        const http = async (path: string, body: unknown = {}, options: SourceHttpOptions = {}): Promise<SourceHttpReply> => {
          control.signal.throwIfAborted()
          const method = options.method ?? 'POST'
          const origin = options.origin === undefined ? platformUrl : options.origin
          const response = await fetch(new URL(path, platformUrl), { method, headers: {
            'content-type': 'application/json', ...(options.token ? { authorization: 'Bearer ' + options.token } : {}),
            ...(origin === null ? {} : { origin }),
          }, ...(method === 'POST' ? { body: options.rawBody ?? JSON.stringify(body) } : {}),
          signal: AbortSignal.any([control.signal, AbortSignal.timeout(10_000)]) })
          const value: unknown = await response.json()
          requests.push({ path, status: response.status })
          return { status: response.status, value }
        }

        await control.phase('http-business', budgets.body, async () => {
          const live = await http('/live', undefined, { method: 'GET' }), health = await http('/health', undefined, { method: 'GET' })
          assert.equal(live.status, 200); assert.equal(health.status, 200)
          z.object({ ready: z.literal(true), schema: z.literal(6), executionEnabled: z.literal(false),
            mcpAvailable: z.literal(false), remoteMcpAvailable: z.literal(false), stdioV2Available: z.literal(false),
            sshAvailable: z.literal(false) }).loose().parse(health.value)
          assert((await connections()) >= 2)
          const actors: SourceHttpActor[] = []
          for (const seed of seeds) {
            const accountReply = await http('/account/login', { username: seed.username, password: seed.password })
            assert.equal(accountReply.status, 200)
            const account = accountLoginValue.parse(accountReply.value)
            secrets.push(account.token)
            const agentReply = await http('/identity/login', { username: seed.username, password: seed.password })
            assert.equal(agentReply.status, 200)
            const agent = z.object({ token: z.string(), user: identity }).strict().parse(agentReply.value)
            secrets.push(agent.token)
            assert.equal(account.user.userId, agent.user.userId)
            assert.equal(account.user.username, seed.username)
            actors.push({ account: account.token, agent: agent.token, user: account.user })
          }
          const [admin, alice, bob] = actors
          assert(admin && alice && bob)
          assert.equal(admin.user.role, 'ADMIN'); assert.equal(alice.user.role, 'USER'); assert.equal(bob.user.role, 'USER')
          control.signal.throwIfAborted()
          await run({ pool, url: platformUrl, actors: { admin, alice, bob }, http, binaryHttp,
            attachmentRoot: join(root, 'private', 'attachments'),
            storageSnapshot: async () => {
              control.signal.throwIfAborted()
              const value = await ownedStorageSnapshot(root)
              control.signal.throwIfAborted()
              return value
            }, snapshot: () => { control.signal.throwIfAborted(); return publicSnapshot(pool) } })

        })
      } catch (error) { caseFailures.push(error); control.abort(error) }
      try { caseFailures.push(...await control.drain()) }
      catch (error) { caseFailures.push(error) }
      let stop: SourceHttpLifetime['stop'] | undefined
      try {
        stop = await control.phase('cli-graceful-disposal', budgets.graceful, async () => {
          const start = Date.now()
          if (!exit) assert.equal(child.kill('SIGTERM'), true)
          const stopped = await done
          const elapsedMs = Date.now() - start
          assert.equal(stopped.code, 0); assert.equal(stopped.signal, null)
          assert(elapsedMs < 5000, 'CLI exceeded its existing five-second graceful-disposal deadline')
          return { ...stopped, elapsedMs, ownedPgConnections: -1 }
        }, false)
      } catch (error) { caseFailures.push(error); control.abort(error) }
      // Escalation is cleanup only and can never satisfy normal SIGTERM qualification.
      if (!exit) {
        try { await control.phase('cli-escalation', budgets.escalation, async () => {
          child.kill('SIGKILL')
          const outcome = await closed
          if (!outcome.ok) throw outcome.error
        }, false) } catch (error) { caseFailures.push(error); control.unsafe(error) }
      }
      try {
        await control.phase('source-capture-and-pg-drain', budgets.capture, async () => {
          const ownedPgConnections = await connections()
          assert.equal(ownedPgConnections, 0)
          const witness = await loadedSource(coverageEnvironment.PE_CLOUD_COVERAGE_INPUT, pid)
          assert.equal(sha(await readFile(sourcePath)), sourceBefore)
          if (stop) {
            stop.ownedPgConnections = ownedPgConnections
            lifetime = { pid, database: ownedDatabase, port, stop, source: witness,
              temporaryRootRemoved: false, ownedDatabaseRemoved: false, requests }
            console.info('Source Platform HTTP process disposed: ' + JSON.stringify({ pid, database: ownedDatabase, port, ...stop }))
          }
        }, false)
      } catch (error) { caseFailures.push(error) }
      if (caseFailures.length) throw new AggregateError(caseFailures, 'Source HTTP assertions or owned CLI tail failed')
    }, { signal: control.signal, setupTimeoutMs: budgets.setup, cleanupTimeoutMs: budgets.cleanup,
      queryTimeoutMs: 5000, onAbort: (reason) => { control.abort(reason) }, onUnsafe: (error) => { control.unsafe(error) },
      onOwned: (owned) => {
        ownedRoot = owned.root; ownedDatabase = owned.database
        assert.match(ownedDatabase, /^pe_cloud_case_[a-f0-9]{32}$/u)
        console.info('Source HTTP owned fixture: ' + JSON.stringify(owned))
      }, onPhase: (event) => {
        if (event.phase === 'fixture-cleanup' && event.state === 'complete') cleanupConfirmed = true
        console.info('Source HTTP fixture phase: ' + JSON.stringify(event))
      } })
  } catch (error) { failures.push(error); control.abort(error) }
  try { failures.push(...await control.drain()) } catch (error) { failures.push(error) }
  if (ownedRoot && !cleanupConfirmed) {
    const error = new Error('Owned source HTTP fixture cleanup was not confirmed')
    failures.push(error); control.unsafe(error)
  }
  console.info('Source HTTP phase receipt: ' + JSON.stringify({ database: ownedDatabase, phases: control.phases,
    pending: control.records.filter(record => !record.settled).map(record => record.name), budgets,
    fileUnsafe: Boolean(fileUnsafe), cleanupConfirmed }))
  if (fileUnsafe) failures.push(fileUnsafe.error)
  if (failures.length) throw new AggregateError(failures, 'Source Platform HTTP fixture failed')
  assert(lifetime)
  assert(cleanupConfirmed)
  lifetime.temporaryRootRemoved = true
  lifetime.ownedDatabaseRemoved = true
  return lifetime
}

/** Launch one actual source Platform Profile and join disposal even when Vitest times out the case.
 * @param run Account, settings and metadata assertions against real HTTP and PostgreSQL.
 * @param lifecycle Actual Vitest cancellation and completion callbacks for this case.
 * @returns Nonsecret source execution and disposal receipt after the original cloudFixture removes its resources.
 */
export async function sourcePlatformHttpFixture(run: (fixture: SourceHttpFixture) => Promise<void>,
  lifecycle: Pick<TestContext, 'signal' | 'onTestFinished'>): Promise<SourceHttpLifetime> {
  // This latch is checked synchronously before mkdtemp, Pool checkout or CLI spawn.
  if (fileUnsafe) throw new AggregateError([fileUnsafe.error], 'Source HTTP file is quarantined before resource acquisition')
  const control = new CaseLifetime(lifecycle.signal)
  let finished = false
  const running = runSourcePlatformHttpFixture(run, control).finally(() => { finished = true; control.finish() })
  const completion = observe(running)
  lifecycle.onTestFinished(async () => {
    if (!finished) control.abort(new Error('Vitest finished before owned source HTTP fixture settled'))
    const settled = await Promise.race([completion, control.deadline])
    if (!settled.ok) throw new AggregateError([settled.error], 'Source HTTP case or bounded completion hook failed')
    if (fileUnsafe) throw new AggregateError([fileUnsafe.error], 'Source HTTP file failed to reach quiescence')
  }, budgets.hook)
  return running
}
