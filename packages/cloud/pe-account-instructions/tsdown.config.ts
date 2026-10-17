import { defineConfig } from 'tsdown'

/** Bundle both public entries in one graph to retain shared constructor identity. */
export default defineConfig({
  entry: ['lib/types/index.js', 'lib/types/session.js'],
  outDir: 'lib',
  format: ['esm'],
  platform: 'node',
  target: 'es2024',
  fixedExtension: false,
  dts: false,
  clean: false,
})
