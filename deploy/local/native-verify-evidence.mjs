/** Fixed read-only evidence for the original 1de3 verification; no caller-supplied allClosed assertion. */
import fs from 'node:fs'
import { join } from 'node:path'
import { execFile } from 'node:child_process'
import { promisify } from 'node:util'
import { createHash } from 'node:crypto'
import { CANDIDATE_CONTAINER } from './inspect.mjs'
import stateModule from './native-delivery-state.cjs'

export const ORIGINAL_VERIFY_OPERATION = '1de3c28b-bb13-46da-91bb-950cb3073133'
export const ORIGINAL_SMOKE_SHA256 = '55d9a40a4a95a3cc06f3199b8efdfe976cf5d123380adf88dddf943e4fa0d845'
const session = '/srv/dsh-features-281fb24f-afdd-4266-8f89-bbda8f8a6a4d/accounts/v1-0b3a173da0d6d761b3976f4f776e623a9054503c25df9196208ec4d3fb7f8715/private/sessions/'
  + '--srv-dsh-features-281fb24f-afdd-4266-8f89-bbda8f8a6a4d-accounts-v1-0b3a173da0d6d761b3976f4f776e623a9054503c25df9196208ec4d3fb7f8715-projects-e16def93-4fd9-45e0-a408-a3b1cdd7ad73--/'
  + 'session-feac4e50-71bf-4bbe-9b81-114aedf82040/session.v4.jsonl'
const records = [
  ['f476338a-2cca-4720-b547-7c0f3306ea64', 'a4df3b5588c80a39534bc9607a030e9ad8eae4a11277a7d0af4db9cd6aed3b0e'],
  ['300d56bc-cfc7-454f-b135-4bea5841541c', 'b58e595a29f767de8944769e2ee6c4374de05e0eeefb39e72d5175cbd99319e7'],
  ['46de8761-0d34-40f8-afa9-e0a6fc509385', 'bb472261356ed9cc2013f0da29c65c7fa3dddea795a55bcda2153544a22391cd'],
]
const execute = promisify(execFile)
const sha = bytes => createHash('sha256').update(bytes).digest('hex')
const reject = () => { throw new stateModule.NativeDeliveryUnconfirmed('verify-original-effects-evidence') }

/** Re-read the original completed producer jobs and original provider completion records, without mutating them. */
export async function readOriginalVerifyEvidence() {
  try {
    const { stdout: text } = await execute('docker', ['exec', CANDIDATE_CONTAINER, 'cat', '/proc/27047/root' + session],
      { encoding: 'utf8', maxBuffer: 262144, timeout: 10000 })
    if (sha(text) !== '3e212d5631699a14718057169c8e86d289c16b0e5d3fd78cfb7e34cb28287287') reject()
    const events = text.trimEnd().split('\n').map(line => JSON.parse(line))
    const jobs = events.filter(row => row.type === 'job/settled')
    if (jobs.length !== 8 || jobs.some(({ data }) => data.status !== 'completed'
      || data.producerReported !== true || data.detail !== 'exit code: 0')
      || events.filter(row => row.type === 'turn/end' && row.data.reason.kind === 'completed').length !== 6) reject()
    for (const [sid, expected] of records) {
      const { stdout } = await execute('docker', ['exec', 'dsh-features-20261107-backend', 'docker', '-H',
        'unix:///run/backend/docker.sock', 'exec', 'dsh-features-science-sdk-c12b4c88-v8',
        'cat', '/work/deletion-completions/' + sid + '.json'], { encoding: 'utf8', maxBuffer: 32768, timeout: 10000 })
      if (sha(stdout) !== expected || JSON.parse(stdout).phase !== 'completed') reject()
    }
    return { sessionSha256: sha(text), providerCompletions: records.map(([sid, sha256]) => ({ sid, sha256 })) }
  } catch (_error) { reject() }
}

/** Claim this one new attempt durably; an existing or unconfirmed claim forbids automatic replay. */
export function claimOriginalVerifyAttempt(directory, evidence) {
  const dir = fs.openSync(directory, fs.constants.O_RDONLY | fs.constants.O_DIRECTORY | fs.constants.O_NOFOLLOW)
  let fd, failure
  try {
    const stat = fs.fstatSync(dir)
    if (!stat.isDirectory() || stat.uid !== process.getuid() || (stat.mode & 0o7777) !== 0o700) reject()
    fd = fs.openSync(join(directory, ORIGINAL_VERIFY_OPERATION + '.verify-attempt.json'), 'wx', 0o600)
    fs.writeFileSync(fd, JSON.stringify({ format: 'pe-cloud-original-verify-attempt/v1', operation: ORIGINAL_VERIFY_OPERATION,
      pid: process.pid, startedAt: new Date().toISOString(), evidence }) + '\n')
    fs.fsyncSync(fd); fs.fsyncSync(dir)
  } catch (error) { failure = error }
  try { if (fd !== undefined) fs.closeSync(fd) } catch (error) { failure ??= error }
  try { fs.closeSync(dir) } catch (error) { failure ??= error }
  if (failure !== undefined) throw new stateModule.NativeDeliveryUnconfirmed('verify-attempt-retained')
}
