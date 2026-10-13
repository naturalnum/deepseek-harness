/** Maximum archive size submitted by the browser; Platform validates its contents. */
export const SKILL_PACKAGE_MAX_BYTES = 1024 * 1024
/** File-picker extensions and ZIP media types; names and size are checked separately. */
export const SKILL_IMPORT_FILE_ACCEPT = '.zip,.skill,application/zip,application/x-zip-compressed'

/** Local archive-selection errors before requesting a Platform upload ticket. */
export type SkillImportFileIssue = 'empty' | 'too-large' | 'invalid-name' | 'invalid-type'

/** Browser usability check; Platform validates ZIP structure and package contents.
 * @param file - selected archive name and byte size.
 * @returns the first local selection error, or undefined.
 */
export function skillImportFileIssue(file: Pick<File, 'name' | 'size'>): SkillImportFileIssue | undefined {
  if (file.size === 0) return 'empty'
  if (file.size > SKILL_PACKAGE_MAX_BYTES) return 'too-large'
  if (file.name.length === 0 || Array.from(file.name).length > 255 || /[\u0000-\u001f\u007f]/u.test(file.name)) return 'invalid-name'
  if (!/\.(?:zip|skill)$/iu.test(file.name)) return 'invalid-type'
  return undefined
}

/** Format the selected archive size for the file-picker hint.
 * @param bytes - archive byte count.
 * @returns byte, KiB or MiB display text.
 */
export function formatSkillImportBytes(bytes: number): string {
  if (bytes < 1024) return `${String(bytes)} B`
  if (bytes < 1024 * 1024) return `${String(Math.ceil(bytes / 1024))} KiB`
  return `${String(Math.round(bytes / (1024 * 1024)))} MiB`
}
