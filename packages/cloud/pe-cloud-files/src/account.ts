/** Account Loader entry; no host filesystem or successful placeholder is installed. */
import type { Context } from '@deepseek-ai/cordis'
import z from '@deepseek-ai/schemastery'
import { FilesFailure } from './error.ts'

/** Account plugin identity. */
export const name = 'pe-cloud-files/account'
/** Missing mount inputs fail here instead of waiting indefinitely for optional injection. */
export const inject = []
/** This entry accepts no client-selectable account, path, or pool parameters. */
export interface Config {}
/** Account identity and roots must arrive through the runtime's trusted mount port. */
export const Config: z<Config> = z.object({})

/**
 * Refuse mounting without a runtime-verified port and the complete native provider.
 * @param _ctx - independent account context.
 * @param _config - empty Loader configuration.
 */
export function apply(_ctx: Context, _config: Config): never {
  throw new FilesFailure('files/prerequisite-missing',
    'pe-cloud-files/account requires a runtime-bound account/epoch/root files port and the native FileSystem provider')
}
