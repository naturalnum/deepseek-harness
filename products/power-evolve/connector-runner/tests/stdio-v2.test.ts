/** Real SDK2 and owned synthetic Node peers; no application, Docker, PG or model entry runs. */
import assert from 'node:assert/strict'
import { mkdtempSync, readFileSync, rmSync } from 'node:fs'
import { dirname, join } from 'node:path'
import { tmpdir } from 'node:os'
import test, { type TestContext } from 'node:test'
import { fileURLToPath } from 'node:url'
import { catalog } from './stdio-v2-fixture.mjs'
import { runStdioV2, type StdioV2Input, type StdioV2Limits, type StdioV2Options, type StdioV2Tool } from '../src/stdio-v2.ts'
import { stdioCatalogFingerprintV2 } from '../src/stdio-v2-digest.ts'
import { readStdioPeerTrace } from './stdio-peer-trace.ts'

const fixture = fileURLToPath(new URL('./stdio-v2-fixture.mjs', import.meta.url))
const limits: StdioV2Limits = { runtimeMs: 3000, requestMs: 700, stdinGraceMs: 30, terminateGraceMs: 100,
  killGraceMs: 500, maxInputBytes: 65536, maxMessageBytes: 32768, maxProtocolBytes: 262144,
  maxProtocolMessages: 100, maxJsonDepth: 64, maxJsonNodes: 10000, maxPages: 8, maxTools: 32,
  maxCatalogBytes: 65536, maxToolBytes: 16384, maxResultBytes: 32768, maxStderrBytes: 4096 }
const fingerprint = (tools: readonly StdioV2Tool[]) => stdioCatalogFingerprintV2(tools, limits)

function peer(t: TestContext, mode = 'normal', overrides: Partial<StdioV2Limits> = {}, argv: string[] = []) {
  const root = mkdtempSync(join(tmpdir(), 'pe-runner-sdk-peer-'))
  const record = join(root, 'trace.jsonl')
  const input: StdioV2Input = { phase: 'discover', program: process.execPath,
    argv: [fixture, mode, record, ...argv], cwd: root }
  const options: StdioV2Options = { env: { HOME: root, PATH: dirname(process.execPath), LANG: 'C.UTF-8' },
    identity: { kind: 'current' }, limits: { ...limits, ...overrides }, fingerprintCatalog: fingerprint }
  const trace = () => readStdioPeerTrace(record)
  t.after(async () => {
    for (const item of trace()) if (item.event === 'spawn' && item.pid) {
      try {
        process.kill(item.pid, 0)
        process.kill(item.pid, 'SIGKILL')
        assert.fail('owned direct child must already have exited after the provider returns')
      } catch (error) { if (!(error instanceof Error && 'code' in error && error.code === 'ESRCH')) throw error }
    }
    for (const item of trace()) if (['pipe-holder', 'pipe-holder-spawn'].includes(item.event) && item.pid) {
      try { process.kill(item.pid, 'SIGKILL') }
      catch (error) { if (!(error instanceof Error && 'code' in error && error.code === 'ESRCH')) throw error }
      const deadline = Date.now() + 1000
      while (true) {
        try { process.kill(item.pid, 0) }
        catch (error) {
          if (error instanceof Error && 'code' in error && error.code === 'ESRCH') break
          throw error
        }
        assert.ok(Date.now() < deadline, 'owned pipe-holder must disappear after test cleanup')
        await new Promise(resolve => setTimeout(resolve, 10))
      }
    }
    rmSync(root, { recursive: true, force: true })
  })
  return { root, input, options, trace, call: { ...input, phase: 'call' as const,
    catalogExpectation: catalog, rawName: 'sum', arguments: { left: 3, right: 5 } } }
}

