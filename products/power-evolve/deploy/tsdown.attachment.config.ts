/** Emit the public attachment helpers from their own Host program, without selecting Desktop workspaces. */
import { resolve } from 'node:path'
import { defineConfig } from 'tsdown'

export default defineConfig({
  cwd: resolve(import.meta.dirname, '../../../packages/attachment/attachment-local'),
  entry: ['lib/types/index.js'], outDir: 'lib', format: 'esm', platform: 'node',
  target: 'es2024', fixedExtension: false, dts: false, clean: false,
})
