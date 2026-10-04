/** Bundle the shared shell adapters; runtime imports remain Electron and Node only. */
import { defineConfig } from 'tsdown'
import { packagedImportsPlugin } from '../../../apps/desktop/scripts/desktop-bundle-imports.mjs'

export default defineConfig([
  {
    entry: ['lib/types/main.js'], outDir: 'lib', format: 'esm', platform: 'node', target: 'es2024',
    clean: false, dts: false, fixedExtension: false,
    deps: { neverBundle: ['electron'] },
    plugins: [packagedImportsPlugin({ packages: new Set(['electron']), nodeBuiltins: true })],
  },
  {
    entry: { 'preload-cloud': 'lib/types/preload-cloud.js' }, outDir: 'lib', format: 'cjs',
    platform: 'node', target: 'es2024', clean: false, dts: false, fixedExtension: false, codeSplitting: false,
    deps: { neverBundle: ['electron'] },
    plugins: [packagedImportsPlugin({ packages: new Set(['electron', 'events', 'timers', 'url']), nodeBuiltins: false })],
  },
])
