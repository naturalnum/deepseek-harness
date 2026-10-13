/** Trusted synthetic MCP peer; every file path is supplied by the owning source test. */
import { appendFileSync } from 'node:fs'
import { spawn } from 'node:child_process'
import { createInterface } from 'node:readline'
import { fileURLToPath } from 'node:url'

/** Complete synthetic descriptors used as the test-only frozen catalog expectation.
 * @type {import('../src/stdio-v2.ts').StdioV2Tool[]}
 */
export const catalog = [
  { name: 'sum', title: 'Two parameters', description: 'Synthetic sum',
    inputSchema: { type: 'object', properties: { left: { type: 'number' }, right: { type: 'number' } },
      required: ['left', 'right'], additionalProperties: false, 'x-raw': { text: 'schema\u0000value' } },
    outputSchema: { type: 'object', properties: { sum: { type: 'number' } }, required: ['sum'] },
    annotations: { readOnlyHint: true, 'x-annotation': { value: 'kept' } },
    _meta: { 'qa/source': { text: 'meta\u0000value' } }, 'x-extension': { full: [true, null, 7] } },
  { name: 'echo', inputSchema: { type: 'object', properties: { text: { type: 'string' } }, required: ['text'] },
    annotations: { readOnlyHint: false }, _meta: { 'qa/page': 2 }, 'x-extension': ['second'] },
]

function serve() {
  const [mode, record, ...literalArgs] = process.argv.slice(2)
  const trace = value => appendFileSync(record, JSON.stringify(value) + '\n', { mode: 0o600 })
  if (mode === 'pipe-holder') {
    trace({ event: 'pipe-holder', pid: process.pid })
    setTimeout(() => { process.exitCode = 0 }, 5000)
    return
  }
  trace({ event: 'spawn', pid: process.pid, argv: literalArgs,
    coverageDirectory: process.env.NODE_V8_COVERAGE,
    envKeys: Object.keys(process.env).sort(), env: { HOME: process.env.HOME, PATH: process.env.PATH, LANG: process.env.LANG } })
  const lines = createInterface({ input: process.stdin })
  if (mode === 'held-pipe') {
    const holder = spawn(process.execPath, [fileURLToPath(import.meta.url), 'pipe-holder', record], {
      cwd: process.cwd(), env: { ...process.env }, stdio: ['ignore', process.stdout, process.stderr],
    })
    // Record ownership before the descendant's Node startup or trace write can be delayed.
    trace({ event: 'pipe-holder-spawn', pid: holder.pid })
    holder.unref()
  }
  const reply = (id, result) => process.stdout.write(JSON.stringify({ jsonrpc: '2.0', id, result }) + '\n')
  lines.on('line', (text) => {
    const message = JSON.parse(text)
    trace({ event: 'request', method: message.method, params: message.params })
    if (message.method === 'initialize') {
      if (mode === 'initialize-lost') return
      reply(message.id, { protocolVersion: mode === 'unsupported' ? '1999-01-01' : message.params.protocolVersion,
        capabilities: { tools: {} }, serverInfo: { name: 'synthetic-stdio-v2', version: '1.0.0' },
        _meta: { 'qa/initialize': 'preserved' } })
    } else if (message.method === 'tools/list') {
      if (mode === 'list-lost') return
      if (mode === 'malformed') { process.stdout.write('not JSON\n'); return }
      if (mode === 'invalid-rpc') { process.stdout.write('{"jsonrpc":"2.0","result":42,"id":1}\n'); return }
      if (mode === 'invalid-utf8') { process.stdout.write(Buffer.from([0xff, 0x0a])); return }
      if (mode === 'protocol-flood') { process.stdout.write(' '.repeat(20000)); return }
      if (mode === 'stderr-flood') process.stderr.write('E'.repeat(20000))
      if (mode === 'empty') { reply(message.id, { tools: [], _meta: { 'qa/empty': true } }); return }
      const page = message.params?.cursor === 'second' ? 1 : 0
      const tool = mode === 'duplicate' && page === 1 ? catalog[0] : mode === 'changed' && page === 1
        ? { ...catalog[page], 'x-extension': ['changed'] } : catalog[page]
      if (mode === 'json-deep') {
        let nested = { text: 'leaf' }
        for (let index = 0; index < 30; index++) nested = { nested }
        reply(message.id, { tools: [{ ...tool, 'x-deep': nested }] })
        return
      }
      const result = { tools: [tool], _meta: { 'qa/page': page + 1 }, 'x-page': { full: true } }
      if (page === 0 || mode === 'cursor-loop') result.nextCursor = 'second'
      reply(message.id, result)
      if (mode === 'trailing-partial' && page === 1) process.stdout.write('incomplete')
    } else if (message.method === 'tools/call') {
      if (mode === 'call-lost') return
      const sum = message.params.arguments.left + message.params.arguments.right
      const structuredContent = message.params.name === 'echo'
        ? { echo: message.params.arguments.text } : { sum, raw: 'structured\u0000value' }
      reply(message.id, { content: [{ type: 'text', text: mode === 'result-flood' ? 'R'.repeat(20000) : `sum:${sum}\u0000`,
        _meta: { 'qa/content': true }, 'x-content': ['preserved'] }],
      structuredContent, isError: mode === 'tool-error',
      _meta: { 'qa/result': { full: true } }, 'x-result': { full: ['preserved', null] } })
    }
  })
  if (mode === 'ignore-term') {
    process.on('SIGTERM', () => { trace({ event: 'sigterm' }) })
    setInterval(() => {}, 1000)
  } else lines.on('close', () => {
    if (mode === 'shutdown-malformed') process.stdout.write('not JSON\n')
    process.exitCode = 0
  })
}

if (process.argv[1] === fileURLToPath(import.meta.url)) serve()
