import assert from 'node:assert/strict'
import { spawn, spawnSync, type ChildProcess } from 'node:child_process'
import { createHash, randomUUID } from 'node:crypto'
import { mkdtempSync, readFileSync, readdirSync, rmSync, watch, writeFileSync } from 'node:fs'
import { createServer } from 'node:net'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import test, { type TestContext } from 'node:test'
import { fileURLToPath } from 'node:url'
import { Client } from '@modelcontextprotocol/client'
import { StdioClientTransport } from '@modelcontextprotocol/client/stdio'
import { readStdioPeerTrace } from './stdio-peer-trace.ts'
import { EgressGate } from '../src/egress.ts'
import { requestDigest, parseCallInput } from '../src/protocol.ts'
import { createConnectorRunner } from '../src/server.ts'
import { StdioMcpTransport } from '../src/stdio.ts'

const token = 'm'.repeat(48)
const fixture = new URL('./stdio-fixture.mjs', import.meta.url).href

function peer(t: TestContext) {
  const root = mkdtempSync(join(tmpdir(), 'pe-stdio-sdk-')), record = join(root, 'trace.jsonl')
  const script = join(root, 'peer.mjs')
  writeFileSync(script, `import { writeFileSync } from 'node:fs';
    writeFileSync(${JSON.stringify(record)}, JSON.stringify({event: 'spawn', pid: process.pid}) + '\\n', {mode: 0o600});
    await import(${JSON.stringify(fixture)});`, { mode: 0o600 })
  const pid = () => readStdioPeerTrace(record)[0]?.pid
  const waitStopped = async () => {
    const ownedPid = pid(); assert.ok(ownedPid, 'SDK peer must record its owned PID')
    const deadline = Date.now() + 1000
    while (true) {
      try { process.kill(ownedPid, 0) }
      catch (error) {
        if (error instanceof Error && 'code' in error && error.code === 'ESRCH') return
        throw error
      }
      assert.ok(Date.now() < deadline, 'SDK peer must exit after transport close')
      await new Promise(resolve => setTimeout(resolve, 10))
    }
  }
  t.after(async () => {
    try {
      const ownedPid = pid()
      if (ownedPid) {
        try { process.kill(ownedPid, 'SIGKILL') }
        catch (error) { if (!(error instanceof Error && 'code' in error && error.code === 'ESRCH')) throw error }
        await waitStopped()
      }
    } finally { rmSync(root, { recursive: true, force: true }) }
  })
  return { script, waitStopped }
}

void test('one isolated MCP process returns only its assigned account and is reaped', async (t) => {
  const p = peer(t), transport = new StdioMcpTransport(p.script)
  const accountId = randomUUID()
  const result = await transport.call({ kind: 'mcp.stdio.whoami', callId: randomUUID(),
    instanceId: randomUUID(), digest: '0'.repeat(64), accountId, timeoutMs: 5000,
    maxOutputBytes: 8192 }, new AbortController().signal)
  assert.deepEqual(result, { kind: 'mcp.stdio.whoami', text: `user:${accountId}` })
  await p.waitStopped()
})

/** Bound real child teardown and clear the timer even when the child fails.
 * @param operation Actual process operation.
 * @returns The original operation result.
 */
async function bounded<T>(operation: Promise<T>): Promise<T> {
  let timer: NodeJS.Timeout | undefined
  try {
    return await Promise.race([operation, new Promise<never>((_resolve, reject) => {
      timer = setTimeout(() => { reject(new Error('Owned child did not close')) }, 5000)
    })])
  } finally { clearTimeout(timer) }
}

/** Confirm the owned PID has disappeared after transport/process closure.
 * @param pid Original child PID.
 */
async function stopped(pid: number): Promise<void> {
  const deadline = Date.now() + 2000
  while (true) {
    try { process.kill(pid, 0) }
    catch (error) {
      if (error instanceof Error && 'code' in error && error.code === 'ESRCH') return
      throw error
    }
    assert.ok(Date.now() < deadline, 'Owned child must disappear')
    await new Promise(resolve => setTimeout(resolve, 10))
  }
}

/** Obtain an owned loopback port and close the reservation on all paths.
 * @returns The released ephemeral port.
 */
