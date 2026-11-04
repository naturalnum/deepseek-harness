/** Bundled Office workflows and filesystem resources for document authoring and operations. */

import { readFileSync, statSync } from 'node:fs'
import { readFile } from 'node:fs/promises'
import { dirname, isAbsolute, join, sep } from 'node:path'
import { isSea } from 'node:sea'
import { fileURLToPath } from 'node:url'
import type { Context } from '@deepseek-ai/cordis'
import z from '@deepseek-ai/schemastery'
import { BUNDLED_SKILL_RANK, type SkillCandidate, type SkillProvider } from '@deepseek-ai/dsh-skill'
import { parse as parseYaml } from 'yaml'
import { readSkillPackage } from '@deepseek-ai/dsh-skill-filesystem'

const SKILL_NAMES = ['office', 'office-docx', 'office-pptx', 'office-xlsx', 'office-render', 'office-recalculate', 'office-export-pdf'] as const

/** Office skill resource location. */
export interface Config {
  /** Absolute assets directory containing skill folders; defaults to packaged assets. */
  assetRoot?: string
  /** Standalone Node executable; defaults to the current executable outside Electron and SEA. */
  node?: string
  /** Absolute LibreOffice Kit CLI entry; false explicitly disables CLI access. */
  cli?: string | false
  /** Guest-visible read-only mirror of assetRoot; omission retains local execution. */
  executionRoot?: string
  /** Explicit guest Node and Kit entries; validated by the execution environment rather than Host stat. */
  executionRuntime?: {
    /** Absolute Node executable in the execution environment. */
    node: string
    /** Absolute LibreOffice Kit CLI entry in the execution environment. */
    cli: string
  }
  /** Explicit native Linux tools selected by the deployment; omission retains LibreOffice Kit. */
  systemTools?: {
    /** Absolute headless LibreOffice executable in the execution environment. */
    soffice: string
    /** Absolute Poppler page-image executable in the execution environment. */
    pdftoppm: string
    /** Optional executable that preserves bundled technical-report C/F/T fields while refreshing catalogs. */
    wordRefresh?: string
  }
  /** Require generated complete-package inventories. */
  packagedBundles?: boolean
}

/** Validated resource configuration. */
export const Config: z<Config> = z.object({
  assetRoot: z.string().min(1),
  executionRoot: z.string().min(1),
  executionRuntime: z.union([z.object({ node: z.string().min(1).required(), cli: z.string().min(1).required() }).required()]),
  packagedBundles: z.boolean(),
  systemTools: z.union([z.object({
    soffice: z.string().min(1).required(), pdftoppm: z.string().min(1).required(), wordRefresh: z.string().min(1),
  }).required()]),
  node: z.string().min(1),
  cli: z.union([z.string().min(1), z.const(false)]),
})

/** Cordis plugin identity. */
export const name = 'skill-office'
/** Registry used by the bundled provider. */
export const inject = ['skills']

function parseSkill(raw: string, path: string): { description: string; content: string } {
  const frontmatter = /^---\r?\n([\s\S]*?)\r?\n---(?:\r?\n|$)/u.exec(raw)
  if (frontmatter?.[1] === undefined) throw new Error(`skill-office: ${path} has no YAML frontmatter`)
  const metadata: unknown = parseYaml(frontmatter[1])
  const description = typeof metadata === 'object' && metadata !== null && 'description' in metadata
    ? metadata.description : undefined
  if (typeof description !== 'string' || description.length === 0) throw new Error(`skill-office: ${path} has no description`)
  return { description, content: raw.slice(frontmatter[0].length).trim() }
}

