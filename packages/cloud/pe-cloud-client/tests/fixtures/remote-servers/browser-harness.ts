/** Explicit finite loopback browser harness; consumes only a caller-owned fresh PostgreSQL configuration. */
import { readFileSync, writeFileSync } from 'node:fs'
import { build } from 'vite'
import paths from 'vite-tsconfig-paths'
import { z } from 'zod'
import { remoteAcceptanceServer } from '../../../../pe-cloud-access/tests/fixtures/remote-servers/server.ts'

if (process.env.PE_REMOTE_BROWSER_ACCEPTANCE !== '1') throw new Error('Explicit browser acceptance opt-in required')
const duration = Number(process.env.PE_REMOTE_BROWSER_DURATION_MS)
if (!Number.isSafeInteger(duration) || duration < 10000 || duration > 3600000) throw new Error('Finite browser duration required')
const input = z.object({ host: z.string(), port: z.number(), user: z.string(), password: z.string(),
  databases: z.object({ access: z.string() }) })
  .parse(JSON.parse(readFileSync(process.env.PE_ACCESS_POSTGRES_CONFIG ?? '', 'utf8')))
const bundle = await build({ configFile: false, plugins: [paths()], root: import.meta.dirname,
  oxc: { jsx: { runtime: 'automatic' } }, build: { write: false, minify: false,
    rolldownOptions: { input: new URL('./browser.client.tsx', import.meta.url).pathname,
      output: { entryFileNames: 'browser.js', assetFileNames: '[name][extname]' } } } })
const outputs = Array.isArray(bundle) ? bundle.flatMap(row => row.output) : 'output' in bundle ? bundle.output : []
const assets = new Map(outputs.map(row => ['/' + row.fileName,
  { type: row.fileName.endsWith('.css') ? 'text/css' : 'text/javascript',
    body: row.type === 'chunk' ? row.code : Buffer.from(row.source) }]))
const css = outputs.filter(row => row.fileName.endsWith('.css')).map(row => `<link rel="stylesheet" href="/${row.fileName}">`).join('')
assets.set('/', { type: 'text/html',
  body: '<!doctype html><html lang="zh"><meta charset="utf-8"><meta name="viewport" content="width=device-width,initial-scale=1">'
  + '<title>Servers acceptance</title>' + css + '<style>body{margin:0;background:#fafafa;font-family:Arial,sans-serif}#root{max-width:1000px;margin:auto}</style>'
  + '<div id="root"></div><script type="module" src="/browser.js"></script></html>' })
const server = await remoteAcceptanceServer({ host: input.host, port: input.port, user: input.user, password: input.password,
  database: input.databases.access }, path => assets.get(path))
const report = process.env.PE_REMOTE_BROWSER_REPORT
if (report === undefined) throw new Error('Owned browser report path required')
writeFileSync(report, JSON.stringify({ url: server.url, status: 'running', productionRootQualification: false }) + '\n')
console.info('Remote browser acceptance ready at ' + server.url)
let closing: Promise<void> | undefined
const close = (): Promise<void> => closing ??= server.close().then(() => {
  writeFileSync(report, JSON.stringify({ url: server.url, status: 'closed', cleanupConfirmed: true,
    productionRootQualification: false }) + '\n')
})
const timer = setTimeout(() => { void close() }, duration)
process.once('SIGINT', () => { clearTimeout(timer); void close() }); process.once('SIGTERM', () => { clearTimeout(timer); void close() })
