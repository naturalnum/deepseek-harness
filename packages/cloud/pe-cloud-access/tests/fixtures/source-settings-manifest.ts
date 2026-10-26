/** Original Analyzer/Emitter supplies native Settings metadata without workspace lib input or handwritten codecs. */
import { mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { dirname, join } from 'node:path'
import { createRequire } from 'node:module'
import { fileURLToPath, pathToFileURL } from 'node:url'
import ts from 'typescript'
import { WorkspaceAnalyzer, FaceModelEmitter, findWorkspaceRoot } from '@deepseek-ai/dsh-typert-generator'
import { validateTypertManifest } from '@deepseek-ai/dsh-typert-loader'
import { onTestFinished } from 'vitest'

/**
 * Generate the actual Settings Host manifest in a test-owned temporary directory.
 * @returns Original validated metadata extracted from the current qualification source.
 */
export async function sourceSettingsManifest(): Promise<ReturnType<typeof validateTypertManifest>> {
  const dir = mkdtempSync(join(tmpdir(), 'bootstrap-locale-source-'))
  onTestFinished(() => { rmSync(dir, { recursive: true, force: true }) })
  const require = createRequire(import.meta.url)
  const remoteSource = readFileSync(require.resolve('@deepseek-ai/dsh-typert-protocol/src/remote-info.ts'), 'utf8')
  const { outputText } = ts.transpileModule(remoteSource, {
    compilerOptions: { module: ts.ModuleKind.ESNext, target: ts.ScriptTarget.ESNext },
  })
  const module = ts.createSourceFile('remote-info.js', outputText, ts.ScriptTarget.ESNext, true, ts.ScriptKind.JS)
  if (module.statements.some(ts.isImportDeclaration)) throw new Error('Original protocol factory requires its source dependencies')
  const remotePath = join(dir, 'remote-info.mjs'); writeFileSync(remotePath, outputText)
  const root = findWorkspaceRoot(dirname(fileURLToPath(import.meta.url))), pkg = '@deepseek-ai/dsh-api-settings-controller'
  const model = new WorkspaceAnalyzer({ root, packages: [pkg], faces: ['host'], mode: 'check',
    checkDiagnostics: true, rejectBuildOutputs: true }).analyze()
  const face = model.faces.find(value => value.face === 'host')
  if (face === undefined) throw new Error('Original Settings Host model absent')
  const code = new FaceModelEmitter(face).emit(pkg).js
    .replace("from 'zod'", 'from ' + JSON.stringify(pathToFileURL(require.resolve('zod')).href))
    .replace("from '@deepseek-ai/dsh-typert-protocol/remote-info'", 'from ' + JSON.stringify(pathToFileURL(remotePath).href))
  const output = join(dir, 'settings.host.mjs'); writeFileSync(output, code)
  const loaded: unknown = await import(pathToFileURL(output).href)
  if (loaded === null || typeof loaded !== 'object') throw new Error('Generated native Settings module absent')
  return validateTypertManifest(pkg, Reflect.get(loaded, 'TYPERT'))
}
