/** Owned MCP process used by current source Worker service flows; no provider or model request. */
import { appendFileSync } from 'node:fs'
import { createHash } from 'node:crypto'
import { createInterface } from 'node:readline'

const [mode, trace] = process.argv.slice(2)
const record = value => appendFileSync(trace, JSON.stringify(value) + '\n', { mode: 0o600 })
const captureDirectory = process.env.NODE_V8_COVERAGE
record({ event: 'spawn', pid: process.pid, uid: process.getuid(), envKeys: Object.keys(process.env).sort(),
  nativeCaptureDirectoryHash: captureDirectory === undefined ? undefined
    : createHash('sha256').update(captureDirectory).digest('hex') })
const lines = createInterface({ input: process.stdin })
const catalog = [{ name: 'echo_note', description: 'Owned echo', inputSchema: { type: 'object',
  properties: { message: { type: 'string' } }, required: ['message'], additionalProperties: false },
_meta: { retained: 'literal\0😀' } }]
const reply = (id, result) => process.stdout.write(JSON.stringify({ jsonrpc: '2.0', id, result }) + '\n')
lines.on('line', (text) => {
  const message = JSON.parse(text)
  record({ event: 'request', method: message.method })
  if (message.method === 'initialize') reply(message.id, { protocolVersion: message.params.protocolVersion,
    capabilities: { tools: {} }, serverInfo: { name: 'owned-current-worker-peer', version: '1' } })
  else if (message.method === 'tools/list' && mode !== 'hold') reply(message.id, { tools: catalog })
  else if (message.method === 'tools/call' && mode !== 'hold') reply(message.id,
    { content: [{ type: 'text', text: message.params.arguments.message }], isError: false })
})
lines.on('close', () => { record({ event: 'stdin-close' }); process.exitCode = 0 })
process.on('SIGTERM', () => { record({ event: 'sigterm' }); lines.close() })
