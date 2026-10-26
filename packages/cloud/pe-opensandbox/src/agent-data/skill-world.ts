/** Root-private fixed working-copy facts; only original files-issued borrows may be translated into them. */
import { need, record, u64 } from './canonical.ts'

/** Exact directory identity, independently rechecked inside each execution namespace. */
export interface SkillDirectoryIdentity { readonly device: string; readonly inode: string }
/** Fixed allocation parent; mount ids remain checked in their original source namespace, never compared across namespaces. */
export interface SkillParent {
  readonly metadata: SkillDirectoryIdentity
  readonly skills: SkillDirectoryIdentity
  readonly maxCopies: number
}
/** Private signed per-operation set; public command inputs still contain only argv/cwd/stdin. */
export interface SkillWorld extends SkillParent {
  readonly copies: readonly { readonly version: string; readonly identity: SkillDirectoryIdentity }[]
}
/** @param value Untrusted decoded identity. @returns Independent closed identity. */
function identity(value: unknown): SkillDirectoryIdentity {
  record(value, ['device', 'inode']); u64(value.device, true); u64(value.inode)
  return Object.freeze({ device: value.device, inode: value.inode })
}
/**
 * Validate and copy the fixed metadata/skills identities and copy limit.
 * @param value Root-selected parent facts.
 * @returns Complete independent finite parent policy.
 */
export function skillParent(value: unknown): SkillParent {
  record(value, ['metadata', 'skills', 'maxCopies'])
  const metadata = identity(value.metadata), skills = identity(value.skills)
  need(metadata.device === skills.device && metadata.inode !== skills.inode
    && typeof value.maxCopies === 'number' && Number.isSafeInteger(value.maxCopies)
    && value.maxCopies >= 1 && value.maxCopies <= 2147483647, 'skill_parent')
  return Object.freeze({ metadata, skills, maxCopies: value.maxCopies })
}
/**
 * Validate parent policy and unique per-operation skill-version directory identities.
 * @param value Private signed copy facts.
 * @returns Complete independent per-operation facts.
 */
export function skillWorld(value: unknown): SkillWorld {
  record(value, ['metadata', 'skills', 'maxCopies', 'copies'])
  const parent = skillParent({ metadata: value.metadata, skills: value.skills, maxCopies: value.maxCopies })
  need(Array.isArray(value.copies) && value.copies.length <= parent.maxCopies, 'skill_copies')
  const names = new Set<string>()
  const copies = value.copies.map((entry: unknown) => {
    record(entry, ['version', 'identity'])
    need(typeof entry.version === 'string' && /^[a-f0-9]{8}-[a-f0-9]{4}-4[a-f0-9]{3}-[89ab][a-f0-9]{3}-[a-f0-9]{12}$/.test(entry.version)
      && !names.has(entry.version), 'skill_version')
    names.add(entry.version)
    const directory = identity(entry.identity)
    need(directory.device === parent.skills.device && directory.inode !== parent.skills.inode
      && directory.inode !== parent.metadata.inode, 'skill_copy_domain')
    return Object.freeze({ version: entry.version, identity: directory })
  })
  return Object.freeze({ ...parent, copies: Object.freeze(copies) })
}
/**
 * Reject operation facts that do not match the retained allocation parent.
 * @param value One checked operation.
 * @param parent Original protected allocation policy.
 * @returns Nothing; refuses mismatched parents.
 */
export function assertSkillParent(value: SkillWorld, parent: SkillParent | undefined): void {
  need(parent !== undefined && value.maxCopies === parent.maxCopies
    && value.metadata.device === parent.metadata.device && value.metadata.inode === parent.metadata.inode
    && value.skills.device === parent.skills.device && value.skills.inode === parent.skills.inode, 'skill_parent_binding')
}
