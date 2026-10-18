/** Source-plane NATIVE Loader/JSONL evidence only; this provider is Node-backed, not cloud files. */
import { existsSync, mkdirSync, mkdtempSync, readFileSync, readdirSync, realpathSync, rmSync, writeFileSync } from 'node:fs'
import { mkdir, realpath, stat, symlink } from 'node:fs/promises'
import { join } from 'node:path'
import { tmpdir } from 'node:os'
import { Context, FiberState } from '@deepseek-ai/cordis'
import { boot } from '@deepseek-ai/dsh-app-boot'
import SessionStore, { SessionId } from '@deepseek-ai/dsh-session'
import Storage from '@deepseek-ai/dsh-storage'
import * as JsonStorage from '@deepseek-ai/dsh-storage-json'
import * as DomainStorage from '@deepseek-ai/dsh-storage-domain'
import * as Jsonl from '@deepseek-ai/dsh-session-persistence-jsonl'
import WorkspaceRegistry, { WorkspaceDirectoryMetadataError, workspaceDomainSpec, type WorkspaceDirectoryMetadata, type WorkspaceDomainState } from '@deepseek-ai/dsh-workspace'
import { expect, it, onTestFinished } from 'vitest'

type MetadataOperation = 'canonicalPath' | 'isDirectory' | 'ensureDirectory'
type Mode = 'node-default' | 'injected-node-test'

/** Explicit Node-backed test dependency; it implements no cloud authorization, worker budget or ready capability. */
function nodeMetadata() {
  const calls: Array<{ operation: MetadataOperation; path: string }> = []
  let canonicalFailure: unknown
  let canonicalGate: (() => Promise<void>) | undefined
  const observed = async <T>(operation: MetadataOperation, path: string, invoke: () => Promise<T>): Promise<T> => {
    calls.push({ operation, path })
    try { return await invoke() }
    catch (error) {
      if (error instanceof Error && 'code' in error && error.code === 'ENOENT') {
        throw new WorkspaceDirectoryMetadataError('missing', { cause: error })
      }
      if (error instanceof Error && 'code' in error && error.code === 'ENOTDIR') {
        throw new WorkspaceDirectoryMetadataError('not-directory', { cause: error })
      }
      throw new WorkspaceDirectoryMetadataError('unavailable', { cause: error })
    }
  }
  const provider: WorkspaceDirectoryMetadata = {
    async canonicalPath(path) {
      // Deliberately unclassified provider failures must be classified by the real native facade.
      if (canonicalFailure !== undefined) {
        calls.push({ operation: 'canonicalPath', path })
        throw canonicalFailure
      }
      const result = await observed('canonicalPath', path, () => realpath(path))
      await canonicalGate?.()
      return result
    },
    isDirectory: path => observed('isDirectory', path, async () => (await stat(path)).isDirectory()),
    ensureDirectory: path => observed('ensureDirectory', path, async () => { await mkdir(path, { recursive: true }) }),
  }
  return { provider, calls,
    failCanonical(error: unknown) { canonicalFailure = error },
    gateCanonical(gate: () => Promise<void>) { canonicalGate = gate },
  }
}

