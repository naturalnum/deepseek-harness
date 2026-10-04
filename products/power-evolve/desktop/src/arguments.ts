/** Product flags follow the Electron application entry; Chromium flags are owned by Electron. */
import { resolve } from 'node:path'
import { parseArgs } from 'node:util'

/**
 * Parse only the explicitly launched product application's options. Packaged launches omit
 * Electron's inspect and remote-debugging-port switches only in numeric equals form (0–65535).
 * Other switches and positional arguments remain strict; installation rejects returned overrides.
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
  let optionsEnded = false
  const args = argv.slice(entry + 1).filter(value => {
    if (value === '--') optionsEnded = true
    const port = packaged && !optionsEnded ? /^--(?:inspect|remote-debugging-port)=(\d+)$/u.exec(value) : null
    return port === null || Number(port[1]) > 65535
  })
  return parseArgs({ args, options: {
    config: { type: 'string' }, 'data-dir': { type: 'string' }, 'device-config': { type: 'string' },
  }, strict: true }).values
}
