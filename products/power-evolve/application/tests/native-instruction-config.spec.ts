/** Maintained Loader, presets and instruction projection read actual files through the native Fs client. */
import { Context, FiberState } from '@deepseek-ai/cordis'
import Loader, { Group } from '@deepseek-ai/cordis-plugin-loader'
import Include from '@deepseek-ai/cordis-plugin-include'
import { composeEntries, loadOverlayPatches } from '@deepseek-ai/dsh-app-boot'
import * as Instructions from '../../../../packages/context/agent-instructions/src/index.ts'
import AgentPreset from '../../../../packages/preset/agent-preset/src/index.ts'
import Presets from '@deepseek-ai/dsh-agent-preset-registry'
import { mountAgentLoopTestDependencies, mountAgentLoopTestHarness } from '@deepseek-ai/dsh-agent-loop-testkit'
import { agentEvents } from '@deepseek-ai/dsh-agent'
import { SessionId } from '@deepseek-ai/dsh-session'
import { FsError } from '@deepseek-ai/dsh-fs'
import { randomUUID } from 'node:crypto'
import { spawnSync } from 'node:child_process'
import { mkdir, mkdtemp, rm, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join, posix } from 'node:path'
import { pathToFileURL } from 'node:url'
import { expect, test } from 'vitest'
import { z } from 'zod'
import NativeInstructionConfig from '../src/host/native-instruction-config.ts'
import { createNativeExecutionHttpBinding } from '../src/native-execution/http-client.ts'
import { installNativeExecutionProviders } from '../src/native-execution/providers.ts'
import { nativeExecutionWorld } from '../src/native-execution/types.ts'


const role = loadOverlayPatches('instruction-test', new URL('../../native-runtime/cordis.patch.yml', import.meta.url).pathname)
const declarations = ['standard', 'ptc', 'cordis'].map((id) => {
  const original = composeEntries([loadOverlayPatches('instruction-test',
    new URL(`../../../../packages/bundle/web-app/presets/${id}.patch.yml`, import.meta.url).pathname)])
  const patched = composeEntries([original.map(row => ({ insert: [row] })), role.filter(row => row.id === 'preset-' + id)])
  expect(patched[0]?.config).toEqual(original[0]?.config)
  expect(patched[0]?.inject).toEqual(['nativeInstructionConfig'])
  return z.object({ id: z.string(), name: z.string(), inject: z.array(z.string()),
    config: z.object({ id: z.string(), plugins: z.array(z.object({ id: z.string().optional(),
      name: z.string(), config: z.unknown().optional() }).loose()) }).loose() }).loose().parse(patched[0])
})
function docker(args: string[], input?: unknown): string {
  const run = spawnSync('docker', args, { input: input === undefined ? undefined : JSON.stringify(input),
    encoding: 'utf8', timeout: 10_000, maxBuffer: 65_536 })
  if (run.error || run.signal || run.status !== 0) throw new Error('Owned Linux instruction fixture command failed')
  return run.stdout.trim()
}

const imageTag = process.env.PE_TEST_CLOUD_IMAGE
if (!imageTag || !/^pe-employee4-cloud:[a-f0-9-]{36}$/u.test(imageTag)) throw new Error('Owned Linux source image is required')
const image = z.object({ Id: z.string().regex(/^sha256:[a-f0-9]{64}$/u), Os: z.literal('linux'),
  Config: z.object({ Labels: z.record(z.string(), z.string()) }) }).loose().array().length(1)
  .parse(JSON.parse(docker(['image', 'inspect', imageTag])))[0]!
if (image.Config.Labels['org.power-evolve.employee4'] !== imageTag.slice('pe-employee4-cloud:'.length)) {
  throw new Error('Linux source image belongs to another fixture')
}
const worker = '/opt/power-evolve/sandbox-payload/native-execution-worker/native-fs-worker.mjs'
const configured = role.flatMap(row => row.insert ?? []).find(row => row.id === 'native-instruction-config')!
const target = z.object({ targetKey: z.string(), displayPath: z.string() }).strict()
const request = z.discriminatedUnion('op', [
  z.object({ op: z.literal('resolve'), path: z.string(), cwd: z.string() }).strict(),
  z.object({ op: z.literal('stat'), target }).strict(),
  z.object({ op: z.literal('readText'), target }).strict(),
  z.object({ op: z.literal('writeText'), target, content: z.string(), expected: z.unknown().optional() }).strict(),
])

