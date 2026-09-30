/** Grant-scoped skill reads without holding a database connection during filesystem access. */
import type { TaskStore } from './tasks.ts'
import type { SkillService } from './skills.ts'
import { PlatformError, skillSnapshot } from '../contracts.ts'

/** Load one accepted skill and fence a lease lost while its bytes were being read.
 * @param tasks - platform-owned grant and operation store.
 * @param skills - owner-scoped, immutable skill content service.
 * @param token - current operation grant.
 * @param skillId - selected skill identity; cannot choose a user or package path.
 * @returns the accepted instruction snapshot after the second lease check.
 */
export async function readRuntimeSkill(tasks: TaskStore, skills: SkillService, token: string,
  skillId: string): Promise<unknown> {
  const { userId, selection } = await tasks.selectedSkills(token)
  const selected = selection.find(item => item.skillId === skillId)
  if (!selected) throw new PlatformError(404, 'skill_not_found')
  const result = skillSnapshot.parse(await skills.readSelected(userId, selected, skillId))
  const resources = await skills.runtimeResourceBase(userId, selection, skillId)
  await tasks.selectedSkills(token)
  return { ...result, ...resources }
}

/** Read only text or metadata in a selected skill's verified manifest.
 * @param tasks - platform-owned operation grants.
 * @param skills - owner-scoped skill content service.
 * @param token - current operation grant.
 * @param skillId - skill selected by this accepted operation.
 * @param path - relative manifest path, omitted to list files.
 * @returns bounded resource text or the manifest file list.
 */
export async function readRuntimeSkillResource(tasks: TaskStore, skills: SkillService, token: string,
  skillId: string, path?: string): Promise<unknown> {
  const { userId, selection } = await tasks.selectedSkills(token)
  const selected = selection.find(item => item.skillId === skillId)
  if (!selected) throw new PlatformError(404, 'skill_not_found')
  const result = await skills.readSelectedResource(userId, selected, path)
  await tasks.selectedSkills(token)
  return result
}
