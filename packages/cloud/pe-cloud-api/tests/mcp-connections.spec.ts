/** Real native storage, credentials, client and HTTP tools in independent account contexts. */
import { mkdtemp, readFile, rm } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { Context } from '@deepseek-ai/cordis'
import { brandString } from '@deepseek-ai/dsh-brand'
import Storage from '@deepseek-ai/dsh-storage'
import * as JsonBackend from '@deepseek-ai/dsh-storage-json'
import * as Domains from '@deepseek-ai/dsh-storage-domain'
import Credentials from '@deepseek-ai/dsh-credentials-local'
import SystemPrompt from '@deepseek-ai/dsh-system-prompt'
import ToolRuntime from '@deepseek-ai/dsh-tools'
import { ToolCallId } from '@deepseek-ai/dsh-llm'
import type { AccountBinding } from '@deepseek-ai/dsh-pe-cloud-runtime/types'
import { openMcpConnectionStore, mcpConnectionInput, type McpConnectionInput } from '@deepseek-ai/dsh-pe-cloud-files'
import { expect, it } from 'vitest'
import { ConfigSaveCoordinator } from '../src/config-saves.ts'
import { AccountMcpConnections } from '../src/mcp-connection-runtime.ts'
import { startHttpMcpFixture } from '../../../mcp/mcp-client/tests/http-fixture.ts'

const limits = { maxConnections: 4, maxUrlBytes: 2048, maxHeaderBytes: 2048, maxHeaderCount: 8, maxToolCallTimeoutMs: 2000 }
const policy = { maxInstructionBytes: 4096,
  reconnect: { enabled: true, initialDelayMs: 20, maxDelayMs: 50, maxAttempts: 2 } }

it('keeps credentials, tool scopes and restored HTTP connections within the original account', async () => {
  const directory = await mkdtemp(join(tmpdir(), 'cloud-mcp-native-')), contexts: Context[] = []
  const fixture = await startHttpMcpFixture({ requiredAuthorization: 'Bearer synthetic-account-token' })
  const saves = new ConfigSaveCoordinator({ maxAccounts: 4, maxRunning: 2, maxQueued: 8, maxQueuedPerAccount: 4,
    maxTrackedOperations: 16, maxTrackedOperationsPerAccount: 8, maxNestedPerOperation: 8, maxWaitersPerAccount: 8 })
  const create = async (name: string, epoch: string) => {
    const ctx = new Context(), lifetime = new AbortController(); contexts.push(ctx)
    const binding: AccountBinding = Object.freeze({ accountId: brandString<AccountBinding['accountId']>(name),
      epoch: brandString<AccountBinding['epoch']>(epoch), recipeVersion: 'mcp-test', lifetime: lifetime.signal })
    ctx.provide('peAccount', binding)
    await ctx.plugin(SystemPrompt); await ctx.plugin(ToolRuntime)
    await ctx.plugin(Storage); await ctx.plugin(JsonBackend, { root: join(directory, name, 'storage') })
    await ctx.plugin(Domains, { backend: 'json' })
    await ctx.plugin(Credentials, { path: join(directory, name, 'credentials.json'), watch: false })
    const barrier = saves.createAccount(binding)
    const check = (): void => { lifetime.signal.throwIfAborted(); ctx.fiber.assertActive() }
    const store = await openMcpConnectionStore(ctx, binding, limits, check, check, task => barrier.admit('mcp-connection', task))
    const runtime = new AccountMcpConnections(ctx, store, policy, check, () => { check() })
    return { ctx, lifetime, store, runtime, barrier }
  }
  const input: McpConnectionInput = { serverName: 'compute', url: fixture.url, enabled: true, toolCallTimeoutMs: 2000,
    headers: { Authorization: 'Bearer synthetic-account-token' } }
  try {
    let a = await create('A', '1')
    const b = await create('B', '1')
    expect(await a.runtime.test(input, new AbortController().signal)).toEqual({ reachable: true, tools: ['mcp__compute__ping'] })
    expect(a.ctx.tools.schemas()).toEqual([])
    expect(await a.runtime.test({ ...input, headers: { Authorization: 'Bearer synthetic-wrong-token' } },
      new AbortController().signal)).toEqual({ reachable: false, failure: 'connection-failed' })
    const row = await a.store.save(undefined, input)
    await a.runtime.apply(row)
    expect(b.store.list()).toEqual([]); expect(b.ctx.tools.schemas()).toEqual([])
    expect(JSON.stringify(a.store.list())).not.toContain('synthetic-account-token')
    const result = await a.ctx.tools.execute({ name: 'mcp__compute__ping', arguments: {},
      callId: ToolCallId('mcp-first'), signal: new AbortController().signal })
    expect(result).toMatchObject({ isError: false, value: { content: [{ type: 'text', text: 'pong' }] } })
    const privateBytes = await readFile(join(directory, 'A', 'credentials.json'), 'utf8')
    expect(privateBytes).toContain('synthetic-account-token')
    await expect(b.store.withHeaders(row.id, async () => 'must-not-run')).rejects.toThrow()
    await a.runtime.close(); await a.barrier.stopConfigSaves(Date.now() + 2000); await a.ctx.fiber.dispose()
    saves.releaseAccount(a.barrier)
    a = await create('A', '2'); await a.runtime.restore()
    expect(a.ctx.tools.schemas().map(tool => tool.name)).toEqual(['mcp__compute__ping'])
    const disabled = await a.store.save(row.id, { ...input, enabled: false, headers: undefined })
    await a.runtime.apply(disabled)
    expect(a.ctx.tools.schemas()).toEqual([]); expect(await a.store.configured(row.id)).toBe(true)
    await a.store.save(row.id, { ...input, enabled: false, headers: {} })
    expect(await a.store.configured(row.id)).toBe(false)
    await a.store.remove(row.id)
    expect(a.store.list()).toEqual([]); expect(await a.ctx.credentials.listRecords()).toEqual([])
    const replacement = await a.store.save(undefined, input); await a.runtime.apply(replacement)
    a.lifetime.abort()
    const stale = await a.ctx.tools.execute({ name: 'mcp__compute__ping', arguments: {},
      callId: ToolCallId('mcp-revoked'), signal: new AbortController().signal })
    expect(stale.isError).toBe(true)
    expect(() => a.store.list()).toThrow()
  } finally {
    for (const ctx of contexts) await ctx.fiber.dispose()
    await fixture.close(); await rm(directory, { recursive: true, force: true })
  }
}, 20000)

it('accepts ordinary HTTP IP endpoints and rejects URL credentials, control headers and over-budget input', () => {
  const form = { serverName: 'compute', url: 'http://192.0.2.1:17273/mcp', enabled: true, toolCallTimeoutMs: 2000 }
  expect(mcpConnectionInput(form, limits).url).toBe(form.url)
  for (const input of [{ ...form, url: 'file:///tmp/mcp' }, { ...form, url: 'http://token@192.0.2.1/mcp' },
    { ...form, headers: { Host: 'other' } }, { ...form, headers: { Authorization: 'x\r\ny' } },
    { ...form, headers: { Authorization: 'x'.repeat(2048) } }, { ...form, transport: 'stdio', command: 'sh' }]) {
    expect(() => mcpConnectionInput(input, limits)).toThrow()
  }
})
