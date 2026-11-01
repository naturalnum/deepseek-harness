/** Pinned Root facts cannot authorize a foreign process, generation, terminal scope or backing. No native grant is minted here. */
import { expect, it } from 'vitest'
import { brandString } from '@deepseek-ai/dsh-brand'
import type { AccountMountInput } from '@deepseek-ai/dsh-pe-cloud-runtime/types'
import type { StaticStorageAccount } from '../src/storage-types.ts'
import { parseRootSkillRevalidation, parseRootSkillRevalidations, assertRootSkillRevalidation } from '../src/skill-revalidation.ts'
import { skillRestartProof, skillRevalidationProof } from './fixtures/skill-revalidation-proof.ts'

const accountId = brandString<AccountMountInput['binding']['accountId']>('account')
const storageKey = brandString<AccountMountInput['layout']['storageKey']>('v1-' + '1'.repeat(64))
const domain = { rootPath: '/account/projects', rootDevice: '1795', rootInode: '2', rootMountId: '1544',
  minimumBytes: '8192', maximumBytes: '8192', minimumInodes: '100', maximumInodes: '100',
  backing: { path: '/backing', device: '1792', inode: '16', bytes: '8192' } }
const account: StaticStorageAccount = { accountId, storageKey, accountRoot: '/account', projects: domain,
  private: { ...domain, rootPath: '/account/private' } }
const observed = { pid: 12345, startTicks: '123' }, hash = 'b'.repeat(64)
const encode = (value: unknown) => new TextEncoder().encode(JSON.stringify(value))
function input(): AccountMountInput {
  return { binding: { accountId, epoch: brandString<AccountMountInput['binding']['epoch']>('2'), recipeVersion: 'recipe',
    lifetime: new AbortController().signal }, instanceId: brandString<AccountMountInput['instanceId']>('fixture-instance'),
  layout: { storageKey, accountRoot: '/account', privateRoot: '/account/private', projectsRoot: '/account/projects',
    profileRoot: '/account/private/profile', patchPath: '/account/private/profile/cordis.patch.yml', credentialsRoot: '/account/private/credentials',
    sessionsRoot: '/account/private/sessions', storageRoot: '/account/private/storage', attachmentsRoot: '/account/private/attachments',
    skillsRoot: '/account/private/skills', instructionsRoot: '/account/private/instructions', environmentsRoot: '/account/environments',
    localIndexRoot: '/cache' }, environment: { get: () => undefined, getFrom: () => undefined } }
}
it('captures the actual recipient after protected bytes are fixed and checks the live factory generation and backing', () => {
  const bytes = encode(skillRevalidationProof(account))
  const proof = parseRootSkillRevalidation(bytes, observed, hash)
  expect(() => { assertRootSkillRevalidation(proof, input(), account) }).not.toThrow()
  expect(proof.recipient).toEqual({ process: observed, planSha256: hash })
  expect(Object.isFrozen(proof.volumes.projects.backing)).toBe(true)
  expect(() => { assertRootSkillRevalidation(proof, { ...input(),
    instanceId: brandString<AccountMountInput['instanceId']>('previous-instance') }, account) }).toThrow()
  expect(() => { assertRootSkillRevalidation(proof, { ...input(), binding: { ...input().binding,
    epoch: brandString<AccountMountInput['binding']['epoch']>('1') } }, account) }).toThrow()
  expect(() => { assertRootSkillRevalidation(proof, input(), { ...account, projects: { ...domain,
    backing: { ...domain.backing, inode: 'other' } } }) }).toThrow()
})
it('refuses missing or unknown terminal evidence and receipt scope borrowed from a historical generation', () => {
  const original = skillRevalidationProof(account)
  for (const changed of [
    { ...original, retirement: null },
    { ...original, retirement: { ...original.retirement, processExit: { ...original.retirement.processExit, exitCode: 1 } } },
    { ...original, retirement: { ...original.retirement, filesTerminal: { ...original.retirement.filesTerminal, epoch: '0' } } },
    { ...original, retirement: { ...original.retirement, filesTerminal: { ...original.retirement.filesTerminal, pendingOperationIds: ['pending'] } } },
    { ...original, retirement: { ...original.retirement, writersTerminal: { ...original.retirement.writersTerminal, kind: 'unknown' } } },
  ]) expect(() => parseRootSkillRevalidation(encode(changed), observed, hash)).toThrow()
})
it('refuses the prior actual process, malformed measured identity, changed lineage or external recipient switches', () => {
  const original = skillRevalidationProof(account)
  expect(() => parseRootSkillRevalidation(encode(original), original.previous.process, hash)).toThrow()
  expect(() => parseRootSkillRevalidation(encode(original), { ...observed, startTicks: 'unknown' }, hash)).toThrow()
  expect(() => parseRootSkillRevalidation(encode(original), observed, 'unknown')).toThrow()
  for (const changed of [
    { ...original, target: { instanceId: 'prefilled', epoch: '2', process: observed, planSha256: hash } },
    { ...original, lineage: { ...original.lineage, after: { ...original.lineage.after,
      projects: { ...original.lineage.after.projects, mountId: '615' } } } },
    { ...original, approved: true },
  ]) expect(() => parseRootSkillRevalidation(encode(changed), observed, hash)).toThrow()
})