async function port(): Promise<number> {
  const server = createServer()
  try {
    await new Promise<void>((resolve, reject) => {
      server.once('error', reject)
      server.listen(0, '127.0.0.1', resolve)
    })
    const address = server.address()
    assert.ok(address && typeof address !== 'string')
    return address.port
  } finally {
    if (server.listening) await new Promise<void>((resolve, reject) => {
      server.close((error) => { if (error) reject(error); else resolve() })
    })
  }
}

/** Launch untouched source bytes with the parent native collector environment.
 * @param t Owning test and immediately registered cleanup.
 * @param entry Actual production entry filename.
 * @param environment Explicit private configuration.
 * @returns Actual child, exit observation and captured output.
 */
function sourceChild(t: TestContext, entry: 'main' | 'stdio-identity-server', environment: NodeJS.ProcessEnv) {
  const root = mkdtempSync(join(tmpdir(), 'pe-runner-entry-')), secret = randomUUID().repeat(2)
  const owned: { child?: ChildProcess; exit?: Promise<{ code: number | null; signal: NodeJS.Signals | null }> } = {}
  t.after(async () => {
    const { child, exit } = owned
    try {
      if (child && exit) {
        if (child.exitCode === null && child.signalCode === null) child.kill('SIGTERM')
        try { await bounded(exit) }
        catch (error) { child.kill('SIGKILL'); await bounded(exit); throw error }
        if (child.pid !== undefined) await stopped(child.pid)
      }
    } finally { rmSync(root, { recursive: true, force: true }) }
  })
  const tokenFile = join(root, 'runner-token')
  writeFileSync(tokenFile, secret, { mode: 0o600 })
  const child = spawn(process.execPath, [fileURLToPath(new URL('../src/' + entry + '.ts', import.meta.url))], {
    cwd: root, env: { ...process.env, CONNECTOR_RUNNER_TOKEN_FILE: tokenFile, ...environment },
    stdio: ['ignore', 'pipe', 'pipe'],
  })
  owned.child = child
  const exit = new Promise<{ code: number | null; signal: NodeJS.Signals | null }>((resolve) => {
    child.once('close', (code, signal) => { resolve({ code, signal }) })
  })
  owned.exit = exit
  let stdout = '', stderr = ''
  child.stdout?.on('data', (bytes: Buffer) => { stdout += bytes.toString('utf8') })
  child.stderr?.on('data', (bytes: Buffer) => { stderr += bytes.toString('utf8') })
  child.once('error', (error) => { stderr += error.name })
  return { child, exit, secret, stdout: () => stdout, stderr: () => stderr }
}

/** Read the PID's actual OS parent and birth identity without sending a signal.
 * @param pid PID obtained from the real transport or native collector.
 * @returns OS parent and identity while present, or null after disappearance.
 */
function processIdentity(pid: number): { pid: number; ppid: number; birth: string } | null {
  try { process.kill(pid, 0) }
  catch (error) {
    if (error instanceof Error && 'code' in error && error.code === 'ESRCH') return null
    if (!(error instanceof Error && 'code' in error && error.code === 'EPERM')) throw error
  }
  const result = spawnSync('ps', ['-p', String(pid), '-o', 'pid=,ppid=,uid=,lstart=,comm='], { encoding: 'utf8' })
  if (result.error) throw result.error
  if (result.status === 0 && result.stdout.trim()) {
    const matched = /^\s*(\d+)\s+(\d+)\s+(.+)$/u.exec(result.stdout.trim())
    assert.ok(matched, 'OS process identity must include actual PID and parent')
    assert.equal(Number(matched[1]), pid)
    return { pid, ppid: Number(matched[2]), birth: String(pid) + ' ' + String(matched[3]).replace(/\s+/gu, ' ') }
  }
  assert.throws(() => process.kill(pid, 0), { code: 'ESRCH' })
  return null
}

/** Observe real SDK target and collector-only negotiation probe PIDs from acquisition.
 * @param currentPid Public transport PID getter.
 * @returns Read-only observations, first acquisition and durable cleanup receipt writer.
 */
