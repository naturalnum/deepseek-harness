/** Translate only the original files borrow, after its owner has rechecked exact issued authority. */
import type { SkillOperationCopies, SkillProjectGrant } from './skill-files-types.ts'
import type { SkillParent, SkillWorld } from './agent-data/skill-world.ts'
import { skillParent, skillWorld } from './agent-data/skill-world.ts'
import { ExecutionStateError } from './errors.ts'

/**
 * Translate retained original skill directories into validated allocation-parent wire facts.
 * @param grant Original actively retained allocation parent.
 * @param maxCopies Explicit Root bound.
 * @returns Checked public-free wire parent.
 */
export function parentFacts(grant: SkillProjectGrant, maxCopies: number): SkillParent {
  const root = grant.project
  for (const item of [grant.metadataDirectory, grant.skillsDirectory]) {
    if (item.device !== root.rootDevice || item.mountId !== root.rootMountId
      || item.uid !== 2000 || item.gid !== 2000 || item.mode !== 0o40700) {
      throw new ExecutionStateError('cloud/execution-unavailable', 'The original skill source directories are unavailable.')
    }
  }
  return skillParent({ metadata: { device: grant.metadataDirectory.device, inode: grant.metadataDirectory.inode },
    skills: { device: grant.skillsDirectory.device, inode: grant.skillsDirectory.inode }, maxCopies })
}
/**
 * Validate retained files borrows and encode fixed per-operation skill-copy identities.
 * @param borrow Original actual files operation borrow.
 * @param maxCopies Explicit Root bound.
 * @returns Checked facts to bind to the original spec hash and role.
 */
export function copyFacts(borrow: SkillOperationCopies, maxCopies: number): SkillWorld {
  const parent = parentFacts(borrow.project, maxCopies)
  const copies = borrow.copies.map((copy) => {
    const selected = borrow.project
    if (copy.binding !== selected.binding || copy.workspaceId !== selected.workspaceId || copy.version.binding !== selected.binding
      || copy.copyDirectory.device !== selected.project.rootDevice || copy.copyDirectory.mountId !== selected.project.rootMountId
      || copy.copyDirectory.uid !== 2000 || copy.copyDirectory.gid !== 2000 || copy.copyDirectory.mode !== 0o40700
      || (['device', 'inode', 'mountId', 'uid', 'gid', 'mode'] as const).some(key => copy.metadataDirectory[key] !== selected.metadataDirectory[key]
        || copy.skillsDirectory[key] !== selected.skillsDirectory[key])
      || copy.resourceBase !== `.pe/skills/${copy.version.id}/`) {
      throw new ExecutionStateError('cloud/execution-unavailable', 'The original skill copy borrow is unavailable.')
    }
    return { version: copy.version.id, identity: { device: copy.copyDirectory.device, inode: copy.copyDirectory.inode } }
  })
  return skillWorld({ ...parent, copies })
}
