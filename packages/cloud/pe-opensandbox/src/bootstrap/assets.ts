/** Resolve the shipped Python payload from the built lib module only. */
import { basename, dirname, extname, join } from 'node:path'
import { fileURLToPath } from 'node:url'
import { runtimePayloadPins, SOURCE_DIGEST } from './asset-manifest.ts'
import { BootstrapFailure, loadBootstrapPayload, type BootstrapPayload } from './bootstrap.ts'

/**
 * Load all eleven fixed Python assets from this installed package before opening remote work.
 * @returns Verified helper bytes and the original eight-file agent payload.
 * @throws BootstrapFailure when invoked from source, or when a shipped file is missing, linked or mismatched.
 */
export async function loadPackagedBootstrapPayload(digest: string = SOURCE_DIGEST): Promise<BootstrapPayload> {
  try {
    const modulePath = fileURLToPath(import.meta.url), lib = dirname(modulePath)
    if (basename(lib) !== 'lib' || extname(modulePath) !== '.js') throw new BootstrapFailure('binding')
    const pins = runtimePayloadPins(digest)
    if (pins === undefined) throw new BootstrapFailure('binding')
    const root = join(lib, '..', pins.directory)
    return await loadBootstrapPayload(join(root, 'bootstrap'), join(root, 'agent'), digest)
  } catch (cause) { throw new BootstrapFailure('binding', cause) }
}
