/** Bundle the Host type program's emitted JavaScript, including lowered decorators. */
import { defineConfig } from 'tsdown'
import { readFileSync, copyFileSync, mkdirSync } from 'node:fs'
import { dirname, resolve } from 'node:path'
import { fileURLToPath } from 'node:url'

const applicationRoot = dirname(fileURLToPath(import.meta.url))

export default defineConfig([{
  entry: ['lib/types/**/*.js'], outDir: 'lib', unbundle: true, format: 'esm', fixedExtension: false, platform: 'node',
  target: 'es2024', dts: false, clean: false,
}, {
  entry: { 'native-fs-worker': 'lib/types/native-execution/fs-worker-entry.js' },
  outDir: 'lib/native-execution-worker', format: 'esm', platform: 'node', target: 'es2024',
  onSuccess() { mkdirSync(resolve(applicationRoot, 'lib/native-execution-worker'), { recursive: true }); copyFileSync(resolve(applicationRoot, 'src/native-execution/process-worker.py'), resolve(applicationRoot, 'lib/native-execution-worker/native-process-worker.py')) },
  tsconfig: 'tsconfig.worker-bundle.json', dts: false, clean: false, deps: { alwaysBundle: [/.*/] },
  plugins: [{ name: 'native-fs-worker-package-metadata', transform(code, id) {
    if (!id.endsWith('/packages/llm/llm/lib/index.js')) return
    const metadata = JSON.parse(readFileSync(resolve(dirname(id), '../package.json'), 'utf8'))
    return code.replace(/createRequire\(import\.meta\.url\)\(["']\.\.\/package\.json["']\)/gu,
      JSON.stringify({ version: metadata.version }))
  } }],
}])
