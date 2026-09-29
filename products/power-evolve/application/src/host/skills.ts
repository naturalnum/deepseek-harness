/** Agent-scoped selected skills; instruction bodies are loaded only through the trusted Platform. */
import { createHash } from 'node:crypto'
import type { Agent } from '@deepseek-ai/dsh-agent'
import { isSkillName, type SkillCandidate, type SkillDefinition, type SkillResourceBase } from '@deepseek-ai/dsh-skill'
import { skillSnapshot, type Grant } from '../contracts.ts'
import type RuntimeScope from './scope.ts'

type Selection = Grant['selection'][number]

const providerName = 'power-evolve-selected-skills'
const aliasPrefix = 'pe-user-skill-'

/** Preserve unique native names, while assigning stable, collision-free names to legacy skills. */
export function selectedSkillAliases(selection: readonly Selection[]): ReadonlyMap<string, string> {
  const names = new Map<string, number>()
  for (const item of selection) names.set(item.name, (names.get(item.name) ?? 0) + 1)
  const aliases = new Map<string, string>()
  const used = new Set<string>()
  for (const item of selection) {
    const keepName = isSkillName(item.name) && !item.name.startsWith(aliasPrefix)
      && names.get(item.name) === 1
    const alias = keepName ? item.name : `${aliasPrefix}${item.skillId.toLowerCase()}`
    if (used.has(alias) || aliases.has(item.skillId)) throw new Error('Duplicate selected Skill identity or alias')
    aliases.set(item.skillId, alias)
    used.add(alias)
  }
  return aliases
}

function resourceBase(item: Selection): SkillResourceBase {
  return item.kind === 'package'
    ? { kind: 'opaque', description: `Package files exist only in the authorized cloud Sandbox at /opt/power-evolve/skills/sha256/${item.packageDigest}/skill. This is not a Host filesystem path; read resources through cloud execution only.` }
    : { kind: 'opaque', description: 'This text skill has no local Host filesystem resources.' }
}

/** Register one grant's immutable catalog in this Agent's native skill layer. */
export function installSelectedSkills(agent: Agent, grant: Grant, runtime: RuntimeScope): void {
  const selection = grant.selection.map(item => ({ ...item }))
  for (const item of selection) {
    if (item.kind === 'package' && (!item.packageDigest || !item.manifestDigest || !item.version)) {
      throw new Error('Selected Skill package metadata is incomplete')
    }
  }
  const aliases = selectedSkillAliases(selection)
  const selected = new Map(selection.map(item => [item.skillId, item] as const))
  const token = grant.token
  const skills = agent.ctx.get('skills')
  if (!skills) throw new Error('Native Skill registry is unavailable')
  agent.ctx.effect(() => skills.registerProvider(control => ({
    name: providerName,
    async list() {
      control.signal.throwIfAborted()
      return [...selected.values()].map(item => {
        const alias = aliases.get(item.skillId)!
        return {
          name: alias,
          description: alias === item.name ? item.description : `${item.name}: ${item.description}`,
          invocation: { modelInvocable: true, userInvocable: true },
          source: 'power-evolve', provider: providerName, rank: 250,
          resourceBase: resourceBase(item), locator: item.skillId,
        } satisfies SkillCandidate
      })
    },
    async get(candidate, options): Promise<SkillDefinition | undefined> {
      control.signal.throwIfAborted()
      options.signal?.throwIfAborted()
      const item = selected.get(String(candidate.locator))
      if (!item || aliases.get(item.skillId) !== candidate.name) return undefined
      const body = skillSnapshot.parse(await runtime.call('/runtime/skills/read', token,
        { skillId: item.skillId }))
      control.signal.throwIfAborted()
      options.signal?.throwIfAborted()
      if (body.name !== item.name || body.description !== item.description
        || body.revision !== item.revision || body.kind !== item.kind || body.version !== item.version
        || body.digest !== item.digest || body.packageDigest !== item.packageDigest
        || body.manifestDigest !== item.manifestDigest
        || createHash('sha256').update(body.instructions).digest('hex') !== item.digest) {
        throw new Error('Selected Skill snapshot differs from the accepted operation')
      }
      return { ...candidate, content: body.instructions }
    },
  })))
}
