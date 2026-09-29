export const SKILL_PACKAGE_MAX_BYTES = 1024 * 1024
export const SKILL_IMPORT_FILE_ACCEPT = '.zip,.skill,application/zip,application/x-zip-compressed'

export type SkillImportFileIssue = 'empty' | 'too-large' | 'invalid-name' | 'invalid-type'

/** Browser usability check; Platform validates ZIP structure and package contents. */
export function skillImportFileIssue(file: Pick<File, 'name' | 'size'>): SkillImportFileIssue | undefined {
  if (file.size === 0) return 'empty'
  if (file.size > SKILL_PACKAGE_MAX_BYTES) return 'too-large'
  if (file.name.length === 0 || [...file.name].length > 255 || [...file.name].some(character => {
    const codePoint = character.codePointAt(0) ?? 0
    return codePoint <= 31 || codePoint === 127
  })) return 'invalid-name'
  if (!/\.(?:zip|skill)$/iu.test(file.name)) return 'invalid-type'
  return undefined
}

export function formatSkillImportBytes(bytes: number): string {
  if (bytes < 1024) return `${String(bytes)} B`
  if (bytes < 1024 * 1024) return `${String(Math.ceil(bytes / 1024))} KiB`
  return `${String(Math.round(bytes / (1024 * 1024)))} MiB`
}
