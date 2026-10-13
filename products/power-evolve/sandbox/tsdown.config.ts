/** Bundle the trusted STDIO library into the existing image Runner; this creates no application launcher. */
import { defineConfig } from 'tsdown'
import { fileURLToPath } from 'node:url'
import { packagedImportsPlugin } from '../../../apps/desktop/scripts/desktop-bundle-imports.mjs'

export default defineConfig({
  entry: { 'stdio-v2-runtime': fileURLToPath(new URL('../connector-runner/lib/stdio-v2-runtime.js', import.meta.url)) },
  outDir: fileURLToPath(new URL('./lib', import.meta.url)), format: 'esm', platform: 'node', target: 'es2024',
  fixedExtension: true, clean: true, dts: false,
  deps: { alwaysBundle: [/.*/u] },
  plugins: [packagedImportsPlugin({ packages: new Set(), nodeBuiltins: true })],
})
