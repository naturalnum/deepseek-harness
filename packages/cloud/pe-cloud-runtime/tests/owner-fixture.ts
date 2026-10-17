/** Synthetic teardown/row fixtures test the control store, not real graph or participant teardown. */
import { brandString } from '@deepseek-ai/dsh-brand'
import type { AccountId, AccountOwnerPhase, InstanceId, OwnerDrainEvidence, OwnerEpoch } from '../src/types.ts'

export const account = brandString<AccountId>('owner-store-test-account')
export const instance = brandString<InstanceId>('owner-store-test-instance')
export const limits = { maxMountedAccounts: 4, maxConcurrentMounts: 2, maxConcurrentDrains: 1 }
export const epoch = brandString<OwnerEpoch>('1')

export function row(phase: AccountOwnerPhase = 'mounting', value = epoch): unknown {
  return { owner: {
    accountId: account, ownerInstanceId: phase === 'unowned' ? null : instance,
    epoch: value, phase, recipeVersion: 'recipe-test',
    heartbeatAt: '2026-10-17T00:00:00.000000Z', updatedAt: '2026-10-17T00:00:00.000000Z',
  } }
}

export function cleanEvidence(accountId = account, ownerEpoch = epoch): OwnerDrainEvidence {
  return {
    accountId, epoch: ownerEpoch, nativeIdle: true, persistenceFlushed: true, contextDisposed: true, disposalErrors: [],
    configSaves: { accountId, epoch: ownerEpoch, status: 'confirmed', pendingOperationIds: [], failures: [], evidenceRefs: ['synthetic-save-fixture'] },
    participants: (['files', 'execution'] as const).map(participant => ({
      participant, accountId, epoch: ownerEpoch, status: 'confirmed', pendingOperationIds: [], evidenceRefs: ['synthetic-participant-fixture'],
    })),
  }
}
