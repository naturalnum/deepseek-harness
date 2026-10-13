/** Actual Platform download methods with explicit account/binding/query and file-byte substitutes; no live PG or storage. */
import { createRequire } from 'node:module'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { mkdtemp, rm } from 'node:fs/promises'
import { expect, test, vi, type MockInstance } from 'vitest'
import { z } from 'zod'
import { brandString } from '@deepseek-ai/dsh-brand'
import type { UserId } from '@power-evolve/contracts/account'
import type { DownloadSessionId } from '@power-evolve/contracts/file-download'
import { FileDownloadService } from '../../application/src/platform/file-downloads.ts'
import { FileService } from '../../application/src/platform/files.ts'
import { transaction } from '../../application/src/platform/database.ts'

const sessionId = brandString<DownloadSessionId>('10000000-0000-4000-8000-000000000001')
const workspaceId = '20000000-0000-4000-8000-000000000002'
const user = { userId: brandString<UserId>('30000000-0000-4000-8000-000000000003'), username: 'employee1-fixture' }
const path = 'docs/报告.txt'
const request = { sessionId, paths: [path] as [string] }
// Independently recorded digest of the fixture's binding and complete selected bytes, not obtained from the service.
const expectedRevision = '092409dc39e816402a5e94e9065d104a7f37bbf2ebf6ac5cc93aabc55817c5f7'
type ConsumerPool = ConstructorParameters<typeof FileDownloadService>[0]
type ConsumerClient = Parameters<Parameters<typeof transaction>[1]>[0]
const pg: unknown = createRequire(new URL('../../application/package.json', import.meta.url))('pg')
const constructors = z.object({ Pool: z.custom<new () => ConsumerPool>(value => typeof value === 'function'),
  Client: z.custom<new () => ConsumerClient>(value => typeof value === 'function') }).parse(pg)

async function fixture(run: (f: {
  service: FileDownloadService
  read: MockInstance<FileService['readBytesInWorkspace']>
  queries: string[]
  setBytes: (bytes: Buffer) => void
  setGeneration: (generation: number) => void
}) => Promise<void>): Promise<void> {
  const root = await mkdtemp(join(tmpdir(), 'employee1-download-platform-'))
  const pool = new constructors.Pool()
  try {
    let bytes: Buffer = Buffer.from('data')
    let generation = 1
    const queries: string[] = []
    const query = async (sql: string) => {
      queries.push(sql)
      const answer = (rows: unknown[]) => ({ rows, rowCount: rows.length })
      if (['BEGIN', 'COMMIT', 'ROLLBACK'].includes(sql)) return answer([])
      if (sql.includes('FROM pe_users')) return answer([{ userId: user.userId, username: user.username, displayName: 'Fixture',
        role: 'USER', enabled: true, revision: 1, credentialVersion: 1, passwordChangeRequired: false, deletedAt: null }])
      if (sql.includes('FROM pe_sessions s')) return answer([{ workspace_id: workspaceId, binding_generation: String(generation),
        binding_state: 'ready' }])
      throw new Error('Unmodelled SQL: ' + sql)
    }
    const client = new constructors.Client()
    Object.defineProperty(client, 'query', { value: query })
    Object.defineProperty(client, 'release', { value: vi.fn() })
    Object.defineProperty(pool, 'connect', { value: async () => client })
    const files = new FileService(pool, root)
    const read = vi.spyOn(files, 'readBytesInWorkspace').mockImplementation(async () => bytes)
    const service = new FileDownloadService(pool, files, { maxFiles: 1, maxTotalBytes: 1024,
      maxConcurrentTransfers: 1, maxUserConcurrentTransfers: 1, transferTimeoutMs: 1000 })
    await run({ service, read, queries, setBytes: (value) => { bytes = value }, setGeneration: (value) => { generation = value } })
  } finally { await pool.end(); await rm(root, { recursive: true, force: true }) }
}

async function received(body: ReadableStream<Uint8Array>): Promise<Buffer> {
  return Buffer.from(await new Response(body).arrayBuffer())
}

