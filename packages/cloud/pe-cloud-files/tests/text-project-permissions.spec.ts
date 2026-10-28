/** Real Loader/native FS mutation entry over a fake external file worker; no kernel or quota acceptance. */
import { mkdtempSync, mkdirSync, realpathSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join, posix } from 'node:path'
import { Context } from '@deepseek-ai/cordis'
import { boot } from '@deepseek-ai/dsh-app-boot'
import SessionStore, { SessionId } from '@deepseek-ai/dsh-session'
import Projections from '@deepseek-ai/dsh-session-projection'
import Storage from '@deepseek-ai/dsh-storage'
import * as JsonStorage from '@deepseek-ai/dsh-storage-json'
import * as DomainStorage from '@deepseek-ai/dsh-storage-domain'
import * as Jsonl from '@deepseek-ai/dsh-session-persistence-jsonl'
import WorkspaceRegistry from '@deepseek-ai/dsh-workspace'
import SandboxPolicy, { setSandboxMode } from '@deepseek-ai/dsh-sandbox-policy'
import { FsVersion } from '@deepseek-ai/dsh-fs'
import type { AccountBinding } from '@deepseek-ai/dsh-pe-cloud-runtime/types'
import { expect, it, onTestFinished, vi } from 'vitest'
import { createAccountFileMutationGuard } from '../../pe-cloud-runtime/src/account-permissions.ts'
import { createTextProjectFileSystem, type TextProjectBackend } from '../src/text-project.ts'
import { createFixedRootReader } from '../src/read-only.ts'

async function fixture(enabled = true) {
  const directory = realpathSync(mkdtempSync(join(tmpdir(), 'text-permissions-'))), project = join(directory, 'project')
  mkdirSync(project)
  const binding: AccountBinding = Object.freeze({ accountId: 'permission-test' as AccountBinding['accountId'],
    epoch: '1' as AccountBinding['epoch'], recipeVersion: 'native-file-policy-test', lifetime: new AbortController().signal })
  const config = join(directory, 'cordis.yml')
  const writes = vi.fn<TextProjectBackend['writeText']>(async (_path, content) => ({
    value: { operation: 'create', version: FsVersion('after'), before: null, after: content }, release() {},
  }))
  const owned: { graph?: Context } = {}
  let selected: ReturnType<Context['sessions']['create']> | undefined, missingGuard = false
  onTestFinished(async () => {
    try { await owned.graph?.fiber.dispose() }
    finally { rmSync(directory, { recursive: true, force: true }) }
  })
  writeFileSync(config, JSON.stringify([
    { id: 'sessions', name: 'cordis:sessions' }, { id: 'projections', name: 'cordis:projections' },
    { id: 'storage', name: 'cordis:storage' },
    { id: 'json', name: 'cordis:json', config: { root: join(directory, 'storage') } },
    { id: 'domain', name: 'cordis:domain', config: { backend: 'json' } },
    { id: 'jsonl', name: 'cordis:jsonl', config: { root: join(directory, 'sessions'), compression: 'none' } },
    { id: 'workspace', name: 'cordis:workspace' },
    { id: 'policy', name: 'cordis:policy', config: { mode: 'workspace-write', workspaceRoot: project } },
    { id: 'files', name: 'cordis:files' },
  ]))
  const graph = await boot('text-permissions-test', config, [], (root) => {
    root.provide('peAccount', binding)
    Object.assign(root.loader.builtins, {
      sessions: SessionStore, projections: Projections, storage: Storage, json: JsonStorage,
      domain: DomainStorage, jsonl: Jsonl, workspace: WorkspaceRegistry, policy: SandboxPolicy,
      files: {
        inject: ['workspaceRegistry', 'sandboxPolicy', 'sessions'],
        async apply(ctx: Context) {
          const workspace = await ctx.workspaceRegistry.create(project)
          const reader = createFixedRootReader(project, {
            maxPathBytes: 1024, assertCurrent() {}, stat: async () => ({ value: undefined, release() {} }),
            streamText: async () => (async function* () { yield 'original' })(),
          })
          const backend: TextProjectBackend = {
            binding, workspace, reader, maxPathBytes: 1024, assertCurrent() {}, assertInstalled() {},
            canonicalPath: async relative => posix.join(project, relative),
            readText: async () => ({ value: 'original', release() {} }),
            lstat: async () => ({ value: undefined, release() {} }), listDir: async () => ({ value: [], release() {} }),
            readBytes: async () => ({ value: new Uint8Array(), release() {} }),
            readByteRange: async () => ({ value: new Uint8Array(), release() {} }), writeText: writes,
          }
          const FileSystem = createTextProjectFileSystem({ binding, bootstrapWorkspace: workspace,
            enforceSessionFilePolicy: enabled, assertCurrent() {}, assertInstalled() {}, project: async () => backend,
            resolveProject: async () => {
              if (selected === undefined) throw new Error('No native Session was selected')
              return { workspace, assertCurrent() {}, ...missingGuard ? {} : {
                assertMutationPolicy: createAccountFileMutationGuard(ctx, selected, project, () => {}),
              } }
            },
          })
          await ctx.plugin(FileSystem)
        },
      },
    })
  })
  owned.graph = graph
  const first = graph.sessions.create(SessionId('first'), { meta: { cwd: project } })
  const second = graph.sessions.create(SessionId('second'), { meta: { cwd: project } })
  selected = first
  return { graph, first, second, writes, project,
    select: (session: typeof first) => { selected = session }, omitGuard: () => { missingGuard = true } }
}

