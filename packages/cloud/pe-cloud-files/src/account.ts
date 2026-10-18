/** Account Loader entry installs the runtime-prepared files owner's real native providers. */
import type { Context } from '@deepseek-ai/cordis'
import z from '@deepseek-ai/schemastery'
import { FilesFailure } from './error.ts'
import { CloudAccountFiles } from './account-service.ts'
import WorkspaceRegistry from '@deepseek-ai/dsh-workspace'

/** Account plugin identity. */
export const name = 'pe-cloud-files/account'
/** Preserve native Registry dependencies; a missing prepared files owner fails when the entry activates. */
export const inject = WorkspaceRegistry.inject
/** This entry accepts no client-selectable account, path, or pool parameters. */
export interface Config {}
/** Account identity and roots must arrive through the runtime's trusted mount port. */
export const Config: z<Config> = z.transform(z.object({}), (config) => {
  if (Object.keys(config).length !== 0) throw new FilesFailure('files/prerequisite-missing', 'Account files Loader configuration must be empty.')
  return config
})

/**
 * Require the prepared graph owner and await its actual native Registry/FS installation.
 * @param ctx - independent account Loader scope.
 * @param config - empty Loader configuration.
 * @returns Actual native installation settlement; it does not publish account readiness or certify cleanup.
 */
export const apply = (ctx: Context, config: Config): Promise<void> => {
  Config(config)
  const files = ctx.get('peCloudFiles')
  if (!(files instanceof CloudAccountFiles)) {
    throw new FilesFailure('files/prerequisite-missing', 'pe-cloud-files/account requires its runtime-bound account files owner.')
  }
  return files.install(ctx).then(() => {})
}