function officeRuntime(config: Config): string {
  if (config.cli === false) return '\n\nLibreOffice Kit is disabled in this deployment.'
  if (config.node === undefined && (isSea() || process.versions.electron !== undefined)) {
    throw new Error('skill-office: packaged applications must supply a standalone Node executable')
  }
  if (config.executionRuntime !== undefined) {
    const { node, cli } = config.executionRuntime
    if (![node, cli].every(isAbsolute)) throw new Error('skill-office: guest runtime entries must be absolute')
    return `\n\n## Installed LibreOffice Kit\n\nRun these entries in the execution environment.\n\n${JSON.stringify({ libreofficeKit: { node, cli } }, undefined, 2)}`
  }
  const node = config.node ?? process.execPath
  let cli = config.cli
  if (cli === undefined) {
    const manifestPath = fileURLToPath(import.meta.resolve('@deepseek-ai/libreoffice-kit/package.json'))
    cli = join(dirname(manifestPath), 'lib', 'cli.js')
  }
  for (const path of [node, cli]) {
    if (!isAbsolute(path) || !statSync(path).isFile()) throw new Error(`skill-office: expected an absolute executable file: ${path}`)
  }
  return `\n\n## Installed LibreOffice Kit\n\nUse these absolute paths for every LibreOffice Kit command. Pass the CLI entry as the first argument to Node.\n\n${JSON.stringify({ libreofficeKit: { node, cli } }, undefined, 2)}`
}

/**
 * Register Office skills with resources readable by the script interpreter.
 * @param ctx - Context carrying the skill registry.
 * @param config - Optional external assets directory for packaged applications.
 */
export function apply(ctx: Context, config: Config = {}): void {
  const assetRoot = config.assetRoot ?? fileURLToPath(new URL('../assets/', import.meta.url))
  if (config.systemTools !== undefined && (!Object.values(config.systemTools).every(isAbsolute)
    || config.executionRuntime !== undefined || config.cli === false)) {
    throw new Error('skill-office: systemTools requires absolute execution paths and cannot be combined with a Kit runtime or disabled CLI')
  }
  if (config.executionRoot !== undefined && !isAbsolute(config.executionRoot)) throw new Error('skill-office: executionRoot must be absolute')
  if (!isAbsolute(assetRoot)) throw new Error('skill-office: assetRoot must be an absolute directory')
  const candidates: SkillCandidate[] = SKILL_NAMES.map((skillName) => {
    const directory = join(assetRoot, skillName)
    const path = join(directory, 'SKILL.md')
    const { description } = parseSkill(readFileSync(path, 'utf8'), path)
    return {
      name: skillName, description,
      invocation: { modelInvocable: true, userInvocable: true },
      provider: 'dsh-office', source: 'bundled', rank: BUNDLED_SKILL_RANK,
      resourceBase: { kind: 'directory', path: join(config.executionRoot ?? assetRoot, skillName).split(sep).join('/') }, locator: path,
      ...config.packagedBundles ? { package: readSkillPackage(directory) } : {},
    }
  })
  const provider: SkillProvider = {
    name: 'dsh-office',
    list: () => Promise.resolve(candidates),
    async get(candidate, options) {
      const { rank: _rank, locator, package: _package, ...summary } = candidate
      const raw = await readFile(locator as string, { encoding: 'utf8', signal: options.signal })
      const operation = ['office-render', 'office-recalculate', 'office-export-pdf'].includes(candidate.name)
      const content = operation && config.systemTools !== undefined
        ? await readFile(join(assetRoot, candidate.name, 'system.md'), { encoding: 'utf8', signal: options.signal })
          + `\n\n## Installed native Linux tools\n\n${JSON.stringify(config.systemTools, undefined, 2)}`
        : parseSkill(raw, locator as string).content + (operation ? officeRuntime(config) : '')
      const reportRuntime = config.systemTools?.wordRefresh === undefined ? ''
        : `\n\n## Bundled technical-report catalogs\n\nFor a technical-report DOCX with C/F/T main, figure and table fields, run the installed wordRefresh executable before PDF export or visual inspection. Pass the source, a new output directory, --soffice with the installed soffice path, --timeout-seconds within the current execution deadline and --cancel-grace-seconds within its cancellation budget. Use the returned report.docx and report.pdf, inspect catalogs.json and check rendered pages. This Linux operation preserves original field codes and content; the bundled Windows COM refresher cannot refresh these catalogs on Linux. Other documents use the normal operation instructions.\n\n${JSON.stringify(config.systemTools, undefined, 2)}`
      return { ...summary, content: content + reportRuntime + (config.executionRoot === undefined ? '' : '\n\nShared resources are read-only paths in the execution environment. Use its Bash tool or interpreter to read referenced files and run scripts; Host file tools do not provide these guest image paths.') }
    },
  }
  ctx.skills.registerProvider(() => provider)
}
