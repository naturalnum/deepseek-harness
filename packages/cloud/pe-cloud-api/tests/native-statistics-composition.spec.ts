/** Native statistics composition: durable provider samples reach the original client projection values. */
import { mkdirSync, mkdtempSync, realpathSync, rmSync, writeFileSync, readFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { FiberState, type Context } from '@deepseek-ai/cordis'
import { boot, initProfile, type ProfileContext } from '@deepseek-ai/dsh-app-boot'
import Sessions, { SessionId, SessionSeq, type SessionEvent } from '@deepseek-ai/dsh-session'
import Projections from '@deepseek-ai/dsh-session-projection'
import TokenMeter from '@deepseek-ai/dsh-token-meter'
import * as SessionStats from '@deepseek-ai/dsh-session-stats'
import { createMessage, type AssistantStreamRecord } from '@deepseek-ai/dsh-llm'
import { expect, it, onTestFinished } from 'vitest'

async function fixture() {
  const home = realpathSync(mkdtempSync(join(tmpdir(), 'cloud-native-statistics-'))), dir = join(home, 'profile')
  let context: Context | undefined
  onTestFinished(async () => {
    try { await context?.fiber.dispose() } finally { rmSync(home, { recursive: true, force: true }) }
  })
  mkdirSync(dir); initProfile(dir, [])
  writeFileSync(join(home, 'package.json'), '{"name":"cloud-native-statistics-fixture","private":true}\n')
  const profile: ProfileContext = { name: 'statistics', dir, home, cwd: home, patchPath: join(dir, 'cordis.patch.yml'),
    installAnchor: join(home, 'package.json'), startedBundles: [], overlays: [], telemetryDisabledEnv: undefined }
  const configPath = join(dir, 'cordis.yml')
  writeFileSync(configPath, readFileSync(new URL('./fixtures/native-ui/statistics.cordis.yml', import.meta.url)))
  const ctx = await boot('cloud-native-statistics', configPath, [], (scope) => {
    context = scope
    scope.provide('profileContext', profile)
    Object.assign(scope.loader.builtins, { 'statistics-sessions': Sessions, 'statistics-projections': Projections,
      'statistics-token-meter': TokenMeter, 'statistics-session-stats': SessionStats })
  })
  for (const row of ctx.loader.entries()) expect(row.fiber?.state, row.options.id).toBe(FiberState.ACTIVE)
  return ctx
}

const sampleUsage = { inputTokens: 100, cacheReadTokens: 900, cacheWriteTokens: 0, outputTokens: 25 }
const sampleStream: readonly AssistantStreamRecord[] = [
  { type: 'text-chunks', time0: 1200, index: 0, dt: [0, 200], texts: ['hello', ' world'] },
  { type: 'chunk', time: 1800, chunk: { type: 'usage', usage: sampleUsage } },
  { type: 'chunk', time: 1900, chunk: { type: 'finish', reason: { kind: 'stop' } } },
]

function sampleSeed(): SessionEvent[] {
  return [
    { seq: SessionSeq(0), time: 900, type: 'request/context', data: { provider: 'fixture', model: 'small', contextWindow: 4000 } },
    { seq: SessionSeq(1), time: 1000, type: 'turn/start', data: { turn: 1 } },
    { seq: SessionSeq(2), time: 1100, type: 'step/start', data: { turn: 1, step: 1 } },
    { seq: SessionSeq(3), time: 1900, type: 'assistant/message', surfaceOp: 'append', data: {
      turn: 1, step: 1, stream: [...sampleStream], usage: sampleUsage,
      message: createMessage({ role: 'assistant', content: [{ type: 'text', text: 'hello world' }],
        source: { kind: 'model', provider: 'fixture', model: 'small' } }),
    } },
    { seq: SessionSeq(4), time: 2000, type: 'step/end', data: { turn: 1, step: 1 } },
    { seq: SessionSeq(5), time: 2100, type: 'turn/end', data: { turn: 1, reason: { kind: 'completed' } } },
  ]
}

it('registers all native usage, context and timing values in the account graph', async () => {
  const ctx = await fixture()
  const session = ctx.sessions.create(SessionId('native-statistics'), { seed: sampleSeed() })
  const snapshot = ctx.sessionProjections.snapshot(session)
  expect(snapshot.values.tokenUsage).toEqual({ uncachedInputTokens: 100, cacheReadTokens: 900, cacheWriteTokens: 0, outputTokens: 25 })
  expect(snapshot.values.contextPressure).toMatchObject({ contextWindow: 4000, pressureTokens: 1000 })
  expect(snapshot.values.contextBreakdown).toBeDefined()
  expect(snapshot.values.sessionStats).toEqual({ turns: 1, steps: 1, llmMs: 800, toolMs: 0,
    ttftMs: 100, ttftSteps: 1, decodeMs: 700, decodeTokens: 25 })
  // The client consumes these native views directly: no cloud-only token/timing computation is installed.
  const wire: unknown = JSON.parse(JSON.stringify(snapshot))
  expect(wire).toEqual(snapshot)
})

it('keeps accounts isolated even when the same Session id exists in both graphs', async () => {
  const [a, b] = await Promise.all([fixture(), fixture()])
  const first = a.sessions.create(SessionId('same-id'), { seed: sampleSeed() })
  const second = b.sessions.create(SessionId('same-id'))
  expect(a.sessionProjections.snapshot(first).values.tokenUsage?.outputTokens).toBe(25)
  expect(b.sessionProjections.snapshot(second).values.tokenUsage?.outputTokens).toBe(0)
  first.append('turn/start', { turn: 2 })
  expect(b.sessionProjections.snapshot(second).values.sessionStats).toMatchObject({ turns: 0, steps: 0 })
})

it('withdraws native statistic registrations with their Loader fibers', async () => {
  const template = new URL('./fixtures/native-ui/statistics.cordis.yml', import.meta.url), original = readFileSync(template)
  const ctx = await fixture(), session = ctx.sessions.create(SessionId('disposal'), { seed: sampleSeed() })
  const fibers = [...ctx.loader.entries()].filter(row => ['token-meter', 'session-stats'].includes(row.options.id ?? ''))
  expect(fibers).toHaveLength(2)
  for (const row of fibers) await row.fiber?.dispose()
  const snapshot = ctx.sessionProjections.snapshot(session)
  expect(snapshot.values.tokenUsage).toBeUndefined()
  expect(snapshot.values.contextPressure).toBeUndefined()
  expect(snapshot.values.contextBreakdown).toBeUndefined()
  expect(snapshot.values.sessionStats).toBeUndefined()
  expect(readFileSync(template)).toEqual(original)
})
