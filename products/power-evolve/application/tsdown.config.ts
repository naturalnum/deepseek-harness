/** Bundle emitted Platform/Host JavaScript and credential-free native execution utilities. */
import { defineConfig } from 'tsdown'
import { copyFileSync, mkdirSync } from 'node:fs'
import { dirname, resolve } from 'node:path'
import { fileURLToPath } from 'node:url'
import { packagedImportsPlugin } from '../../../apps/desktop/scripts/desktop-bundle-imports.mjs'
import { compiledNativePackages, packageMetadata } from './native-execution-artifact-config.ts'

const applicationRoot = dirname(fileURLToPath(import.meta.url))

/** Production application modules and the credential-free filesystem utility. */
export default defineConfig([{
  entry: ['lib/types/**/*.js'], outDir: 'lib', unbundle: true, format: 'esm', fixedExtension: false, platform: 'node',
  target: 'es2024', dts: false, clean: false,
}, {
  entry: { 'native-fs-worker': 'lib/types/native-execution/fs-worker-entry.js',
    'native-stdio-worker': 'lib/types/native-execution/stdio-worker-entry.js' },
  outDir: 'lib/native-execution-worker', format: 'esm', platform: 'node', target: 'es2024',
  onSuccess() { mkdirSync(resolve(applicationRoot, 'lib/native-execution-worker'), { recursive: true }); copyFileSync(resolve(applicationRoot, 'src/native-execution/process-worker.py'), resolve(applicationRoot, 'lib/native-execution-worker/native-process-worker.py')) },
  tsconfig: 'tsconfig.worker-bundle.json', dts: false, clean: false, deps: { alwaysBundle: [/.*/] },
  plugins: [compiledNativePackages, packageMetadata, packagedImportsPlugin({ packages: new Set(), nodeBuiltins: true })],
}])
