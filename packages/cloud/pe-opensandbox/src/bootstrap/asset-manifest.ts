/** Fixed nonsecret Python payload pins; mismatches reject before any remote bootstrap work. */
import { BOOTSTRAP_PINS } from './payload-pins.ts'

/** Installation candidate aggregate; Root adoption and target qualification remain required. */
export const SOURCE_DIGEST = 'bcd587b7b73e02e9b888409e6d812de0192e029e7094536c11cef376944f1fe2'
/** Installation candidate source hashes and exact byte lengths, shared with the candidate publisher. */
export const SOURCES = {
  'server.py': ['1d368b899c9a587c4346e110824fd7906c811190294b609b117bdbd19f89e1fd', 13930],
  'wire.py': ['3fe52dc73a8da069ac45d6a5e9aa4e09ed2640b0d27a67df3a14678093d313bc', 9190],
  'manager.py': ['f77fe50f041e84f6892b0a7314bbc796cb77a2c7f0e32edd8eab80b1cb2e9f64', 10286],
  'launcher.py': ['b4e36866eeec36c15586ca21815321b8aff18ceaa01d0d5ccc07502a0f33a667', 17976],
  'guardian.py': ['d154d7ec699fca6da6a4e46327421ee548e5b0098744142dcab2384f9b4c6f70', 5001],
  'paths.py': ['ef950f6625a134c93b11feedb028cc69bb6b4698a9914270ec9340bb7ee7e0e7', 9728],
} as const

/** The complete nine-file runtime payload shipped beside lib; no secret configuration is included. */
export const RUNTIME_ASSET_MANIFEST = Object.freeze([
  ...Object.entries(SOURCES).map(([name, pin]) => Object.freeze({ path: `agent/${name}`, bytes: pin[1], sha256: pin[0] })),
  ...Object.entries(BOOTSTRAP_PINS).map(([name, pin]) => Object.freeze({ path: `bootstrap/${name}`, bytes: pin.bytes, sha256: pin.sha256 })),
])
