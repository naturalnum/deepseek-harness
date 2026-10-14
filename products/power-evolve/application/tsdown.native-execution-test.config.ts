/** Explicit test-only artifact build; production images never require or discover test source. */
import { defineConfig } from 'tsdown'
import { compiledNativePackages, packageMetadata } from './native-execution-artifact-config.ts'

export default defineConfig({
  entry: { 'native-consumers': 'tests/native-execution-consumers-case.mjs' }, outDir: 'lib/native-execution-consumers',
  format: 'esm', platform: 'node', target: 'es2024', tsconfig: 'tsconfig.worker-bundle.json', dts: false, clean: false,
  deps: { alwaysBundle: [/.*/] }, plugins: [compiledNativePackages, packageMetadata],
})
