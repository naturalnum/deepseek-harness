/** Import uploaded text only; the parser receives no Host filesystem reader. */
import { parseSshConfig, splitDirective } from './ssh-config.ts'

/** Parse literal hosts from uploaded SSH config text.
 * Local files, Includes, Match rules, forwarding and proxy execution cannot be carried into cloud credentials.
 * @param text Account-uploaded UTF-8 configuration, bounded by the original upload owner.
 * @param maxBytes Explicit complete text bound.
 * @returns Detached candidates; authentication requires a separate authorized account key.
 */
export function uploadedSshConfig(text: string, maxBytes: number): readonly {
  alias: string
  host: string
  user?: string
  port?: number
  requiresAccountKey: true
}[] {
  if (!Number.isSafeInteger(maxBytes) || maxBytes < 1 || typeof text !== 'string'
    || Buffer.byteLength(text) > maxBytes || text.includes('\0')) throw new Error('cloud/invalid-ssh-config')
  for (const line of text.split('\n')) {
    const directive = splitDirective(line)
    if (directive !== undefined && !['host', 'hostname', 'user', 'port', 'identityfile'].includes(directive.keyword)) {
      throw new Error('cloud/unsupported-ssh-config-directive')
    }
  }
  const source = '/uploaded-config'
  const parsed = parseSshConfig(source, { home: '/no-host-home', read: path => path === source ? text : undefined })
  return parsed.map(({ alias, host, user, port }) => ({ alias, host, ...(user === undefined ? {} : { user }),
    ...(port === undefined ? {} : { port }), requiresAccountKey: true }))
}
