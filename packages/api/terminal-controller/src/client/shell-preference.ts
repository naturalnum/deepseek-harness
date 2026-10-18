import { resolveClientPersistence, type ClientPersistence } from '@deepseek-ai/dsh-client-store'
/** Browser-local shell preference; Host discovery decides whether the saved path is usable. */
const KEY = 'dsh.terminal.shell'

/**
 * Read the browser preference.
 * @param persistence - captured page port; omitted uses ordinary browser storage.
 * @returns the last selected shell path, or null when storage is unavailable.
 */
export function preferredShell(persistence?: ClientPersistence): string | null {
  return resolveClientPersistence(persistence).getItem(KEY)
}

/**
 * Remember the selected shell without making storage a startup dependency.
 * @param path - verified executable path offered by the Host.
 * @param persistence - captured page port; omitted uses ordinary browser storage.
 */
export function rememberShell(path: string, persistence?: ClientPersistence): void {
  resolveClientPersistence(persistence).setItem(KEY, path)
}
