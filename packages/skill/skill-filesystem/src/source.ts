/** Borrowed filesystem reads and completed resource projection for the native skill parser. */
import type { FileSystem } from '@deepseek-ai/dsh-fs'
import type { SkillResourceBase, SkillViewOptions } from '@deepseek-ai/dsh-skill'

/** Read-only native filesystem operations available only inside the source callback. */
export type FileSystemSkillReader = Pick<FileSystem, 'resolve' | 'processPath' | 'stat' | 'listDir' | 'readText'>

/** Public guidance after complete resource preparation; source-private paths are never implicit defaults. */
export interface FileSystemSkillResources {
  /** Resource location usable by the admitted caller after preparation completes. */
  readonly resourceBase: SkillResourceBase
  /** Public instruction-file path; omission exposes no path from the private discovery source. */
  readonly path?: string
}

/** Optional programmatic source; the provider keeps native discovery and frontmatter parsing. */
export interface FileSystemSkillSource {
  /**
   * Retain one source through the callback's complete reads and resource preparation, including after observer cancellation.
   * The source owns authorization and lifetime; callback failure must retain its original outcome.
   * @param consume Native parser work using only this borrowed reader and materializer.
   * @param options Original registry view object, including the original caller and cancellation signal.
   * @returns The callback result after its actual work settles and the source is released.
   */
  withFiles<T>(consume: (source: {
    readonly files: FileSystemSkillReader
    /**
     * Prepare all resources for this source directory without releasing its borrow early.
     * @param directory Private directory selected by native discovery.
     * @param options Original registry view object; the source must authorize its caller.
     * @returns Complete public guidance; rejection publishes no partial skill definition.
     */
    materialize(directory: string, options: SkillViewOptions): Promise<FileSystemSkillResources>
  }) => Promise<T>, options: SkillViewOptions): Promise<T>
}
