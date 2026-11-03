/** Optional account-owned HTTP operations; native tree retains selection, picking and presentation. */
import type { SessionId } from '@deepseek-ai/dsh-session/types'

/** One user-selected file; File bytes stay in the browser's native HTTP body. */
export interface WorkspaceUploadFile { readonly file: File; readonly path: string }
/** Account/page captured callbacks installed before native tree activation. */
export interface WorkspaceFileManagement {
  upload(sessionId: SessionId, directory: string, files: readonly WorkspaceUploadFile[], signal: AbortSignal,
    progress: (completed: number, total: number) => void): Promise<void>
  download(sessionId: SessionId, paths: readonly string[], signal: AbortSignal): Promise<void>
  createDirectory(sessionId: SessionId, directory: string, name: string, signal: AbortSignal): Promise<string>
}

declare module '@deepseek-ai/cordis' {
  interface Context { workspaceFileManagement: WorkspaceFileManagement }
}
