/** Native parser over one files-issued complete immutable tree; no private filesystem access. */
import { posix } from 'node:path'
import type { Context } from '@deepseek-ai/cordis'
import type { Workspace } from '@deepseek-ai/dsh-workspace/types'
import { FsError, FsTargetKey, FsVersion, type FsTarget } from '@deepseek-ai/dsh-fs'
import { FileSystemSkillProvider, type FileSystemSkillReader, type FileSystemSkillSource,
  type FileSystemSkillResources } from '@deepseek-ai/dsh-skill-filesystem'
import type { SkillProviderControl, SkillViewOptions } from '@deepseek-ai/dsh-skill'
import type { SkillBundleLimits, SkillBundlePort, SkillBundleVersion } from '@deepseek-ai/dsh-pe-cloud-files'
import type { ManagedSkillApiLimits } from './managed-skill-types.ts'

/** Original live Agent/project admission, independent from standing discovery or workspace selection. */
export interface ManagedSkillResourcePreparation {
  /** @param options Exact original native caller, not a reconstructed Agent or workspace scope. */
  assertCaller(options: SkillViewOptions): void
  /**
   * @param version Exact operation-scoped files-issued lease from the active source callback.
   * @param options Original admitted native caller.
   * @returns Complete projected resources.
   */
  materialize(version: SkillBundleVersion, options: SkillViewOptions): Promise<FileSystemSkillResources>
}

/** Explicit trusted assembly; Root supplies the installed files policy and original workspace guard. */
export interface ManagedSkillPreparation {
  readonly limits: ManagedSkillApiLimits
  readonly bundleLimits: SkillBundleLimits
  /** @param workspace Original account registry entity; this performs the existing ownership check. */
  assertWorkspace(workspace: Workspace): void
  readonly resources?: ManagedSkillResourcePreparation
}

/**
 * Adapt a complete files-owned source to the unchanged native provider and parser.
 * @param ctx Original native registry scope.
 * @param control Original registration lifetime and invalidation.
 * @param port Original bound files bundle port.
 * @param version Issued immutable handle; never reconstructed from public id/hash.
 * @param resources Original live projection capability, when installed.
 * @returns Native discovery and loading, with body/resource preparation under the same source borrow.
 */
export function managedSkillProviderFor(ctx: Context, control: SkillProviderControl, port: SkillBundlePort,
  version: SkillBundleVersion, resources?: ManagedSkillResourcePreparation): FileSystemSkillProvider {
  const virtual = `/skill-source/${version.id}`
  const source: FileSystemSkillSource = {
    async withFiles(consume, options) {
      const held = await port.withBundleSource(version, async (snapshot, signal) => {
        const members = new Map(snapshot.files.map(file => [file.relativePath, file]))
        const directories = new Set(['', ...snapshot.directories])
        const targets = new WeakMap<FsTarget, string>()
        const current = (target: FsTarget): string => {
          signal.throwIfAborted(); options.signal?.throwIfAborted()
          const path = targets.get(target)
          if (path === undefined) throw new FsError('The skill source target is unavailable.', 'FS_PERMISSION_DENIED')
          return path
        }
        const files: FileSystemSkillReader = {
          // oxlint-disable-next-line typescript/require-await -- filesystem reader failures are asynchronous.
          async resolve(path) {
            signal.throwIfAborted(); options.signal?.throwIfAborted()
            const normalized = posix.resolve(path), relative = posix.relative(virtual, normalized)
            if (normalized !== '/skill-source' && (relative === '..' || relative.startsWith('../') || posix.isAbsolute(relative))) {
              throw new FsError('The skill source target is unavailable.', 'FS_PERMISSION_DENIED')
            }
            const target = Object.freeze({ targetKey: FsTargetKey(`${version.id}:${normalized}`), displayPath: normalized })
            targets.set(target, relative)
            return target
          },
          processPath(target) { return posix.join(virtual, current(target)) },
          // oxlint-disable-next-line typescript/require-await -- filesystem reader failures are asynchronous.
          async stat(target) {
            const relative = current(target), member = members.get(relative)
            if (member !== undefined) return { type: 'file', version: FsVersion(member.sha256), size: member.bytes }
            return relative === '..' || directories.has(relative)
              ? { type: 'directory', version: FsVersion(version.treeSha256), size: 0 } : undefined
          },
          async listDir(target) {
            const parent = current(target)
            if (parent === '..') return [{ name: version.id, type: 'directory', target: await files.resolve(virtual) }]
            if (!directories.has(parent)) throw new FsError('The skill target is not a directory.', 'FS_NOT_DIRECTORY')
            const direct = (path: string): boolean => path !== '' && (posix.dirname(path) === '.' ? '' : posix.dirname(path)) === parent
            return Promise.all([...snapshot.directories.filter(direct).map(path => ({ path, type: 'directory' as const })),
              ...snapshot.files.filter(file => direct(file.relativePath)).map(file => ({ path: file.relativePath, type: 'file' as const }))]
              .map(async entry => ({ name: posix.basename(entry.path), type: entry.type,
                target: await files.resolve(posix.join(virtual, entry.path)) })))
          },
          async readText(target, readSignal) {
            if (current(target) !== 'SKILL.md') throw new FsError('The skill target is not instruction text.', 'FS_NOT_TEXT')
            return snapshot.readText('SKILL.md', readSignal)
          },
        }
        return consume({ files, materialize: (_directory, lookup) => resources === undefined
          ? Promise.reject(new FsError('Account skill project resources are unavailable.', 'FS_PERMISSION_DENIED'))
          : resources.materialize(snapshot.version, lookup) })
      }, options.signal ?? version.binding.lifetime)
      try { return held.value } finally { held.release() }
    },
  }
  return new FileSystemSkillProvider(ctx, control, { providerName: 'account-published-skills', includeDefaultRoots: false,
    customSkillDirs: ['/skill-source'], watch: false }, source)
}
