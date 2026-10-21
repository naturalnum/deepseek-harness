/** Fixed nonsecret Python payload pins; mismatches reject before any remote bootstrap work. */
import { BOOTSTRAP_PINS } from './payload-pins.ts'

/** Installation candidate aggregate; Root adoption and target qualification remain required. */
export const SOURCE_DIGEST = 'cc55d7cb7d61a9bc74569c1f980830bc52fa150f26eecccf0adb7bce37e6abd0'
/** Installation candidate source hashes and exact byte lengths, shared with the candidate publisher. */
export const SOURCES = {
  'server.py': ['302480c419d9790c4355a2295acfe545e43a798051eab5b96cbb940b191aaaf8', 12848],
  'wire.py': ['58311cbe1b5e6c942c05091a02dbd1c5d897275b9e764ce2fc56b650f1e612d6', 6441],
  'manager.py': ['1019519dc566cf29f9a9f55ca769cf40c1c095a0ef266e963fdb9acd326531ae', 10155],
  'launcher.py': ['bfcbf51b0e283216022a2ece1269c8395f8e13919fe71224060185134fdd13f7', 16024],
  'guardian.py': ['24c2a9122b356bc71f26824862570999d4069f53343d7a29c000e5d6feac9c9f', 4618],
  'paths.py': ['65cd31b5d865151fe6b0baeedb7f601ce8d03b702b6581a294dd93208a5d7fbe', 2649],
} as const

/** The complete nine-file runtime payload shipped beside lib; no secret configuration is included. */
export const RUNTIME_ASSET_MANIFEST = Object.freeze([
  ...Object.entries(SOURCES).map(([name, pin]) => Object.freeze({ path: `agent/${name}`, bytes: pin[1], sha256: pin[0] })),
  ...Object.entries(BOOTSTRAP_PINS).map(([name, pin]) => Object.freeze({ path: `bootstrap/${name}`, bytes: pin.bytes, sha256: pin.sha256 })),
])