void test('SDK2 initializes one literal child and discovers all original paginated JSON with a credential-free env', async (t) => {
  const argv = ['two words', '$(pe-qa-not-a-command)', '; pe-qa-not-a-command', '"quotes"', 'line\nbreak', 'Ω\\path']
  const p = peer(t, 'normal', {}, argv)
  const result = await runStdioV2(p.input, p.options, new AbortController().signal)
  if (result.state !== 'completed') assert.fail(result.errorCode)
  assert.deepEqual(result.catalog, catalog)
  assert.equal(result.pages.length, 2)
  assert.deepEqual(result.pages.map(page => page['x-page']), [{ full: true }, { full: true }])
  assert.deepEqual(result.initializeResult._meta, { 'qa/initialize': 'preserved' })
  assert.equal(result.facts.toolsCallAttempted, false)
  assert.equal(result.facts.effectMayHaveOccurred, true)
  assert.equal(result.facts.cleanupConfirmed, true)
  assert.equal(result.facts.childExitObserved, true)
  assert.equal(result.facts.childCloseObserved, true)
  const trace = p.trace()
  assert.deepEqual(trace[0]?.argv, argv)
  // Node adds its own coverage directory to spawned Node processes during native collection.
  assert.equal(trace[0]?.coverageDirectory, process.env.NODE_V8_COVERAGE)
  // macOS also adds an encoding hint. All remaining keys must match the explicit environment.
  const observedKeys = trace[0]?.envKeys?.filter(key =>
    !(process.platform === 'darwin' && key === '__CF_USER_TEXT_ENCODING')
    && !(process.env.NODE_V8_COVERAGE !== undefined && key === 'NODE_V8_COVERAGE'))
  assert.deepEqual(observedKeys, ['HOME', 'LANG', 'PATH'])
  assert.deepEqual(trace[0]?.env, p.options.env)
  assert.equal(trace.filter(item => item.event === 'spawn').length, 1)
  assert.equal(trace.filter(item => item.method === 'initialize').length, 1)
  assert.equal(trace.filter(item => item.method === 'tools/list').length, 2)
  assert.equal(trace.filter(item => item.method === 'tools/call').length, 0)
})

void test('a frozen full directory permits exactly one two-parameter SDK call and preserves raw content/extensions', async (t) => {
  const p = peer(t)
  const result = await runStdioV2(p.call, p.options, new AbortController().signal)
  assert.equal(result.state, 'completed')
  if (result.state !== 'completed' || result.phase !== 'call') assert.fail('expected complete call')
  assert.deepEqual(result.catalog, catalog)
  assert.deepEqual(result.result, { content: [{ type: 'text', text: 'sum:8\u0000', _meta: { 'qa/content': true },
    'x-content': ['preserved'] }], structuredContent: { sum: 8, raw: 'structured\u0000value' }, isError: false,
  _meta: { 'qa/result': { full: true } }, 'x-result': { full: ['preserved', null] } })
  assert.equal(result.facts.toolsCallAttempted, true)
  assert.equal(result.facts.cleanupConfirmed, true)
  const calls = p.trace().filter(item => item.method === 'tools/call')
  assert.equal(calls.length, 1)
  assert.deepEqual(calls[0]?.params, { name: 'sum', arguments: { left: 3, right: 5 } })
})

void test('isError and escaped NUL arguments remain full RPC results', async (t) => {
  const p = peer(t, 'tool-error')
  const result = await runStdioV2({ ...p.call, rawName: 'echo', arguments: { text: 'arg\u0000value' } },
    p.options, new AbortController().signal)
  if (result.state !== 'completed' || result.phase !== 'call') assert.fail('expected complete error result')
  assert.equal(result.result.isError, true)
  assert.deepEqual(result.result.structuredContent, { echo: 'arg\u0000value' })
  assert.equal(p.trace().filter(item => item.method === 'tools/call').length, 1)
})

