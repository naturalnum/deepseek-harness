/**
 * Tests for the event-relation collector's demand-driven call-site indexing:
 * the single-file fast path and the global fallback must recover the same
 * helper-parameter event names, including shapes that defeat the locality
 * proof (alias escapes and global script files).
 */

import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { dirname, join } from 'node:path'
import { afterAll, describe, expect, it } from 'vitest'
import { collectPackageSources, EventRelationCollector } from './gen-doc-graphs.ts'
import { TypeScriptProject } from './ts-project.ts'

const FIXTURE: Record<string, string> = {
  'tsconfig.host.json': JSON.stringify({
    compilerOptions: {
      target: 'es2022',
      module: 'esnext',
      moduleResolution: 'bundler',
      allowImportingTsExtensions: true,
      noEmit: true,
      skipLibCheck: true,
      strictNullChecks: true,
      types: [],
    },
    include: ['vendor/**/*.ts', 'packages/**/*.ts'],
  }),
  'vendor/cordis/src/context.ts': 'export class Context { private brand!: void }\n',
  'vendor/cordis/src/events.ts': [
    'export class EventsService {',
    '  dispatch(type: string, args: unknown[]): unknown[] { return [type, args] }',
    '}',
    '',
  ].join('\n'),
  'packages/core/agent/src/dispatch.ts':
    'export interface AgentEventDispatch { emit(...args: unknown[]): void; serial(...args: unknown[]): void }\n',
  // fireLocal: every same-file reference is a direct callee, so the locality
  // proof holds and only this file is indexed. fireAliased: the exported
  // const is a value-position reference, so the proof fails and the global
  // fallback must find the cross-file call in pkgb.
  'packages/fix/pkga/src/index.ts': [
    "import { EventsService } from '../../../../vendor/cordis/src/events.ts'",
    'declare const events: EventsService',
    "function fireLocal(args: [string]): void { void events.dispatch('emit', args) }",
    "fireLocal(['pkga/local-event'])",
    "function fireAliased(args: [string]): void { void events.dispatch('emit', args) }",
    'export const aliased = fireAliased',
    '',
  ].join('\n'),
  'packages/fix/pkgb/src/index.ts': [
    "import { aliased } from '../../pkga/src/index.ts'",
    "aliased(['pkgb/aliased-event'])",
    '',
  ].join('\n'),
  // Global script files (no import/export): scriptFire is program-visible, so
  // the cross-file call in caller.ts leaves no same-file reference. Only the
  // module-ness premise check routes this helper to the global index; without
  // it the proof would pass and the event would silently drop.
  'packages/fix/pkgc/src/globals.ts':
    "declare var gEvents: import('../../../../vendor/cordis/src/events.ts').EventsService\n",
  'packages/fix/pkgc/src/helper.ts':
    "function scriptFire(args: [string]): void { void gEvents.dispatch('emit', args) }\n",
  'packages/fix/pkgc/src/caller.ts': "scriptFire(['pkgc/script-event'])\n",
  'packages/fix/pkgd/src/index.ts': [
    "import type { AgentEventDispatch } from '../../../core/agent/src/dispatch.ts'",
    'declare const optionalDispatch: AgentEventDispatch | undefined',
    "optionalDispatch?.emit('pkgd/optional-event', {})",
    "declare const limitedDispatch: Pick<AgentEventDispatch, 'emit'> | undefined",
    "limitedDispatch?.emit('pkgd/limited-event', {})",
    'declare const lookalike: { emit(...args: unknown[]): void } | undefined',
    "lookalike?.emit('pkgd/lookalike-event', {})",
    // The fixture intentionally represents an untyped external object, whose method name is insufficient evidence.
    'declare const untyped: any',
    "untyped?.emit('pkgd/untyped-event', {})",
    '',
  ].join('\n'),
}

const root = mkdtempSync(join(tmpdir(), 'gen-doc-graphs-'))
for (const [rel, content] of Object.entries(FIXTURE)) {
  mkdirSync(dirname(join(root, rel)), { recursive: true })
  writeFileSync(join(root, rel), content)
}
const project = new TypeScriptProject(root)
const sources = collectPackageSources(project)

afterAll(() => {
  rmSync(root, { recursive: true, force: true })
})

function dispatchersOf(pkgs: readonly string[], event: string): string[] {
  const subset = sources.filter(source => pkgs.includes(source.pkg))
  const relations = new EventRelationCollector(project, subset).collect()
  return [...(relations.get(event)?.dispatchers.keys() ?? [])]
}

describe('event relation call-site indexing', () => {
  it('recovers a proven-local helper through the single-file fast path', () => {
    expect(dispatchersOf(['pkga', 'pkgb'], 'pkga/local-event')).toEqual(['pkga'])
  })

  it('recovers an alias-escaped helper through the global fallback', () => {
    expect(dispatchersOf(['pkga', 'pkgb'], 'pkgb/aliased-event')).toEqual(['pkga'])
  })

  it('rejects the locality proof for global script files', () => {
    // pkgc alone: the script helper is the first demand, so a wrongly passing
    // proof would index helper.ts only and lose the caller.ts call site.
    expect(dispatchersOf(['pkgc'], 'pkgc/script-event')).toEqual(['pkgc'])
  })

  it('records optional typed dispatch while refusing optional untyped lookalikes', () => {
    expect(dispatchersOf(['pkgd'], 'pkgd/optional-event')).toEqual(['pkgd'])
    expect(dispatchersOf(['pkgd'], 'pkgd/limited-event')).toEqual(['pkgd'])
    expect(dispatchersOf(['pkgd'], 'pkgd/lookalike-event')).toEqual([])
    expect(dispatchersOf(['pkgd'], 'pkgd/untyped-event')).toEqual([])
  })
})
