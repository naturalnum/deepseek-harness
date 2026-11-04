/** Deterministic OpenSSH request for an account-authorized credential lease; no ambient SSH configuration. */
import type { RemoteServer } from './account.ts'

/** Assemble one connection. Paths come only from an original private credential lease, never a browser form.
 * @param entry Validated account target.
 * @param command Exact remote shell command.
 * @param lease Original execution-world private files, retained until actual process release.
 * @param connectTimeoutSeconds Explicit finite connect bound.
 * @returns Argv without key contents; the original managed Subprocess provider must own spawning and cancellation.
 */
export function sshArgv(entry: RemoteServer, command: string,
  lease: { readonly identityPath: string; readonly knownHostsPath: string }, connectTimeoutSeconds: number): readonly string[] {
  if (!Number.isSafeInteger(connectTimeoutSeconds) || connectTimeoutSeconds < 1 || connectTimeoutSeconds > 60) throw new RangeError('Invalid connect bound')
  for (const path of [lease.identityPath, lease.knownHostsPath]) if (!path.startsWith('/') || /[\0\s]/.test(path)) throw new Error('Invalid original credential lease')
  return ['/usr/bin/ssh', '-F/dev/null', '-oBatchMode=yes', '-oStrictHostKeyChecking=yes',
    '-oGlobalKnownHostsFile=/dev/null', `-oUserKnownHostsFile=${lease.knownHostsPath}`, '-oIdentitiesOnly=yes',
    '-oIdentityAgent=none', '-oControlPath=none', '-oPreferredAuthentications=publickey',
    `-oConnectTimeout=${connectTimeoutSeconds}`, `-i${lease.identityPath}`, `-p${entry.port}`,
    '--', `${entry.user}@${entry.host}`, command]
}
