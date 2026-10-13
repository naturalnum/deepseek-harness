/** Standalone ESM validation for trusted approval and isolated Office tasks, with no external runtime imports. */
import { defineConfig } from 'tsdown'

const browser = ['execution-resolution', 'office-preview'].map(name => ({
  entry: { [name]: `src/${name}.ts` },
  outDir: 'lib/browser',
  format: 'esm' as const,
  platform: 'browser' as const,
  target: 'es2022',
  clean: true,
  dts: false,
  deps: { alwaysBundle: [/^zod(?:\/|$)/u, '@deepseek-ai/dsh-brand'] },
  outputOptions: {
    codeSplitting: false,
    banner: 'globalThis.__zod_globalConfig ??= {}; globalThis.__zod_globalConfig.jitless = true;',
  },
}))

export default defineConfig([{
  entry: ['src/**/*.ts'], outDir: 'lib', unbundle: true, format: 'esm', fixedExtension: false, platform: 'node',
  target: 'es2024', dts: false, clean: false,
}, ...browser])
