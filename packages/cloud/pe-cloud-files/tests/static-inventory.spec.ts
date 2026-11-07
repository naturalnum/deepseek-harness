import { createHash } from 'node:crypto'
import { describe, expect, it } from 'vitest'
import { createStaticStorageInventory } from '../src/static-inventory.ts'
import { parseStorageDeploymentPlan } from '../src/storage-probe.ts'
import { physicalInventoryPlan, remountInventoryPlan } from './fixtures/static-inventory.ts'

const encode = (value: unknown) => new TextEncoder().encode(JSON.stringify(value))
function inventory(value: unknown) {
  const parsed = parseStorageDeploymentPlan(encode(value), 1024)
  if (parsed.version !== 3) throw new Error('Expected v3 inventory')
  return createStaticStorageInventory(parsed)
}

describe('persistent physical inventory identity', () => {
  it('keeps the same digest across namespace mounts, loop reassignment, deployment code and record ordering', () => {
    const first = physicalInventoryPlan(), second = physicalInventoryPlan()
    remountInventoryPlan(second)
    second.recipeVersion = 'another-reviewed-code-deployment'
    second.baseConfigPath = '/app/next-base.yml'; second.installAnchor = '/app/next-package.json'
    second.slots.reverse()
    for (const slot of second.slots) slot.environmentBank.slots.reverse()
    const reverseKeys = (value: unknown): unknown => {
      if (Array.isArray(value)) return value.map(reverseKeys)
      if (value !== null && typeof value === 'object') {
        return Object.fromEntries(Object.entries(value).reverse().map(([key, child]) => [key, reverseKeys(child)]))
      }
      return value
    }
    const reordered = reverseKeys(second)
    expect(createHash('sha256').update(encode(first)).digest('hex'))
      .not.toBe(createHash('sha256').update(encode(reordered)).digest('hex'))
    expect(inventory(reordered)).toEqual(inventory(first))
    expect(Object.isFrozen(inventory(first).slots[0])).toBe(true)
    expect(JSON.stringify(inventory(first))).not.toContain('/accounts/')
  })

  it.each<[string, (plan: ReturnType<typeof physicalInventoryPlan>) => void]>([
    ['arena backing device', (plan) => { plan.arena.backing.device = '901' }],
    ['arena backing inode', (plan) => { plan.arena.backing.inode = '9999' }],
    ['arena backing path', (plan) => { plan.arena.backing.path = '/replacement-arena' }],
    ['arena reserve', (plan) => { plan.arenaReserveBytes = '12288' }],
    ['control backing', (plan) => { plan.control.backing.inode = '9999' }],
    ['private backing', (plan) => { plan.slots[0]!.private.backing.inode = '9999' }],
    ['projects backing path', (plan) => { plan.slots[0]!.projects.backing.path = '/replacement-projects' }],
    ['backing bytes', (plan) => { plan.slots[0]!.private.backing.bytes = '12288' }],
    ['byte quota', (plan) => { plan.slots[0]!.projects.maximumBytes = '12288' }],
    ['inode quota', (plan) => { plan.slots[0]!.private.maximumInodes = '201' }],
    ['slot identity', (plan) => { plan.slots[0]!.slotId = 'another-slot' }],
    ['template', (plan) => { plan.slots[0]!.templateId = 'another-template' }],
    ['bank identity', (plan) => { plan.slots[0]!.environmentBank.bankId = 'another-bank' }],
    ['environment slot identity', (plan) => {
      const entry = plan.slots[0]!.environmentBank.slots[0]!
      entry.slotId = 'another-environment'; entry.domain.rootPath = `${plan.slots[0]!.accountRoot}/environments/${entry.slotId}`
    }],
    ['bank mode', (plan) => { Reflect.deleteProperty(plan.slots[0]!.environmentBank, 'mode') }],
    ['environment backing', (plan) => { plan.slots[0]!.environmentBank.slots[0]!.domain.backing.inode = '9999' }],
    ['application identity', (plan) => { plan.appUid = 1001 }],
    ['slot paths and storage key', (plan) => {
      const slot = plan.slots[0]!, key = 'v1-' + 'a'.repeat(64)
      slot.storageKey = key; slot.accountRoot = `/accounts/${key}`
      slot.private.rootPath = `${slot.accountRoot}/private`; slot.projects.rootPath = `${slot.accountRoot}/projects`
      for (const entry of slot.environmentBank.slots) entry.domain.rootPath = `${slot.accountRoot}/environments/${entry.slotId}`
    }],
  ])('changes the association digest when %s changes', (_name, change) => {
    const original = physicalInventoryPlan(), changed = physicalInventoryPlan()
    change(changed)
    expect(inventory(changed).sha256).not.toBe(inventory(original).sha256)
  })
})