for (const [mode, expected] of [['changed', 'catalog_changed'], ['duplicate', 'tool_duplicate'],
  ['cursor-loop', 'cursor_repeated'], ['malformed', 'protocol_invalid'], ['invalid-rpc', 'protocol_invalid'],
  ['invalid-utf8', 'protocol_invalid'], ['unsupported', 'protocol_unsupported'],
  ['trailing-partial', 'protocol_invalid'], ['shutdown-malformed', 'protocol_invalid']] as const) {
  void test(`${mode} refuses the call and reaps the original child`, async (t) => {
    const p = peer(t, mode)
    const invocation = mode === 'trailing-partial' || mode === 'shutdown-malformed' ? p.input : p.call
    const result = await runStdioV2(invocation, p.options, new AbortController().signal)
    assert.equal(result.state, 'failed')
    if (result.state !== 'failed') assert.fail('expected failure')
    assert.equal(result.errorCode, expected)
    assert.equal(result.facts.toolsCallAttempted, false)
    assert.equal(result.facts.cleanupConfirmed, true)
    assert.equal(p.trace().filter(item => item.method === 'tools/call').length, 0)
    assert.equal(p.trace().filter(item => item.event === 'spawn').length, 1)
    assert.equal(p.trace().filter(item => item.method === 'initialize').length, 1)
  })
}

for (const [mode, overrides, expected] of [
  ['normal', { maxPages: 1 }, 'pages_limit'], ['normal', { maxTools: 1 }, 'tools_limit'],
  ['normal', { maxCatalogBytes: 16 }, 'catalog_limit'], ['normal', { maxToolBytes: 16 }, 'tool_limit'],
  ['normal', { maxProtocolBytes: 32 }, 'protocol_bytes_limit'],
  ['normal', { maxProtocolMessages: 2 }, 'protocol_messages_limit'],
  ['protocol-flood', { maxMessageBytes: 1024 }, 'protocol_message_limit'],
  ['stderr-flood', { maxStderrBytes: 16 }, 'stderr_limit'],
  ['json-deep', { maxJsonDepth: 8 }, 'json_limit'],
] as const) {
  void test(`${expected} fails instead of publishing a truncated directory`, async (t) => {
    const p = peer(t, mode, overrides)
    const result = await runStdioV2(p.input, p.options, new AbortController().signal)
    if (result.state !== 'failed') assert.fail('expected budget refusal')
    assert.equal(result.errorCode, expected)
    assert.equal(result.facts.toolsCallAttempted, false)
    assert.equal(result.facts.cleanupConfirmed, true)
  })
}

void test('result overflow retains the one-call effect fact without a truncated success', async (t) => {
  const p = peer(t, 'result-flood', { maxResultBytes: 128 })
  const result = await runStdioV2(p.call, p.options, new AbortController().signal)
  if (result.state !== 'failed') assert.fail('expected result refusal')
  assert.equal(result.errorCode, 'result_limit')
  assert.equal(result.result, undefined)
  assert.equal(result.facts.toolsCallAttempted, true)
  assert.equal(result.facts.cleanupConfirmed, true)
  assert.equal(p.trace().filter(item => item.method === 'tools/call').length, 1)
})

for (const [mode, expectedCalls] of [['initialize-lost', 0], ['list-lost', 0], ['call-lost', 1]] as const) {
  void test(`${mode} never retries initialize, listing or tools/call`, async (t) => {
    const p = peer(t, mode, { requestMs: 1000, runtimeMs: 5000 })
    const result = await runStdioV2(p.call, p.options, new AbortController().signal)
    if (result.state !== 'failed') assert.fail('expected lost reply')
    assert.equal(result.errorCode, 'request_timeout')
    assert.equal(result.facts.toolsCallAttempted, expectedCalls === 1)
    assert.equal(result.facts.cleanupConfirmed, true)
    assert.equal(p.trace().filter(item => item.method === 'initialize').length, 1)
    assert.equal(p.trace().filter(item => item.method === 'tools/call').length, expectedCalls)
    assert.equal(p.trace().filter(item => item.event === 'spawn').length, 1)
  })
}

