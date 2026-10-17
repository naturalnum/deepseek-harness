import { defineConfig } from 'tsdown'

/** Build the Host Loader entries and configuration schema from TypeScript output. */
export default defineConfig({
  entry: ['lib/types/{index,root,account,schema,types}.js'],
  outDir: 'lib',
  format: ['esm'],
  platform: 'node',
  target: 'es2024',
  fixedExtension: false,
  dts: false,
  clean: false,
})