/** All business services are original native implementations mounted by a real config tree. */
function fixture(label: string) {
  const home = realpathSync(mkdtempSync(join(tmpdir(), 'm7-workspace-loader-')))
  const project = join(home, 'same-project-name')
  const storageRoot = join(home, 'private-storage')
  const sessionsRoot = join(home, 'private-sessions')
  mkdirSync(project)
  let generation = 0
  const roots: Context[] = []
  onTestFinished(async () => {
    try { for (const ctx of roots) await ctx.fiber.dispose() }
    finally { rmSync(home, { recursive: true, force: true }) }
  })
  const start = async (options: { mode?: Mode; registry?: boolean; canonicalFailure?: unknown } = {}) => {
    const mode = options.mode ?? 'injected-node-test'
    const metadata = nodeMetadata()
    if (options.canonicalFailure !== undefined) metadata.failCanonical(options.canonicalFailure)
    let selections = 0
    class BoundRegistry extends WorkspaceRegistry {
      static override inject = [...WorkspaceRegistry.inject, 'sessions']
      private readonly constructedProvider = metadata.provider
      protected override createDirectoryMetadata(): WorkspaceDirectoryMetadata {
        expect(this.constructedProvider).toBe(metadata.provider)
        selections++
        return this.constructedProvider
      }
    }
    const Registry = mode === 'node-default' ? WorkspaceRegistry : BoundRegistry
    const config = join(home, `cordis-${++generation}.yml`)
    const rows = [
      { id: 'sessions', name: 'cordis:m7-sessions' },
      { id: 'storage', name: 'cordis:m7-storage' },
      { id: 'json-storage', name: 'cordis:m7-json-storage', config: { root: storageRoot } },
      { id: 'domain', name: 'cordis:m7-domain', config: { backend: 'json' } },
      { id: 'jsonl', name: 'cordis:m7-jsonl', config: { root: sessionsRoot, compression: 'none' } },
      ...options.registry === false ? [] : [{ id: 'workspace', name: 'cordis:m7-workspace' }],
    ]
    writeFileSync(config, JSON.stringify(rows))
    const ctx = await boot('m7-native-workspace-' + label, config, [], (root) => {
      roots.push(root)
      Object.assign(root.loader.builtins, {
        'm7-sessions': SessionStore, 'm7-storage': Storage, 'm7-json-storage': JsonStorage,
        'm7-domain': DomainStorage, 'm7-jsonl': Jsonl, 'm7-workspace': Registry,
      })
    })
    const entry = [...ctx.loader.entries()].find(row => row.options.id === 'workspace')
    return { ctx, entry, metadata, selections: () => selections,
      registry(): WorkspaceRegistry {
        const registry = ctx.get('workspaceRegistry')
        if (registry === undefined) throw new Error('fixture Workspace service is absent')
        return registry
      },
      close: () => ctx.fiber.dispose(),
    }
  }
  return { home, project, storageRoot, sessionsRoot, start }
}

/** Real public native persistence path; no Session/Workspace surrogate and no model turn. */
async function persistSession(ctx: Context, id: SessionId, cwd: string): Promise<void> {
  const prepared = ctx.sessions.prepare(id, { meta: { cwd } })
  const handle = await ctx.sessionPersistence.create(prepared.header)
  try {
    // The original barrier materializes an empty Session header; no model or synthetic turn is needed.
    await handle.flush()
  } finally { await handle.close() }
  await ctx.sessionPersistence.flush()
}

function snapshot(root: string): Record<string, string> {
  if (!existsSync(root)) return {}
  return Object.fromEntries(readdirSync(root, { recursive: true, withFileTypes: true })
    .filter(entry => entry.isFile()).map(entry => [join(entry.parentPath, entry.name).slice(root.length), readFileSync(join(entry.parentPath, entry.name), 'utf8')]))
}

async function domainState(test: ReturnType<typeof fixture>) {
  const graph = await test.start({ registry: false })
  const domain = await graph.ctx.storageDomain.open(workspaceDomainSpec)
  try {
    const global: WorkspaceDomainState = domain.global.get()
    return { global, records: [...domain.table('workspaces').entries()] }
  }
  finally {
    await domain.close()
    await graph.close()
  }
}

function nativeOnly(ctx: Context): void {
  expect(ctx.get('llm')).toBeUndefined()
  expect(ctx.get('agents')).toBeUndefined()
  expect(ctx.get('peFilesPool')).toBeUndefined()
  expect(ctx.get('peAccountRuntime')).toBeUndefined()
}

