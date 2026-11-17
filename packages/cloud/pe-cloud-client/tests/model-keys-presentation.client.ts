/** Actual Cloud display data used by the moved key-control purposes. */
import type { ModelsCredentialEditing } from '@deepseek-ai/dsh-client-ui-settings-models/client'
import { modelCredentialCopy, cloudModelEditorLayout } from '../src/client/model-credential-locales.ts'
export const CREDENTIAL_COPY = modelCredentialCopy.en
export const credentialPresentation: Pick<ModelsCredentialEditing, 'unavailable' | 'layoutFor'> = {
  unavailable: () => CREDENTIAL_COPY.keyEditUnavailable,
  layoutFor: cloudModelEditorLayout,
}
