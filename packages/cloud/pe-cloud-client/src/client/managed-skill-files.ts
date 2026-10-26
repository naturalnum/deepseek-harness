/** Complete browser-file encoding for the API owner's files/ZIP DTO; no archive parsing, path authorization or source handle is created. */
import type { ManagedSkillBundle, ManagedSkillLimits } from './managed-skill-editing.ts'
import type { ManagedSkillRemote } from './managed-skill-remote.ts'
import { ClientFailure } from './errors.ts'

function base64(bytes: Uint8Array<ArrayBuffer>): string {
  let binary = ''
  for (const byte of bytes) binary += String.fromCharCode(byte)
  return btoa(binary)
}

/**
 * Read a complete user-selected package under the limits captured with its directory edit.
 * @param bundle Local full-file draft or original ZIP File; edited instructions replace only the selected root SKILL.md.
 * @param limits Explicit native capability limits; server decoding, expanded-size and request-envelope limits remain authoritative.
 * @param signal Original page/editor observation; cancellation never implies backend rollback.
 * @returns The exact files or ZIP JSON fields defined by the API owner; each resource is read once without executing it.
 */
export async function encodeManagedSkillBundle(bundle: ManagedSkillBundle, limits: ManagedSkillLimits, signal: AbortSignal): Promise<Parameters<ManagedSkillRemote['install']>[0]['bundle']> {
  signal.throwIfAborted()
  if (bundle.kind === 'zip') {
    if (bundle.file.size === 0 || bundle.file.size > limits.maxArchiveBytes) throw new ClientFailure('closed')
    const bytes = new Uint8Array(await bundle.file.arrayBuffer())
    signal.throwIfAborted()
    if (bytes.byteLength !== bundle.file.size || bytes.byteLength > limits.maxArchiveBytes) throw new ClientFailure('closed')
    return Object.freeze({ kind: 'zip' as const, dataBase64: base64(bytes) })
  }
  const markdown = new TextEncoder().encode(bundle.markdown)
  if (markdown.byteLength === 0 || markdown.byteLength > limits.maxFileBytes) throw new ClientFailure('closed')
  let total = markdown.byteLength
  for (const entry of bundle.selection.files) if (entry.path !== 'SKILL.md') total += entry.file.size
  if (total > limits.maxTotalBytes) throw new ClientFailure('closed')
  const files: Array<{ readonly relativePath: string; readonly dataBase64: string }> = []
  for (const entry of bundle.selection.files) {
    const bytes = entry.path === 'SKILL.md' ? markdown : new Uint8Array(await entry.file.arrayBuffer())
    signal.throwIfAborted()
    if (bytes.byteLength > limits.maxFileBytes || entry.path !== 'SKILL.md' && bytes.byteLength !== entry.file.size) {
      throw new ClientFailure('closed')
    }
    files.push(Object.freeze({ relativePath: entry.path, dataBase64: base64(bytes) }))
  }
  return Object.freeze({ kind: 'files' as const, files: Object.freeze(files) })
}