for (const declaration of declarations) test(`${declaration.id} loads workspace and user-global instructions without leaving its read-only world`, async () => {
  const root = await mkdtemp(join(tmpdir(), 'pe-native-instructions-')), ctx = new Context(), owner = new Context()
  const paths: string[] = [], token = randomUUID(), streams = new Map<string, Buffer>()
  let container: string | undefined
  const world = nativeExecutionWorld.parse({ worldId: randomUUID(), userId: randomUUID(), sessionId: randomUUID(),
    agentId: randomUUID(), workspaceId: randomUUID(), operationId: randomUUID(), operationEpoch: 1,
    storageGeneration: 1, permissionGeneration: 1, mode: 'read-only', workspaceRoot: '/workspace', homeRoot: '/home/agent' })
  try {
    await mkdir(join(root, 'workspace')); await mkdir(join(root, 'home/agent/.dsh'), { recursive: true })
    await writeFile(join(root, 'workspace/AGENTS.md'), 'Workspace instructions from the owned execution world.\n')
    await writeFile(join(root, 'home/agent/.dsh/AGENTS.md'), 'User-global instructions from the owned Home.\n')
    container = docker(['run', '--detach', '--read-only', '--network', 'none', '--user', '1000:1000',
      '--cap-drop', 'ALL', '--security-opt', 'no-new-privileges', '--label', 'power-evolve.instruction-fixture=' + token,
      '--mount', 'type=bind,src=' + join(root, 'workspace') + ',dst=/workspace,readonly',
      '--mount', 'type=bind,src=' + join(root, 'home/agent') + ',dst=/home/agent,readonly',
      '--entrypoint', '/bin/sleep', image.Id, 'infinity'])
    const pod = container
    const call = (value: unknown): unknown => JSON.parse(docker(['exec', '--interactive', pod, 'node', worker], value)) as unknown
    const binding = createNativeExecutionHttpBinding(owner, world, token, async (route, bearer, input) => {
      expect(bearer).toBe(token)
      if (route.startsWith('/runtime/native-world/fs/stream/')) {
        const stream = z.object({ world: nativeExecutionWorld, id: z.uuid(), target: target.optional(),
          outputOffset: z.number().optional() }).strict().parse(input)
        expect(stream.world).toEqual(world)
        const action = route.split('/').at(-1)
        if (action === 'start') {
          if (!stream.target || !stream.target.targetKey.startsWith(world.worldId + ':')) throw new Error('Invalid stream owner')
          const output = docker(['exec', '--interactive', pod, 'node', worker], { op: 'streamText',
            target: { ...stream.target, targetKey: stream.target.targetKey.slice(world.worldId.length + 1) } })
          streams.set(stream.id, Buffer.from(output + '\n')); return { id: stream.id }
        }
        if (action === 'poll') {
          const output = streams.get(stream.id)
          if (output === undefined) throw new Error('Unknown stream owner')
          return { state: 'completed', outcome: { exitCode: 0, signal: null }, error: null,
            output: { data: output.toString('base64'), nextOffset: output.length, lossy: false, exhausted: true } }
        }
        if (action === 'stop' || action === 'release') {
          if (!streams.has(stream.id)) throw new Error('Unknown cleanup owner')
          if (action === 'release') streams.delete(stream.id)
          return { stopped: true }
        }
        throw new Error('Unexpected native stream operation')
      }
      expect(route).toBe('/runtime/native-world/fs')
      const parsed = z.object({ world: nativeExecutionWorld, request }).strict().parse(input)
      expect(parsed.world).toEqual(world)
      const value = parsed.request
      if (value.op === 'resolve') {
        paths.push(posix.resolve(value.cwd, value.path))
        const reply = z.discriminatedUnion('ok', [z.object({ ok: z.literal(true), value: target }).strict(),
          z.object({ ok: z.literal(false), code: z.string(), message: z.string() }).strict()]).parse(call(value))
        return reply.ok ? { ...reply, value: { ...reply.value, targetKey: world.worldId + ':' + reply.value.targetKey } } : reply
      }
      const prefix = world.worldId + ':'
      if (!value.target.targetKey.startsWith(prefix)) throw new FsError('Target belongs to another world.', 'FS_PERMISSION_DENIED')
      return call({ ...value, target: { ...value.target, targetKey: value.target.targetKey.slice(prefix.length) } })
    }, { pollMs: 1, maxOutputBytes: 65536 })
    await mountAgentLoopTestDependencies(ctx)
    const harness = await mountAgentLoopTestHarness(ctx)
    await ctx.plugin(Loader); ctx.loader.builtins.group = Group; ctx.loader.builtins.include = Include
    ctx.loader.builtins.instructions = Instructions; ctx.loader.builtins.preset = AgentPreset
    ctx.loader.builtins['native-instructions'] = NativeInstructionConfig
    installNativeExecutionProviders(ctx, { defaultMode: 'read-only', resolve: () => binding })
    await ctx.plugin(Presets, { default: declaration.config.id })
    const instructions = z.object({ config: z.record(z.string(), z.unknown()) }).loose().parse(
      declaration.config.plugins.find(row => row.id === 'agent-instructions'))
    // Other preset consumers are outside this focused fixture; retain the original declaration and instruction module/config.
    const row = { ...declaration, name: 'cordis:preset', config: { ...declaration.config,
      plugins: [{ id: 'agent-instructions', name: 'cordis:instructions', config: instructions.config }] } }
    await ctx.loader.create({ name: 'cordis:include',
      config: { path: pathToFileURL(join(root, 'preset.json')).href, initial: [row] } })
    await ctx.loader.await()
    const pending = [...ctx.loader.entries()].find(entry => entry.options.id === declaration.id)
    expect(pending?.fiber?.state).toBe(FiberState.PENDING)
    await ctx.loader.create({ name: 'cordis:include',
      config: { path: pathToFileURL(join(root, 'configuration.json')).href,
        initial: [{ ...configured, name: 'cordis:native-instructions' }] } })
    await ctx.loader.await()
    const agent = await harness.create(SessionId(world.sessionId), {}, { cwd: '/workspace' })
    await ctx.agentPresets.mount(agent.ctx, declaration.config.id)
    await agentEvents(ctx, agent).waterfall('agent/pre-step', { messages: [], turn: 1, step: 1,
      signal: new AbortController().signal }, async () => ({ kind: 'enter' as const, messages: [] }))
    const messages = harness.claim(agent, 'next-step', 1)
    const baseline = messages.find(message => message.source.kind === 'agent-instructions')
    expect(baseline).toBeDefined()
    const text = baseline?.content.map(block => block.type === 'text' ? block.text : '').join('\n')
    expect(text).toContain('Workspace instructions from the owned execution world.')
    expect(text).toContain('User-global instructions from the owned Home.')
    expect(text).toMatchInlineSnapshot(`
      "<system-reminder>
      The following workspace instructions may be relevant to your work. Use them as guidance when applicable. More specific instructions take precedence over broader ones. They do not override system, developer, or direct user instructions.

      Instructions from: $DSH_HOME/AGENTS.md

      User-global instructions from the owned Home.


      Instructions from: AGENTS.md

      Workspace instructions from the owned execution world.

      </system-reminder>"
    `)
    expect(baseline?.source).toMatchObject({ kind: 'agent-instructions', baseline: true,
      changes: [{ action: 'set', path: '$DSH_HOME/AGENTS.md' }, { action: 'set', path: 'AGENTS.md' }] })
    expect(paths).not.toContain('/.git'); expect(paths).not.toContain('/workspace/.git')
    expect(paths).toContain('/home/agent/.dsh/AGENTS.md')
    expect(binding.filesystem.sandboxMode).toBe('read-only')
    const file = await binding.filesystem.resolve('/workspace/AGENTS.md')
    await expect(binding.filesystem.writeText(file, 'forbidden')).rejects.toBeInstanceOf(FsError)
    expect(await binding.filesystem.readText(file)).toBe('Workspace instructions from the owned execution world.\n')
    const inspect = z.object({ HostConfig: z.object({ ReadonlyRootfs: z.literal(true) }),
      Mounts: z.array(z.object({ RW: z.literal(false) }).loose()) }).loose().array().length(1)
      .parse(JSON.parse(docker(['inspect', pod])))[0]!
    expect(inspect.Mounts).toHaveLength(2)
    await expect(binding.filesystem.resolve('/.git')).rejects.toMatchObject({ code: 'FS_PERMISSION_DENIED' })
    await expect(binding.filesystem.resolve('/runtime/state/dsh/AGENTS.md')).rejects.toMatchObject({ code: 'FS_PERMISSION_DENIED' })
    await binding.close()
  } finally {
    await ctx.fiber.dispose(); await owner.fiber.dispose()
    if (container !== undefined) { docker(['stop', '--time', '1', container]); docker(['rm', container]) }
    await rm(root, { recursive: true, force: true })
  }
})

test('leaves unrelated plugin configuration and the original schema rejection intact', async () => {
  const ctx = new Context(), observed: unknown[] = []
  try {
    await ctx.plugin(NativeInstructionConfig, { dshHome: '/home/agent/.dsh', projectRootMarkers: ['.'] })
    await ctx.plugin({ name: 'agent-instructions', apply: (_child: Context, config: unknown) => { observed.push(config) } },
      { maxBytes: 77, dshHome: '/original', projectRootMarkers: ['.git'] })
    expect(observed).toEqual([{ maxBytes: 77, dshHome: '/original', projectRootMarkers: ['.git'] }])
    await mountAgentLoopTestDependencies(ctx)
    await expect(Promise.resolve(ctx.plugin(Instructions, null))).rejects.toBeInstanceOf(Error)
  } finally { await ctx.fiber.dispose() }
})
