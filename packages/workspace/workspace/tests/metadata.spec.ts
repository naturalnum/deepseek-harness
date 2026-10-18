import { afterEach, describe, expect, it, vi } from 'vitest'
import { Context } from '@deepseek-ai/cordis'
import Storage from '@deepseek-ai/dsh-storage'
import { DomainFacility } from '@deepseek-ai/dsh-storage-domain'
import { SESSION_FORMAT_VERSION, SessionId } from '@deepseek-ai/dsh-session'
import type { SessionHeader } from '@deepseek-ai/dsh-session'
import { SessionPersistenceRevision } from '@deepseek-ai/dsh-session-persistence'
import { MemoryMediaPool, MemoryStorageBackend } from '../../../storage/storage-domain/tests/helpers/memory-backend.ts'
import WorkspaceRegistry, { WorkspaceDirectoryMetadataError, WorkspaceId } from '../src/index.ts'
import type { WorkspaceDirectoryMetadata, WorkspaceRecord } from '../src/index.ts'

const root = '/workspace-metadata-native-test'
const header = (id: string, cwd = root): SessionHeader => ({
  version: SESSION_FORMAT_VERSION, id: SessionId(id), cwd, createdAt: 1, isSeeded: false,
})
const contexts: Context[] = []
afterEach(async () => {
  for (const ctx of contexts.splice(0).reverse()) await ctx.fiber.dispose()
})

function provider(canonical = root) {
  return {
    canonicalPath: vi.fn(async (_path: string) => canonical),
    isDirectory: vi.fn(async (_path: string) => true),
    ensureDirectory: vi.fn(async (_path: string): Promise<void> => {}),
  } satisfies WorkspaceDirectoryMetadata
}

interface SetupOptions {
  stored?: SessionHeader[]
  live?: SessionHeader[]
  pool?: MemoryMediaPool
  select?: () => WorkspaceDirectoryMetadata | undefined
  beforeClose?: () => Promise<void>
}

async function setup(metadata = provider(), options: SetupOptions = {}) {
  const ctx = new Context()
  contexts.push(ctx)
  const pool = options.pool ?? new MemoryMediaPool()
  await ctx.plugin(Storage)
  const backend = new MemoryStorageBackend(pool)
  if (options.beforeClose !== undefined) {
    const open = backend.kv.open.bind(backend.kv)
    const beforeClose = options.beforeClose
    backend.kv.open = async (descriptor) => {
      const unit = await open(descriptor)
      const close = unit.close.bind(unit)
      unit.close = async () => { await beforeClose(); await close() }
      return unit
    }
  }
  ctx.storage.backend.register('memory', backend)
  const facility = new DomainFacility(ctx, { backend: 'memory', routes: {} })
  ctx.storage.mount('domain', facility)
  ctx.provide('storageDomain', facility)
  let stored = options.stored ?? []
  const live = options.live ?? []
  const list = vi.fn(async () => stored.map(value => ({
    header: value, revision: SessionPersistenceRevision(`metadata-${value.id}`),
  })))
  ctx.provide('sessionPersistence', { list } as never)
  ctx.provide('sessions', {
    get: (id: SessionId) => live.find(value => value.id === id) === undefined
      ? undefined : { header: live.find(value => value.id === id)! },
    list: () => live.map(value => ({ header: value })),
  } as never)
  const selected = vi.fn(options.select ?? (() => metadata))
  class BoundRegistry extends WorkspaceRegistry {
    private readonly constructed = true
    protected override createDirectoryMetadata(): WorkspaceDirectoryMetadata | undefined {
      expect(this.constructed).toBe(true)
      return selected()
    }
  }
  const fiber = ctx.plugin(BoundRegistry)
  return {
    ctx, pool, live, selected, metadata, fiber, list,
    setStored: (values: SessionHeader[]) => { stored = values },
    registry: async () => { await fiber; return ctx.workspaceRegistry },
  }
}

