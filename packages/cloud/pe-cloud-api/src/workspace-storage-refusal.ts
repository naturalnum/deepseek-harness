/** Confirmed storage-capacity refusals shared by workspace write routes. */
import { FdMutationFailure } from '@deepseek-ai/dsh-pe-cloud-files'

/**
 * Decode a Files storage refusal after the mutation owner confirms no publication.
 * @param error Original mutation settlement from Files.
 * @returns A public capacity reason, or undefined if there is no confirmed capacity refusal.
 */
export function workspaceStorageRefusal(error: unknown): 'quota-exceeded' | 'disk-full' | undefined {
  if (!(error instanceof FdMutationFailure) || error.outcome !== 'not-published') return undefined
  return error.syscallCode === 'EDQUOT' ? 'quota-exceeded' : error.syscallCode === 'ENOSPC' ? 'disk-full' : undefined
}