it('keeps A/B native Loader graphs, aliases, new attach, status and cold Workspace membership independent', async () => {
  const a = fixture('A')
  const b = fixture('B')
  const [ga, gb] = await Promise.all([a.start(), b.start()])
  expect(ga.ctx.root).toBe(ga.ctx)
  expect(gb.ctx.root).toBe(gb.ctx)
  expect(ga.ctx).not.toBe(gb.ctx)
  expect(ga.registry()).not.toBe(gb.registry())
  nativeOnly(ga.ctx)
  nativeOnly(gb.ctx)
  expect(ga.entry?.fiber?.state).toBe(FiberState.ACTIVE)
  expect(gb.entry?.fiber?.state).toBe(FiberState.ACTIVE)
  expect(ga.selections()).toBe(1)
  expect(gb.selections()).toBe(1)
  const aliasA = join(a.home, 'project-alias')
  const aliasB = join(b.home, 'project-alias')
  await Promise.all([symlink(a.project, aliasA), symlink(b.project, aliasB)])
  const [wa, wb] = await Promise.all([ga.registry().create(a.project, 'same-title'), gb.registry().create(b.project, 'same-title')])
  expect(wa.path).toBe(a.project)
  expect(wb.path).toBe(b.project)
  expect(wa.title).toBe('same-title')
  expect(wb.title).toBe('same-title')
  expect((await ga.registry().create(aliasA, 'ignored')).id).toBe(wa.id)
  expect((await gb.registry().resolveByPath(aliasB))?.id).toBe(wb.id)
  const id = SessionId('same-native-session-id')
  await Promise.all([persistSession(ga.ctx, id, a.project), persistSession(gb.ctx, id, b.project)])
  await Promise.all([wa.attachSession(id), wb.attachSession(id)])
  expect(wa.sessionIds).toEqual([id])
  expect(wb.sessionIds).toEqual([id])
  expect(await wa.status()).toBe('ok')
  expect(await wb.status()).toBe('ok')
  const beforeA = snapshot(a.storageRoot)
  const beforeB = snapshot(b.storageRoot)
  expect(JSON.stringify(beforeA)).not.toContain(b.project)
  expect(JSON.stringify(beforeB)).not.toContain(a.project)
  expect(ga.metadata.calls.every(call => call.path.startsWith(a.home + '/'))).toBe(true)
  expect(gb.metadata.calls.every(call => call.path.startsWith(b.home + '/'))).toBe(true)
  await Promise.all([ga.close(), gb.close()])
  const [coldA, coldB] = await Promise.all([a.start(), b.start()])
  const restoredA = coldA.registry().get(wa.id)
  const restoredB = coldB.registry().get(wb.id)
  expect(restoredA?.sessionIds).toEqual([id])
  expect(restoredB?.sessionIds).toEqual([id])
  expect(restoredA?.path).toBe(a.project)
  expect(restoredB?.path).toBe(b.project)
  expect(restoredA?.title).toBe('same-title')
  expect(restoredB?.title).toBe('same-title')
  expect(await coldA.registry().resolveByPath(aliasA)).toBe(restoredA)
  expect(await coldB.registry().resolveByPath(aliasB)).toBe(restoredB)
  expect(coldA.metadata.calls.some(call => call.operation === 'canonicalPath' && call.path === a.project)).toBe(true)
  expect(coldB.metadata.calls.some(call => call.operation === 'canonicalPath' && call.path === b.project)).toBe(true)
  expect(coldA.selections()).toBe(1)
  expect(coldB.selections()).toBe(1)
  expect(snapshot(a.storageRoot)).toEqual(beforeA)
  expect(snapshot(b.storageRoot)).toEqual(beforeB)
})

it.each<Mode>(['node-default', 'injected-node-test'])('preserves default identity, history and deletion rules through real storage restart (%s)', async (mode) => {
  const test = fixture(mode)
  const graph = await test.start({ mode })
  const requested = join(test.home, 'nested', 'NativeDefault')
  const [first, repeated] = await Promise.all([
    graph.registry().initializeDefault(async () => requested),
    graph.registry().initializeDefault(async () => { throw new Error('second resolver must not run') }),
  ])
  expect(first).toBeDefined()
  expect(repeated?.id).toBe(first?.id)
  expect(first?.title).toBe('NativeDefault')
  const id = SessionId('real-default-history')
  await persistSession(graph.ctx, id, requested)
  await first!.attachSession(id)
  await graph.close()
  const cold = await test.start({ mode })
  const restored = cold.registry().get(first!.id)
  expect(restored?.sessionIds).toEqual([id])
  expect((await cold.registry().initializeDefault(async () => { throw new Error('existing default must not resolve again') }))?.id).toBe(first!.id)
  if (mode === 'injected-node-test') expect(graph.metadata.calls.some(call => call.operation === 'ensureDirectory')).toBe(true)
  else expect(graph.selections()).toBe(0)
  await cold.registry().delete(first!.id)
  await cold.close()
  const deleted = await test.start({ mode })
  expect(deleted.registry().list()).toEqual([])
  expect(await deleted.registry().initializeDefault(async () => { throw new Error('deleted default must not be recreated') })).toBeUndefined()
})

