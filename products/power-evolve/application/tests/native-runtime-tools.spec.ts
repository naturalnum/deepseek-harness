/** Actual frozen native schemas extend authorization while external catalogs retain their exact definitions. */
import { expect, test, onTestFinished } from 'vitest'
import { assertModelToolDeclarations, compileMcpModelTool, type McpModelTool } from '../src/mcp-model-tools.ts'

const native: McpModelTool = { name: 'new_native_consumer', description: 'Native consumer '.repeat(100),
  parameters: { type: 'object', properties: { value: { type: 'string' } }, required: ['value'], additionalProperties: false } }
const declaration = { name: native.name, description: native.description, input_schema: native.parameters }

test('authorizes the exact scoped native schema without adding its name to the legacy product list', () => {
  expect(() =>{  assertModelToolDeclarations([declaration], [], [native]) }).not.toThrow()
  expect(() =>{  assertModelToolDeclarations([declaration], []) }).toThrow('model_tool_not_authorized')
  expect(() =>{  assertModelToolDeclarations([{ ...declaration, description: 'changed' }], [],
    [native]) }).toThrow('model_tool_not_authorized')
  expect(() =>{  assertModelToolDeclarations([{ ...declaration, input_schema: {} }], [], [native]) }).toThrow('model_tool_not_authorized')
  expect(() =>{  assertModelToolDeclarations([declaration, declaration], [], [native]) }).toThrow('model_tool_duplicate')
})

test('rejects collisions between native registrations and original MCP snapshots at compilation and model dispatch', () => {
  const tool = { publicName: native.name, raw: { name: 'remote', inputSchema: { type: 'object' } } }
  const limits = { maxToolBytes: 1024, maxDescriptionBytes: 4096 }
  expect(() => compileMcpModelTool(tool, limits, undefined, [native.name])).toThrow('mcp_tool_name_conflict')
  expect(() =>{  assertModelToolDeclarations([declaration], [native], [native]) }).toThrow('mcp_snapshot_conflict')
  const external = compileMcpModelTool({ ...tool, publicName: 'mcp__original__remote' }, limits)
  const exact = { name: external.name, description: external.description, input_schema: external.parameters }
  expect(() =>{  assertModelToolDeclarations([declaration, exact], [external], [native]) }).not.toThrow()
  expect(() =>{  assertModelToolDeclarations([{ ...exact, input_schema: { type: 'object',
    additionalProperties: true } }], [external], [native]) })
    .toThrow('model_tool_not_authorized')
})

/** Original Loader, Settings and Search consumers share a real profile; the local response is a transport fixture. */
import { mkdtemp, mkdir, readFile, writeFile, rm } from 'node:fs/promises'
import { join } from 'node:path'
import { tmpdir } from 'node:os'
import { once } from 'node:events'
import { createServer } from 'node:http'
import { randomUUID } from 'node:crypto'
import { boot, initProfile, loadOverlayPatches, readProfilePatches, type ProfileContext } from '@deepseek-ai/dsh-app-boot'
import ConfigEditor from '@deepseek-ai/dsh-config-editor'
import Settings from '@deepseek-ai/dsh-settings'
import WebRuntime from '@deepseek-ai/dsh-web'
import { Session, SessionId } from '@deepseek-ai/dsh-session'
import * as OriginalSearch from '../../../../packages/web/web-search-deepseek/src/index.ts'
import SettingsController from '../../../../packages/api/settings-controller/src/index.ts'
import * as NativeSearch from '../src/host/web-search.ts'
import { nativeTenantSettingsArguments, nativeTenantSettingsResult, nativeTenantSettingsEvent } from '../src/host/native-settings.ts'

