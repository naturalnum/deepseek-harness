/** Node startup identity creation for the process instance-registration owner. */
import { randomUUID } from 'node:crypto'
import { brandString } from '@deepseek-ai/dsh-brand'
import type { InstanceId } from './types.ts'
import type { OwnerStoreIdentity } from './owner-types.ts'

/**
 * Generate fresh identity at root process startup, never from deployment/account/wire data.
 * The root owns one registration component and shares this exact identity with its owner store.
 * @returns An immutable, server-generated identity; no persistent id is reused after restart.
 */
export function createProcessInstanceIdentity(): OwnerStoreIdentity {
  return Object.freeze({ instanceId: brandString<InstanceId>(randomUUID()) })
}
