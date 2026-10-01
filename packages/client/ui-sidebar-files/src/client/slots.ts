/** Optional controls in the native file tree; the enclosing tab owns their lifetime. */
import type { WorkspaceDirectoryEntry } from '@deepseek-ai/dsh-api-workspace-files/types'
import type { TabId } from '@deepseek-ai/dsh-client-ui-dockkit'
import type { UseSidebarRightTabInfo } from '@deepseek-ai/dsh-client-ui-sidebar-right/client'

/** Inputs shared by file-tree toolbar and row contributions. */
export interface FilesActionsOwner {
  readonly tabId: TabId
  /** Absolute root of the displayed tree, in the Session's execution environment. */
  readonly root: string
}

/** One listed entry; contributions must distinguish files from directories and other entries. */
export interface FilesEntryOwner extends FilesActionsOwner {
  /** Absolute entry path; listing does not establish a native Host mapping. */
  readonly path: string
  readonly type: WorkspaceDirectoryEntry['type']
}

declare module '@deepseek-ai/dsh-client-ui-slots' {
  interface SlotMap {
    /** Controls before a row's open or expand button, never nested inside it. */
    'sidebar.right.tab.files.entry.leading': {
      kind: 'list'
      scope: 'session'
      owner: FilesEntryOwner
      hookContext: UseSidebarRightTabInfo
      inject: { hooks: { tabInfo: typeof filesTabInfoFactory } }
    }
    /** Controls after the root path and before the tree's reload button. */
    'sidebar.right.tab.files.actions': {
      kind: 'list'
      scope: 'session'
      owner: FilesActionsOwner
      hookContext: UseSidebarRightTabInfo
      inject: { hooks: { tabInfo: typeof filesTabInfoFactory } }
    }
  }
}

/** Forward the enclosing tab's bound reader to its file-tree contributions.
 * @param _standard - framework Session props; the reader is already bound.
 * @param useTabInfo - the enclosing tab's information hook.
 * @returns the same hook, retaining its tab record lifetime.
 */
export function filesTabInfoFactory(_standard: unknown, useTabInfo: UseSidebarRightTabInfo): UseSidebarRightTabInfo {
  return useTabInfo
}
