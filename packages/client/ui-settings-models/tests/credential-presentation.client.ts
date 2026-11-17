/** Test-owned display data supplied through the public embedding callbacks; no Cloud source import. */
import type { ModelsCredentialEditing } from '../src/client/operations.ts'
export const CREDENTIAL_COPY = { keyEditUnavailable: 'Test editing scope unavailable' }
export const credentialPresentation: Pick<ModelsCredentialEditing, 'unavailable' | 'layoutFor'> = {
  unavailable: () => CREDENTIAL_COPY.keyEditUnavailable,
  layoutFor: provider => provider === 'deepseek-official' ? 'deepseek' : undefined,
}
