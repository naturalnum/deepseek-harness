/** Graph-local directory I/O and failure classification for native Workspaces. */
import { mkdir, stat } from 'node:fs/promises'
import { fullyQualifiedWorkspacePath, realpathNormalize } from './paths.ts'
import type { WorkspaceDirectoryMetadata } from './types.ts'

/** A determinate filesystem result or an unavailable injected observation. */
export class WorkspaceDirectoryMetadataError extends Error {
  /**
   * @param reason - Missing corresponds to ENOENT; not-directory to ENOTDIR.
   * Unavailable never establishes filesystem absence or operation rollback.
   * @param options - Original provider failure, preserved as cause.
   */
  constructor(
    readonly reason: 'missing' | 'not-directory' | 'unavailable',
    options?: ErrorOptions,
  ) {
    super(`Workspace directory metadata: ${reason}.`, options)
    this.name = 'WorkspaceDirectoryMetadataError'
  }
}

/** The registry-owned fixed provider; its Node branch retains native errors. */
export class DirectoryMetadataAccess implements WorkspaceDirectoryMetadata {
  private readonly provider: WorkspaceDirectoryMetadata | undefined
  private closed = false

  /**
   * @param provider - Fixed injected operations, or the original Node backend.
   * @param isDisposed - Owning fiber's disposal state, including pending cleanup.
   */
  constructor(provider: WorkspaceDirectoryMetadata | undefined, private readonly isDisposed: () => boolean) {
    this.provider = provider === undefined ? undefined : Object.freeze({
      canonicalPath: provider.canonicalPath.bind(provider),
      isDirectory: provider.isDirectory.bind(provider),
      ensureDirectory: provider.ensureDirectory.bind(provider),
    })
  }

  /** Whether this registry uses the strict injected failure policy. */
  get injected(): boolean { return this.provider !== undefined }

  /** Close injected operation admission without claiming actual I/O settlement. */
  close(): void { this.closed = true }

  /** Reject use of an injected provider after its owning graph has closed. */
  assertAvailable(): void {
    if (this.provider !== undefined && this.isClosed()) {
      throw new WorkspaceDirectoryMetadataError('unavailable')
    }
  }

  async canonicalPath(path: string): Promise<string> {
    const provider = this.provider
    if (provider === undefined) return await realpathNormalize(path)
    this.assertAvailable()
    if (!fullyQualifiedWorkspacePath(path)) {
      throw new TypeError(`Workspace path is not fully qualified: '${path}'`)
    }
    return await this.observe(() => provider.canonicalPath(path))
  }

  async isDirectory(path: string): Promise<boolean> {
    const provider = this.provider
    if (provider === undefined) return (await stat(path)).isDirectory()
    return await this.observe(() => provider.isDirectory(path))
  }

  async ensureDirectory(path: string): Promise<void> {
    const provider = this.provider
    if (provider === undefined) {
      await mkdir(path, { recursive: true })
      return
    }
    await this.observe(() => provider.ensureDirectory(path))
  }

  private isClosed(): boolean { return this.closed || this.isDisposed() }

  private async observe<T>(operation: () => Promise<T>): Promise<T> {
    this.assertAvailable()
    let value: T
    try {
      value = await operation()
    } catch (error) {
      if (!this.isClosed() && error instanceof WorkspaceDirectoryMetadataError) throw error
      throw new WorkspaceDirectoryMetadataError('unavailable', { cause: error })
    }
    this.assertAvailable()
    return value
  }
}
