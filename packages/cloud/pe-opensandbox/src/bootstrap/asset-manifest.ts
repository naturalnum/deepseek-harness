/** Fixed nonsecret Python payload pins; mismatches reject before any remote bootstrap work. */
import { BOOTSTRAP_PINS } from './payload-pins.ts'

/** Installation candidate aggregate; Root adoption and target qualification remain required. */
export const SOURCE_DIGEST = 'd2d3e62db5f958a8305b7405d8d72db6d20bd7a0c0b7082955f25f5762bb728d'
/** Installation candidate source hashes and exact byte lengths, shared with the candidate publisher. */
export const SOURCES = {
  'server.py': ['1d368b899c9a587c4346e110824fd7906c811190294b609b117bdbd19f89e1fd', 13930],
  'wire.py': ['ddb047c40b6ebfba24807bba127901e6e3fc707a8085711e55ee6ad33871a22b', 9191],
  'manager.py': ['f77fe50f041e84f6892b0a7314bbc796cb77a2c7f0e32edd8eab80b1cb2e9f64', 10286],
  'launcher.py': ['3bf36a1d9d6949d9ebe3c4072a023e9fa8284a1394c70cf63eca2256d70d94e6', 18049],
  'guardian.py': ['d154d7ec699fca6da6a4e46327421ee548e5b0098744142dcab2384f9b4c6f70', 5001],
  'paths.py': ['11043c68c68641401d16ef683939d13ccb1c86a7dd6c49e4c3e27c4880cfd8b6', 9764],
} as const

/** The complete nine-file runtime payload shipped beside lib; no secret configuration is included. */
export const RUNTIME_ASSET_MANIFEST = Object.freeze([
  ...Object.entries(SOURCES).map(([name, pin]) => Object.freeze({ path: `agent/${name}`, bytes: pin[1], sha256: pin[0] })),
  ...Object.entries(BOOTSTRAP_PINS).map(([name, pin]) => Object.freeze({ path: `bootstrap/${name}`, bytes: pin.bytes, sha256: pin.sha256 })),
])
