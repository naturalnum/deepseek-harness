/** Fixed nonsecret Python payload pins; mismatches reject before any remote bootstrap work. */
import { BOOTSTRAP_PINS } from './payload-pins.ts'

/** Installation candidate aggregate; Root adoption and target qualification remain required. */
export const SOURCE_DIGEST = '4d9f9ceb554d72662d61e70cc03faa936e3b495db235c69d01649cc4845093b5'
/** Installation candidate source hashes and exact byte lengths, shared with the candidate publisher. */
export const SOURCES = {
  'guardian.py': ['6b03761b7a000334f92ace6ff8131feccd2a85347a2bbc8dfe99c92c0cc1e54e', 6683],
  'launcher.py': ['21ce9feb12e6e96780a5383adc87ceaf4ad5301bb1aee5c6ec66c3bee042a9e3', 23544],
  'manager.py': ['f73bb3effd9132ed23dcfe76d2aebe48ba1a9cc52d18b6c5c7a75c35274bfe46', 13544],
  'paths.py': ['6cd24d1c063b997dc3fee2568e07881361eb0e4db67ba1714f4590ad79765f1d', 10042],
  'server.py': ['70a28d4e7011a6e156ba59728d76770773432cc5589e2767819e7b83d883aa32', 19002],
  'stream.py': ['3d74398162ed9ec113c9e5a1b06e878f4aaf42e6533809fc21bfe60ced6db785', 10287],
  'terminal.py': ['e7c3e8e298562a9629f1cefec2f753d34fda1d6285ad14982859c4cd026d8c36', 6830],
  'wire.py': ['f24f61297924fa11d3cf0876c6bbe9ca07c22774555aadc24dfb36acc9a5ab8c', 11322],
} as const

/** The complete eleven-file runtime payload shipped beside lib; no secret configuration is included. */
export const RUNTIME_ASSET_MANIFEST = Object.freeze([
  ...Object.entries(SOURCES).map(([name, pin]) => Object.freeze({ path: `agent/${name}`, bytes: pin[1], sha256: pin[0] })),
  ...Object.entries(BOOTSTRAP_PINS).map(([name, pin]) => Object.freeze({ path: `bootstrap/${name}`, bytes: pin.bytes, sha256: pin.sha256 })),
])
