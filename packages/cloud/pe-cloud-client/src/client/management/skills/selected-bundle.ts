/** Local file selection for a complete skill bundle; files/account still validates and owns every uploaded version. */

/** Browser-selected file with a path relative to the selected bundle root. */
export interface SelectedSkillFile {
  readonly path: string
  readonly file: File
}

/** Explicit UI limits supplied by the account capability; no transport or installation authority is granted. */
export interface SkillSelectionLimits {
  readonly maxFiles: number
  readonly maxEntries: number
  readonly maxDirectories: number
  readonly maxPathDepth: number
  readonly maxPathBytes: number
  readonly maxFileBytes: number
  readonly maxTotalBytes: number
}

/** Local selection facts only; resource contents remain in the original immutable browser Files until upload. */
export interface SelectedSkillBundle {
  readonly files: readonly SelectedSkillFile[]
  readonly markdown: string
  readonly totalBytes: number
}

/** The receiving UI localizes these input failures; cancellation remains the caller's AbortSignal rejection. */
export type SkillSelectionResult = { readonly ok: true; readonly value: SelectedSkillBundle }
  | { readonly ok: false; readonly reason: 'files' | 'path' | 'collision' | 'entries' | 'bytes' | 'instructions' | 'read' }

/**
 * Check a complete local selection before reading only its root instructions.
 * @param selected File-picker paths relative to one bundle root; no path is normalized or authorized here.
 * @param limits Explicit account limits, already validated by the capability provider.
 * @param signal Original interaction cancellation; late instruction reads cannot return an accepted selection.
 * @returns Frozen selection metadata and strict UTF-8 instructions, or a local input failure. Resources still require server validation.
 */
export async function readSelectedSkillBundle(selected: readonly SelectedSkillFile[], limits: SkillSelectionLimits,
  signal: AbortSignal): Promise<SkillSelectionResult> {
  signal.throwIfAborted()
  if (selected.length === 0 || selected.length > limits.maxFiles) return { ok: false, reason: 'files' }
  const files = selected.map(({ path, file }) => Object.freeze({ path, file }))
  const paths = new Set<string>(), directories = new Set<string>(), encoder = new TextEncoder()
  let totalBytes = 0, instructions: File | undefined
  for (const { path, file } of files) {
    const parts = path.split('/')
    if (parts.length > limits.maxPathDepth || path.includes('\\') || path.includes('\0') || encoder.encode(path).byteLength > limits.maxPathBytes
      || parts.some(part => part === '' || part === '.' || part === '..')) return { ok: false, reason: 'path' }
    if (paths.has(path)) return { ok: false, reason: 'collision' }
    paths.add(path)
    for (let i = 1; i < parts.length; i++) directories.add(parts.slice(0, i).join('/'))
    if (directories.size > limits.maxDirectories || paths.size + directories.size > limits.maxEntries) return { ok: false, reason: 'entries' }
    totalBytes += file.size
    if (file.size > limits.maxFileBytes || totalBytes > limits.maxTotalBytes) return { ok: false, reason: 'bytes' }
    if (path === 'SKILL.md') instructions = file
  }
  for (const path of paths) if (directories.has(path)) return { ok: false, reason: 'collision' }
  if (instructions === undefined || instructions.size === 0) return { ok: false, reason: 'instructions' }
  let bytes: ArrayBuffer
  try { bytes = await instructions.arrayBuffer() }
  catch (_readFailure) { signal.throwIfAborted(); return { ok: false, reason: 'read' } }
  signal.throwIfAborted()
  if (bytes.byteLength !== instructions.size || bytes.byteLength > limits.maxFileBytes) return { ok: false, reason: 'bytes' }
  let markdown: string
  try { markdown = new TextDecoder('utf-8', { fatal: true, ignoreBOM: true }).decode(bytes) }
  catch (_invalidUtf8) { return { ok: false, reason: 'instructions' } }
  return { ok: true, value: Object.freeze({ files: Object.freeze(files), markdown, totalBytes }) }
}
