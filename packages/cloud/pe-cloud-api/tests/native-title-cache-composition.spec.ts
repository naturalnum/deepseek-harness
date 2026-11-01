/** Account-owned native cache composition; no model, kernel, quota or Target authority. */
import { mkdtempSync, mkdirSync, realpathSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { type Context, FiberState } from '@deepseek-ai/cordis'
import { boot, initProfile, type ProfileContext } from '@deepseek-ai/dsh-app-boot'
import { mountAgentLoopTestDependencies } from '@deepseek-ai/dsh-agent-loop-testkit'
import AgentLoop from '@deepseek-ai/dsh-agent-loop'
import { SessionId } from '@deepseek-ai/dsh-session'
import Title from '@deepseek-ai/dsh-session-title'
import Cache from '@deepseek-ai/dsh-session-projection-cache'
import Storage from '@deepseek-ai/dsh-storage'
import * as StorageJson from '@deepseek-ai/dsh-storage-json'
import * as StorageDomain from '@deepseek-ai/dsh-storage-domain'
import * as Jsonl from '@deepseek-ai/dsh-session-persistence-jsonl'
import { expect, it, onTestFinished, vi } from 'vitest'

function fixture() {
  const home = realpathSync(mkdtempSync(join(tmpdir(), 'cloud-title-cache-')))
  const dir = join(home, 'profile'), contexts: Context[] = []
  onTestFinished(async () => {
    try { for (const ctx of contexts.reverse()) await ctx.fiber.dispose() }
    finally { rmSync(home, { recursive: true, force: true }) }
  })
  mkdirSync(dir); initProfile(dir, [])
  writeFileSync(join(home, 'package.json'), '{"name":"cloud-title-cache-fixture","private":true}\n')
  const profile: ProfileContext = { name: 'cache', dir, home, cwd: home,
    patchPath: join(dir, 'cordis.patch.yml'), installAnchor: join(home, 'package.json'),
    startedBundles: [], overlays: [], telemetryDisabledEnv: undefined }
  const start = async (cache: boolean) => {
    const configPath = join(dir, 'cordis.yml')
    writeFileSync(configPath, JSON.stringify([
      { id: 'dependencies', name: 'cordis:cache-dependencies' },
      { id: 'storage', name: 'cordis:cache-storage' },
      { id: 'storage-json', name: 'cordis:cache-storage-json', config: { root: join(home, 'storage') } },
      { id: 'storage-domain', name: 'cordis:cache-storage-domain', config: { backend: 'json' } },
      { id: 'jsonl', name: 'cordis:cache-jsonl', config: { root: join(home, 'sessions'), compression: 'none' } },
      { id: 'title', name: 'cordis:cache-title', config: { fallbackMaxWords: 12, fallbackMaxBytes: 256, maxTitleBytes: 512 } },
      { id: 'session-projection-cache', name: 'cordis:cache-checkpoints', disabled: !cache,
        config: { writeEveryEvents: 200, writeIntervalMs: 5000 } },
      { id: 'agent-loop', name: 'cordis:cache-loop', config: { agents: [] } },
    ]) + '\n')
    const ctx = await boot('cloud-title-cache', configPath, [], (scope) => {
      contexts.push(scope)
      scope.provide('profileContext', profile)
      Object.assign(scope.loader.builtins, {
        'cache-dependencies': { async apply(owner: Context) { await mountAgentLoopTestDependencies(owner) } },
        'cache-storage': Storage, 'cache-storage-json': StorageJson, 'cache-storage-domain': StorageDomain,
        'cache-jsonl': Jsonl, 'cache-title': Title, 'cache-checkpoints': Cache, 'cache-loop': AgentLoop,
      })
    })
    for (const entry of ctx.loader.entries()) {
      if (entry.options.disabled !== true) expect(entry.fiber?.state, entry.options.id).toBe(FiberState.ACTIVE)
    }
    return ctx
  }
  const createOldTitle = async (title: string) => {
    const ctx = await start(false), id = SessionId('same-original-session')
    const handle = await ctx.agents.create({ sessionId: id, meta: { cwd: home } })
    try {
      ctx.sessionTitle.rename(handle.agent.session, title)
      expect(await ctx.sessions.flush(handle.agent.session)).toBe(true)
    } finally { await handle.dispose() }
    expect(ctx.get('sessionProjectionCache')).toBeUndefined()
    await ctx.fiber.dispose()
    return id
  }
  return { start, createOldTitle }
}

it('uses native resume and durable checkpoints to retain an old title through a cold account restart', async () => {
  const f = fixture(), id = await f.createOldTitle('Original durable title'), first = await f.start(true)
  const before = (await first.sessionPersistence.list()).find(row => row.header.id === id)
  expect(before).toBeDefined()
  if (before === undefined) throw new Error('Original native Session header is absent')
  expect(first.sessionProjectionCache.cachedSnapshot(before.header)).toBeUndefined()
  const handle = await first.agents.resume({ resumeSessionId: id })
  try {
    await vi.waitFor(() => {
      expect(first.sessionProjectionCache.cachedSnapshot(handle.agent.session.header)?.values.title).toBe('Original durable title')
    }, { timeout: 2000 })
  } finally { await handle.dispose() }
  await first.fiber.dispose()
  const second = await f.start(true), open = vi.spyOn(second.sessionPersistence, 'open')
  const stored = (await second.sessionPersistence.list()).find(row => row.header.id === id)
  if (stored === undefined) throw new Error('Original native Session header is absent after restart')
  expect(second.sessionProjectionCache.cachedSnapshot(stored.header)?.values.title).toBe('Original durable title')
  expect(open).not.toHaveBeenCalled()
  expect(second.sessions.get(id)).toBeUndefined()
  expect(second.sessionProjectionCache.cachedSnapshot({ ...stored.header, cwd: '/unrelated-account' })).toBeUndefined()
}, 15000)

it('keeps the same Session id bound to each account native storage domain', async () => {
  const a = fixture(), b = fixture()
  const id = await a.createOldTitle('Account A title')
  expect(await b.createOldTitle('Account B title')).toBe(id)
  const left = await a.start(true), right = await b.start(true)
  const first = await left.agents.resume({ resumeSessionId: id })
  const second = await right.agents.resume({ resumeSessionId: id })
  try {
    await vi.waitFor(() => {
      expect(left.sessionProjectionCache.cachedSnapshot(first.agent.session.header)?.values.title).toBe('Account A title')
      expect(right.sessionProjectionCache.cachedSnapshot(second.agent.session.header)?.values.title).toBe('Account B title')
    }, { timeout: 2000 })
  } finally { await first.dispose(); await second.dispose() }
  await left.fiber.dispose(); await right.fiber.dispose()
  const coldLeft = await a.start(true), coldRight = await b.start(true)
  const leftHeader = (await coldLeft.sessionPersistence.list()).find(row => row.header.id === id)?.header
  const rightHeader = (await coldRight.sessionPersistence.list()).find(row => row.header.id === id)?.header
  if (leftHeader === undefined || rightHeader === undefined) throw new Error('An account native Session header is absent')
  expect(coldLeft.sessionProjectionCache.cachedSnapshot(leftHeader)?.values.title).toBe('Account A title')
  expect(coldRight.sessionProjectionCache.cachedSnapshot(rightHeader)?.values.title).toBe('Account B title')
  expect(coldLeft.sessionProjectionCache.cachedSnapshot(rightHeader)).toBeUndefined()
  expect(coldRight.sessionProjectionCache.cachedSnapshot(leftHeader)).toBeUndefined()
}, 15000)
