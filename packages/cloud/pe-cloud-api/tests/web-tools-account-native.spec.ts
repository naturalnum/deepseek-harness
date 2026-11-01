/** Actual C06 AccountCredentials and native web tool/provider calls; only provider HTTP is stubbed. */
import { afterEach, expect, it, vi } from 'vitest'
import { Context } from '@deepseek-ai/cordis'
import { ToolCallId } from '@deepseek-ai/dsh-llm'
import { DSH_LAUNCH_ENVIRONMENT_KEY, createLaunchEnvironmentSnapshot } from '@deepseek-ai/dsh-launch-environment'
import { AccountModelKeyEnvironment } from '../src/model-key.ts'
import { credentialRef } from '@deepseek-ai/dsh-credentials'
import Web from '@deepseek-ai/dsh-web'
import * as Messages from '@deepseek-ai/dsh-web-search-deepseek'
import * as Api from '@deepseek-ai/dsh-web-deepseek-api'
import * as ToolWeb from '@deepseek-ai/dsh-tool-web'
import * as Timeout from '@deepseek-ai/dsh-tool-call-timeout-policy'
import { localeFixture } from './locale-field-fixture.ts'

const fields = [
  { namespace: 'web', field: 'searchProvider', values: ['deepseek-official', 'deepseek-search-api'] },
  { namespace: 'web', field: 'fetchProvider', values: ['http', 'deepseek-fetch-api'] },
  { namespace: 'web-search-deepseek', field: 'baseURL', values: ['https://api.deepseek.com/anthropic/v1'] },
  { namespace: 'web-search-deepseek', field: 'maxUses' },
  { namespace: 'web-deepseek-api', field: 'baseURL', values: ['https://api.deepseek.com/v1/tools'] },
  { namespace: 'web-deepseek-api', field: 'count' },
]
afterEach(() => vi.unstubAllGlobals())
function transport() {
  const seen: { url: string; key: string | null }[] = []
  vi.stubGlobal('fetch', vi.fn(async (url: string, init: RequestInit) => {
    const endpoint = url
    if (!['https://api.deepseek.com/anthropic/v1/messages', 'https://api.deepseek.com/v1/tools/search', 'https://api.deepseek.com/v1/tools/fetch'].includes(endpoint)) throw Error('unexpected endpoint')
    seen.push({ url: endpoint, key: new Headers(init.headers).get('authorization') })
    const body = endpoint.endsWith('/messages') ? { content: [{ type: 'web_search_tool_result', content: [{ type: 'web_search_result', url: 'https://example.com/', title: 'Example' }] }] }
      : endpoint.endsWith('/search') ? { results: [{ url: 'https://example.com/', title: 'Example', snippet: 'fixture', date: null }] }
        : { content: '# Fixture page' }
    return new Response(JSON.stringify(body), { status: 200, headers: { 'content-type': 'application/json' } })
  }))
  return seen
}
async function execute(ctx: Context, name: string, args: unknown) {
  return ctx.tools.execute({ name, arguments: args, callId: ToolCallId('fixture'), signal: new AbortController().signal })
}
it('uses each actual C06 account key for native Messages and Search/Fetch tools; unset cannot fall back to Root', async () => {
  const seen = transport()
  const a = await localeFixture('web-tools-a', true, fields), b = await localeFixture('web-tools-b', true, fields)
  await a.writeKey((await a.keyState()).version, 'synthetic-a')
  await b.writeKey((await b.keyState()).version, 'synthetic-b')
  for (const f of [a, b]) { await f.ctx.plugin(Timeout); await f.ctx.plugin(ToolWeb) }
  for (const f of [a, b]) {
    expect((await execute(f.ctx, 'web_search', { queries: ['test'] })).isError).toBe(false)
  }
  expect(seen.map(x => x.key)).toEqual(['Bearer synthetic-a', 'Bearer synthetic-b'])
  for (const f of [a, b]) await f.call([
    { op: 'set', path: ['searchProvider'], value: 'deepseek-search-api' },
    { op: 'set', path: ['fetchProvider'], value: 'deepseek-fetch-api' },
  ], f.revision('web'), { ns: 'web' })
  for (const f of [a, b]) {
    const search = await execute(f.ctx, 'web_search', { queries: ['test'] })
    if (search.isError) throw new Error(JSON.stringify(search.error))
    expect(search).toMatchObject({ isError: false })
    const fetch = await execute(f.ctx, 'web_fetch', { url: 'https://example.com/' })
    expect(fetch).toMatchObject({ isError: false })
  }
  expect(seen.slice(2).map(x => x.key)).toEqual(['Bearer synthetic-a', 'Bearer synthetic-a', 'Bearer synthetic-b', 'Bearer synthetic-b'])
  await a.unsetKey((await a.keyState()).version)
  const count = seen.length
  expect((await execute(a.ctx, 'web_search', { queries: ['test'] })).isError).toBe(true)
  expect((await execute(a.ctx, 'web_fetch', { url: 'https://example.com/' })).isError).toBe(true)
  expect(seen).toHaveLength(count)
  await a.call([{ op: 'set', path: ['searchProvider'], value: 'deepseek-official' },
    { op: 'set', path: ['fetchProvider'], value: 'http' }], a.revision('web'), { ns: 'web' })
  expect((await execute(a.ctx, 'web_search', { queries: ['test'] })).isError).toBe(true)
  expect(seen).toHaveLength(count)
  expect((await execute(b.ctx, 'web_search', { queries: ['test'] })).isError).toBe(false)
  expect(seen.at(-1)?.key).toBe('Bearer synthetic-b')
}, 30000)

