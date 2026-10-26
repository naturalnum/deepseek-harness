/** Pinned Root facts cannot authorize a foreign process, generation, terminal scope or backing. No native grant is minted here. */
import { expect, it } from 'vitest'
import { brandString } from '@deepseek-ai/dsh-brand'
import type { AccountMountInput } from '@deepseek-ai/dsh-pe-cloud-runtime/types'
import type { StaticStorageAccount } from '../src/storage-types.ts'
import { parseRootSkillRevalidation, assertRootSkillRevalidation } from '../src/skill-revalidation.ts'
import { skillRevalidationProof } from './fixtures/skill-revalidation-proof.ts'

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
