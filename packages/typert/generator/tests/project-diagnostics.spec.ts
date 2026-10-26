/** Project diagnostics retain the original reported scope and complete owned errors. */
import { mkdirSync, readFileSync, writeFileSync } from 'node:fs'
import { join, relative } from 'node:path'
import ts from 'typescript'
import { expect, it, vi } from 'vitest'
import { TypertAnalysisError, WorkspaceAnalyzer } from '../src/analyzer.ts'
import { copyFixture, useMemoryWorkspaces } from './type-model-workspace.ts'

vi.mock('node:fs', async (importOriginal) => {
  const { memoryFileSystem } = await import('./type-model-workspace.ts')
  return memoryFileSystem(await importOriginal<typeof import('node:fs')>())
})
useMemoryWorkspaces()

function normalizedPath(path: string): string { return path.replaceAll('\\', '/') }

function withInvalidDependency() {
  const root = copyFixture('typert-owned-diagnostics-')
  const file = join(root, 'packages/host/src/index.ts')
  const dependency = join(root, 'packages/foreign/src')
  mkdirSync(dependency, { recursive: true })
  writeFileSync(join(dependency, 'index.ts'), 'export const unrelatedBody: boolean = 1\n')
  writeFileSync(file, "import '../../foreign/src/index.ts'\n" + readFileSync(file, 'utf8'))
  return { root, file, models: join(root, 'packages/host/src/models.ts') }
}

function originalDiagnostics(root: string) {
  const parsed = ts.getParsedCommandLineOfConfigFile(join(root, 'packages/host/tsconfig.json'), {}, {
    ...ts.sys, onUnRecoverableConfigFileDiagnostic(diagnostic) {
      throw new Error(ts.flattenDiagnosticMessageText(diagnostic.messageText, '\n'))
    },
  })
  if (parsed === undefined) throw new Error('Original host config absent')
  const program = ts.createProgram({ rootNames: parsed.fileNames, options: {
    ...parsed.options, composite: false, incremental: false, noEmit: true, rootDir: root,
  } })
  return [...program.getSyntacticDiagnostics(), ...program.getSemanticDiagnostics()]
    .filter((value): value is ts.DiagnosticWithLocation => value.file !== undefined && value.start !== undefined)
}

it.each(['syntax', 'semantic'] as const)('retains every owned %s diagnostic in the original order and wording', (kind) => {
  const f = withInvalidDependency()
  const edits: readonly [string, string] = kind === 'semantic' ? ['export const ownedOne: string = 1\n', "export const ownedTwo: number = 'invalid'\n"]
    : ['export const = 1\n', 'export const ownedTwo = ;\n']
  for (const [file, text] of [[f.file, edits[0]], [f.models, edits[1]]] as const) {
    writeFileSync(file, readFileSync(file, 'utf8') + '\n' + text)
  }
  const complete = originalDiagnostics(f.root)
  expect(complete.some(value => normalizedPath(value.file.fileName).includes('/packages/foreign/'))).toBe(true)
  const owned = complete.filter(value => normalizedPath(value.file.fileName).startsWith(normalizedPath(join(f.root, 'packages/host')) + '/'))
  expect(owned.some(value => normalizedPath(value.file.fileName) === normalizedPath(f.file))).toBe(true)
  expect(owned.some(value => normalizedPath(value.file.fileName) === normalizedPath(f.models))).toBe(true)
  const expected = owned.map((value) => {
    const at = value.file.getLineAndCharacterOfPosition(value.start)
    return `typert(host): ${relative(f.root, value.file.fileName).replaceAll('\\', '/')}:${at.line + 1}:${at.character + 1}: TypeScript TS${value.code}: ${ts.flattenDiagnosticMessageText(value.messageText, '\n')}`
  }).join('\n')
  let failure: unknown
  try { new WorkspaceAnalyzer({ root: f.root, packages: ['@fixture/host'], faces: ['host'] }).analyze() }
  catch (error) { failure = error }
  expect(failure).toBeInstanceOf(TypertAnalysisError)
  if (!(failure instanceof Error)) throw new Error('Owned diagnostics were not rejected')
  expect(failure.message).toBe(expected)
})

it('retains the original policy for an unrelated dependency body error', () => {
  const f = withInvalidDependency()
  expect(originalDiagnostics(f.root).some(value => normalizedPath(value.file.fileName).includes('/packages/foreign/'))).toBe(true)
  expect(() => new WorkspaceAnalyzer({ root: f.root, packages: ['@fixture/host'], faces: ['host'] }).analyze()).not.toThrow()
})
