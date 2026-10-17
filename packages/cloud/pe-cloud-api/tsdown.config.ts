import { defineConfig } from 'tsdown'

/** Bundle only the package's Host Loader and schema entries. */
export default defineConfig([{
  entry: ['lib/types/index.js', 'lib/types/root.js', 'lib/types/account.js', 'lib/types/schema.js'],
  outDir: 'lib',
  format: ['esm'],
  platform: 'node',
  target: 'es2024',
  fixedExtension: false,
  dts: false,
  clean: false,
}])