function sdkPidLedger(currentPid: () => number | null) {
  const owner = processIdentity(process.pid)
  assert.ok(owner, 'SDK scope must have an actual owner birth identity')
  const scopeId = randomUUID()
  const inputFile = process.env.PE_CLOUD_COVERAGE_INPUT
  const text = inputFile === undefined ? undefined : readFileSync(inputFile, 'utf8')
  const input: unknown = text === undefined ? undefined : JSON.parse(text)
  assert.ok(input === undefined || input && typeof input === 'object' && 'directory' in input
    && typeof input.directory === 'string')
  const directoryValue = input === undefined ? undefined : input.directory
  assert.ok(directoryValue === undefined || typeof directoryValue === 'string')
  const directory = directoryValue
  const code = directory === undefined ? undefined : join(directory, 'code')
  const inputHash = text === undefined ? undefined : createHash('sha256').update(text).digest('hex')
  const baseline = new Set(code === undefined ? [] : readdirSync(code))
  const rows = new Map<number, {
    pid: number
    sources: string[]
    birth: string
    ancestry: { pid: number; ppid: number; birth: string }[]
    gone?: boolean
  }>()
  const excluded = new Map<string, {
    pid: number
    source: string
    reason: string
    identity: { pid: number; ppid: number; birth: string } | null
  }>()
  const errors: unknown[] = []
  let acquired: (() => void) | undefined
  const started = new Promise<void>((resolve) => { acquired = resolve })
  const remember = (pid: number, source: string): void => {
    const existing = rows.get(pid)
    if (existing) { if (!existing.sources.includes(source)) existing.sources.push(source); return }
    if (excluded.has(source)) return
    const identity = processIdentity(pid), ancestry = [], seen = new Set<number>()
    let ancestor = identity
    while (ancestor && ancestor.pid !== owner.pid && !seen.has(ancestor.pid) && ancestry.length < 64) {
      seen.add(ancestor.pid); ancestry.push(ancestor)
      ancestor = ancestor.ppid > 0 ? processIdentity(ancestor.ppid) : null
    }
    if (!identity || !ancestor || ancestor.pid !== owner.pid || ancestor.birth !== owner.birth) {
      excluded.set(source, { pid, source, identity,
        reason: identity === null ? 'gone before ownership proof' : 'outside actual owner ancestry' })
      return
    }
    rows.set(pid, { pid, sources: [source], birth: identity.birth, ancestry })
    acquired?.()
  }
  const observe = (): void => {
    try {
      const pid = currentPid()
      if (pid !== null) remember(pid, 'transport')
      if (code === undefined) return
      for (const name of readdirSync(code)) {
        if (baseline.has(name) || !/^\d+-\d+\.json$/u.test(name)) continue
        let captured: unknown
        try { captured = JSON.parse(readFileSync(join(code, name), 'utf8')) }
        catch (error) { if (error instanceof SyntaxError) continue; throw error }
        if (!captured || typeof captured !== 'object' || !('pid' in captured) || !('inputHash' in captured)
          || typeof captured.pid !== 'number' || !Number.isSafeInteger(captured.pid) || captured.pid <= 0
          || captured.inputHash !== inputHash) throw new Error('Owned native PID evidence mismatch')
        remember(captured.pid, 'code/' + name)
      }
    } catch (error) { errors.push(error) }
  }
  const watcher = code === undefined ? undefined : watch(code, { persistent: false }, observe)
  watcher?.on('error', (error) => { errors.push(error) })
  const timer = setInterval(observe, 10)
  timer.unref()
  observe()
  if (directory !== undefined) writeFileSync(join(directory, 'sdk-scope-started-' + scopeId + '.json'),
    JSON.stringify({ scopeId, owner }), { mode: 0o600 })
  const finish = async (stages: unknown, connection: unknown): Promise<void> => {
    try {
      observe()
      const stoppedResults = await Promise.allSettled([...rows.values()].map(async (row) => {
        const deadline = Date.now() + 2000
        while (true) {
          const now = processIdentity(row.pid)
          if (now === null || now.birth !== row.birth) { row.gone = true; return }
          assert.ok(Date.now() < deadline, 'Original SDK/probe birth identity must disappear')
          await new Promise(resolve => setTimeout(resolve, 10))
        }
      }))
      for (const result of stoppedResults) if (result.status === 'rejected') errors.push(result.reason)
    } finally {
      clearInterval(timer)
      watcher?.close()
      if (directory !== undefined) writeFileSync(join(directory, 'sdk-pid-ledger-' + randomUUID() + '.json'),
        JSON.stringify({ scopeId, owner, connection, stages, observations: [...rows.values()],
          excluded: [...excluded.values()],
          observerErrors: errors.map(error => error instanceof Error ? { name: error.name, message: error.message } : typeof error),
          observerErrorNames: errors.map(error => error instanceof Error ? error.name : typeof error) }), { mode: 0o600 })
    }
    if (errors.length) throw new AggregateError(errors, 'Owned SDK PID observation or closure failed')
  }
  return { started, observe, finish }
}

