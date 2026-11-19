/** Fixed nonsecret Python payload pins; mismatches reject before any remote bootstrap work. */
import { BOOTSTRAP_PINS } from './payload-pins.ts'
import { RENEWAL_SOURCE_DIGEST, RENEWAL_SOURCES } from './renewal-asset-manifest.ts'
import { RENEWAL_BOOTSTRAP_PINS } from './renewal-payload-pins.ts'

/** Installation candidate aggregate; Root adoption and target qualification remain required. */
export const SOURCE_DIGEST = '9e1744674aa758c8b9b75e64c13aed36d46f90439b0949c96b22532cd3cf5bd5'
/** Installation candidate source hashes and exact byte lengths, shared with the candidate publisher. */
export const SOURCES = {
  'guardian.py': ['6b03761b7a000334f92ace6ff8131feccd2a85347a2bbc8dfe99c92c0cc1e54e', 6683],
  'launcher.py': ['532138ba6063c24cee3c5857441268316f27848e452adbc57d36ddae1dd8d719', 23609],
  'manager.py': ['f73bb3effd9132ed23dcfe76d2aebe48ba1a9cc52d18b6c5c7a75c35274bfe46', 13544],
  'paths.py': ['32eee56d10be1c13cc3d4615e614888abcf26e1ad8e102db801d81fd084e858b', 10067],
  'server.py': ['70a28d4e7011a6e156ba59728d76770773432cc5589e2767819e7b83d883aa32', 19002],
  'stream.py': ['3d74398162ed9ec113c9e5a1b06e878f4aaf42e6533809fc21bfe60ced6db785', 10287],
  'terminal.py': ['e7c3e8e298562a9629f1cefec2f753d34fda1d6285ad14982859c4cd026d8c36', 6830],
  'wire.py': ['d3bb470972d4ff0782694095771d425c8d79e6bbce2d0130bb5f65d5ca006e79', 11329],
} as const

/** The complete eleven-file runtime payload shipped beside lib; no secret configuration is included. */
export const RUNTIME_ASSET_MANIFEST = Object.freeze([
  ...Object.entries(SOURCES).map(([name, pin]) => Object.freeze({ path: `agent/${name}`, bytes: pin[1], sha256: pin[0] })),
  ...Object.entries(BOOTSTRAP_PINS).map(([name, pin]) => Object.freeze({ path: `bootstrap/${name}`, bytes: pin.bytes, sha256: pin.sha256 })),
])

/** Map one protected digest to its fixed local files, never to a caller-supplied directory. */
export function runtimePayloadPins(digest: string) {
  if (digest === SOURCE_DIGEST) return { agent: SOURCES, bootstrap: BOOTSTRAP_PINS, directory: 'runtime' }
  if (digest === RENEWAL_SOURCE_DIGEST) {
    return { agent: RENEWAL_SOURCES, bootstrap: RENEWAL_BOOTSTRAP_PINS, directory: 'runtime/s08-renewal' }
  }
}