test('actual prepare and open bind exact selected path, binding generation and independently recorded digest', () => fixture(async (f) => {
  const signal = new AbortController().signal
  const prepared = await f.service.prepare(user, request, signal)
  expect(prepared).toEqual({ sessionId, workspaceId, revision: expectedRevision,
    downloadUrl: '/api/powerEvolve/workspace-download?sessionId=' + sessionId
      + '&paths=%5B%22docs%2F%E6%8A%A5%E5%91%8A.txt%22%5D&revision=' + expectedRevision,
    fileName: '报告.txt', contentType: 'application/octet-stream', fileCount: 1, sourceBytes: 4, totalBytes: 4 })
  const opened = await f.service.open(user, { ...request, revision: expectedRevision }, signal)
  expect(opened.view).toEqual(prepared)
  expect(await received(opened.body)).toEqual(Buffer.from('data'))
  expect(f.read).toHaveBeenCalledTimes(3)
  expect(f.read.mock.calls.every(([owner, workspace, selected, lifetime, generation]) =>
    owner === user && workspace === workspaceId && selected === path && lifetime instanceof AbortSignal && generation === 1)).toBe(true)
  expect(f.queries.some(sql => /^(?:UPDATE|INSERT|DELETE)/u.test(sql))).toBe(false)
}))

test('actual Platform accepts an empty file and emits a complete empty stream', () => fixture(async (f) => {
  f.setBytes(Buffer.alloc(0))
  const signal = new AbortController().signal
  const prepared = await f.service.prepare(user, request, signal)
  expect(prepared).toMatchObject({ sourceBytes: 0, totalBytes: 0, fileCount: 1 })
  const opened = await f.service.open(user, { ...request, revision: prepared.revision }, signal)
  expect(await received(opened.body)).toEqual(Buffer.alloc(0))
  expect(f.read).toHaveBeenCalledTimes(3)
}))

for (const [name, paths, status] of [['zero files', [], 400], ['two files', ['a', 'b'], 413],
  ['absolute path', ['/etc/passwd'], 400], ['traversal', ['a/../b'], 400], ['drive path', ['C:a'], 400],
  ['backslash', ['a\\b'], 400], ['empty segment', ['a//b'], 400], ['NFC violation', ['e\u0301'], 400],
  ['surrogate', ['\ud800'], 400], ['control', ['a\u0000'], 400]] as const) {
  test('actual prepare/open reject ' + name + ' before authority, file reads or transfer admission', () => fixture(async (f) => {
    const signal = new AbortController().signal
    // Malformed external wire deliberately crosses each public method's runtime validation boundary.
    const prepareCall = f.service.prepare.bind(f.service)
    const prepareResult: unknown = Reflect.apply(prepareCall, undefined, [user, { sessionId, paths }, signal])
    await expect(Promise.resolve(prepareResult)).rejects.toMatchObject({ status })
    const openCall = f.service.open.bind(f.service)
    const openResult: unknown = Reflect.apply(openCall, undefined, [user, { sessionId, paths, revision: expectedRevision }, signal])
    await expect(Promise.resolve(openResult)).rejects.toMatchObject({ status })
    expect(f.queries).toEqual([]); expect(f.read).not.toHaveBeenCalled()
    // Rejection did not consume the only transfer slot.
    expect(await f.service.prepare(user, request, signal)).toMatchObject({ revision: expectedRevision })
  }))
}

for (const change of ['bytes', 'selection', 'binding', 'revision'] as const) {
  test('actual open rejects changed ' + change + ' without opening a stream or writing storage', () => fixture(async (f) => {
    const signal = new AbortController().signal
    await f.service.prepare(user, request, signal)
    if (change === 'bytes') f.setBytes(Buffer.from('changed'))
    if (change === 'binding') f.setGeneration(2)
    const selected = change === 'selection' ? { ...request, paths: ['else/报告.txt'] as [string] } : request
    await expect(f.service.open(user, { ...selected, revision: change === 'revision' ? 'f'.repeat(64) : expectedRevision }, signal))
      .rejects.toMatchObject({ status: 409, code: 'download_changed' })
    expect(f.read).toHaveBeenCalledTimes(2)
    expect(f.queries.some(sql => /^(?:UPDATE|INSERT|DELETE)/u.test(sql))).toBe(false)
  }))
}

test('changed bytes after open are rejected before the first stream chunk', () => fixture(async (f) => {
  const opened = await f.service.open(user, { ...request, revision: expectedRevision }, new AbortController().signal)
  f.setBytes(Buffer.from('different bytes'))
  const reader = opened.body.getReader()
  try {
    await expect(reader.read()).rejects.toMatchObject({ status: 409, code: 'download_changed' })
    expect(f.read).toHaveBeenCalledTimes(2)
  } finally { reader.releaseLock() }
}))