function savedRecord(pool: MemoryMediaPool, id: string): WorkspaceRecord {
  return pool.media.get('workspace')!.tables.get('workspaces')!.get(id) as WorkspaceRecord
}

function seeded() {
  const pool = new MemoryMediaPool()
  const id = WorkspaceId('metadata-history')
  pool.versions.set('workspace', 2)
  pool.media.set('workspace', {
    tables: new Map([['workspaces', new Map([[id, {
      path: root, title: 'History', sessionIds: [SessionId('kept')],
      createdAt: '2026-10-18T00:00:00.000Z', updatedAt: '2026-10-18T00:00:00.000Z',
    }]])]]),
    global: { initialized: true, workspaceIds: [id], archivedSessionIds: [], pinnedSessionIds: [] },
  })
  return { pool, id }
}

describe('graph-local Workspace directory metadata', () => {
  it('routes all six native paths through the selected provider', async () => {
    const h = await setup(provider(), { stored: [header('stored')] })
    const registry = await h.registry()
    const workspace = registry.list()[0]!
    expect(workspace.sessionIds).toEqual([SessionId('stored')])
    expect(await registry.create(`${root}/alias`)).toBe(workspace)
    expect(await registry.resolveByPath(`${root}/alias`)).toBe(workspace)
    expect(await workspace.status()).toBe('ok')
    h.live.push(header('new'))
    await workspace.attachSession(SessionId('new'))
    h.setStored([header('stored'), header('later')])
    await registry.pinSession(SessionId('later'))
    expect(h.metadata.canonicalPath).toHaveBeenCalledWith(root)
    expect(h.metadata.isDirectory).toHaveBeenCalledWith(root)
    expect(h.selected).toHaveBeenCalledOnce()

    const first = await setup()
    const firstRegistry = await first.registry()
    const defaults = await Promise.all([
      firstRegistry.initializeDefault(async () => `${root}/requested`),
      firstRegistry.initializeDefault(async () => { throw new Error('must reuse the native default') }),
    ])
    expect(defaults[0]).toBe(defaults[1])
    expect(defaults[0]!.title).toBe('requested')
    expect(first.metadata.ensureDirectory).toHaveBeenCalledExactlyOnceWith(`${root}/requested`)
  })

  it('retains separate providers and captures methods before later replacement', async () => {
    const a = await setup(provider(`${root}/a`))
    const b = await setup(provider(`${root}/b`))
    const ar = await a.registry()
    const br = await b.registry()
    a.metadata.canonicalPath = vi.fn(async () => `${root}/changed`)
    expect((await ar.create(root)).path).toBe(`${root}/a`)
    expect((await br.create(root)).path).toBe(`${root}/b`)
    expect(a.metadata.canonicalPath).not.toHaveBeenCalled()
  })

  it('fails provider selection before opening or recovering the domain', async () => {
    const failure = new Error('required metadata port is not ready')
    const h = await setup(provider(), { select: () => { throw failure } })
    await expect(h.registry()).rejects.toBe(failure)
    expect(h.pool.media.has('workspace')).toBe(false)
  })

  it('rejects relative paths before invoking the provider', async () => {
    const h = await setup()
    const registry = await h.registry()
    await expect(registry.create('relative')).rejects.toThrow('fully qualified')
    await expect(registry.resolveByPath('relative')).rejects.toThrow('fully qualified')
    await expect(registry.initializeDefault(async () => 'relative')).rejects.toThrow('fully qualified')
    expect(h.metadata.canonicalPath).not.toHaveBeenCalled()
    expect(h.metadata.ensureDirectory).not.toHaveBeenCalled()
  })

  it('does not bootstrap live-only headers or perform metadata I/O after bootstrap', async () => {
    const h = await setup(provider(), { live: [header('live')] })
    const registry = await h.registry()
    expect(registry.list()).toEqual([])
    expect(h.metadata.canonicalPath).toHaveBeenCalledOnce()
    expect(h.metadata.isDirectory).toHaveBeenCalledOnce()
    expect(h.pool.media.get('workspace')!.global).toMatchObject({ initialized: true, workspaceIds: [] })
  })

  it.each(['stored', 'live'] as const)('does not commit bootstrap when %s metadata is unavailable', async (kind) => {
    const metadata = provider()
    const cause = new Error(`${kind} backend unavailable`)
    metadata.canonicalPath.mockRejectedValue(cause)
    const h = await setup(metadata, { [kind]: [header('old')] })
    await expect(h.registry()).rejects.toMatchObject({ reason: 'unavailable', cause })
    expect(h.pool.media.get('workspace')!.global).toBeNull()
    expect(h.pool.media.get('workspace')!.tables.has('workspaces')).toBe(false)
  })

  it.each(['canonicalPath', 'isDirectory', 'ensureDirectory'] as const)(
    'keeps unclassified %s failures unavailable with their original cause', async (method) => {
      const h = await setup()
      const registry = await h.registry()
      const cause = Object.assign(new Error('not a classified filesystem result'), { code: 'ENOENT' })
      h.metadata[method].mockRejectedValue(cause)
      const operation = method === 'ensureDirectory'
        ? registry.initializeDefault(async () => root) : registry.create(root)
      await expect(operation).rejects.toMatchObject({ reason: 'unavailable', cause })
      expect(registry.list()).toEqual([])
    },
  )

  it.each(['missing', 'not-directory'] as const)('status maps only declared %s to missing-dir', async (reason) => {
    const h = await setup()
    const workspace = await (await h.registry()).create(root)
    h.metadata.isDirectory.mockRejectedValue(new WorkspaceDirectoryMetadataError(reason))
    expect(await workspace.status()).toBe('missing-dir')
    expect(savedRecord(h.pool, workspace.id).path).toBe(root)
  })

  it.each([new Error('capacity'), Object.assign(new Error('denied'), { code: 'EACCES' }), null])(
    'status rejects unavailable metadata without changing the record (%s)', async (cause) => {
      const h = await setup()
      const workspace = await (await h.registry()).create(root)
      const before = structuredClone(savedRecord(h.pool, workspace.id))
      h.metadata.isDirectory.mockRejectedValue(cause)
      await expect(workspace.status()).rejects.toMatchObject({ reason: 'unavailable', cause })
      expect(savedRecord(h.pool, workspace.id)).toEqual(before)
    },
  )

  it('preserves a dedicated unavailable error and its cause', async () => {
    const h = await setup()
    const registry = await h.registry()
    const failure = new WorkspaceDirectoryMetadataError('unavailable', { cause: 'provider stopped' })
    h.metadata.canonicalPath.mockRejectedValue(failure)
    await expect(registry.create(root)).rejects.toBe(failure)
  })

  it('does not attach a new member after an unavailable check', async () => {
    const h = await setup()
    const workspace = await (await h.registry()).create(root)
    h.live.push(header('new'))
    h.metadata.canonicalPath.mockRejectedValue(new Error('stale generation'))
    await expect(workspace.attachSession(SessionId('new'))).rejects.toMatchObject({ reason: 'unavailable' })
    expect(savedRecord(h.pool, workspace.id).sessionIds).toEqual([])
  })

  it('does not prune an existing member after a later index failure', async () => {
    const state = seeded()
    const h = await setup(provider(), { pool: state.pool, stored: [header('kept')] })
    const registry = await h.registry()
    h.setStored([header('kept'), header('later')])
    h.metadata.canonicalPath.mockRejectedValue(new Error('backend unavailable'))
    await expect(registry.pinSession(SessionId('later'))).rejects.toMatchObject({ reason: 'unavailable' })
    await registry.get(state.id)!.setTitle('Still owned')
    expect(savedRecord(h.pool, state.id).sessionIds).toEqual([SessionId('kept')])
  })

  it('does not persist stored bootstrap groups before a live snapshot failure', async () => {
    const metadata = provider()
    metadata.canonicalPath.mockImplementation(async (path) => {
      if (path.endsWith('/live')) throw new Error('live metadata unavailable')
      return root
    })
    const h = await setup(metadata, { stored: [header('stored')], live: [header('live', `${root}/live`)] })
    await expect(h.registry()).rejects.toMatchObject({ reason: 'unavailable' })
    expect(h.pool.media.get('workspace')!.global).toBeNull()
    expect(h.pool.media.get('workspace')!.tables.has('workspaces')).toBe(false)
  })

  it('resolves injected live metadata before any bootstrap durability', async () => {
    const pool = new MemoryMediaPool()
    const metadata = provider()
    metadata.isDirectory.mockImplementation(async () => {
      expect(pool.media.get('workspace')!.global).toBeNull()
      return true
    })
    const h = await setup(metadata, { pool, stored: [header('stored')], live: [header('live')] })
    const registry = await h.registry()
    expect(metadata.isDirectory).toHaveBeenCalledTimes(2)
    expect(registry.list()[0]!.sessionIds).toEqual([SessionId('stored')])
  })

  it('does not classify provider ENOTDIR or TypeError as a bad native header', async () => {
    for (const cause of [Object.assign(new Error('backend'), { code: 'ENOTDIR' }), new TypeError('provider defect')]) {
      const metadata = provider()
      metadata.canonicalPath.mockRejectedValue(cause)
      const h = await setup(metadata, { stored: [header('stored')] })
      await expect(h.registry()).rejects.toMatchObject({ reason: 'unavailable', cause })
      expect(h.pool.media.get('workspace')!.global).toBeNull()
    }
  })

  it('retains native invalid-header filtering without invoking the provider', async () => {
    const h = await setup(provider(), { stored: [header('invalid', 'relative')] })
    expect((await h.registry()).list()).toEqual([])
    expect(h.metadata.canonicalPath).not.toHaveBeenCalled()
  })

  it('does not retry or register after directory creation followed by unavailable canonical metadata', async () => {
    const h = await setup()
    const registry = await h.registry()
    let created = false
    h.metadata.ensureDirectory.mockImplementation(async () => { created = true })
    h.metadata.canonicalPath.mockRejectedValue(new Error('mkdir response observation unavailable'))
    const choose = vi.fn(async () => `${root}/new`)
    await expect(registry.initializeDefault(choose)).rejects.toMatchObject({ reason: 'unavailable' })
    expect(created).toBe(true)
    expect(choose).toHaveBeenCalledOnce()
    expect(h.metadata.ensureDirectory).toHaveBeenCalledOnce()
    expect(registry.list()).toEqual([])
    expect(h.pool.media.get('workspace')!.global).not.toHaveProperty('defaultWorkspaceId')
  })

  it('keeps the native second history check after directory preparation', async () => {
    const h = await setup()
    const registry = await h.registry()
    h.metadata.ensureDirectory.mockImplementation(async () => { h.setStored([header('arrived')]) })
    expect(await registry.initializeDefault(async () => root)).toBeUndefined()
    expect(registry.list()).toEqual([])
    expect(h.metadata.ensureDirectory).toHaveBeenCalledOnce()
  })

  it('retains default deletion identity across an injected cold rebuild', async () => {
    const h = await setup()
    const registry = await h.registry()
    const workspace = (await registry.initializeDefault(async () => root))!
    await registry.delete(workspace.id)
    await h.ctx.fiber.dispose()
    const next = await setup(provider(), { pool: h.pool })
    expect(await (await next.registry()).initializeDefault(async () => root)).toBeUndefined()
    expect(next.metadata.ensureDirectory).not.toHaveBeenCalled()
    expect(next.pool.media.get('workspace')!.global).toHaveProperty('defaultWorkspaceId', workspace.id)
  })

  it.each(['missing', 'not-directory'] as const)('keeps the native %s membership distinction', async (reason) => {
    const state = seeded()
    const metadata = provider()
    metadata.canonicalPath.mockRejectedValue(new WorkspaceDirectoryMetadataError(reason))
    const h = await setup(metadata, { pool: state.pool, stored: [header('kept')] })
    const workspace = (await h.registry()).get(state.id)!
    expect(workspace.sessionIds).toEqual(reason === 'missing' ? [SessionId('kept')] : [])
  })

  it('rejects status after graph closure without invoking the provider', async () => {
    const h = await setup()
    const workspace = await (await h.registry()).create(root)
    h.metadata.isDirectory.mockClear()
    await h.ctx.fiber.dispose()
    await expect(workspace.status()).rejects.toMatchObject({ reason: 'unavailable' })
    expect(h.metadata.isDirectory).not.toHaveBeenCalled()
  })

  it('closes metadata admission while domain close is still pending', async () => {
    const closing = Promise.withResolvers<undefined>()
    const release = Promise.withResolvers<undefined>()
    const h = await setup(provider(), { beforeClose: async () => {
      closing.resolve(undefined)
      await release.promise
    } })
    const registry = await h.registry()
    const workspace = await registry.create(root)
    h.metadata.canonicalPath.mockClear()
    h.metadata.isDirectory.mockClear()
    const disposal = h.ctx.fiber.dispose()
    await closing.promise
    try {
      await expect(workspace.status()).rejects.toMatchObject({ reason: 'unavailable' })
      await expect(registry.create(root)).rejects.toMatchObject({ reason: 'unavailable' })
      expect(h.metadata.canonicalPath).not.toHaveBeenCalled()
      expect(h.metadata.isDirectory).not.toHaveBeenCalled()
    } finally {
      release.resolve(undefined)
      await disposal
    }
  })

  it('cannot advance bootstrap when disposal begins during init metadata I/O', async () => {
    const entered = Promise.withResolvers<undefined>()
    const release = Promise.withResolvers<string>()
    const metadata = provider()
    metadata.canonicalPath.mockImplementation(async () => {
      entered.resolve(undefined)
      return await release.promise
    })
    const h = await setup(metadata, { stored: [header('stored')] })
    const initialized = h.registry().then(value => ({ value }), (error: unknown) => ({ error }))
    await entered.promise
    const disposal = h.ctx.fiber.dispose()
    await expect.poll(() => h.fiber.uid).toBeNull()
    expect(h.ctx.get('workspaceRegistry')).toBeUndefined()
    release.resolve(root)
    expect(await initialized).toMatchObject({ error: { reason: 'unavailable' } })
    await disposal
    expect(h.pool.media.get('workspace')!.global).toBeNull()
    expect(h.metadata.isDirectory).not.toHaveBeenCalled()
  })

  it.each(['canonicalPath', 'isDirectory', 'ensureDirectory'] as const)(
    'rejects a late %s result after graph closure', async (method) => {
      const h = await setup()
      const registry = await h.registry()
      let finish!: () => void
      const entered = Promise.withResolvers<undefined>()
      h.metadata[method].mockImplementation(async () => {
        entered.resolve(undefined)
        await new Promise<void>((resolve) => { finish = resolve })
        if (method === 'canonicalPath') return root as never
        if (method === 'isDirectory') return true as never
        return undefined as never
      })
      const operation = method === 'ensureDirectory'
        ? registry.initializeDefault(async () => root) : registry.create(root)
      const observed = operation.then(value => ({ value }), (error: unknown) => ({ error }))
      await entered.promise
      await h.ctx.fiber.dispose()
      finish()
      expect(await observed).toMatchObject({ error: { reason: 'unavailable' } })
      expect(h.metadata.ensureDirectory.mock.calls.length).toBe(method === 'ensureDirectory' ? 1 : 0)
    },
  )
})
