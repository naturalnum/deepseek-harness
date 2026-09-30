/** Fixed private projections for account policy and explicit administrator initialization. */
import { readFile } from 'node:fs/promises'

/** Deployment projection of the operator-owned account policy. */
export const accountManagementPath = '/run/power-evolve/private/account-management.json'
/** Deployment projection selected only for explicit first-administrator initialization. */
export const accountBootstrapPath = '/run/power-evolve/private/account-bootstrap.json'

/** Return whether deployment values explicitly enable the one-shot bootstrap file.
 * @param input Optional accounts object from deployment values.
 * @returns Whether the Platform may read the bootstrap projection.
 */
export function accountBootstrapEnabled(input) {
  if (input === undefined) return false
  if (!input || typeof input !== 'object' || Array.isArray(input)
    || Object.keys(input).some(key => key !== 'bootstrap') || typeof input.bootstrap !== 'boolean') {
    throw new Error('Invalid account deployment settings')
  }
  return input.bootstrap
}

/** Validate projected account files without returning passwords or parser diagnostics.
 * @param bootstrapPath Selected fixed bootstrap projection, or empty to disable it.
 * @param readText Reader restricted to projected private files.
 * @returns Completion after the runtime parsers accept the selected configuration.
 */
export async function validateAccountStartup(bootstrapPath, readText = filename => readFile(filename, 'utf8')) {
  try {
    if (bootstrapPath && bootstrapPath !== accountBootstrapPath) throw new Error('Invalid projection')
    const { loadAccountManagementConfig, loadAccountBootstrapConfig } =
      await import('../application/lib/platform/account-config.js')
    await loadAccountManagementConfig(accountManagementPath, readText)
    await loadAccountBootstrapConfig(bootstrapPath || '', readText)
  } catch { throw new Error('Invalid account deployment configuration') }
}