it('enforces read-only inside the native write method before dispatching any worker mutation', async () => {
  const f = await fixture(), target = await f.graph.fs.resolve('hello.py')
  setSandboxMode(f.first, 'read-only')
  await expect(f.graph.fs.writeText(target, 'blocked')).rejects.toMatchObject({ code: 'FS_SANDBOX_DENIED' })
  await expect(f.graph.fs.writeText(target, 'direct override is not an escalation grant', undefined, undefined, {
    mode: 'workspace-write', workspaceRoot: f.project, sessionId: f.first.id,
  })).rejects.toMatchObject({ code: 'FS_SANDBOX_DENIED' })
  expect(f.writes).not.toHaveBeenCalled()
  setSandboxMode(f.first, 'workspace-write')
  await expect(f.graph.fs.writeText(target, 'permitted')).resolves.toMatchObject({ after: 'permitted' })
  expect(f.writes).toHaveBeenCalledTimes(1)
  expect(f.graph.fs.sandboxMode).toBe('workspace-write')
})

it('uses the current calling Session even when another Session in the workspace resolved the target', async () => {
  const f = await fixture(), target = await f.graph.fs.resolve('shared.py')
  setSandboxMode(f.second, 'read-only'); f.select(f.second)
  await expect(f.graph.fs.writeText(target, 'not allowed')).rejects.toMatchObject({ code: 'FS_SANDBOX_DENIED' })
  expect(f.writes).not.toHaveBeenCalled()
  f.select(f.first)
  await expect(f.graph.fs.writeText(target, 'allowed')).resolves.toMatchObject({ after: 'allowed' })
})

it('refuses a missing original mutation guard while permission enforcement is enabled', async () => {
  const f = await fixture(), target = await f.graph.fs.resolve('denied.py')
  f.omitGuard()
  await expect(f.graph.fs.writeText(target, 'blocked')).rejects.toMatchObject({ code: 'FS_SANDBOX_DENIED' })
  expect(f.writes).not.toHaveBeenCalled()
})

it('retains legacy writes only without an explicit policy request or enabled enforcement', async () => {
  const f = await fixture(false), target = await f.graph.fs.resolve('legacy.py')
  await expect(f.graph.fs.writeText(target, 'old contract')).resolves.toMatchObject({ after: 'old contract' })
  await expect(f.graph.fs.writeText(target, 'must not ignore policy', undefined, undefined, {
    mode: 'read-only', workspaceRoot: f.project, sessionId: f.first.id,
  })).rejects.toMatchObject({ code: 'FS_SANDBOX_DENIED' })
  expect(f.writes).toHaveBeenCalledTimes(1)
})
