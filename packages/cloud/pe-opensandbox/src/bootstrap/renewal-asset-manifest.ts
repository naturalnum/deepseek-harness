/** Fixed nonsecret Python payload pins; mismatches reject before any remote bootstrap work. */
import { RENEWAL_BOOTSTRAP_PINS } from './renewal-payload-pins.ts'

/** Installation candidate aggregate; Root adoption and target qualification remain required. */
export const RENEWAL_SOURCE_DIGEST = '12c3fbda33481dbaba289859315c3c069b8230b96dae6bc8233a6599bd3b2ddf'
/** Installation candidate source hashes and exact byte lengths, shared with the candidate publisher. */
export const RENEWAL_SOURCES = {
  'guardian.py': ['6b03761b7a000334f92ace6ff8131feccd2a85347a2bbc8dfe99c92c0cc1e54e', 6683],
  'launcher.py': ['769697b5c39639f6ce8b38e53c4a9dae0e8f6bbaf38e88aec25c16f853566b38', 24053],
  'manager.py': ['a122c28b5c52c5853ef974f7db247bcd38bb734577ee70dc774be0d2994ef998', 20368],
  'paths.py': ['32eee56d10be1c13cc3d4615e614888abcf26e1ad8e102db801d81fd084e858b', 10067],
  'server.py': ['cbe8542c93105ad0e7873995f4d3a0ca5f09bdff4ea55ea15bad0cd79cb00901', 19462],
  'stream.py': ['e1ccec8f85755f20bdaa457d2b28777b24e7a33a20cd8ca35e1de52874210e38', 10399],
  'terminal.py': ['e7c3e8e298562a9629f1cefec2f753d34fda1d6285ad14982859c4cd026d8c36', 6830],
  'wire.py': ['023781dee5665f1fee6cdbedda9a21c0d1623cf35fd826ac1c5b23be89d3b0f9', 15686],
} as const

/** The complete eleven-file runtime payload shipped beside lib; no secret configuration is included. */
export const RENEWAL_RUNTIME_ASSET_MANIFEST = Object.freeze([
  ...Object.entries(RENEWAL_SOURCES).map(([name, pin]) => Object.freeze({ path: `agent/${name}`, bytes: pin[1], sha256: pin[0] })),
  ...Object.entries(RENEWAL_BOOTSTRAP_PINS).map(([name, pin]) => Object.freeze({ path: `bootstrap/${name}`, bytes: pin.bytes, sha256: pin.sha256 })),
])