it('propagates unclassified ENOENT-like startup failure as unavailable without initialized/default/member corruption', async () => {
  const test = fixture('startup-failure')
  const id = SessionId('stored-before-registry')
  const seed = await test.start({ registry: false })
  await persistSession(seed.ctx, id, test.project)
  await seed.close()
  const jsonlBefore = snapshot(test.sessionsRoot)
  const uninitializedBefore = snapshot(test.storageRoot)
  const failure = Object.assign(new Error('provider unavailable, not determinate missing'), { code: 'ENOENT' })
  const failed = await test.start({ canonicalFailure: failure })
  expect(failed.entry?.fiber?.state).toBe(FiberState.FAILED)
  await expect(failed.entry!.fiber!.await()).rejects.toMatchObject({
    reason: 'unavailable', cause: failure,
  })
  try { await failed.entry!.fiber!.await() } catch (error) {
    expect(error).toBeInstanceOf(WorkspaceDirectoryMetadataError)
    if (!(error instanceof WorkspaceDirectoryMetadataError)) throw error
    expect(error.cause).toBe(failure)
  }
  await failed.close()
  const state = await domainState(test)
  expect(state.global.initialized).toBe(false)
  expect(state.global.defaultWorkspaceId).toBeUndefined()
  expect(state.global.workspaceIds).toEqual([])
  expect(state.records).toEqual([])
  expect(snapshot(test.sessionsRoot)).toEqual(jsonlBefore)
  // A read-only domain open need not write any file; the prior real JSONL flush remains durable.
  expect(snapshot(test.storageRoot)).toEqual(uninitializedBefore)
  const recovered = await test.start()
  expect(recovered.entry?.fiber?.state).toBe(FiberState.ACTIVE)
  const workspace = recovered.registry().list()[0]
  expect(workspace?.path).toBe(test.project)
  expect(workspace?.sessionIds).toEqual([id])
  await recovered.close()
  const initializedBefore = snapshot(test.storageRoot)
  const failedAgain = await test.start({ canonicalFailure: failure })
  expect(failedAgain.entry?.fiber?.state).toBe(FiberState.FAILED)
  await expect(failedAgain.entry!.fiber!.await()).rejects.toMatchObject({ reason: 'unavailable' })
  await failedAgain.close()
  expect(snapshot(test.storageRoot)).toEqual(initializedBefore)

  const existing = fixture('existing-default-failure')
  const initialized = await existing.start()
  const workspaceDefault = await initialized.registry().initializeDefault(async () => existing.project)
  expect(workspaceDefault).toBeDefined()
  await persistSession(initialized.ctx, id, existing.project)
  await workspaceDefault!.attachSession(id)
  await initialized.close()
  const defaultBefore = snapshot(existing.storageRoot)
  const defaultFailure = await existing.start({ canonicalFailure: failure })
  expect(defaultFailure.entry?.fiber?.state).toBe(FiberState.FAILED)
  await expect(defaultFailure.entry!.fiber!.await()).rejects.toMatchObject({ reason: 'unavailable' })
  await defaultFailure.close()
  expect(snapshot(existing.storageRoot)).toEqual(defaultBefore)
  const kept = await domainState(existing)
  expect(kept.global.initialized).toBe(true)
  expect(kept.global.defaultWorkspaceId).toBe(workspaceDefault!.id)
  expect(kept.records[0]?.[1].sessionIds).toEqual([id])
})

it('rejects a late canonical result and old Entity use after the actual Registry fiber closes', async () => {
  const test = fixture('late')
  const graph = await test.start()
  const workspace = await graph.registry().create(test.project)
  const before = snapshot(test.storageRoot)
  const entered = Promise.withResolvers<undefined>()
  const release = Promise.withResolvers<undefined>()
  graph.metadata.gateCanonical(async () => {
    entered.resolve(undefined)
    await release.promise
  })
  const pending = graph.registry().resolveByPath(test.project)
  const rejection = expect(pending).rejects.toMatchObject({ reason: 'unavailable' })
  onTestFinished(async () => {
    release.resolve(undefined)
    await Promise.allSettled([pending])
  })
  await entered.promise
  await graph.entry!.fiber!.dispose()
  release.resolve(undefined)
  await rejection
  const calls = graph.metadata.calls.length
  await expect(workspace.status()).rejects.toBeInstanceOf(WorkspaceDirectoryMetadataError)
  expect(graph.metadata.calls).toHaveLength(calls)
  expect(snapshot(test.storageRoot)).toEqual(before)
})
