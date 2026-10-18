/** S2 native service over one genuinely registered project; ungranted file capabilities reject before I/O. */
import type { Context } from '@deepseek-ai/cordis'
import FileSystem, { FsError } from '@deepseek-ai/dsh-fs'
import type { AccountBinding } from '@deepseek-ai/dsh-pe-cloud-runtime/types'
import type { Workspace } from '@deepseek-ai/dsh-workspace'
import type { FixedRootReader } from './read-only.ts'

/** Native service constructor installed by the trusted graph recipe, never a client-selected provider. */
export interface S2FileSystemConstructor {
  new(ctx: Context): FileSystem
  readonly inject: readonly string[]
}

/** Fixed graph directory capability matches the native Session adapter without depending on API. */
export interface S2ProjectDirectory {
  readonly binding: AccountBinding
  /**
   * Validate the already registered project on the original lane; never mkdir or mint authority from cwd.
   * @param cwd Exact native project address already chosen by account admission.
   * @returns Actual current directory verification, usable after registration closes.
   */
  prepare(cwd: string): Promise<void>
}

/** Component output only; account activation still requires a real deployment storage issuer. */
export interface S2ProjectPort {
  readonly binding: AccountBinding
  readonly workspaceId: Workspace['id']
  readonly FileSystem: S2FileSystemConstructor
  readonly projectDirectory: S2ProjectDirectory
}

/** Supplied only by the bound pool after its actual native Registry selected the default Workspace. */
export interface S2ProjectBackend {
  readonly binding: AccountBinding
  readonly workspace: Workspace
  readonly reader: FixedRootReader
  assertCurrent(): void
  assertInstalled(ctx: Context): void
}

/**
 * Compose the complete native method table for a fixed metadata-only S2 scope.
 * @param backend Actual same-lane project reader and original native Registry/current checks.
 * @returns Native FS constructor and directory validation, with no write, content, preview or execution authority.
 */
export function createS2ProjectPort(backend: S2ProjectBackend): S2ProjectPort {
  backend.assertCurrent()
  const rootPath = backend.workspace.path
  const reader = backend.reader
  const denied = (): FsError => {
    backend.assertCurrent()
    return new FsError('This file capability is not granted by the S2 recipe.', 'FS_PERMISSION_DENIED')
  }
  const refused = <T>(): Promise<T> => Promise.resolve().then(() => { throw denied() })
  class ProjectFileSystem extends FileSystem {
    static inject = ['peAccount']

    constructor(ctx: Context) {
      backend.assertInstalled(ctx)
      if (ctx.get('fs') !== undefined) throw new FsError('A native filesystem is already installed.', 'FS_PERMISSION_DENIED')
      super(ctx)
    }

    override async resolve(...args: Parameters<FileSystem['resolve']>): ReturnType<FileSystem['resolve']> {
      backend.assertCurrent()
      const target = await reader.resolve(...args)
      backend.assertCurrent()
      return target
    }

    override async stat(...args: Parameters<FileSystem['stat']>): ReturnType<FileSystem['stat']> {
      backend.assertCurrent()
      const info = await reader.stat(...args)
      backend.assertCurrent()
      return info
    }

    override processPath(...args: Parameters<FileSystem['processPath']>): string {
      backend.assertCurrent()
      return reader.processPath(...args)
    }

    override fileUrl(..._args: Parameters<FileSystem['fileUrl']>): never { throw denied() }
    override contains(..._args: Parameters<FileSystem['contains']>): never { throw denied() }
    override lstat(..._args: Parameters<FileSystem['lstat']>): ReturnType<FileSystem['lstat']> { return refused() }
    override readText(..._args: Parameters<FileSystem['readText']>): ReturnType<FileSystem['readText']> { return refused() }
    override streamText(..._args: Parameters<FileSystem['streamText']>): ReturnType<FileSystem['streamText']> { return refused() }
    override readBytes(..._args: Parameters<FileSystem['readBytes']>): ReturnType<FileSystem['readBytes']> { return refused() }
    override readByteRange(..._args: Parameters<FileSystem['readByteRange']>): ReturnType<FileSystem['readByteRange']> { return refused() }
    override listDir(..._args: Parameters<FileSystem['listDir']>): ReturnType<FileSystem['listDir']> { return refused() }
    override writeText(..._args: Parameters<FileSystem['writeText']>): ReturnType<FileSystem['writeText']> { return refused() }
    override editText(..._args: Parameters<FileSystem['editText']>): ReturnType<FileSystem['editText']> { return refused() }
    override watch(..._args: Parameters<FileSystem['watch']>): ReturnType<FileSystem['watch']> { return refused() }
    override processPathFromHostPath(..._args: Parameters<FileSystem['processPathFromHostPath']>): undefined {
      backend.assertCurrent()
      return undefined
    }
  }
  const projectDirectory: S2ProjectDirectory = Object.freeze({
    binding: backend.binding,
    prepare: async (cwd: string) => {
      backend.assertCurrent()
      if (cwd !== rootPath) throw denied()
      const target = await reader.resolve('.')
      const info = await reader.stat(target)
      backend.assertCurrent()
      if (info?.type !== 'directory' || reader.processPath(target) !== rootPath) {
        throw new FsError('The approved native project directory is unavailable.', 'FS_NOT_DIRECTORY')
      }
    },
  })
  return Object.freeze({ binding: backend.binding, workspaceId: backend.workspace.id, FileSystem: ProjectFileSystem, projectDirectory })
}
