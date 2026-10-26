import { describe, expect, it } from 'vitest'
import type { AccountId, AccountOwner, InstanceId, OwnerEpoch, RuntimeInstanceRecord } from '@deepseek-ai/dsh-pe-cloud-runtime/types'
import { selectOwnerDestination, type OwnerDestinationInput } from '../src/owner-destination.ts'

const accountId = 'route-account' as AccountId
const localInstanceId = 'node-two' as InstanceId
const ownerInstanceId = 'node-one' as InstanceId
const epoch = '9001' as OwnerEpoch
function input(): OwnerDestinationInput & { owner: AccountOwner; instance: RuntimeInstanceRecord } {
  return {
    accountId, localInstanceId, recipeVersion: 'reviewed-recipe',
    owner: { accountId, ownerInstanceId, epoch, phase: 'ready', recipeVersion: 'reviewed-recipe',
      heartbeatAt: '2000-01-01T00:00:00Z', updatedAt: '2000-01-01T00:00:00Z' },
    instance: { instanceId: ownerInstanceId, internalAddress: 'https://node-one.internal:8443',
      recipeVersion: 'reviewed-recipe', phase: 'registered', heartbeatAt: '2000-01-01T00:00:00Z' },
    trustedTargets: new Map([[ownerInstanceId, {
      internalAddress: 'https://node-one.internal:8443', serviceIdentityRef: 'reviewed-node-one-identity',
    }]]),
  }
}

describe('Host-only owner destination candidate', () => {
  it('preserves the existing epoch and target without treating an old heartbeat as takeover authority', () => {
    const original = input(), selected = selectOwnerDestination(original)
    expect(selected).toMatchObject({ kind: 'remote-candidate', owner: { ownerInstanceId, epoch },
      target: { serviceIdentityRef: 'reviewed-node-one-identity' } })
    if (selected.kind !== 'remote-candidate') throw new Error('Expected a metadata candidate')
    expect(selected.owner).not.toBe(original.owner)
    expect(selected.instance).not.toBe(original.instance)
    expect(Object.isFrozen(selected)).toBe(true)
    expect(Object.isFrozen(selected.owner)).toBe(true)
    expect(Object.isFrozen(selected.instance)).toBe(true)
    expect(Object.isFrozen(selected.target)).toBe(true)
  })

  it('classifies the same startup identity locally without acquiring a graph', () => {
    expect(selectOwnerDestination({ ...input(), localInstanceId: ownerInstanceId }))
      .toMatchObject({ kind: 'local-candidate', owner: { epoch } })
  })

  it('refuses missing ownership and missing or mismatched instance metadata', () => {
    const value = input()
    expect(selectOwnerDestination({ ...value, owner: undefined })).toEqual({ kind: 'unavailable' })
    expect(selectOwnerDestination({ ...value, instance: undefined })).toEqual({ kind: 'unavailable' })
    expect(selectOwnerDestination({ ...value, instance: { ...value.instance, instanceId: localInstanceId } }))
      .toEqual({ kind: 'unavailable' })
  })

  it('refuses another account and every non-ready owner phase without generating a replacement', () => {
    const value = input()
    expect(selectOwnerDestination({ ...value, accountId: 'another-account' as AccountId })).toEqual({ kind: 'unavailable' })
    for (const phase of ['unowned', 'mounting', 'reconfiguring', 'draining', 'parked', 'quarantined'] as const) {
      expect(selectOwnerDestination({ ...value, owner: { ...value.owner, phase } })).toEqual({ kind: 'unavailable' })
    }
  })

  it('refuses recipe drift and a closed instance', () => {
    const value = input()
    expect(selectOwnerDestination({ ...value, recipeVersion: 'another-recipe' })).toEqual({ kind: 'unavailable' })
    expect(selectOwnerDestination({ ...value, instance: { ...value.instance, recipeVersion: 'another-recipe' } }))
      .toEqual({ kind: 'unavailable' })
    expect(selectOwnerDestination({ ...value, instance: { ...value.instance, phase: 'closed' } }))
      .toEqual({ kind: 'unavailable' })
  })

  it('refuses an unselected destination and a PG address differing from the trusted deployment selection', () => {
    const value = input()
    expect(selectOwnerDestination({ ...value, trustedTargets: new Map() })).toEqual({ kind: 'unavailable' })
    expect(selectOwnerDestination({ ...value, instance: { ...value.instance, internalAddress: 'https://unselected.internal' } }))
      .toEqual({ kind: 'unavailable' })
  })
})
