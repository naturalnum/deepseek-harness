/** Fixed nonsecret Python payload pins; mismatches reject before any remote bootstrap work. */
import { BOOTSTRAP_PINS } from './payload-pins.ts'

/** Installation candidate aggregate; Root adoption and target qualification remain required. */
export const SOURCE_DIGEST = '20bcbcf4fb67868ec6c9120abc3b218770e695563b634b112e808661f9868e6d'
/** Installation candidate source hashes and exact byte lengths, shared with the candidate publisher. */
export const SOURCES = {
  'guardian.py': ['6b03761b7a000334f92ace6ff8131feccd2a85347a2bbc8dfe99c92c0cc1e54e', 6683],
  'launcher.py': ['b60e9714b0bfd08804900485a4816c9e4a542ea2031c0ab43af1a81b36791a7a', 22898],
  'manager.py': ['7b21968b03ddc76f67edeabfa4424f1f8f98cdb3d15bbc3453b36563f5b32d1d', 13545],
  'paths.py': ['718a6818a548a4c766d974d70e9cad4e88cbc184abc722fd4cb85cbc895f903f', 10018],
  'server.py': ['70a28d4e7011a6e156ba59728d76770773432cc5589e2767819e7b83d883aa32', 19002],
  'stream.py': ['850e40e6c07eb5516b770bf3dd830bd7f506903f6ec7f390b640299fa4bbca7e', 10219],
  'terminal.py': ['e7c3e8e298562a9629f1cefec2f753d34fda1d6285ad14982859c4cd026d8c36', 6830],
  'wire.py': ['6f09005091c01691501cdb859f7ecc43c73ec4cdfa6f5a6b8383146e6252567e', 11322],
} as const

/** The complete eleven-file runtime payload shipped beside lib; no secret configuration is included. */
export const RUNTIME_ASSET_MANIFEST = Object.freeze([
  ...Object.entries(SOURCES).map(([name, pin]) => Object.freeze({ path: `agent/${name}`, bytes: pin[1], sha256: pin[0] })),
  ...Object.entries(BOOTSTRAP_PINS).map(([name, pin]) => Object.freeze({ path: `bootstrap/${name}`, bytes: pin.bytes, sha256: pin.sha256 })),
])
