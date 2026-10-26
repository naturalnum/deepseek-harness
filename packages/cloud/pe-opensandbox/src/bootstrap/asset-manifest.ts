/** Fixed nonsecret Python payload pins; mismatches reject before any remote bootstrap work. */
import { BOOTSTRAP_PINS } from './payload-pins.ts'

/** Installation candidate aggregate; Root adoption and target qualification remain required. */
export const SOURCE_DIGEST = 'f808ab275dfb15768dd622ae69882dc9412e1c4d67121e79301692a260049a02'
/** Installation candidate source hashes and exact byte lengths, shared with the candidate publisher. */
export const SOURCES = {
  'server.py': ['1d368b899c9a587c4346e110824fd7906c811190294b609b117bdbd19f89e1fd', 13930],
  'wire.py': ['d63d99dd66428bb33a0a6a249f5e42fbf1a13e5366ccd74a08ff912be3b7c66e', 8701],
  'manager.py': ['3fb2504f33f19c73c57dde8de9a5d1bc09352dc67268607103d99164c395de47', 10194],
  'launcher.py': ['80538adf46352f93f232ec24b5a7cfb45140b56c19c44cf5be30833787f393db', 17164],
  'guardian.py': ['aba4674b0e19de53a1aa9516e63b273fa5bd3b93ebbd4168549860f929d7a576', 4779],
  'paths.py': ['b7d39bf8596ef9e937a08fa148336945ef245aa6bb863583544994ffd9c4cea1', 8832],
} as const

/** The complete nine-file runtime payload shipped beside lib; no secret configuration is included. */
export const RUNTIME_ASSET_MANIFEST = Object.freeze([
  ...Object.entries(SOURCES).map(([name, pin]) => Object.freeze({ path: `agent/${name}`, bytes: pin[1], sha256: pin[0] })),
  ...Object.entries(BOOTSTRAP_PINS).map(([name, pin]) => Object.freeze({ path: `bootstrap/${name}`, bytes: pin.bytes, sha256: pin.sha256 })),
])