for (const signal of ['SIGTERM', 'SIGINT'] as const) {
  void test('formal Connector entry serves authenticated control and closes on ' + signal, async (t) => {
    const httpPort = await port()
    let forbidden = await port()
    while (forbidden === httpPort) forbidden = await port()
    const p = sourceChild(t, 'main', { CONNECTOR_RUNNER_PORT: String(httpPort),
      CONNECTOR_RUNNER_ALLOWED_DESTINATIONS: '', CONNECTOR_RUNNER_FORBIDDEN_PROBE: '127.0.0.1:' + String(forbidden),
      CONNECTOR_RUNNER_REFUSED_PROVES_DENIAL: '1' })
    const url = 'http://127.0.0.1:' + String(httpPort), headers = { 'x-power-evolve-runner-token': p.secret }
    const deadline = Date.now() + 10_000
    let health: Response | undefined
    while (true) {
      health = await fetch(url + '/health', { headers, signal: AbortSignal.timeout(500) }).catch(() => undefined)
      if (health?.status === 200) break
      assert.equal(p.child.exitCode, null, 'Formal entry must remain alive during startup')
      assert.ok(Date.now() < deadline, 'Real loopback refusal probes must reach readiness')
      await new Promise(resolve => setTimeout(resolve, 50))
    }
    const view: unknown = await health.json()
    assert.ok(view && typeof view === 'object' && 'ready' in view && 'instanceId' in view)
    assert.equal(view.ready, true)
    assert.equal(typeof view.instanceId, 'string')
    const unauthorized = await fetch(url + '/health')
    assert.equal(unauthorized.status, 401)
    assert.deepEqual(await unauthorized.json(), { error: 'unauthorized' })
    const missing = await fetch(url + '/calls/' + randomUUID(), { headers })
    assert.equal(missing.status, 404)
    assert.deepEqual(await missing.json(), { error: 'call_not_found', instanceId: view.instanceId })
    const refused = await fetch(url + '/calls', { method: 'POST',
      headers: { ...headers, 'content-type': 'application/json' }, body: '{}' })
    assert.equal(refused.status, 400)
    assert.equal((await refused.text()).includes(p.secret), false)
    assert.ok(p.child.pid)
    assert.equal(p.child.kill(signal), true)
    assert.deepEqual(await bounded(p.exit), { code: 0, signal: null })
    await stopped(p.child.pid)
    assert.equal(p.stdout().includes(p.secret), false)
    assert.equal(p.stderr().includes(p.secret), false)
    await assert.rejects(fetch(url + '/health', { headers, signal: AbortSignal.timeout(500) }))
  })
}

