/** Explicit test-only artifact build; production images never require or discover test source. */
import { defineConfig } from 'tsdown'
import { pathToFileURL } from 'node:url'
import { compiledNativePackages, packageMetadata } from './native-execution-artifact-config.ts'

// Keep native package-owned lazy dependencies anchored to the original Linux artifact.
// Relocating import.meta.url into this fixture would resolve them from the application.
const lazyRequireOrigin = { name: 'native-consumer-lazy-require-origin', transform(code: string, id: string) {
  return code.replace(/createLazyRequire\((['"][^'"]+['"]),\s*import\.meta\.url\)/gu,
    `createLazyRequire($1, ${JSON.stringify(pathToFileURL(id).href)})`)
} }

/** Explicit artifact-plane native consumer fixture; production images do not build tests. */
export default defineConfig({
  entry: { 'native-consumers': 'tests/native-execution-consumers-case.mjs' }, outDir: 'lib/native-execution-consumers',
  format: 'esm', platform: 'node', target: 'es2024', tsconfig: 'tsconfig.worker-bundle.json', dts: false, clean: false,
  deps: { alwaysBundle: [/.*/] }, plugins: [compiledNativePackages, packageMetadata, lazyRequireOrigin],
})
