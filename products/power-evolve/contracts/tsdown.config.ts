/** Standalone ESM validation for the trusted approval page, with no external runtime imports. */
import { defineConfig } from 'tsdown'

export default defineConfig({
  entry: { 'execution-resolution': 'src/execution-resolution.ts' },
  outDir: 'lib/browser',
  format: 'esm',
  platform: 'browser',
  target: 'es2022',
  clean: true,
  dts: false,
  deps: { alwaysBundle: [/^zod(?:\/|$)/u, '@deepseek-ai/dsh-brand'] },
  outputOptions: {
    banner: 'globalThis.__zod_globalConfig ??= {}; globalThis.__zod_globalConfig.jitless = true;',
  },
})
