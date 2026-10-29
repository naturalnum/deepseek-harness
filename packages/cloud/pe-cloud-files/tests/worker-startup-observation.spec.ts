/** Original start/catch fault injection and separate real Worker error/exit checks; neither supplies native readiness. */
import { readFileSync, mkdtempSync, mkdirSync, writeFileSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { runInNewContext } from 'node:vm'
import { Worker } from 'node:worker_threads'
import ts from 'typescript'
import { afterEach, expect, it, vi } from 'vitest'
import { FdWorkerClient } from '../src/worker-client.ts'
import { observeFileWorkerFailure } from '../src/worker-startup-observation.ts'
import type { FileWorkerStartupStage } from '../src/worker-startup-observation.ts'

afterEach(() => { vi.restoreAllMocks() })

const source = ts.createSourceFile('file-worker.ts', readFileSync(new URL('../src/file-worker.ts', import.meta.url), 'utf8'), ts.ScriptTarget.Latest, true)
const selected = source.statements.filter(node => (ts.isFunctionDeclaration(node)
  && ['record', 'failure', 'start'].includes(node.name?.text ?? '')) || ts.isClassDeclaration(node) && node.name?.text === 'WorkerFailure')
if (selected.length !== 4) throw new Error('Original worker startup declarations required')
const program = ts.transpileModule(selected.map(node => node.getText(source)).join('\n'), {
  compilerOptions: { target: ts.ScriptTarget.ES2024, module: ts.ModuleKind.ESNext }, reportDiagnostics: true,
})
if (program.diagnostics?.length) throw new Error('Original worker startup declarations must compile')

function failStartup(stage: FileWorkerStartupStage, error: Error) {
  const port = { postMessage: vi.fn(), close: vi.fn() }
  const limits = { helperPath: '/PRIVATE_HELPER.node', maxPathBytes: 4096, storageProbe: {}, content: {},
    staging: { helperPath: '/PRIVATE_STAGING.node' } }
  const step = (name: FileWorkerStartupStage, value: object): object => {
    if (name === stage) throw error
    return value
  }
  runInNewContext(program.outputText + '\nstart();', {
    parentPort: port, workerData: {}, observeFileWorkerFailure,
    input: () => step('input', limits), createStorageWorker: () => step('storage-initialize', {}),
    helper: () => step('fd-helper-load', { abiVersion: 8, probeKernel: () => step('kernel-probe', {}) }),
    loadStagingNative: () => step('staging-helper-load', {}),
  })
  return port
}

it.each([
  ['input', 'EINVAL', 'FS_IO_ERROR'], ['storage-initialize', 'ENOSYS', 'FS_IO_ERROR'],
  ['fd-helper-load', 'ERR_DLOPEN_FAILED', 'FS_IO_ERROR'], ['kernel-probe', 'EPERM', 'FS_PERMISSION_DENIED'],
  ['staging-helper-load', 'EIO', 'FS_IO_ERROR'],
] as const)('observes %s while preserving the actual startup-failed mapping and port closure', (stage, code, wireCode) => {
  const stderr = vi.spyOn(console, 'warn').mockImplementation(() => {})
  const error = Object.assign(new Error('PRIVATE_MESSAGE /PRIVATE_PATH'), { code })
  const port = failStartup(stage, error)
  expect(stderr).toHaveBeenCalledExactlyOnceWith('Cloud files worker failure: %j', { stage, code })
  expect(port.postMessage).toHaveBeenCalledExactlyOnceWith({ kind: 'startup-failed', code: wireCode, syscallCode: code })
  expect(port.close).toHaveBeenCalledExactlyOnceWith()
  expect(JSON.stringify(stderr.mock.calls)).not.toContain('PRIVATE_')
})

it('still sends the original startup failure and closes its port when stderr throws', () => {
  vi.spyOn(console, 'warn').mockImplementation(() => { throw new Error('PRIVATE_LOGGER') })
  const port = failStartup('kernel-probe', Object.assign(new Error('PRIVATE_ERROR'), { code: 'EPERM' }))
  expect(port.postMessage).toHaveBeenCalledExactlyOnceWith({ kind: 'startup-failed', code: 'FS_PERMISSION_DENIED', syscallCode: 'EPERM' })
  expect(port.close).toHaveBeenCalledExactlyOnceWith()
})

it.each(['PRIVATE_CODE', 'x'.repeat(4096), 'EIO\nPRIVATE', 'accessor', 'inherited', 'proxy'])('logs only a fixed unknown code for %s', (kind) => {
  const stderr = vi.spyOn(console, 'warn').mockImplementation(() => {}), forbidden = vi.fn(() => 'PRIVATE_ACCESSOR')
  let error: object = { code: kind }
  if (kind === 'accessor') Object.defineProperty(error, 'code', { get: forbidden })
  if (kind === 'inherited') error = Object.create({ code: 'EIO' }) as object
  if (kind === 'proxy') error = new Proxy({}, { getOwnPropertyDescriptor() { throw new Error('PRIVATE_PROXY') } })
  Object.defineProperty(error, 'message', { get: forbidden })
  Object.defineProperty(error, 'stack', { get: forbidden })
  observeFileWorkerFailure('fd-helper-load', error)
  expect(stderr).toHaveBeenCalledExactlyOnceWith('Cloud files worker failure: %j', { stage: 'fd-helper-load', code: 'unclassified' })
  expect(forbidden).not.toHaveBeenCalled()
  expect(JSON.stringify(stderr.mock.calls)).not.toContain('PRIVATE_')
})

it.each([false, true])('keeps real missing-module Worker failure and exit1 when the diagnostic sink throws=%s', async (brokenSink) => {
  const stderr = vi.spyOn(console, 'warn').mockImplementation(() => { if (brokenSink) throw new Error('PRIVATE_SINK') })
  const worker = new Worker('void import("file:///PRIVATE_WORKER_IMPORT/never.mjs")', { eval: true })
  const terminate = vi.spyOn(worker, 'terminate'), client = new FdWorkerClient(worker)
  try {
    await expect(client.ready).rejects.toMatchObject({ code: 'FS_IO_ERROR' })
    expect(await client.exited).toBe(1)
    expect(await client.close()).toBe(1)
    expect(client.available).toBe(false)
    expect(terminate).toHaveBeenCalledTimes(1)
    expect(stderr).toHaveBeenCalledExactlyOnceWith('Cloud files worker failure: %j', expect.objectContaining({
      stage: 'worker-thread-error', code: 'ERR_MODULE_NOT_FOUND', name: 'Error', sites: expect.any(Array) as unknown,
    }))
    expect(JSON.stringify(stderr.mock.calls)).not.toContain('PRIVATE_')
  } finally { await client.close(); await client.exited }
})

it.each([
  ['const = 1', 'SyntaxError'], ['throw new TypeError("PRIVATE_TYPE_MESSAGE")', 'TypeError'],
] as const)('preserves real syntactic Worker failure %s and reports only its standard type', async (source, name) => {
  const stderr = vi.spyOn(console, 'warn').mockImplementation(() => {})
  const worker = new Worker(source, { eval: true }), client = new FdWorkerClient(worker)
  try {
    await expect(client.ready).rejects.toMatchObject({ code: 'FS_IO_ERROR' })
    expect(await client.exited).toBe(1)
    expect(stderr).toHaveBeenCalledExactlyOnceWith('Cloud files worker failure: %j', expect.objectContaining({
      stage: 'worker-thread-error', code: 'unclassified', name, sites: expect.any(Array) as unknown,
    }))
    expect(JSON.stringify(stderr.mock.calls)).not.toContain('PRIVATE_')
  } finally { await client.close(); await client.exited }
})

it('identifies an actual missing public named export without logging its raw SyntaxError', async () => {
  const directory = mkdtempSync(join(tmpdir(), 'files-worker-export-')), stderr = vi.spyOn(console, 'warn').mockImplementation(() => {})
  const entry = join(directory, 'packages/cloud/pe-cloud-files/lib/file-worker.mjs')
  const dependency = join(directory, 'node_modules/@deepseek-ai/dsh-fs')
  mkdirSync(join(directory, 'packages/cloud/pe-cloud-files/lib'), { recursive: true })
  mkdirSync(dependency, { recursive: true })
  writeFileSync(join(dependency, 'package.json'), '{"type":"module","exports":"./index.mjs"}')
  writeFileSync(join(dependency, 'index.mjs'), 'export const other = 1')
  writeFileSync(entry, 'import { FsVersion } from "@deepseek-ai/dsh-fs"; export { FsVersion }')
  const worker = new Worker(entry), client = new FdWorkerClient(worker)
  try {
    await expect(client.ready).rejects.toMatchObject({ code: 'FS_IO_ERROR' })
    expect(await client.exited).toBe(1)
    expect(stderr).toHaveBeenCalledExactlyOnceWith('Cloud files worker failure: %j', expect.objectContaining({
      stage: 'worker-thread-error', name: 'SyntaxError', code: 'unclassified',
      namedExport: { specifier: '@deepseek-ai/dsh-fs', identifier: 'FsVersion' },
      sites: expect.arrayContaining([
        expect.stringMatching(/^packages\/cloud\/pe-cloud-files\/lib\/file-worker\.mjs:1(?::[0-9]+)?$/) as unknown,
      ]) as unknown,
    }))
    expect(JSON.stringify(stderr.mock.calls)).not.toContain(directory)
  } finally { await client.close(); await client.exited; rmSync(directory, { recursive: true, force: true }) }
})

it('retains bounded public positions and common Node codes while excluding unknown files and raw text', () => {
  const stderr = vi.spyOn(console, 'warn').mockImplementation(() => {})
  const frame = '\n at loader (file:///opt/dsh-installed-products/packages/cloud/pe-cloud-files/lib/worker-client-Ab_cdE12.js:40:9)'
  observeFileWorkerFailure('worker-thread-error', { name: 'TypeError', code: 'ERR_INVALID_ARG_TYPE',
    message: 'PRIVATE_MESSAGE', stack: 'PRIVATE_STACK\n at /PRIVATE_PATH/secret.js:1:2' + frame.repeat(10) })
  expect(stderr).toHaveBeenCalledExactlyOnceWith('Cloud files worker failure: %j', {
    stage: 'worker-thread-error', code: 'ERR_INVALID_ARG_TYPE', name: 'TypeError',
    sites: Array(6).fill('packages/cloud/pe-cloud-files/lib/worker-client*.js:40:9'),
  })
  expect(JSON.stringify(stderr.mock.calls)).not.toContain('PRIVATE_')
})

it('never invokes error accessors and excludes oversized own stacks and nonpublic named exports', () => {
  const stderr = vi.spyOn(console, 'warn').mockImplementation(() => {}), getter = vi.fn(() => 'PRIVATE_GETTER')
  const error = {}
  for (const key of ['name', 'message', 'stack', 'code']) Object.defineProperty(error, key, { get: getter })
  observeFileWorkerFailure('worker-thread-error', error)
  observeFileWorkerFailure('worker-thread-error', { name: 'SyntaxError', stack: 'x'.repeat(16385),
    message: "The requested module 'PRIVATE_MODULE' does not provide an export named 'PRIVATE_TOKEN'" })
  expect(getter).not.toHaveBeenCalled()
  expect(stderr.mock.calls.map((call): unknown => call[1])).toEqual([
    { stage: 'worker-thread-error', code: 'unclassified', name: 'Error', sites: [] },
    { stage: 'worker-thread-error', code: 'unclassified', name: 'SyntaxError', sites: [] },
  ])
  expect(JSON.stringify(stderr.mock.calls)).not.toContain('PRIVATE_')
})