test('mounts the actual distinct Search provider and original volatile Settings consumer from the native Role', async () => {
  const home = await mkdtemp(join(tmpdir(), 'pe-native-search-assembly-')), dir = join(home, 'profiles', 'test')
  onTestFinished(() => rm(home, { recursive: true, force: true }))
  initProfile(dir, ['search-test-bundle'])
  const bundle = join(dir, 'node_modules', 'search-test-bundle')
  await mkdir(bundle, { recursive: true })
  await writeFile(join(home, 'package.json'), '{"name":"test-search-installation"}\n')
  await writeFile(join(bundle, 'package.json'), JSON.stringify({ name: 'search-test-bundle', version: '1.0.0',
    dsh: { bundle: { patch: 'cordis.patch.yml' } } }))
  await writeFile(join(bundle, 'cordis.patch.yml'), JSON.stringify([{ insert: [
    { id: 'config-editor', name: 'cordis:editor' }, { id: 'settings', name: 'cordis:settings' },
    { id: 'web', name: 'cordis:web' }, { id: 'web-search-deepseek', name: 'cordis:original-search' },
  ] }]))
  await writeFile(join(dir, 'cordis.yml'), '[]\n')
  const source = loadOverlayPatches('search-test', new URL('../../native-runtime/cordis.patch.yml', import.meta.url).pathname)
  const disabled = source.find(row => row.id === 'web-search-deepseek')
  const mounted = source.flatMap(row => row.insert ?? []).find(row => row.id === 'power-evolve-web-search')
  // Builtins select the exact source modules while the original Loader still applies both production patch records.
  await writeFile(join(dir, 'cordis.patch.yml'), JSON.stringify([...(disabled === undefined ? [] : [disabled]),
    ...(mounted === undefined ? [] : [{ insert: [{ ...mounted, name: 'cordis:owned-search' }] }])]))
  const profile: ProfileContext = { name: 'test', startedBundles: ['search-test-bundle'], dir,
    patchPath: join(dir, 'cordis.patch.yml'), installAnchor: join(home, 'package.json'), cwd: home, home,
    overlays: [], telemetryDisabledEnv: undefined }
  const session = Session.create(SessionId(randomUUID())), observed: { path: string; body: unknown; flushed: number }[] = []
  let flushed = 0
  const server = createServer((request, response) => {
    const chunks: Buffer[] = []
    request.on('data', (chunk: Buffer) => { chunks.push(chunk) })
    request.on('end', () => {
      observed.push({ path: request.url ?? '', body: JSON.parse(Buffer.concat(chunks).toString()) as unknown, flushed })
      response.writeHead(200, { 'content-type': 'application/json' })
      response.end(JSON.stringify({ content: [{ type: 'web_search_tool_result', content: [{ type: 'web_search_result',
        url: 'https://search-fixture.example/source', title: 'Transport fixture' }] }] }))
    })
  })
  server.listen(0, '127.0.0.1'); await once(server, 'listening')
  onTestFinished(() => new Promise<void>((resolve, reject) => { server.close((error) => { if (error) reject(error); else resolve() }) }))
  const address = server.address()
  if (!address || typeof address === 'string') throw new Error('Search fixture address unavailable')
  const grant = { token: 'owned-operation-transport-fixture', sessionId: session.id }
  const ctx = await boot('search-test', join(dir, 'cordis.yml'), readProfilePatches('search-test', profile), (ctx) => {
    ctx.provide('profileContext', profile)
    ctx.provide('appReady', { onReady: (listener: () => void) => { listener(); return () => {} } })
    ctx.provide('agents', { currentInitiator: () => ({ id: session.id, session }) } as never)
    ctx.provide('sessions', { flush: () => { flushed = session.snapshotEvents().length; return Promise.resolve() } } as never)
    ctx.provide('powerEvolveRuntime', { config: { platformUrl: `http://127.0.0.1:${address.port}` },
      runtimeDefaultModel: 'fixture-model', require: (id: string) => { expect(id).toBe(session.id); return grant },
      assertGrant: (value: unknown) => { expect(value).toBe(grant) },
      publication: () => ({ backpressure: () => Promise.resolve() }) } as never)
    Object.assign(ctx.loader.builtins, { editor: ConfigEditor, settings: Settings, web: WebRuntime,
      'original-search': OriginalSearch, 'owned-search': NativeSearch })
  })
  onTestFinished(() => ctx.fiber.dispose())
  const updates: { namespace: string; revision: number }[] = []
  ctx.on('settings/document-updated', (namespace, revision) => { updates.push({ namespace, revision }) })
  const controller = new SettingsController(ctx)
  const described = nativeTenantSettingsResult('settings/describe', { ok: true, value: controller.describe() })
  expect(described.ok).toBe(true)
  if (!described.ok) throw new Error('Original Settings result rejected')
  const view = described.value as ReturnType<SettingsController['describe']>
  expect(view.namespaces.filter(row => row.ns === 'web-search-deepseek')).toHaveLength(1)
  expect(view.namespaces.some(row => row.ns === 'power-evolve-web-search')).toBe(false)
  const before = view.namespaces.find(row => row.ns === 'web-search-deepseek')!
  const args = nativeTenantSettingsArguments({ ns: before.ns, patch: { maxUses: 2 }, expectedRevision: before.revision })
  const updated = await controller.update(String(args.ns), { maxUses: 2 }, before.revision)
  const aliased = nativeTenantSettingsResult('settings/update', { ok: true, value: updated })
  expect(aliased).toMatchObject({ ok: true, value: { ns: before.ns, value: { maxUses: 2 } } })
  await expect(controller.update(String(args.ns), { maxUses: 3 }, before.revision)).rejects.toMatchObject({ code: 'settings/conflict' })
  await expect(controller.update(String(args.ns), { baseURL: 'https://unowned.example' }, updated.revision))
    .rejects.toMatchObject({ code: 'settings/rejected' })
  const found = await ctx.web.search({ query: 'original native consumer' })
  expect(found.sources[0]?.url).toBe('https://search-fixture.example/source')
  expect(observed).toMatchObject([{ path: '/runtime/web-search/messages', flushed: 1,
    body: { model: 'fixture-model', tools: [{ max_uses: 2 }] } }])
  expect(await readFile(profile.patchPath, 'utf8')).toContain('power-evolve-web-search')
  const notification = updates.filter(row => row.namespace === 'power-evolve-web-search').at(-1)
  expect(notification?.revision).toBe(updated.revision)
  const frame = { type: 'emit', event: 'settings/document-updated', args: [notification?.namespace, notification?.revision] }
  expect(nativeTenantSettingsEvent(frame)).toEqual({ ...frame, args: ['web-search-deepseek', updated.revision] })
  expect(nativeTenantSettingsEvent({ ...frame, event: 'unrelated' })).toEqual({ ...frame, event: 'unrelated' })
})
