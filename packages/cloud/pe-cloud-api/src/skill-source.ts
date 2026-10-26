/** Native filesystem discovery over one files-owned snapshot and optional admitted caller projection. */
import { posix } from 'node:path'
import type { Context } from '@deepseek-ai/cordis'
import { FsError, FsTargetKey, FsVersion, type FsTarget } from '@deepseek-ai/dsh-fs'
import { FileSystemSkillProvider, type FileSystemSkillReader, type FileSystemSkillSource,
  type FileSystemSkillResources } from '@deepseek-ai/dsh-skill-filesystem'
import type { SkillProviderControl, SkillViewOptions } from '@deepseek-ai/dsh-skill'
import type { SkillVersion, SkillVersionPort } from '@deepseek-ai/dsh-pe-cloud-files'
import { FdMutationFailure } from '@deepseek-ai/dsh-pe-cloud-files'
import { CloudApiError } from './errors.ts'
import { ConfigSaveOutcomeUnknown } from './config-saves.ts'

/**
 * Complete projection after admission by the original graph adapter.
 * @param version Exact files-issued immutable version.
 * @param options Original lookup scope and cancellation.
 * @returns Complete caller-usable resource guidance after actual files work settles.
 */
export type SkillResourceMaterializer = (version: SkillVersion, options: SkillViewOptions) => Promise<FileSystemSkillResources>

/** Original account guards precede source I/O; complete projection rechecks that same caller after awaits. */
export interface SkillResourcePreparation {
  /** @param options Original lookup scope, requiring an exact live Agent and its currently approved project. */
  assertCaller(options: SkillViewOptions): void
  readonly materialize: SkillResourceMaterializer
}

/**
 * Use W5's native parser and W4's actual no-follow/hash-verified snapshot for this exact version.
 * @param ctx Original account's native skill scope.
 * @param control Original registry registration, not a synthetic invalidation callback.
 * @param port Same graph's files-issued version port.
 * @param version Exact files-issued immutable handle.
 * @param materialize Optional original live Agent/project admission and complete files projection.
 * @returns Native provider whose resource-bearing get explicitly rejects until real project projection exists.
 */
export function skillProviderFor(ctx: Context, control: SkillProviderControl, port: SkillVersionPort,
  version: SkillVersion, materialize?: SkillResourceMaterializer): FileSystemSkillProvider {
  const virtual = `/skill-source/${version.id}`
  const source: FileSystemSkillSource = {
    async withFiles(consume, options) {
      try {
        const result = await port.withSource(version, async (snapshot, signal) => {
          const targets = new WeakMap<FsTarget, string>()
          const current = (target: FsTarget): string => {
            signal.throwIfAborted(); options.signal?.throwIfAborted()
            const path = targets.get(target)
            if (path === undefined) throw new FsError('The skill snapshot target is unavailable.', 'FS_PERMISSION_DENIED')
            return path
          }
          const files: FileSystemSkillReader = {
            // oxlint-disable-next-line typescript/require-await -- The asynchronous reader reports target failures as rejections.
            async resolve(path) {
              signal.throwIfAborted(); options.signal?.throwIfAborted()
              const normalized = posix.resolve(path)
              if (![virtual, `${virtual}/SKILL.md`, `${virtual}/resource.bin`].includes(normalized)) {
                throw new FsError('The skill snapshot target is unavailable.', 'FS_PERMISSION_DENIED')
              }
              const target = Object.freeze({ targetKey: FsTargetKey(`${version.id}:${normalized}`), displayPath: normalized })
              targets.set(target, normalized)
              return target
            },
            processPath(target) { return current(target) },
            // oxlint-disable-next-line typescript/require-await -- The asynchronous reader reports released-target failures as rejections.
            async stat(target) {
              const path = current(target)
              if (path === virtual) return { type: 'directory', version: FsVersion(version.id), size: 0 }
              if (path === `${virtual}/SKILL.md`) return { type: 'file', version: FsVersion(version.skillSha256), size: version.skillBytes }
              return { type: 'file', version: FsVersion(version.resourceSha256), size: version.resourceBytes }
            },
            async listDir(target) {
              if (current(target) !== virtual) throw new FsError('The skill target is not a directory.', 'FS_NOT_DIRECTORY')
              return Promise.all(['SKILL.md', 'resource.bin'].map(async name =>
                ({ name, type: 'file' as const, target: await files.resolve(`${virtual}/${name}`) })))
            },
            async readText(target, signal) {
              if (current(target) !== `${virtual}/SKILL.md`) throw new FsError('The skill target is not instruction text.', 'FS_NOT_TEXT')
              return snapshot.readText('SKILL.md', signal)
            },
          }
          return consume({ files, materialize: (_directory, options) => materialize === undefined
            ? Promise.reject(new FsError('Account skill project resources are unavailable.', 'FS_PERMISSION_DENIED'))
            : materialize(snapshot.version, options) })
        }, options.signal ?? version.binding.lifetime)
        try { return result.value } finally { result.release() }
      } catch (error) {
        if (error instanceof ConfigSaveOutcomeUnknown
          || error instanceof FdMutationFailure && error.outcome === 'unknown') throw new ConfigSaveOutcomeUnknown()
        throw new CloudApiError('cloud/account-unavailable', 'The complete account skill source is unavailable.')
      }
    },
  }
  return new FileSystemSkillProvider(ctx, control, { providerName: 'account-published-skills',
    includeDefaultRoots: false, customSkillDirs: [virtual], watch: false }, source)
}