void test('formal identity source initializes and returns only each actual SDK child account scope', async (t) => {
  for (const accountId of [randomUUID(), randomUUID()]) {
    const client = new Client({ name: 'owned-entry-test', version: '0.1.0' },
      { capabilities: {}, versionNegotiation: { mode: 'auto' } })
    const environment: Record<string, string> = { PE_MCP_ACCOUNT_ID: accountId }
    for (const key of ['PE_CLOUD_COVERAGE_INPUT', 'NODE_V8_COVERAGE', 'NODE_OPTIONS']) {
      const value = process.env[key]
      if (value !== undefined) environment[key] = value
    }
    const transport = new StdioClientTransport({ command: process.execPath,
      args: [fileURLToPath(new URL('../src/stdio-identity-server.ts', import.meta.url))],
      stderr: 'pipe', env: environment })
    const ledger = sdkPidLedger(() => transport.pid), controller = new AbortController()
    let pid: number | null = null, stderr = '', connectionSettled = false
    let cleanupWork: Promise<void> | undefined
    const cleanup = (): Promise<void> => cleanupWork ??= (async () => {
      ledger.observe()
      controller.abort(new DOMException('Owned SDK fixture cleanup', 'AbortError'))
      const errors: unknown[] = [], stages: unknown[] = []
      const close = async (phase: string): Promise<void> => {
        const results = await Promise.allSettled([
          Promise.resolve().then(() => client.close()), Promise.resolve().then(() => transport.close()),
        ])
        stages.push({ phase, results: results.map(result => ({ status: result.status,
          ...(result.status === 'rejected' ? { errorName: result.reason instanceof Error ? result.reason.name : 'non-Error' } : {}) })) })
        for (const result of results) if (result.status === 'rejected') errors.push(result.reason)
      }
      let outcome: unknown
      try {
        await close('before connection drain')
        const result = await observed
        outcome = { status: result.status, settled: connectionSettled,
          ...(result.status === 'rejected'
            ? { errorName: result.reason instanceof Error ? result.reason.name : 'non-Error' } : {}) }
      } finally {
        try { ledger.observe(); await close('after connection drain') }
        finally {
          const finished = await Promise.allSettled([ledger.finish(stages, outcome)])
          for (const result of finished) if (result.status === 'rejected') errors.push(result.reason)
        }
      }
      if (errors.length) throw new AggregateError(errors, 'Original SDK cleanup failures')
    })()
    t.after(cleanup)
    const connection = client.connect(transport, { timeout: 5000, signal: controller.signal })
    const observed = connection.then(() => {
      connectionSettled = true; ledger.observe(); return { status: 'fulfilled' as const, value: undefined }
    }, (reason: unknown) => {
      connectionSettled = true; ledger.observe(); return { status: 'rejected' as const, reason }
    })
    ledger.observe()
    await connection
    pid = transport.pid
    transport.stderr?.on('data', (bytes: Buffer) => { stderr += bytes.toString('utf8') })
    assert.ok(pid)
    assert.equal(client.getServerVersion()?.name, 'power-evolve-stdio-identity')
    const listed = await client.listTools(undefined, { timeout: 5000 })
    assert.deepEqual(listed.tools.map(tool => tool.name), ['whoami'])
    assert.deepEqual(listed.tools[0]?.annotations,
      { readOnlyHint: true, destructiveHint: false, openWorldHint: false })
    const result = await client.callTool({ name: 'whoami', arguments: {} }, { timeout: 5000 })
    assert.deepEqual(result.content, [{ type: 'text', text: 'user:' + accountId }])
    assert.notEqual(result.isError, true)
    await client.close()
    await transport.close()
    await stopped(pid)
    assert.equal(stderr.includes(accountId), false)
    await cleanup()
  }
})

for (const accountId of [undefined, 'invalid-scope-' + randomUUID()]) {
  void test('formal identity source refuses ' + (accountId === undefined ? 'missing' : 'invalid') + ' scope', async (t) => {
    const p = sourceChild(t, 'stdio-identity-server', { PE_MCP_ACCOUNT_ID: accountId })
    const result = await bounded(p.exit)
    assert.equal(result.code, 1)
    assert.equal(result.signal, null)
    assert.equal(p.stdout(), '')
    assert.match(p.stderr(), /Invalid account scope/u)
    assert.equal(p.stderr().includes(p.secret), false)
    if (accountId !== undefined) assert.equal(p.stderr().includes(accountId), false)
    assert.ok(p.child.pid)
    await stopped(p.child.pid)
  })
}

void test('Runner fences process calls on egress readiness, instance and stable digest', async (t) => {
  const p = peer(t)
  const instanceId = randomUUID()
  const gate = new EgressGate({ host: '192.0.2.3', port: 2999 }, async () => 'denied', false, 60_000)
  const runner = createConnectorRunner({ token, allowlist: new Set(), egress: gate,
    transport: { async call() { throw new Error('SSH must not be called') } },
    stdioTransport: new StdioMcpTransport(p.script), instanceId })
  runner.server.listen(0, '127.0.0.1')
  await new Promise<void>(resolve => runner.server.once('listening', resolve))
  t.after(() => runner.close())
  const address = runner.server.address()
  assert.ok(address && typeof address !== 'string')
  const url = `http://127.0.0.1:${address.port}`
  const api = async (path: string, init: RequestInit = {}) => {
    const headers = new Headers(init.headers)
    headers.set('x-power-evolve-runner-token', token)
    const response = await fetch(`${url}${path}`, { ...init, headers })
    return { status: response.status, value: await response.json() as Record<string, unknown> }
  }
  const post = (value: unknown) => api('/calls', { method: 'POST',
    headers: { 'content-type': 'application/json' }, body: JSON.stringify(value) })
  const unsigned = { kind: 'mcp.stdio.whoami' as const, callId: randomUUID(), instanceId,
    accountId: randomUUID(), timeoutMs: 5000, maxOutputBytes: 8192 }
  const signed = { ...unsigned, digest: requestDigest(unsigned, token) }
  assert.equal((await post(signed)).status, 503)
  await gate.check(); await gate.check(); await gate.check()
  assert.equal((await post(signed)).status, 202)
  assert.equal((await post(signed)).status, 200)
  let state: Record<string, unknown> = {}
  for (let attempt = 0; attempt < 50; attempt++) {
    state = (await api(`/calls/${unsigned.callId}`)).value
    if (state.state !== 'running') break
    await new Promise(resolve => setTimeout(resolve, 50))
  }
  assert.equal(state.state, 'succeeded')
  assert.equal('effectMayHaveOccurred' in state, false)
  assert.deepEqual(state.result, { kind: 'mcp.stdio.whoami', text: `user:${unsigned.accountId}` })
  const conflict = { ...unsigned, accountId: randomUUID() }
  assert.equal((await post({ ...conflict, digest: requestDigest(conflict, token) })).status, 409)
  assert.equal((await post({ ...unsigned, instanceId: randomUUID(), digest: signed.digest })).status, 409)
  assert.equal((await post({ ...signed, accountId: 'wrong' })).status, 400)
  assert.equal((await post({ ...signed, command: '/bin/sh' })).status, 400)
  assert.equal(parseCallInput(signed).kind, 'mcp.stdio.whoami')
  await p.waitStopped()
})

