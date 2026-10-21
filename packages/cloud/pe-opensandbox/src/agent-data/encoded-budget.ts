/** Pure preallocation bound for the unchanged 4KiB atomic guardian-config frame. */
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
 * @returns Conservative maximum ASCII encoded frame bytes, including four20-digit integer identities and fixed ENV.
 */
export function guardianEncodedBudget(projectRoot: string, value: OperationSpec): number {
  absolute(projectRoot)
  const normalized = spec(value, projectRoot)
  // Only fixed numeric tokens are raw. User strings/argv always go through the existing canonical encoder.
  const frame = '{"argv":' + asciiJSON(normalized.argv) + ',"env":' + asciiJSON(ENV)
    + ',"roots":{' + asciiJSON(projectRoot) + ':' + ROOT_PAIR + ',' + asciiJSON(ENV_ROOT) + ':' + ROOT_PAIR + '}'
    + ',"projectRoot":' + asciiJSON(projectRoot) + ',"cwd":' + asciiJSON(normalized.cwd)
    + ',"stdinMode":' + asciiJSON(normalized.stdin.mode) + '}'
  const bytes = Buffer.byteLength(frame, 'ascii')
  need(bytes <= 4096, 'guardian_config_budget')
  return bytes
}
