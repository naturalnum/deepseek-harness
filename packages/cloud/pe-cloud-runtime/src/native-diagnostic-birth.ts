/** Select an already flushed Native JSONL artifact without interpreting imported bytes as ownership. */
import { lstat } from 'node:fs/promises'
import { logPath } from '@deepseek-ai/dsh-session-persistence-jsonl'
import type { SessionHeader } from '@deepseek-ai/dsh-session'

/**
 * Select the current generation logged by the original Native creator. Historical imports do not call this function.
 * @param root Exact Native layout owned by the current Runtime account.
 * @param header Original live header after the Native flush barrier.
 * @returns One observed exact current artifact, or undefined for absent or conflicting encodings.
 */
export async function nativeDiagnosticArtifact(root: string, header: SessionHeader): Promise<string | undefined> {
  const paths = await Promise.all((['none', 'zstd'] as const).map(async (compression) => {
    const path = logPath(root, header.cwd, header.id, compression)
    try { return (await lstat(path)).isFile() ? path : undefined }
    catch (error) {
      if (error instanceof Error && Reflect.get(error, 'code') === 'ENOENT') return undefined
      throw error
    }
  }))
  const present = paths.filter(path => path !== undefined)
  return present.length === 1 ? present[0] : undefined
}