void test('abort before spawn starts nothing; runtime expiry interrupts the single initialized peer', async (t) => {
  const p = peer(t, 'initialize-lost', { runtimeMs: 1500, requestMs: 2000 })
  const stopped = new AbortController()
  stopped.abort()
  const before = await runStdioV2(p.input, p.options, stopped.signal)
  if (before.state !== 'failed') assert.fail('expected abort')
  assert.equal(before.errorCode, 'aborted')
  assert.equal(before.facts.programStartAttempted, false)
  assert.equal(p.trace().length, 0)
  const result = await runStdioV2(p.input, p.options, new AbortController().signal)
  if (result.state !== 'failed') assert.fail('expected timeout')
  assert.equal(result.errorCode, 'runtime_timeout')
  assert.equal(result.facts.cleanupConfirmed, true)
  assert.equal(p.trace().filter(item => item.method === 'initialize').length, 1)
})

void test('abort during a lost call waits for actual child close without replaying it', async (t) => {
  const p = peer(t, 'call-lost')
  const stopped = new AbortController()
  const running = runStdioV2(p.call, p.options, stopped.signal)
  const deadline = Date.now() + limits.requestMs
  while (!p.trace().some(item => item.method === 'tools/call') && Date.now() < deadline) {
    await new Promise(resolve => setTimeout(resolve, 10))
  }
  assert.ok(p.trace().some(item => item.method === 'tools/call'), 'fixture must reach the call before abort')
  stopped.abort()
  const result = await running
  if (result.state !== 'failed') assert.fail('expected abort')
  assert.equal(result.errorCode, 'aborted')
  assert.equal(result.facts.toolsCallAttempted, true)
  assert.equal(result.facts.childCloseObserved, true)
  assert.equal(result.facts.cleanupConfirmed, true)
  assert.equal(p.trace().filter(item => item.method === 'tools/call').length, 1)
})

void test('a peer ignoring stdin and TERM is closed by the configured KILL phase', async (t) => {
  const p = peer(t, 'ignore-term')
  const result = await runStdioV2(p.input, p.options, new AbortController().signal)
  assert.equal(result.state, 'completed')
  assert.equal(result.facts.signal, 'SIGKILL')
  assert.equal(result.facts.childCloseObserved, true)
  assert.equal(result.facts.cleanupConfirmed, true)
})

void test('child exit with a descendant-held pipe leaves cleanup unconfirmed and publishes no catalog', async (t) => {
  const p = peer(t, 'held-pipe', { stdinGraceMs: 30, terminateGraceMs: 30, killGraceMs: 30 })
  const result = await runStdioV2(p.input, p.options, new AbortController().signal)
  if (result.state !== 'failed') assert.fail('expected unconfirmed cleanup')
  assert.equal(result.errorCode, 'cleanup_unconfirmed')
  assert.equal(result.facts.childExitObserved, true)
  assert.equal(result.facts.childCloseObserved, false)
  assert.equal(result.facts.cleanupConfirmed, false)
  assert.equal('catalog' in result, false)
})

void test('a legitimate empty directory remains empty and environment extensions refuse before spawn', async (t) => {
  const p = peer(t, 'empty')
  const empty = await runStdioV2(p.input, p.options, new AbortController().signal)
  if (empty.state !== 'completed') assert.fail('expected complete empty directory')
  assert.deepEqual(empty.catalog, [])
  const extraEnvironment = { ...p.options.env, NODE_OPTIONS: '--synthetic' }
  const unsafe = await runStdioV2(p.input, { ...p.options, env: extraEnvironment }, new AbortController().signal)
  if (unsafe.state !== 'failed') assert.fail('expected env refusal')
  assert.equal(unsafe.errorCode, 'invocation_invalid')
  assert.equal(unsafe.facts.programStartAttempted, false)
})


