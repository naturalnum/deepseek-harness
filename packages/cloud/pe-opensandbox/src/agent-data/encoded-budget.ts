/** Pure preallocation bound for the unchanged 4KiB atomic guardian-config frame. */
import { skillWorld, type SkillWorld } from './skill-world.ts'
import { absolute, asciiJSON, need, spec } from './canonical.ts'
import type { OperationSpec } from './types.ts'

const ENV_ROOT = '/opt/session-env'
const ENV = { PATH: ENV_ROOT + '/venv/bin:/usr/local/bin:/usr/bin:/bin', HOME: ENV_ROOT + '/home',
  TMPDIR: ENV_ROOT + '/tmp', LANG: 'C.UTF-8' }
const U64_MAX_DECIMAL = '18446744073709551615'
const ROOT_PAIR = '[' + U64_MAX_DECIMAL + ',' + U64_MAX_DECIMAL + ']'

/**
 * Reject an oversized complete guardian config before Root allocates any resource.
 * @param projectRoot - Original Root-selected canonical project target, under the existing startup root policy.
 * @param value - Existing argv/cwd/stdin spec; mode is explicit and finite batch input remains a separate pipe.
 * @param copies - Optional normalized original-files facts included in the same complete frame budget.
 * @returns Conservative maximum ASCII encoded frame bytes, including four 20-digit integer identities and fixed ENV.
 */
export function guardianEncodedBudget(projectRoot: string, value: OperationSpec, copies?: SkillWorld): number {
  absolute(projectRoot)
  const normalized = spec(value, projectRoot)
  // Only fixed numeric tokens are raw. User strings/argv always go through the existing canonical encoder.
  const frame = '{"argv":' + asciiJSON(normalized.argv) + ',"env":' + asciiJSON(ENV)
    + ',"roots":{' + asciiJSON(projectRoot) + ':' + ROOT_PAIR + ',' + asciiJSON(ENV_ROOT) + ':' + ROOT_PAIR + '}'
    + ',"projectRoot":' + asciiJSON(projectRoot) + ',"cwd":' + asciiJSON(normalized.cwd)
    + ',"stdinMode":' + asciiJSON(normalized.stdin.mode)
    + (copies === undefined ? '' : ',"skillWorld":' + asciiJSON(skillWorld(copies))) + '}'
  const bytes = Buffer.byteLength(frame, 'ascii')
  need(bytes <= 4096, 'guardian_config_budget')
  return bytes
}

/**
 * Reserve room for the complete owner-selected set before any command reservation or allocation.
 * These strings are scalar byte ceilings, never issued identities or wire input; no count-sized array is allocated.
 * @param projectRoot Original canonical project target.
 * @param value Original three-field command.
 * @param maximum Explicit original-owner maximum copies per operation.
 * @returns Conservative complete frame bytes, or refusal if the whole maximum cannot fit.
 */
export function guardianWorkingCopiesBudget(projectRoot: string, value: OperationSpec, maximum: number): number {
  need(Number.isSafeInteger(maximum) && maximum >= 1 && maximum <= 2147483647, 'skill_copy_budget')
  const base = guardianEncodedBudget(projectRoot, value)
  const directory = '{"device":"' + U64_MAX_DECIMAL + '","inode":"' + U64_MAX_DECIMAL + '"}'
  const entry = '{"identity":' + directory + ',"version":"' + '0'.repeat(36) + '"}'
  const fixed = '{"copies":[],"maxCopies":' + String(maximum) + ',"metadata":' + directory + ',"skills":' + directory + '}'
  const bytes = base + Buffer.byteLength(',"skillWorld":' + fixed, 'ascii') + maximum * entry.length + maximum - 1
  need(Number.isSafeInteger(bytes) && bytes <= 4096, 'guardian_config_budget')
  return bytes
}