/** Own a real listener before the entry can probe or attempt to bind it.
 * @param t Test that releases the listener on every path.
 * @param host Actual IPv4 or IPv6 listen address.
 * @returns The owned port and number of actual accepted connections.
 */
async function startupListener(t: TestContext, host: '127.0.0.1' | '::1' | '0.0.0.0') {
  let connections = 0
  const server = createServer((socket) => { connections++; socket.destroy() })
  t.after(async () => {
    if (server.listening) await new Promise<void>((resolve, reject) => {
      server.close((error) => { if (error) reject(error); else resolve() })
    })
  })
  await new Promise<void>((resolve, reject) => {
    server.once('error', reject)
    server.listen(0, host, resolve)
  })
  const address = server.address()
  assert.ok(address && typeof address !== 'string')
  return { port: address.port, connections: () => connections, listening: () => server.listening }
}

/** Observe actual authenticated startup without requiring the denial gate to pass.
 * @param p Owned original source entry.
 * @param httpPort Its private listener port.
 * @returns Actual HTTP health response after startup.
 */
async function startupHealth(p: ReturnType<typeof sourceChild>, httpPort: number): Promise<Response> {
  const url = 'http://127.0.0.1:' + String(httpPort), deadline = Date.now() + 10_000
  while (true) {
    const response = await fetch(url + '/health', {
      headers: { 'x-power-evolve-runner-token': p.secret }, signal: AbortSignal.timeout(500),
    }).catch(() => undefined)
    if (response) return response
    assert.equal(p.child.exitCode, null, 'Source entry must remain alive during startup')
    assert.ok(Date.now() < deadline, 'Source entry must open its configured listener')
    await new Promise(resolve => setTimeout(resolve, 10))
  }
}

/** Stop the actual entry and confirm its process and listener have both closed.
 * @param p Owned original source entry.
 * @param httpPort Its private listener port.
 */
async function stopStartup(p: ReturnType<typeof sourceChild>, httpPort: number): Promise<void> {
  assert.ok(p.child.pid)
  assert.equal(p.child.kill('SIGTERM'), true)
  assert.deepEqual(await bounded(p.exit), { code: 0, signal: null })
  await stopped(p.child.pid)
  assert.equal(p.stdout().includes(p.secret), false)
  assert.equal(p.stderr().includes(p.secret), false)
  await assert.rejects(fetch('http://127.0.0.1:' + String(httpPort) + '/health', { signal: AbortSignal.timeout(500) }))
}

