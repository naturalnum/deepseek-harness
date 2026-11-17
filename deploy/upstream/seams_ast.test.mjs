import assert from 'node:assert/strict'
import { execFileSync } from 'node:child_process'
import { readFileSync } from 'node:fs'
import { test } from 'node:test'

const scan = files => JSON.parse(execFileSync(process.execPath,
  [new URL('./seams_ast.mjs', import.meta.url).pathname], { input: JSON.stringify({ files }), encoding: 'utf8' }))

test('includes native import types, dynamic imports, re-exports and external import aliases', () => {
  const result = scan([{ path: 'packages/cloud/example/src/index.ts', text: `
    type Ref = import('@deepseek-ai/dsh-brand').Branded<'recovery'>
    const native = await import('@deepseek-ai/dsh-agent')
    export { type Session } from '@deepseek-ai/dsh-session'
    export type * from '@deepseek-ai/dsh-fs'
    export * as loader from '@deepseek-ai/cordis-plugin-loader'
    import cordis = require('@deepseek-ai/cordis')
    import { type Context, Service } from '@deepseek-ai/cordis'
    import type { Local } from './local.ts'
  ` }])
  assert.equal(result.imports.length, 8)
  assert.ok(result.imports.some(row => row.names.includes('Context') && row.typeOnly))
  assert.ok(result.imports.some(row => row.names.includes('Service') && !row.typeOnly))
  assert.deepEqual(result.imports.filter(row => row.kind === 'import-type').map(row => [row.module, row.names, row.typeOnly]),
    [['@deepseek-ai/dsh-brand', ['Branded'], true]])
  assert.equal(result.imports.find(row => row.kind === 'dynamic-import').module, '@deepseek-ai/dsh-agent')
  assert.equal(result.imports.filter(row => row.kind === 'export-from').length, 3)
})

test('reports computed imports and recursive registration spreads for review', () => {
  const result = scan([{ path: 'deploy/upstream/recipe.ts', text: `
    const value = await import(selectedModule)
    const entries = { ...entries }
    nativeInstallBuiltins(ctx, entries)
  ` }])
  assert.equal(result.unresolvedImports[0].expression, 'selectedModule')
  assert.equal(result.mounts[0].unresolved, true)
})

test('expands local registration objects, conditional spreads and shorthand without crossing lexical scopes', () => {
  const result = scan([{ path: 'packages/cloud/example/src/index.ts', text: `
    import Native from '@deepseek-ai/dsh-agent'
    const entries = { wrong: Native }
    function mount(ctx) {
      const entries = { agent: Native, ...enabled ? { optional: Native } : {} }
      const firstScreen = enabled ? {} : { first: Native }
      nativeInstallBuiltins(ctx, { ...entries, ...firstScreen })
      Object.assign(ctx.loader.builtins, { Native, ...external })
      ctx.loader.builtins.direct = Native
    }
  ` }])
  assert.deepEqual(result.mounts.map(row => row.entry), ['agent', 'optional', 'first', 'Native', '(unresolved registration)', 'ctx.loader.builtins.direct'])
  assert.equal(result.mounts.find(row => row.entry === '(unresolved registration)').unresolved, true)
  assert.deepEqual(result.mounts.find(row => row.entry === 'agent').modules, ['@deepseek-ai/dsh-agent'])
})

test('covers the actual recovery type, tool recipe imports and account builtin installation', () => {
  const paths = ['packages/cloud/pe-cloud-runtime/src/owner-types.ts', 'deploy/upstream/registrations.ts',
    'packages/cloud/pe-cloud-runtime/src/account-native-integration.ts']
  const result = scan(paths.map(path => ({ path, text: readFileSync(new URL('../../' + path, import.meta.url), 'utf8') })))
  assert.ok(result.imports.some(row => row.path === paths[0] && row.module === '@deepseek-ai/dsh-brand' && row.kind === 'import-type'))
  assert.ok(result.imports.some(row => row.path === paths[1] && row.module === '@deepseek-ai/dsh-brand' && row.kind === 'dynamic-import'))
  assert.ok(result.mounts.some(row => row.path === paths[2] && row.entry === '[ACCOUNT_NATIVE_ENTRIES.runtime]'))
  assert.ok(result.mounts.some(row => row.path === paths[2] && row.entry === '[ACCOUNT_FIRST_SCREEN_ENTRIES.workspaceController]'))
  assert.ok(result.mounts.some(row => row.path === paths[2] && row.entry === '[ACCOUNT_NATIVE_ENTRIES.attachments]'))
})
