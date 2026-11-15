/** Page-owned selection over the currently drawn Native workspace rows. */
import { defineStore } from '@deepseek-ai/dsh-client-store'

/** Selection belongs to one account page and original Session store instance. */
export interface WorkspaceFileSelection {
  root?: string
  directory?: string
  selected: string[]
}
/** UI containment only; the account file owner remains the authorization boundary. */
export function insideWorkspace(root: string | undefined, path: string): boolean {
  return root !== undefined && (path === root || path.startsWith(root.endsWith('/') ? root : `${root}/`))
}
/** @returns A shared Session-scoped handle instantiated only by the renderer. */
export function createWorkspaceFileActionsStore() {
  return defineStore({
    init: (): WorkspaceFileSelection => ({ selected: [] }),
    actions: {
      root(d, root: string) {
        if (d.root === root) return
        d.root = root; d.directory = root; d.selected = []
      },
      directory(d, path: string) { if (insideWorkspace(d.root, path)) d.directory = path },
      select(d, path: string) {
        if (!insideWorkspace(d.root, path) || path === d.root) return
        d.selected = d.selected.includes(path) ? d.selected.filter(value => value !== path) : [...d.selected, path]
      },
      forget(d, path: string) {
        d.selected = d.selected.filter(value => value !== path)
        if (d.directory === path) { delete d.directory; if (d.root !== undefined) d.directory = d.root }
      },
    },
  })
}
