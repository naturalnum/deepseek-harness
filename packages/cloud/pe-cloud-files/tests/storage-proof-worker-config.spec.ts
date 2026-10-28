/** Real workerData -> production parser -> production proof read/hash path; OS/native facts are test-only stand-ins. */
import { Worker } from 'node:worker_threads'
import { createHash } from 'node:crypto'
import { copyFile, mkdtemp, readFile, readdir, rm, writeFile } from 'node:fs/promises'
import { resolve } from 'node:path'
import { fileURLToPath } from 'node:url'
import ts from 'typescript'
import { afterAll, beforeAll, expect, it, onTestFinished } from 'vitest'
import { FdWorkerClient } from '../src/worker-client.ts'
import type { FdWorkerInput } from '../src/worker-protocol.ts'
import type { StaticStorageConfig } from '../src/storage-types.ts'

let directory: string
const here = fileURLToPath(new URL('.', import.meta.url))
const repository = resolve(here, '../../../..'), proof = new TextEncoder().encode('{"exact":"worker proof fixture"}')
const hash = (bytes: Uint8Array) => createHash('sha256').update(bytes).digest('hex')
let input: FdWorkerInput & { storageProbe: StaticStorageConfig }
beforeAll(async () => {
  const published = resolve(here, '../lib/types')
  directory = await mkdtemp(resolve(published, 'proof-worker-config-'))
  for (const entry of await readdir(published, { withFileTypes: true })) {
    if (entry.isFile() && entry.name.endsWith('.js')) await copyFile(resolve(published, entry.name), resolve(directory, entry.name))
  }
  const config = ts.getParsedCommandLineOfConfigFile(resolve(repository, 'packages/cloud/pe-cloud-files/tsconfig.json'), {}, {
    ...ts.sys, onUnRecoverableConfigFileDiagnostic: (diagnostic) => {
      throw new Error(ts.flattenDiagnosticMessageText(diagnostic.messageText, '\n'))
    },
  })
  if (config === undefined) throw new Error('Original files compiler face required')
  for (const name of ['file-worker', 'worker-startup-observation']) {
    const emitted = ts.transpileModule(await readFile(resolve(here, `../src/${name}.ts`), 'utf8'), {
      fileName: resolve(here, `../src/${name}.ts`), compilerOptions: { ...config.options, composite: false, incremental: false,
        declaration: false, declarationMap: false, sourceMap: false }, reportDiagnostics: true,
    })
    expect(emitted.diagnostics ?? []).toHaveLength(0)
    await writeFile(resolve(directory, `${name}.js`), emitted.outputText)
  }
  const helperPath = resolve(directory, 'file-helper.node'), probeHelperPath = resolve(directory, 'probe.cjs')
  await copyFile(resolve(here, 'fixtures/proof-config-file-helper.cjs'), helperPath)
  await copyFile(resolve(here, 'fixtures/proof-config-native.cjs'), probeHelperPath)
  const plan = new TextEncoder().encode('{"plan":"fixture"}')
  await writeFile(resolve(directory, 'plan.json'), plan, { mode: 0o600 })
  await writeFile(resolve(directory, 'proof.json'), proof, { mode: 0o600 })
  const probeModule = new Uint8Array(await readFile(probeHelperPath))
  input = { helperPath, maxReadBytes: 2048, maxPathBytes: 4096, maxResolveRetries: 1, readChunkBytes: 64,
    content: { maxEntries: 16, maxNameBytes: 255, maxReplyBytes: 4096, operationTimeoutMs: 1000 },
    storageProbe: { planPath: resolve(directory, 'plan.json'), planSha256: hash(plan), probeHelperPath,
      probeHelperSha256: hash(probeModule), maxProbeAssetBytes: 16384, maxPlanBytes: 2048, maxMountInfoBytes: 1024,
      rootProbeReservationBytes: 2_000_000, probeTimeoutMs: 1000 } }
})
afterAll(async () => { if (directory !== undefined) await rm(directory, { recursive: true, force: true }) })
function start(selected: unknown = { proofPath: resolve(directory, 'proof.json'), proofSha256: hash(proof) }, includeProof = true) {
  const reads = new SharedArrayBuffer(8)
  const worker = new Worker(new URL('./fixtures/proof-config-worker.mjs', import.meta.url), { workerData: {
    ...input, storageProbe: { ...input.storageProbe, ...includeProof ? { skillRevalidation: selected } : {} },
    fixture: { root: directory, entry: resolve(directory, 'file-worker.js'), planPath: input.storageProbe.planPath,
      proofPath: resolve(directory, 'proof.json'), reads },
  } })
  const client = new FdWorkerClient(worker)
  onTestFinished(async () => { await client.close(); await client.exited; await worker.terminate() })
  return { client, reads: new Int32Array(reads) }
}
it('retains the fixed proof across real workerData decoding and reads its exact protected selector and hash', async () => {
  const f = start()
  await f.client.ready
  expect(new TextDecoder().decode(await f.client.storageRecord(2048, new AbortController().signal))).toBe('{"plan":"fixture"}')
  const result = await f.client.storageSkillProof(2048, new AbortController().signal)
  expect(result.bytes).toEqual(proof)
  expect(result.process).toEqual({ pid: process.pid, startTicks: '12345' })
  expect(Array.from(f.reads)).toEqual([1, 1])
})
it('retains ordinary storage without proof but refuses a proof read instead of falling back', async () => {
  const f = start(undefined, false)
  await f.client.ready
  expect(await f.client.storageRecord(2048, new AbortController().signal)).toHaveLength(18)
  await expect(f.client.storageSkillProof(2048, new AbortController().signal)).rejects.toMatchObject({ code: 'FS_IO_ERROR' })
  await f.client.exited
  expect(Array.from(f.reads)).toEqual([1, 0])
})
it('refuses a mismatched fixed proof hash after an actual bounded read', async () => {
  const f = start({ proofPath: resolve(directory, 'proof.json'), proofSha256: '0'.repeat(64) })
  await f.client.ready
  await expect(f.client.storageSkillProof(2048, new AbortController().signal)).rejects.toMatchObject({ code: 'FS_IO_ERROR' })
  await f.client.exited
  expect(Array.from(f.reads)).toEqual([0, 1])
})
it.each([null, { proofPath: '/fixture' }, { proofPath: '/fixture', proofSha256: '0'.repeat(64), approved: true }])(
  'refuses an incomplete or expanded optional proof object during worker startup', async (selected) => {
    const f = start(selected)
    await expect(f.client.ready).rejects.toMatchObject({ code: 'FS_IO_ERROR' })
    expect(Array.from(f.reads)).toEqual([0, 0])
  })
