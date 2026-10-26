/** Explicit trial deployment data shared by native component fixtures, never framework defaults. */
import { credentialRef } from '@deepseek-ai/dsh-credentials'
import type { CredentialRef } from '@deepseek-ai/dsh-credentials'
import type { ApprovedModelKeyBinding } from '../src/types.ts'
export const MODEL_KEY_FIXTURE = Object.freeze({ ref: credentialRef('DEEPSEEK_API_KEY'),
  provider: 'deepseek-official', plugin: '@deepseek-ai/dsh-llm-deepseek-api-key' })
/** @param providerEntryId Actual fixture entry. @param ref Explicit fixture ref. @returns Root-selected native binding data. */
export function modelKeyBinding(providerEntryId: string, ref: CredentialRef = MODEL_KEY_FIXTURE.ref): ApprovedModelKeyBinding {
  return { provider: MODEL_KEY_FIXTURE.provider, providerEntryId, moduleName: MODEL_KEY_FIXTURE.plugin, ref }
}
