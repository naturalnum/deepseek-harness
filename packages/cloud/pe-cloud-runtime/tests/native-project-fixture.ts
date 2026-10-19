/** Owned Node directory observations for native component tests; no FD/quota/storage approval. */
import { statSync } from 'node:fs'
import { isAbsolute, relative, resolve } from 'node:path'
import type { Context } from '@deepseek-ai/cordis'
import FsLocal from '@deepseek-ai/dsh-fs-local'
import { FsError } from '@deepseek-ai/dsh-fs'
import type { AccountFilesPreparation, ResolveAccountFileProject } from '@deepseek-ai/dsh-pe-cloud-files'
import type { AccountBinding } from '../src/types.ts'

type PathOptions = { cwd?: string }
type ResolveOptions = { cwd?: string; signal?: AbortSignal }
interface RoutedFileSystemPlugin {
  new(owner: Context): FsLocal
  inject: string[]
}

export function nativeProjectDeriver(
  binding: AccountBinding, current: () => void, observed?: (cwd: string) => void | Promise<void>,
): NonNullable<AccountFilesPreparation['projectFor']> {
  return async (workspace, assertRegistered, signal) => {
    current()
    assertRegistered()
    signal?.throwIfAborted()
    return { binding, workspace, projectDirectory: { binding, prepare: async (cwd) => {
      current()
      assertRegistered()
      if (cwd !== workspace.path || !statSync(cwd).isDirectory()) throw new Error('Outside the original native fixture Workspace')
      await observed?.(cwd)
      current()
      assertRegistered()
    } } }
  }
}

/** Node-only path confinement exercises Runtime selection, without supplying a production storage port. */
export function nativeRoutedFileSystem(cwd: string, getProject: ResolveAccountFileProject): RoutedFileSystemPlugin {
  return class NativeRoutedFileSystem extends FsLocal {
    static inject = ['peAccount']
    constructor(owner: Context) { super(owner, FsLocal.Config({ cwd })) }
    private async selected(path: string, options?: PathOptions, signal?: AbortSignal) {
      const selected = await getProject(this.ctx, signal)
      selected.assertCurrent()
      const root = selected.workspace.path, actualCwd = options?.cwd ?? root
      const part = relative(root, resolve(actualCwd, path))
      if (part === '..' || part.startsWith('../') || isAbsolute(part) || actualCwd !== root) {
        throw new FsError('Outside the selected original native Workspace.', 'FS_PERMISSION_DENIED')
      }
      return { selected, cwd: actualCwd }
    }
    override async resolve(path: string, options?: ResolveOptions) {
      const { selected, cwd } = await this.selected(path, options, options?.signal)
      const target = await super.resolve(path, { cwd, ...options?.signal === undefined ? {} : { signal: options.signal } })
      selected.assertCurrent()
      return target
    }
    override async lstat(path: string, options?: PathOptions, signal?: AbortSignal) {
      const { selected, cwd } = await this.selected(path, options, signal)
      const value = await super.lstat(path, { cwd }, signal)
      selected.assertCurrent()
      return value
    }
  }
}
