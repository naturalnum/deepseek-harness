/** Volatile selections belong to a viewed Session, tab record and displayed root. */
import { defineStore } from '@deepseek-ai/dsh-client-store'
import { downloadPaths, MAX_DOWNLOAD_FILES } from './download-client.ts'

interface Selection { sessionId: string; root: string; paths: string[] }
export interface DownloadSelections { byTab: Record<string, Selection> }

/** Reject additions that cannot fit the shared request and URL limits.
 * @param sessionId - viewed Session owning the files.
 * @param paths - currently selected absolute paths.
 * @param path - candidate absolute Workspace file path.
 * @returns whether the addition passes protocol validation.
 */
export function canSelect(sessionId: string, paths: readonly string[], path: string): boolean {
  try { downloadPaths(sessionId, [...paths, path]); return true }
  catch (_error) { return false }
}

/** Hiding the tree retains selections; tab abort or a changed root discards them.
 * @returns a Session-scoped store handle shared by row and toolbar contributions.
 */
export function createDownloadSelectionStore() {
  return defineStore({
    init: (): DownloadSelections => ({ byTab: {} }),
    actions: {
      toggle(state, sessionId: string, tabId: string, root: string, path: string) {
        const previous = state.byTab[tabId]
        const paths = previous?.sessionId === sessionId && previous.root === root ? previous.paths : []
        const selected = paths.includes(path)
        if (!selected && (paths.length >= MAX_DOWNLOAD_FILES || !canSelect(sessionId, paths, path))) return
        const next = selected ? paths.filter(item => item !== path) : [...paths, path]
        if (next.length === 0) delete state.byTab[tabId]
        else state.byTab[tabId] = { sessionId, root, paths: next }
      },
      forget(state, tabId: string) { delete state.byTab[tabId] },
      resetRoot(state, sessionId: string, tabId: string, root: string) {
        const previous = state.byTab[tabId]
        if (previous?.sessionId !== sessionId || previous.root !== root) delete state.byTab[tabId]
      },
    },
  })
}