it('accepts the legacy proof and an account-scoped bounded collection without duplicate Workspaces', () => {
  const first = skillRevalidationProof(account), second = { ...first, workspaceId: 'workspace-2', recordSha256: 'b'.repeat(64) }
  const legacy = parseRootSkillRevalidations(encode(first), observed, hash, [account], 2)
  const result = parseRootSkillRevalidations(encode({ schema: 2, records: [first, second] }), observed, hash, [account], 2)
  expect(legacy).toHaveLength(1); expect(result.map(row => row.workspaceId)).toEqual(['workspace', 'workspace-2'])
  expect(parseRootSkillRevalidations(encode(first), observed, hash, [account], undefined)).toHaveLength(1)
  expect(() => parseRootSkillRevalidations(encode({ schema: 2, records: [first] }), observed, hash, [account], undefined)).toThrow()
  expect(Object.isFrozen(result)).toBe(true)
  for (const bad of [
    { schema: 2, records: [] },
    { schema: 2, records: [first, first] },
    { schema: 2, records: [first, second, { ...second, workspaceId: 'third' }] },
    { schema: 2, records: [first, { ...second, accountId: 'other' }] },
    { schema: 2, records: [first, { ...second, retirement: null }] },
    { schema: 2, records: [first], approved: true },
  ]) expect(() => parseRootSkillRevalidations(encode(bad), observed, hash, [account], 2)).toThrow()
})

it('matches each proof to a known account and enforces the project limit per account', () => {
  const other = { ...account, accountId: brandString<typeof accountId>('other'),
    storageKey: brandString<typeof storageKey>('v1-' + '2'.repeat(64)) }
  const first = skillRevalidationProof(account), second = skillRevalidationProof(other)
  const both = { schema: 2, records: [first, second] }
  expect(parseRootSkillRevalidations(encode(both), observed, hash, [account, other], 1)).toHaveLength(2)
  expect(() => parseRootSkillRevalidations(encode(both), observed, hash, [account], 1)).toThrow()
  expect(() => parseRootSkillRevalidations(encode({ schema: 2, records: [first, { ...first, workspaceId: 'other' }, second] }),
    observed, hash, [account, other], 1)).toThrow()
})

it('accepts normal restart continuity without inventing archive lineage, alone or in a bounded mixed collection', () => {
  const normal = skillRestartProof(account), legacy = skillRevalidationProof(account)
  const parsed = parseRootSkillRevalidation(encode(normal), observed, hash)
  expect(() => { assertRootSkillRevalidation(parsed, input(), account) }).not.toThrow()
  const collection = { schema: 2, records: [normal, { ...legacy, workspaceId: 'legacy-workspace' }] }
  expect(parseRootSkillRevalidations(encode(collection), observed, hash, [account], 2).map(row => row.workspaceId))
    .toEqual(['workspace', 'legacy-workspace'])
})

it('rejects incomplete normal restart or changed controller, physical volume and termination evidence', () => {
  const original = skillRestartProof(account), lineage = original.lineage, retirement = original.retirement
  for (const changed of [
    { ...original, retirement: { ...retirement, filesTerminal: { ...retirement.filesTerminal, kind: 'lane-joined' } } },
    { ...original, retirement: { ...retirement, processExit: { ...retirement.processExit, exitCode: 1 } } },
    { ...original, retirement: { ...retirement, filesTerminal: { ...retirement.filesTerminal, pendingOperationIds: ['unknown'] } } },
    { ...original, retirement: { ...retirement, writersTerminal: { ...retirement.writersTerminal, kind: 'unknown' } } },
    { ...original, retirement: { ...retirement, ownerRecoverySha256: '' } },
    { ...original, lineage: { ...lineage, kind: 'archive' } },
    { ...original, lineage: { ...lineage, beforeReceiptSha256: 'unknown' } },
    { ...original, lineage: { ...lineage, oldArchiveSha256: 'a'.repeat(64) } },
    { ...original, lineage: { ...lineage, after: { ...lineage.after,
      controller: { ...lineage.after.controller, process: { pid: 1, startTicks: '100' } } } } },
    { ...original, lineage: { ...lineage, after: { ...lineage.after,
      controller: { ...lineage.after.controller, mountNamespace: 'mnt:[124]' } } } },
    { ...original, lineage: { ...lineage, after: { ...lineage.after,
      projects: { ...lineage.after.projects, mountId: '615' } } } },
    { ...original, lineage: { ...lineage, after: { ...lineage.after,
      private: { ...lineage.after.private, backing: { ...lineage.after.private.backing, inode: '7' } } } } },
  ]) expect(() => parseRootSkillRevalidation(encode(changed), observed, hash)).toThrow()
  const proof = parseRootSkillRevalidation(encode(original), observed, hash)
  expect(() => { assertRootSkillRevalidation(proof, input(), { ...account,
    projects: { ...account.projects, backing: { ...account.projects.backing, inode: '7' } } }) }).toThrow()
})
