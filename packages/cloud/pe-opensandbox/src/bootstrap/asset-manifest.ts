/** Fixed nonsecret Python payload pins; mismatches reject before any remote bootstrap work. */
import { BOOTSTRAP_PINS } from './payload-pins.ts'

/** Installation candidate aggregate; Root adoption and target qualification remain required. */
export const SOURCE_DIGEST = 'f4f591c8eb43595ccad18ba16f3269bceadbe167167ae040de9268672ad1fb86'
/** Installation candidate source hashes and exact byte lengths, shared with the candidate publisher. */
export const SOURCES = {
  'server.py': ['1d368b899c9a587c4346e110824fd7906c811190294b609b117bdbd19f89e1fd', 13930],
  'wire.py': ['61ccc388862c0df0b0d3e011f7f1a3e3c7506ac460dab26a18070d71e3c4b885', 9213],
  'manager.py': ['f77fe50f041e84f6892b0a7314bbc796cb77a2c7f0e32edd8eab80b1cb2e9f64', 10286],
  'launcher.py': ['039c76f8a83c142281b6d3f69ee183f166ecff693836eeca362c130450e7d6f5', 18093],
  'guardian.py': ['d154d7ec699fca6da6a4e46327421ee548e5b0098744142dcab2384f9b4c6f70', 5001],
  'paths.py': ['2515e2e14346dd2eaf0ed98fc7a6c1b9085b32180bd5a06911c63bf9101fff34', 9830],
} as const

/** The complete nine-file runtime payload shipped beside lib; no secret configuration is included. */
export const RUNTIME_ASSET_MANIFEST = Object.freeze([
  ...Object.entries(SOURCES).map(([name, pin]) => Object.freeze({ path: `agent/${name}`, bytes: pin[1], sha256: pin[0] })),
  ...Object.entries(BOOTSTRAP_PINS).map(([name, pin]) => Object.freeze({ path: `bootstrap/${name}`, bytes: pin.bytes, sha256: pin.sha256 })),
])
