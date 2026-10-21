/** Resolve the shipped Python payload from the built lib module only. */
import { basename, dirname, extname, join } from 'node:path'
import { fileURLToPath } from 'node:url'
import { BootstrapFailure, loadBootstrapPayload, type BootstrapPayload } from './bootstrap.ts'

/**
 * Load all nine fixed Python assets from this installed package before opening remote work.
 * @returns Verified helper bytes and the original six-file agent payload.
 * @throws BootstrapFailure when invoked from source, or when a shipped file is missing, linked or mismatched.
 */
export async function loadPackagedBootstrapPayload(): Promise<BootstrapPayload> {
  try {
    const modulePath = fileURLToPath(import.meta.url), lib = dirname(modulePath)
    if (basename(lib) !== 'lib' || extname(modulePath) !== '.js') throw new BootstrapFailure('binding')
    return await loadBootstrapPayload(join(lib, '../runtime/bootstrap'), join(lib, '../runtime/agent'))
  } catch (cause) { throw new BootstrapFailure('binding', cause) }
}
