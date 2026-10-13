/** Read-only display capability used by the native account launcher. */
export interface AccountNavigation {
  readonly displayName: string
  readonly role: 'ADMIN' | 'USER'
  readonly canManage: boolean
  readonly accountUrl: string
}

/** Keep menu navigation on the configured trusted account entry.
 * @param entry - validated Platform account entry URL.
 * @param action - page section selected by the gesture.
 * @returns a destination carrying no password or credential.
 */
export function accountDestination(entry: string, action: 'password' | 'admin'): string {
  const url = new URL(entry)
  if (!['http:', 'https:'].includes(url.protocol) || url.username || url.password
    || url.pathname !== '/account' && url.pathname !== '/account/' || url.search) {
    throw new Error('Invalid trusted account destination')
  }
  url.hash = action
  return url.href
}
