/** Agent-scoped selected skills; instruction bodies are loaded only through the trusted Platform. */
import { createHash } from 'node:crypto'
import type { Agent } from '@deepseek-ai/dsh-agent'
import { isSkillName, type SkillCandidate, type SkillDefinition, type SkillResourceBase } from '@deepseek-ai/dsh-skill'
import { defineTool } from '@deepseek-ai/dsh-tools'
import { runtimeSkillSnapshot, skillResourceView, type Grant } from '../contracts.ts'
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

function resourceBase(item: Selection, target: Grant['target']['kind'], runtimePath = `/opt/power-evolve/skills/sha256/${item.packageDigest}/skill`): SkillResourceBase {
  return item.kind === 'package'
    ? { kind: 'opaque', description: target === 'desktop'
      ? `Read referenced text or list files with skill_resource; this does not start a Sandbox. The selected package is mounted read-only at ${runtimePath} in the authorized Desktop container. To execute its code, use desktop_exec and write outputs in /workspace or persistent Home /home/agent. This is not a Host filesystem path.`
      : `Read referenced text or list files with skill_resource; this does not start a Sandbox. To execute code, use the authorized cloud Sandbox path ${runtimePath}. This is not a Host filesystem path.` }
    : { kind: 'opaque', description: 'Read SKILL.md with skill_resource. This text skill has no executable package files.' }
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
  const target = grant.target.kind
  if (selection.length) agent.ctx.effect(() => agent.ctx.tools.register(defineTool({
    name: 'skill_resource',
    description: 'Read a selected skill reference or script as text, or list its packaged files. Does not execute code or start a Sandbox. Paths are relative to the skill package; omit path to list files.',
    parameters: {
      name: { type: 'string', required: true, description: 'Exact skill name from the available skills catalog.' },
      path: { type: 'string', description: 'Relative file path from this skill\'s manifest; omit to list files.' },
    },
    output: { schema: { type: 'object', additionalProperties: false,
      properties: { result: { type: 'string', required: true } } },
      render: (_args, value) => [{ type: 'text', text: value.result }] },
    async execute(args, exec) {
      exec.signal.throwIfAborted()
      const item = selection.find(value => aliases.get(value.skillId) === args.name)
      if (!item) throw new Error('Skill is not selected by this operation')
      const value = skillResourceView.parse(await runtime.call('/runtime/skills/resource', token,
        { skillId: item.skillId, ...(args.path === undefined ? {} : { path: args.path }) }))
      exec.signal.throwIfAborted()
      if (value.kind === 'text' && (value.path !== args.path
        || createHash('sha256').update(value.text).digest('hex') !== value.sha256)) {
        throw new Error('Selected Skill resource differs from its verified bytes')
      }
      return { result: JSON.stringify(value) }
    },
    presentCall(args) {
      return { card: 'generic', title: `Read skill resource ${args.name}`, kind: 'read', rawInput: args.path ?? args.name }
    },
  })))
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
          resourceBase: resourceBase(item, target), locator: item.skillId,
        } satisfies SkillCandidate
      })
    },
    async get(candidate, options): Promise<SkillDefinition | undefined> {
      control.signal.throwIfAborted()
      options.signal?.throwIfAborted()
      const item = selected.get(String(candidate.locator))
      if (!item || aliases.get(item.skillId) !== candidate.name) return undefined
      const body = runtimeSkillSnapshot.parse(await runtime.call('/runtime/skills/read', token,
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
      let resources = resourceBase(item, target)
      if (body.runtimePath !== undefined && body.runtimePath !== null) {
        const original = `/opt/power-evolve/skills/sha256/${item.packageDigest}/skill`
        const suite = /^\/opt\/power-evolve\/skills\/report-suites\/[a-f0-9]{64}\/(report-workflow-orchestrator|power-grid-technical-report-writer|report-reviewer|tech-report-writer)$/u.exec(body.runtimePath)
        if (item.kind !== 'package' || (body.runtimePath !== original
          && (target !== 'cloud' || !body.suiteAvailable || suite?.[1] !== item.name))) {
          throw new Error('Selected Skill runtime path differs from its package')
        }
        resources = resourceBase(item, target, body.runtimePath)
      }
      return { ...candidate, content: body.instructions, resourceBase: resources }
    },
  })))
}
