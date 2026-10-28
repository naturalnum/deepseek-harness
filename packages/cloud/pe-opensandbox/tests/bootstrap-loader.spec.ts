/** Real Loader, Root, assembly, storage adapter and coordinator; scripted OS/PG and installed asset location only. */
import { createHash } from 'node:crypto'
import { mkdtempSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { fileURLToPath } from 'node:url'
import type { Context } from '@deepseek-ai/cordis'
import { boot } from '@deepseek-ai/dsh-app-boot'
import { brandString } from '@deepseek-ai/dsh-brand'
import { ToolCallId } from '@deepseek-ai/dsh-llm'
import { SessionId } from '@deepseek-ai/dsh-session'
import type { Workspace } from '@deepseek-ai/dsh-workspace'
import { CloudAccountFiles, type AccountFilesProject, type ExecutionMountGrant } from '@deepseek-ai/dsh-pe-cloud-files'
import { PeAccountRuntime } from '@deepseek-ai/dsh-pe-cloud-runtime/root'
import { installAccountBinding } from '@deepseek-ai/dsh-pe-cloud-runtime/src/binding.ts'
import type { DrainParticipant, RootMetadataDatabase } from '@deepseek-ai/dsh-pe-cloud-runtime/types'
import { mountAgentLoopTestDependencies, mountAgentLoopTestHarness,
  provideWorkingDirectoryFixture } from '@deepseek-ai/dsh-agent-loop-testkit'
import * as ToolBash from '@deepseek-ai/dsh-tool-bash'
import { Agent as HttpAgent } from 'undici'
import { afterEach, beforeEach, expect, it, vi } from 'vitest'
import { loadBootstrapPayload } from '../src/bootstrap/bootstrap.ts'
import { allocationMigrationSql } from '../src/migrations/allocations.ts'
import { installIssuedExecutionPort } from '../src/account-port.ts'
import { SdkAllocationBackend } from '../src/sdk-lifecycle.ts'
import * as account from '../src/account.ts'
import * as root from '../src/root.ts'
import { managedDeploymentFixture, sharedPathDeploymentFixture } from './fixtures/root-deployment.ts'

const io = vi.hoisted(() => ({
  files: new Map<string, Buffer>(), fds: new Map<number, string>(), next: 10000,
  planCurrent: true, opens: [] as string[], closes: [] as string[],
  queries: [] as string[], sourceOpens: [] as string[], assets: vi.fn(),
}))
vi.mock('node:fs', async (importOriginal) => {
  const actual = await importOriginal<typeof import('node:fs')>()
  const stat = (path: string) => {
    const bytes = io.files.get(path), directory = bytes === undefined
    return { uid: 0n, gid: directory ? 0n : path.endsWith('/config.json') ? 2000n : 0n, nlink: 1n,
      mode: directory ? 0o40755n : path.endsWith('/config.json') ? 0o100440n : 0o100644n,
      size: BigInt(bytes?.length ?? 0), dev: 1n,
      ino: path.endsWith('/storage-plan.json') && !io.planCurrent ? 3n : 2n,
      mtimeNs: 3n, ctimeNs: 4n, isFile: () => !directory, isDirectory: () => directory }
  }
  return { ...actual,
    openSync: (...args: Parameters<typeof actual.openSync>) => {
      const [path] = args
      if (typeof path === 'string' && path.startsWith('/accounts/')) {
        io.sourceOpens.push(path)
        throw new Error('The scripted source mount must remain unopened after files grant refusal.')
      }
      if (typeof path !== 'string' || !io.files.has(path) && !path.startsWith('/proc/')) return actual.openSync(...args)
      const fd = io.next++; io.fds.set(fd, path); io.opens.push(path); return fd
    },
    fstatSync: (fd: number, options: { bigint: true }) => {
      const path = io.fds.get(fd)
      return path === undefined ? actual.fstatSync(fd, options) : stat(path)
    },
    lstatSync: (path: string, options: { bigint: true }) => path === '/' || path === '/root-private' || io.files.has(path)
      ? stat(path) : actual.lstatSync(path, options),
    readSync: (fd: number, target: Buffer, offset: number, length: number, position: number) => {
      const path = io.fds.get(fd)
      if (path === undefined) return actual.readSync(fd, target, offset, length, position)
      const bytes = io.files.get(path) ?? (path === '/proc/self/mountinfo'
        ? Buffer.from('77 1 8:1 / /root-private ro - ext4 /dev/test ro\n') : Buffer.from('mnt_id:\t77\n'))
      const chunk = bytes.subarray(position, position + length); target.set(chunk, offset); return chunk.length
    },
    closeSync: (fd: number) => {
      const path = io.fds.get(fd)
      if (path === undefined) { actual.closeSync(fd); return }
      io.fds.delete(fd); io.closes.push(path)
    },
  }
})
// Source discovery intentionally refuses production use. Supply only the installed asset location; verify real pinned bytes.
vi.mock('../src/bootstrap/assets.ts', () => ({ loadPackagedBootstrapPayload: () => {
  io.assets()
  const runtime = fileURLToPath(new URL('../runtime/', import.meta.url))
  return loadBootstrapPayload(join(runtime, 'bootstrap'), join(runtime, 'agent'))
} }))

class LoaderRuntime extends PeAccountRuntime {
  private readonly metadata: { registered?: DrainParticipant } = {}
  override registerDrainParticipant(participant: DrainParticipant): () => void | Promise<void> {
    const withdraw = super.registerDrainParticipant(participant)
    this.metadata.registered = participant
    return withdraw
  }
  override controlDatabase(participant: DrainParticipant): RootMetadataDatabase {
    if (participant !== this.metadata.registered) throw new Error('Scripted PG requires the original registered participant.')
    return { wasNotSubmitted: () => false, query: async (sql) => {
      io.queries.push(sql)
      if (sql !== allocationMigrationSql && !sql.startsWith('SELECT')) throw new Error('Unexpected scripted PG write.')
      return { rows: [] }
    } }
  }
}

function plan(version = 2): Buffer {
  const domain = (index: number, rootPath = `/domain-${index}`) => ({
    rootPath, rootDevice: String(index), rootInode: '2', rootMountId: String(index + 10),
    minimumBytes: '4096', maximumBytes: '8192', minimumInodes: '100', maximumInodes: '200',
    backing: { path: `/backing-${index}`, device: '9', inode: String(index + 20), bytes: '8192' },
  })
  return Buffer.from(JSON.stringify({ version, recipeVersion: 'v1', appUid: 2000, appGid: 2000,
    arenaReserveBytes: '8192', arena: domain(1), control: domain(2),
    baseConfigPath: '/app/base.yml', installAnchor: '/app/package.json', auxiliary: [],
    accounts: [1, 2].map((index) => {
      const accountRoot = `/accounts/v1-${String(index).repeat(64)}`
      return { accountId: `account-${index}`, storageKey: `v1-${String(index).repeat(64)}`, accountRoot,
        private: domain(index * 2 + 1, `${accountRoot}/private`), projects: domain(index * 2 + 2, `${accountRoot}/projects`),
        ...version === 2 ? { environmentBank: { bankId: `bank-${index}`, slots: [{ slotId: 'one',
          domain: domain(index + 6, `${accountRoot}/environments/one`) }] } } : {},
      }
    }),
  }))
}

beforeEach(() => {
  io.files.clear(); io.fds.clear(); io.opens.length = 0; io.closes.length = 0; io.queries.length = 0
  io.sourceOpens.length = 0
  io.planCurrent = true; io.assets.mockClear()
  const original = process
  vi.stubGlobal('process', new Proxy(original, { get(target, key, receiver) {
    if (key === 'platform') return 'linux'
    if (key === 'getuid' || key === 'getgid') return () => 2000
    const value: unknown = Reflect.get(target, key, receiver)
    return value
  } }))
})
afterEach(() => { vi.unstubAllGlobals(); vi.restoreAllMocks() })

async function launch(input = sharedPathDeploymentFixture(), bytes = plan()) {
  const temporary = mkdtempSync(join(tmpdir(), 'shared-path-loader-'))
  const digest = (value: Buffer) => createHash('sha256').update(value).digest('hex')
  input.storage.plan.sha256 = digest(bytes)
  io.files.set(input.storage.plan.path, bytes)
  const selected = Buffer.from(JSON.stringify(input)), config = join(temporary, 'cordis.yml')
  io.files.set('/root-private/config.json', selected)
  writeFileSync(config, JSON.stringify([
    { id: 'execution-root', name: 'cordis:shared-execution', config: { mode: 'session-collect', requiredCapabilities: ['argv-collect'],
      managed: managedDeploymentFixture(), rootDeployment: { path: '/root-private/config.json', sha256: digest(selected) } } },
  ]))
  try {
    const ctx = await boot('shared-path-loader-test', config, [], async (setup) => {
      await setup.plugin(LoaderRuntime, { maxMountedAccounts: 2, maxConcurrentMounts: 1, maxConcurrentDrains: 1 })
      setup.loader.builtins['shared-execution'] = root
    })
    return { ctx, close: async () => { try { await ctx.fiber.dispose() } finally { rmSync(temporary, { recursive: true, force: true }) } } }
  } catch (cause) { rmSync(temporary, { recursive: true, force: true }); throw cause }
}

it('boots explicit shared-path through Loader and closes original storage leases after the real SDK owner', async () => {
  const f = await launch()
  const cleanupErrors = vi.spyOn(f.ctx.logger, 'error').mockImplementation(() => {})
  try {
    const entry = [...f.ctx.loader.entries()].find(candidate => candidate.options.id === 'execution-root')
    await entry?.fiber?.await()
    expect(f.ctx.get('peSandboxCoordinator')).toBeDefined()
    expect(() => { f.ctx.peSandboxCoordinator.assertReady() }).not.toThrow()
    expect(io.assets).toHaveBeenCalledOnce()
    expect(io.queries).toHaveLength(2)
    expect(io.queries[0]).toBe(allocationMigrationSql)
    expect([...io.fds.values()]).toEqual(['/root-private/config.json', '/root-private/storage-plan.json'])
    expect(io.opens).not.toContain('/proc/self/fd/4')
    io.planCurrent = false
    expect(() => { f.ctx.peSandboxCoordinator.assertReady() }).toThrow()
  } finally { await f.close() }
  expect(io.fds.size).toBe(0)
  expect(io.closes.slice(-2)).toEqual(['/root-private/storage-plan.json', '/root-private/config.json'])
  expect(f.ctx.get('peSandboxCoordinator')).toBeUndefined()
  expect(cleanupErrors).not.toHaveBeenCalled()
})

it.each(['mode', 'plan-v1'] as const)('refuses invalid shared-path %s through Loader before installed SDK assets or PG', async (invalid) => {
  const input = sharedPathDeploymentFixture()
  if (invalid === 'mode') Reflect.deleteProperty(input.storage, 'mode')
  const f = await launch(input, plan(invalid === 'plan-v1' ? 1 : 2))
  try {
    const entry = [...f.ctx.loader.entries()].find(candidate => candidate.options.id === 'execution-root')
    expect(entry?.fiber).toBeDefined()
    await expect(entry?.fiber?.await()).rejects.toMatchObject({ code: 'binding' })
    expect(f.ctx.get('peSandboxCoordinator')).toBeUndefined()
    expect(f.ctx.get('shell')).toBeUndefined()
    expect(io.assets).not.toHaveBeenCalled()
    expect(io.queries).toHaveLength(0)
  } finally { await f.close() }
  expect(io.fds.size).toBe(0)
})

it('refuses the original files current callback inside shared-path admission before source opens, allocation SQL or SDK create', async () => {
  const f = await launch(), temporary = mkdtempSync(join(tmpdir(), 'shared-path-account-loader-'))
  const sdkCreate = vi.spyOn(SdkAllocationBackend.prototype, 'create')
  const network = vi.spyOn(HttpAgent.prototype, 'request').mockRejectedValue(new Error('Actual network is disabled in this refusal test.'))
  const lifetime = new AbortController(), release = vi.fn(), denied = new Error('Original files grant is no longer current.')
  const filesCurrent = vi.fn<(grant: ExecutionMountGrant) => void>()
  let accountContext: Context | undefined
  try {
    const config = join(temporary, 'cordis.yml')
    writeFileSync(config, JSON.stringify([
      { id: 'execution-account', name: 'cordis:shared-account', config: { mode: 'session-collect', requiredCapabilities: ['argv-collect'] } },
      { id: 'bash', name: 'cordis:shared-bash', config: { enableRunInBackground: false, promoteOnTimeout: false } },
    ]))
    const ctx = await boot('shared-path-account-loader-test', config, [], async (setup) => {
      const binding = installAccountBinding(setup, { accountId: brandString<ExecutionMountGrant['binding']['accountId']>('account-1'),
        epoch: brandString<ExecutionMountGrant['binding']['epoch']>('1'), recipeVersion: 'v1', lifetime: lifetime.signal })
      const accountRoot = `/accounts/v1-${'1'.repeat(64)}`, projectPath = `${accountRoot}/projects/default-workspace`
      await mountAgentLoopTestDependencies(setup, { tools: { mode: 'native' } })
      provideWorkingDirectoryFixture(setup, projectPath)
      const harness = await mountAgentLoopTestHarness(setup)
      const agent = await harness.create(SessionId('shared-path-denied-agent'), {}, { cwd: projectPath })
      const workspace: Workspace = { id: brandString<Workspace['id']>('shared-path-workspace'), path: projectPath,
        sessionIds: [agent.session.id], title: 'Shared path grant refusal',
        createdAt: '2026-10-27T00:00:00Z', updatedAt: '2026-10-27T00:00:00Z',
        setTitle: async () => {}, attachSession: async () => {}, detachSession: async () => {},
        insertSessionBefore: async () => {}, status: async () => 'ok' }
      const project: AccountFilesProject = { binding, workspace, projectDirectory: { binding, prepare: async () => {} } }
      const identity = (inode: string) => ({ device: '7', inode, mountId: '17', uid: 2000, gid: 2000, mode: 0o40700 })
      const grant: ExecutionMountGrant = { binding, sessionId: agent.session.id, workspaceId: workspace.id,
        project: { rootPath: projectPath, rootDevice: '4', rootInode: '11', rootMountId: '14', mountVersion: '4:11:14',
          quota: { device: '4', mountId: '14', maximumBytes: '8192', maximumInodes: '200' }, readOnlyPaths: ['.pe'],
          metadataDirectory: { device: '4', inode: '12', mountId: '14', uid: 2000, gid: 2000, mode: 0o40700, relativePath: '.pe' } },
        environment: { rootPath: `${accountRoot}/environments/one`, rootDevice: '7', rootInode: '2', rootMountId: '17',
          targetPath: '/opt/session-env', bankId: 'bank-1', slotId: 'one', slotGeneration: 1, environmentVersion: 'env-v1',
          rootReadOnly: true, writablePaths: ['home', 'venv', 'tmp'],
          quota: { device: '7', mountId: '17', maximumBytes: '8192', maximumInodes: '200' },
          layout: { home: identity('21'), venv: identity('22'), tmp: identity('23') } } }
      filesCurrent.mockImplementation((selected) => {
        expect(selected).toBe(grant)
        // Coordinator checks once before sharing; the adapter must invoke this same authority before opening a source.
        if (filesCurrent.mock.calls.length === 2) throw denied
      })
      const scripted = { projectFor: async () => project, prepareExecutionMounts: async () => ({ value: grant, release }),
        assertExecutionMountGrant: filesCurrent }
      const files = new Proxy(CloudAccountFiles.prototype, { get(_target, key): unknown {
        const value: unknown = Reflect.get(scripted, key)
        if (value === undefined) throw new Error('Unexpected scripted files operation.')
        return value
      } })
      const port = f.ctx.peSandboxCoordinator.bindAccount(setup, binding, () => { lifetime.signal.throwIfAborted() }, {
        assertBusinessCurrent: () => { lifetime.signal.throwIfAborted() }, getAgent: id => setup.agents.get(id),
        projectForAgent: () => workspace, projectForSession: () => workspace, files: () => files,
      })
      installIssuedExecutionPort(setup, port)
      setup.loader.builtins['shared-account'] = account
      setup.loader.builtins['shared-bash'] = ToolBash
    })
    accountContext = ctx
    const entry = [...ctx.loader.entries()].find(candidate => candidate.options.id === 'execution-account')
    expect(entry?.fiber).toBeDefined()
    await entry?.fiber?.await()
    const agent = ctx.agents.get(SessionId('shared-path-denied-agent'))
    expect(agent).toBeDefined()
    if (agent === undefined) throw new Error('The original native Agent is unavailable.')
    const result = await ctx.tools.execute({ callId: ToolCallId('shared-path-files-refusal'), name: 'bash', agent,
      signal: new AbortController().signal, arguments: { command: 'printf blocked', description: 'Check revoked files grant.' } })
    expect(result.isError).toBe(true)
    expect(filesCurrent).toHaveBeenCalledTimes(2)
    expect(release).toHaveBeenCalledOnce()
    expect(io.sourceOpens).toHaveLength(0)
    expect(sdkCreate).not.toHaveBeenCalled()
    expect(network).not.toHaveBeenCalled()
    expect(io.queries).toHaveLength(2)
    expect(io.planCurrent).toBe(true)
    // A current plan and available Root coordinator do not certify files-grant or source-volume health.
    expect(() => { f.ctx.peSandboxCoordinator.assertReady() }).not.toThrow()
  } finally {
    await accountContext?.fiber.dispose()
    await f.close()
    rmSync(temporary, { recursive: true, force: true })
  }
  expect(io.fds.size).toBe(0)
})
