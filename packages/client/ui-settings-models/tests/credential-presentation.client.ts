/** Test-owned display data supplied through the public embedding callbacks; no Cloud source import. */
import type { ModelsCredentialEditing, ModelsCredentialCopy } from '../src/client/operations.ts'
export const CREDENTIAL_COPY: ModelsCredentialCopy = {
  'editKey': 'Edit API key',
  'removeKey': 'Remove API key',
  'removeKeyTitle': 'Remove this API key?',
  'removeKeyDescription': 'Only the stored API key is removed. Provider and model settings are kept.',
  'removingKey': 'Removing API key…',
  'keyPreparing': 'Preparing API key editor…',
  'keyEditUnavailable': 'This editing page is unavailable. Close it and reopen to check the current state.',
}
export const credentialPresentation: Pick<ModelsCredentialEditing, 'copy' | 'unavailable' | 'layoutFor'> = {
  copy: () => CREDENTIAL_COPY,
  unavailable: () => CREDENTIAL_COPY.keyEditUnavailable,
  layoutFor: provider => provider === 'deepseek-official' ? 'deepseek' : undefined,
}