const startupRefusals: { name: string; environment: NodeJS.ProcessEnv }[] = [
  { name: 'relative token file', environment: { CONNECTOR_RUNNER_TOKEN_FILE: 'runner-token' } },
  { name: 'multiple forbidden targets', environment: {
    CONNECTOR_RUNNER_FORBIDDEN_PROBE: '127.0.0.1:1234,[::1]:1235' } },
  { name: 'allowlisted forbidden target', environment: {
    CONNECTOR_RUNNER_FORBIDDEN_PROBE: '127.0.0.1:1234', CONNECTOR_RUNNER_ALLOWED_DESTINATIONS: '127.0.0.1:1234' } },
  { name: 'invalid refusal flag', environment: { CONNECTOR_RUNNER_REFUSED_PROVES_DENIAL: '2' } },
  { name: 'non-integer port', environment: { CONNECTOR_RUNNER_PORT: '1.5' } },
  { name: 'zero port', environment: { CONNECTOR_RUNNER_PORT: '0' } },
  { name: 'port above TCP limit', environment: { CONNECTOR_RUNNER_PORT: '65536' } },
]
for (const scenario of startupRefusals) {
  void test('formal Connector startup refuses ' + scenario.name, async (t) => {
    const httpPort = await port()
    const p = sourceChild(t, 'main', { CONNECTOR_RUNNER_PORT: String(httpPort),
      CONNECTOR_RUNNER_ALLOWED_DESTINATIONS: '', CONNECTOR_RUNNER_FORBIDDEN_PROBE: undefined,
      CONNECTOR_RUNNER_REFUSED_PROVES_DENIAL: '0', ...scenario.environment })
    assert.deepEqual(await bounded(p.exit), { code: 1, signal: null })
    assert.equal(p.stdout(), '')
    assert.equal(p.stderr(), 'Connector Runner failed to start: Error\n')
    assert.ok(p.child.pid)
    await stopped(p.child.pid)
    await assert.rejects(fetch('http://127.0.0.1:' + String(httpPort) + '/health', { signal: AbortSignal.timeout(500) }))
  })
}

void test('formal Connector startup refuses an already owned listening port', async (t) => {
  const reservation = await startupListener(t, '0.0.0.0')
  const p = sourceChild(t, 'main', { CONNECTOR_RUNNER_PORT: String(reservation.port),
    CONNECTOR_RUNNER_ALLOWED_DESTINATIONS: '', CONNECTOR_RUNNER_FORBIDDEN_PROBE: undefined,
    CONNECTOR_RUNNER_REFUSED_PROVES_DENIAL: '0' })
  assert.deepEqual(await bounded(p.exit), { code: 1, signal: null })
  assert.equal(p.stdout(), '')
  assert.equal(p.stderr(), 'Connector Runner failed to start: Error\n')
  assert.equal(reservation.listening(), true)
  assert.ok(p.child.pid)
  await stopped(p.child.pid)
})

for (const host of ['127.0.0.1', '::1'] as const) {
  void test('formal Connector startup parses actual forbidden ' + (host === '::1' ? 'IPv6' : 'IPv4') + ' target', async (t) => {
    const httpPort = await port(), probe = await startupListener(t, host)
    const target = (host === '::1' ? '[' + host + ']' : host) + ':' + String(probe.port)
    const p = sourceChild(t, 'main', { CONNECTOR_RUNNER_PORT: String(httpPort),
      CONNECTOR_RUNNER_ALLOWED_DESTINATIONS: '', CONNECTOR_RUNNER_FORBIDDEN_PROBE: target,
      CONNECTOR_RUNNER_REFUSED_PROVES_DENIAL: '0' })
    const health = await startupHealth(p, httpPort)
    assert.equal(health.status, 503)
    const view: unknown = await health.json()
    assert.ok(view && typeof view === 'object' && 'ready' in view)
    assert.equal(view.ready, false)
    const deadline = Date.now() + 2000
    while (probe.connections() === 0) {
      assert.ok(Date.now() < deadline, 'Parsed forbidden target must reach its actual owned listener')
      await new Promise(resolve => setTimeout(resolve, 10))
    }
    await stopStartup(p, httpPort)
  })
}

void test('formal Connector startup defaults keep absent allowlist and forbidden probe unready', async (t) => {
  const httpPort = await port()
  const p = sourceChild(t, 'main', { CONNECTOR_RUNNER_PORT: String(httpPort),
    CONNECTOR_RUNNER_ALLOWED_DESTINATIONS: undefined, CONNECTOR_RUNNER_FORBIDDEN_PROBE: undefined,
    CONNECTOR_RUNNER_REFUSED_PROVES_DENIAL: undefined })
  const health = await startupHealth(p, httpPort)
  assert.equal(health.status, 503)
  const view: unknown = await health.json()
  assert.ok(view && typeof view === 'object' && 'ready' in view)
  assert.equal(view.ready, false)
  await stopStartup(p, httpPort)
})