it('actual native providers cannot read the Root sentinel when credentials service is absent', async () => {
  const seen = transport()
  const ref = credentialRef('DEEPSEEK_API_KEY')
  for (const searchProvider of ['deepseek-official', 'deepseek-search-api']) {
    const ctx = new Context()
    try {
      ctx.provide(DSH_LAUNCH_ENVIRONMENT_KEY, new AccountModelKeyEnvironment(
        createLaunchEnvironmentSnapshot([{ source: 'process', values: { DEEPSEEK_API_KEY: 'synthetic-root-must-not-escape' } }]), [ref]))
      await ctx.plugin(Web, { searchProvider, fetchProvider: 'deepseek-fetch-api' })
      await ctx.plugin(Messages, { apiKeyEnv: ref, baseURL: 'https://api.deepseek.com/anthropic/v1' })
      await ctx.plugin(Api, { apiKeyEnv: ref, baseURL: 'https://api.deepseek.com/v1/tools' })
      await expect(ctx.web.search({ query: 'test' })).rejects.toBeDefined()
      await expect(ctx.web.fetch({ url: 'https://example.com/' })).rejects.toBeDefined()
    } finally { await ctx.fiber.dispose() }
  }
  expect(seen).toHaveLength(0)
})

it('mounts the native tools in a real Agent preset, scoped to that Agent', async () => {
  const seen = transport(), f = await localeFixture('web-tools-preset', true, fields)
  const { default: AgentPresets } = await import('@deepseek-ai/dsh-agent-preset-registry')
  const { SessionId } = await import('@deepseek-ai/dsh-session')
  const { default: AgentLoop } = await import('@deepseek-ai/dsh-agent-loop')
  await f.ctx.plugin(AgentLoop, { agents: [] })
  const internal = f.ctx.loader.internal!
  const nativeImport = internal.import
  internal.import = async (name: string, ...args: unknown[]) => {
    if (name === '@deepseek-ai/dsh-tool-web') return ToolWeb
    if (name === '@deepseek-ai/dsh-tool-call-timeout-policy') return Timeout
    const loaded: unknown = await Reflect.apply(nativeImport, internal, [name, ...args])
    return loaded
  }
  await f.ctx.plugin(AgentPresets, { default: 'cloud-text' })
  await f.ctx.agentPresets.register({ id: 'cloud-text', plugins: [
    { id: 'timeout-policy', name: '@deepseek-ai/dsh-tool-call-timeout-policy' },
    { id: 'tool-web', name: '@deepseek-ai/dsh-tool-web', config: { fetch: true, searchTimeoutMs: 60000 } },
  ] })
  const handle = await f.ctx.agents.create({ sessionId: SessionId('web-preset-agent'),
    setup: async (agentCtx) => { await f.ctx.agentPresets.mount(agentCtx, 'cloud-text') } })
  const names = f.ctx.tools.schemas(handle.agent).map(row => row.name)
  expect(names).toContain('web_search'); expect(names).toContain('web_fetch')
  expect(f.ctx.tools.schemas().map(row => row.name)).not.toContain('web_search')
  const result = await f.ctx.tools.execute({ name: 'web_search', arguments: { queries: ['test'] },
    agent: handle.agent, callId: ToolCallId('preset-call'), signal: new AbortController().signal })
  expect(result.isError).toBe(false)
  expect(JSON.stringify(result.content)).toContain('Example')
  expect(seen).toHaveLength(1)
  f.ctx.on('tools/pre-execute', (exec, next) => exec.name === 'web_search'
    ? Promise.resolve({ kind: 'deny', reason: 'fixture policy' }) : next())
  const denied = await f.ctx.tools.execute({ name: 'web_search', arguments: { queries: ['test'] },
    agent: handle.agent, callId: ToolCallId('denied-call'), signal: new AbortController().signal })
  expect(denied.isError).toBe(true)
  expect(seen).toHaveLength(1)
}, 30000)

it('pins the complete reviewed preset with the account policy canonical digest', async () => {
  const { readFileSync } = await import('node:fs')
  const { accountPresetConfigDigest } = await import('../../pe-cloud-runtime/src/account-policy.ts')
  const preset = JSON.parse(readFileSync(new URL('./fixtures/web-preset-baseline.json', import.meta.url), 'utf8')) as { plugins: object[] }
  expect(accountPresetConfigDigest(preset, 16384)).toBe('573567687c89ee5086c125b02b6fda1d1cf27d4d1eadbc2813002435d9008677')
  preset.plugins.push({ id: 'timeout-policy', name: '@deepseek-ai/dsh-tool-call-timeout-policy' },
    { id: 'tool-web', name: '@deepseek-ai/dsh-tool-web', config: { fetch: true, searchTimeoutMs: 60000 } })
  expect(accountPresetConfigDigest(preset, 16384)).toBe('805b8285cfb1e3fd5bfa2ce904da870a0b75098473b6bb6332063ce1f09e9a92')
})
