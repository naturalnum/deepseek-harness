/** Bundle the Node type program's emitted JavaScript. */
import { defineConfig } from 'tsdown'

export default defineConfig({
  entry: ['lib/types/**/*.js'], outDir: 'lib', unbundle: true, format: 'esm', fixedExtension: false, platform: 'node',
  target: 'es2024', dts: false, clean: false,
})