void test('oversized frozen expectations refuse before starting a program', async (t) => {
  const p = peer(t)
  const oversized = await runStdioV2(p.call, { ...p.options, limits: { ...limits, maxTools: 1 } },
    new AbortController().signal)
  if (oversized.state !== 'failed') assert.fail('expected expectation refusal')
  assert.equal(oversized.errorCode, 'tools_limit')
  assert.equal(oversized.facts.programStartAttempted, false)
  assert.equal(p.trace().length, 0)
})


void test('caller mutation after startup cannot change the original literal invocation, budgets or call arguments', async (t) => {
  const p = peer(t)
  const input = structuredClone(p.call)
  const running = runStdioV2(input, p.options, new AbortController().signal)
  input.rawName = 'echo'
  input.arguments.left = 99
  const first = input.catalogExpectation[0]; assert.ok(first)
  first.name = 'changed-after-start'
  p.options.limits.maxTools = 0
  p.options.env.LANG = 'changed-after-start'
  const result = await running
  if (result.state !== 'completed' || result.phase !== 'call') assert.fail('expected original call')
  assert.deepEqual(result.result.structuredContent, { sum: 8, raw: 'structured\u0000value' })
  assert.equal(p.trace()[0]?.env?.LANG, 'C.UTF-8')
  assert.deepEqual(p.trace().find(item => item.method === 'tools/call')?.params,
    { name: 'sum', arguments: { left: 3, right: 5 } })
})

void test('explicit Unix identity passes both configured IDs and snapshots them before SDK startup',
  async (t) => {
    const p = peer(t), identityFile = join(p.root, 'identity.json')
    assert(process.getuid && process.getgid)
    const uid = process.getuid(), gid = process.getgid()
    const script = `import { writeFileSync } from 'node:fs';
      writeFileSync(${JSON.stringify(identityFile)}, JSON.stringify({ uid: process.getuid(), gid: process.getgid() }));
      process.argv = [process.execPath, ${JSON.stringify(fixture)}, 'normal', ${JSON.stringify(join(p.root, 'trace.jsonl'))}];
      await import(${JSON.stringify(new URL('./stdio-v2-fixture.mjs', import.meta.url).href)});`
    p.input.argv = ['--input-type=module', '-e', script]
    p.options.identity = { kind: 'unix', uid, gid }
    const running = runStdioV2(p.input, p.options, new AbortController().signal)
    p.options.identity.uid = 4_294_967_295; p.options.identity.gid = -1
    const result = await running
    if (result.state !== 'completed') assert.fail(result.errorCode)
    assert.deepEqual(JSON.parse(readFileSync(identityFile, 'utf8')), { uid, gid })
    assert.equal(result.facts.cleanupConfirmed, true)
  })

void test('missing, extended or invalid Unix identities are rejected before any program start', async (t) => {
  for (const identity of [undefined, null, { kind: 'current', uid: 0 }, { kind: 'other' },
    { kind: 'unix', uid: 1 }, { kind: 'unix', uid: -1, gid: 1 }, { kind: 'unix', uid: 1, gid: -1 },
    { kind: 'unix', uid: 1.5, gid: 1 }, { kind: 'unix', uid: 1, gid: Number.NaN },
    { kind: 'unix', uid: 4_294_967_295, gid: 1 }, { kind: 'unix', uid: 1, gid: Number.MAX_SAFE_INTEGER },
    { kind: 'unix', uid: '1', gid: 1 }, { kind: 'unix', uid: 1, gid: 1, extra: true }]) {
    const p = peer(t); Reflect.set(p.options, 'identity', identity)
    const result = await runStdioV2(p.input, p.options, new AbortController().signal)
    if (result.state !== 'failed') assert.fail('expected identity refusal')
    assert.equal(result.errorCode, 'identity_invalid'); assert.equal(result.facts.programStartAttempted, false)
    assert.equal(result.facts.effectMayHaveOccurred, false); assert.equal(p.trace().length, 0)
  }
})
