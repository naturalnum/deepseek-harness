/** Account Loader entry; trusted runtime/files/native-save integration is required. */
import type { Context } from '@deepseek-ai/cordis'
import z from '@deepseek-ai/schemastery'
import { CloudApiError } from './errors.ts'

/** Account plugin identity. */
export const name = 'pe-cloud-api/account'
/** Account mount must fail explicitly while its trusted ports are unavailable. */
export const inject: string[] = []
/** Account identity, roots and save hooks cannot be selected in Loader JSON. */
export interface Config {}
/** There are no client-selectable account parameters. */
export const Config: z<Config> = z.object({})

/**
 * Refuse an incomplete account API rather than publish a native bypass.
 * @param _ctx - isolated account context.
 * @param _config - empty Loader configuration.
 * @throws CloudApiError until runtime binding, project ports and native F06 hooks are integrated.
 */
export function apply(_ctx: Context, _config: Config): never {
  throw new CloudApiError(
    'cloud/account-unavailable',
    'pe-cloud-api/account requires runtime-bound admission, verified project ports and native configuration save hooks.',
  )
}
