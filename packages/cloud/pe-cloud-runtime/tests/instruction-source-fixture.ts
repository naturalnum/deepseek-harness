/** In-memory fixed-root readers and counted reservations; no Linux FD, quota or ready authority. */
import { posix } from 'node:path'
import { FsError, FsTargetKey, FsVersion, type FsTarget } from '@deepseek-ai/dsh-fs'
import type { AccountFilesPreparation, InstructionReadReaders } from '@deepseek-ai/dsh-pe-cloud-files'
import type { Workspace } from '@deepseek-ai/dsh-workspace'
import { TextAdapter } from './account-policy-fixture.ts'

export const instructionLimits = {
  maxFiles: 8, maxFileBytes: 256, maxTotalBytes: 512, maxSnapshotBytes: 8192, maxResidentBytes: 400000,
}

export function instructionSourceFixture(options: { beforeBuild?: () => Promise<void>; failure?: FsError } = {}) {
  const adapter = new TextAdapter()
  const text = { account: 'account source belongs to this graph', project: 'project source belongs to its native Workspace' }
  const state = { reservations: [] as number[], workspaces: [] as Workspace[], heldBytes: 0, releases: 0, reads: [] as string[] }

  const bind = (assertCurrent: () => void): NonNullable<AccountFilesPreparation['withInstructionReaders']> =>
    async (workspace, bytes, build, signal) => {
      const current = (): void => { signal.throwIfAborted(); assertCurrent() }
      current()
      state.reservations.push(bytes)
      state.workspaces.push(workspace)
      state.heldBytes += bytes
      const release = (): void => { state.releases++; state.heldBytes -= bytes }
      const reader = (kind: keyof typeof text, root: string): InstructionReadReaders['project'] => {
        const issued = new WeakMap<FsTarget, string>()
        const file = (target: FsTarget, control?: AbortSignal): string => {
          current()
          control?.throwIfAborted()
          const path = issued.get(target)
          if (path === undefined) throw new FsError('Target belongs to another fixture reader.', 'FS_PERMISSION_DENIED')
          return path
        }
        const port: InstructionReadReaders['project'] = {
          async resolve(path, input) {
            current()
            input?.signal?.throwIfAborted()
            const absolute = posix.resolve(input?.cwd ?? root, path)
            const relative = posix.relative(root, absolute)
            if (relative !== '' && relative !== 'AGENTS.md' && relative !== 'CLAUDE.md') {
              throw new FsError('Outside the fixed fixture source.', 'FS_PERMISSION_DENIED')
            }
            if (relative === 'AGENTS.md' && kind === 'project' && options.failure !== undefined) throw options.failure
            const target = Object.freeze({ targetKey: FsTargetKey(`${kind}:${absolute}`), displayPath: absolute })
            issued.set(target, relative)
            return target
          },
          processPath(target) { file(target); return target.displayPath },
          async stat(target, control) {
            const path = file(target, control)
            return { version: FsVersion('instruction-fixture'), type: path === '' ? 'directory' : 'file',
              size: path === '' ? 0 : Buffer.byteLength(text[kind]) }
          },
          async streamText(target, control) {
            const path = file(target, control)
            if (path !== 'AGENTS.md') throw new FsError('Not the selected fixture instruction.', 'FS_NOT_FOUND')
            return (async function* () {
              current()
              control?.throwIfAborted()
              state.reads.push(`${kind}/${path}`)
              yield text[kind]
              current()
            })()
          },
        }
        return Object.freeze(port)
      }
      try {
        await options.beforeBuild?.()
        current()
        const value = await build({ account: reader('account', posix.join(workspace.path, '.fixture-account')),
          project: reader('project', workspace.path) }, signal)
        current()
        return { value, release }
      } catch (error) { release(); throw error }
    }
  return { adapter, text, state, bind }
}

export type InstructionSourceFixture = ReturnType<typeof instructionSourceFixture>
