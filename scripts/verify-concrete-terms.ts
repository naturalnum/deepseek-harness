/** Reject one ambiguous origin label from maintained tracked files. */

import { lstatSync, readFileSync, readlinkSync } from 'node:fs'
import { createHash } from 'node:crypto'
import { resolve } from 'node:path'
import { pathToFileURL } from 'node:url'
import { historicalSchemaRegion } from './historical-schema-region.ts'
import { trackedRepositoryFiles } from './tracked-repository-files.ts'
import { isUnchangedImportedResearchContent } from './imported-research-content.ts'

const root = resolve(import.meta.dirname, '..')
const blockedTerm = 'prove' + 'nance'
const excludedPrefixes = ['vendor/', '.agents/notes/archived/'] as const
const originalReport = 'packages/skill/skill-office/assets/reports/power-grid-technical-report-writer/'
// Complete imported report packages retain original wording; any edited bytes lose the exemption.
const originalReportHashes: ReadonlyMap<string, string> = new Map([
  [originalReport + 'references/rule-migration-manifest-v3.6.0.json',
    'a98ca676be64c25282a99dec245f03bc8ea90e9bd89c8e2368852b02da6092f5'],
  [originalReport + 'scripts/validate_rule_restructure.py',
    'bb2f2943c8942e5497baf85ef38bc8b878f560b563afcf9619d1f6655e5dfaf5'],
])

/** One blocked term occurrence in a tracked path or text line. */
export interface ConcreteTermViolation {
  /** Repository-relative tracked path. */
  file: string
  /** One-based source line, or null when the path contains the term. */
  line: number | null
}

function isExcluded(file: string): boolean {
  return excludedPrefixes.some(prefix => file.startsWith(prefix))
    // Release snapshots retain the identifiers present in their pinned source;
    // historical-format pairing records key sections by those identifiers' headings.
    || /^docs\/persistence-changes\/releases\/dsh-v\d+\.\d+\.\d+-(?:alpha|rc)\.\d+\.schema\.json$/u.test(file)
    || /^docs\/persistence-changes\/historical-formats\/v(?:0|[1-9]\d*)\.(?:schema\.json|i18n\.yaml)$/u.test(file)
}

function containsBlockedTerm(value: string): boolean {
  return value.normalize('NFKC').toLowerCase().includes(blockedTerm)
}

/**
 * Find the blocked term in one maintained tracked file.
 * @param file - repository-relative tracked path.
 * @param source - text contents or symlink target.
 * @returns violations outside unchanged pinned report resources, vendor, frozen notes and checked historical schema regions.
 */
export function findConcreteTermViolations(file: string, source: string): ConcreteTermViolation[] {
  if (isExcluded(file)) return []
  // This generated path/digest catalog has no prose; its strict schema is checked by the shared reader.
  if (file === 'scripts/imported-research-content.json' || isUnchangedImportedResearchContent(file, source)) return []
  const originalHash = originalReportHashes.get(file)
  if (originalHash !== undefined && createHash('sha256').update(source).digest('hex') === originalHash) return []
  const violations: ConcreteTermViolation[] = []
  if (containsBlockedTerm(file)) violations.push({ file, line: null })
  const lines = source.split(/\r?\n/u)
  const schemaRegion = historicalSchemaRegion(file, source)
  for (const [index, line] of lines.entries()) {
    if (schemaRegion !== undefined && index >= schemaRegion[0] && index < schemaRegion[1]) continue
    if (containsBlockedTerm(line)) violations.push({ file, line: index + 1 })
  }
  return violations
}

function trackedFiles(repoRoot: string): string[] {
  const files = trackedRepositoryFiles(repoRoot)
  if (!files.includes('AGENTS.md')
    || !files.some(file => file.startsWith('packages/'))
    || !files.some(file => file.startsWith('docs/'))
    || !files.some(file => file.startsWith('vendor/'))
    || !files.some(file => file.startsWith('.agents/notes/archived/'))) {
    throw new Error('verify-concrete-terms: tracked-file discovery omitted a required repository area')
  }
  return files
}

/**
 * Read one tracked file without following a symlink to its target.
 * @param repoRoot - Repository root containing the tracked path.
 * @param file - Repository-relative tracked path.
 * @returns File text, the symlink target, or undefined when the path is absent or not a file.
 */
export function readTrackedSource(repoRoot: string, file: string): string | undefined {
  const path = resolve(repoRoot, file)
  const stat = lstatSync(path, { throwIfNoEntry: false })
  if (stat === undefined) return undefined
  if (stat.isSymbolicLink()) return readlinkSync(path)
  return stat.isFile() ? readFileSync(path, 'utf8') : undefined
}

function scanRepository(repoRoot: string): ConcreteTermViolation[] {
  const violations: ConcreteTermViolation[] = []
  for (const file of trackedFiles(repoRoot)) {
    const source = readTrackedSource(repoRoot, file)
    if (source === undefined) continue
    violations.push(...findConcreteTermViolations(file, source))
  }
  return violations
}

const invokedPath = process.argv[1]
const isMain = invokedPath !== undefined && import.meta.url === pathToFileURL(resolve(invokedPath)).href
if (isMain) {
  const violations = scanRepository(root)
  if (violations.length === 0) {
    console.log(`verify-concrete-terms: maintained tracked files contain no ${blockedTerm}.`)
  } else {
    console.error(`verify-concrete-terms: ${blockedTerm} is forbidden; name the exact source, field, identity, or evidence:`)
    for (const violation of violations) {
      console.error(violation.line === null
        ? `  ${violation.file} (path)`
        : `  ${violation.file}:${String(violation.line)}`)
    }
    process.exitCode = 1
  }
}
