/** Product flags follow the Electron application entry; Chromium flags are owned by Electron. */
import { resolve } from 'node:path'
import { parseArgs } from 'node:util'

/**
 * Parse only the explicitly launched product application's options.
 * @param argv - Electron process argument vector, including its executable.
 * @param application - Electron-resolved application directory.
 * @param packaged - Whether the executable itself owns the application entry.
 * @returns Local deployment file and optional development data/Device files.
 */
export function cloudDesktopArguments(argv: readonly string[], application: string, packaged: boolean): {
  readonly config?: string; readonly 'data-dir'?: string; readonly 'device-config'?: string
} {
  const entry = packaged ? 0 : argv.findIndex((value, index) => index > 0 && !value.startsWith('--') && resolve(value) === resolve(application))
  if (entry < 0) throw new Error('PowerEvolve desktop: missing application argument')
  return parseArgs({ args: argv.slice(entry + 1), options: {
    config: { type: 'string' }, 'data-dir': { type: 'string' }, 'device-config': { type: 'string' },
  }, strict: true }).values
}
