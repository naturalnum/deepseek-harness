import { createHash } from 'node:crypto'
import { readFileSync, writeFileSync } from 'node:fs'
import { sessionFormatCatalog } from '@deepseek-ai/dsh-session-format-catalog'
import { snapshotSessionFormatJson } from '@deepseek-ai/dsh-session-format'
import { normalizeSessionLog, redactSessionSnapshotIds } from '@deepseek-ai/dsh-session-snapshot'
import { defineContentToolFixture } from '@deepseek-ai/dsh-tools'
import { expect, it } from 'vitest'
import { Context } from '@deepseek-ai/cordis'
import { mkdtemp, mkdir, realpath, rm } from 'node:fs/promises'
import { join } from 'node:path'
import { tmpdir } from 'node:os'
import { Reader } from './harness.ts'
import { acceptedInstructions, enterInstructionTurn, mountInstructionConsumer, instructionFixture } from './loader-harness.ts'

it('loads the complete project-root to committed native cwd chain through the real Session Loader', async () => {
  const temporary = await realpath(await mkdtemp(join(tmpdir(), 'c09-nested-')))
  const root = join(temporary, 'project'), nested = join(root, 'team', 'deep')
  const ctx = new Context(), project = new Reader(root)
  try {
    await mkdir(nested, { recursive: true })
    project.files.set(join(root, 'AGENTS.md'), { chunks: ['project root'] })
    project.files.set(join(root, 'CLAUDE.md'), { chunks: ['excluded root alternative'] })
    project.files.set(join(root, 'team', 'CLAUDE.md'), { chunks: ['nested fallback'] })
    project.files.set(join(nested, 'AGENTS.md'), { chunks: [] })
    project.files.set(join(nested, 'CLAUDE.md'), { chunks: ['excluded empty alternative'] })
    project.files.set(join(temporary, 'AGENTS.md'), { chunks: ['excluded parent'] })
    const { agent, adapter, reservations } = await mountInstructionConsumer(ctx, { project }, root)
    await ctx.workingDirectory.set(agent, nested)
    expect(ctx.workingDirectory.get(agent.session)).toBe(nested)
    expect(agent.session.header.cwd).toBe(root)
    await enterInstructionTurn(agent)
    expect(adapter.requests).toHaveLength(1)
    expect(acceptedInstructions(agent)[0]?.source.snapshot.sources.map(source => [source.relativeName, source.text])).toEqual([
      ['AGENTS.md', 'project root'], ['team/CLAUDE.md', 'nested fallback'], ['team/deep/AGENTS.md', ''],
    ])
    expect(project.probes).not.toContain(join(temporary, 'AGENTS.md'))
    expect(project.probes).not.toContain(join(root, 'CLAUDE.md'))
    expect(project.probes).not.toContain(join(nested, 'CLAUDE.md'))
    expect(reservations).toMatchObject({ prepared: 1, releases: 1, held: 0 })
  } finally {
    await ctx.fiber.dispose()
    await rm(temporary, { recursive: true, force: true })
  }
})


it('keeps the captured nested snapshot through a cwd/tool change and reads the committed cwd only next turn', async () => {
  const fixture = await instructionFixture()
  const { ctx, root, preferences, project, account } = fixture
  const firstCwd = join(root, 'team', 'deep'), nextCwd = join(root, 'team', 'other')
  try {
    await Promise.all([mkdir(firstCwd, { recursive: true }), mkdir(nextCwd, { recursive: true })])
    account.files.set(join(preferences, 'AGENTS.md'), { chunks: ['preference first'] })
    project.files.set(join(root, 'AGENTS.md'), { chunks: ['root first'] })
    project.files.set(join(root, 'team', 'CLAUDE.md'), { chunks: ['parent first'] })
    project.files.set(join(firstCwd, 'AGENTS.md'), { chunks: ['leaf first'] })
    const { agent, adapter, reservations } = await mountInstructionConsumer(ctx, { project, account }, root)
    adapter.toolFirst = true
    ctx.tools.register(defineContentToolFixture({
      name: 'change_sources', description: 'change next-turn instruction inputs', parameters: {},
      async execute() {
        account.files.set(join(preferences, 'AGENTS.md'), { chunks: ['preference next'] })
        project.files.delete(join(root, 'AGENTS.md'))
        project.files.set(join(root, 'CLAUDE.md'), { chunks: ['root next'] })
        project.files.set(join(root, 'team', 'CLAUDE.md'), { chunks: ['parent next'] })
        project.files.set(join(firstCwd, 'AGENTS.md'), { chunks: ['old directory changed'] })
        project.files.set(join(nextCwd, 'AGENTS.md'), { chunks: ['next directory'] })
        await ctx.workingDirectory.set(agent, nextCwd)
        return [{ type: 'text', text: 'changed for next turn' }]
      },
    }))
    await ctx.workingDirectory.set(agent, firstCwd)
    await enterInstructionTurn(agent)
    expect(adapter.requests).toHaveLength(2)
    expect(reservations).toMatchObject({ prepared: 1, releases: 1, held: 0 })
    const first = acceptedInstructions(agent)[0]
    if (first === undefined) throw new Error('Missing accepted first-turn snapshot')
    const continuation = adapter.requests[1]?.messages.findLast(message => message.source?.kind === 'pe-account-instructions')
    if (continuation?.source?.kind !== 'pe-account-instructions') throw new Error('Missing native continuation snapshot')
    expect(continuation.id).toBe(first.id)
    expect(continuation.source.snapshot).toEqual(first.source.snapshot)
    expect(first.source.snapshot.sources.map(source => source.text)).toEqual(['preference first', 'root first', 'parent first', 'leaf first'])
    expect(Object.isFrozen(first.source.snapshot)).toBe(true)
    expect(first.source.snapshot.sources.every(source => Object.isFrozen(source))).toBe(true)
    expect(ctx.workingDirectory.get(agent.session)).toBe(nextCwd)
    expect(agent.session.header.cwd).toBe(root)
    await enterInstructionTurn(agent)
    expect(adapter.requests).toHaveLength(3)
    expect(reservations).toMatchObject({ prepared: 2, releases: 2, held: 0 })
    const second = acceptedInstructions(agent)[1]
    if (second === undefined) throw new Error('Missing accepted next-turn snapshot')
    expect(second.id).not.toBe(first.id)
    expect(second.source.form).toBe('instructions')
    expect(second.source.snapshot.sources.map(source => [source.kind, source.relativeName, source.text])).toEqual([
      ['account', 'AGENTS.md', 'preference next'], ['project', 'CLAUDE.md', 'root next'],
      ['project', 'team/CLAUDE.md', 'parent next'], ['project', 'team/other/AGENTS.md', 'next directory'],
    ])
    expect(second.source.snapshot.text).not.toContain('old directory changed')
    expect(first.source.snapshot.sources.at(-1)?.text).toBe('leaf first')
    for (const message of [first, second]) {
      expect(message.source.snapshot.totalBytes).toBe(Buffer.byteLength(message.source.snapshot.text, 'utf8'))
      for (const source of message.source.snapshot.sources) {
        expect(source.hash).toBe(createHash('sha256').update(source.text, 'utf8').digest('hex'))
      }
    }
    const rows = [
      sessionFormatCatalog.encodeCurrentHeader({ ...agent.session.header, delegationDepth: 0 }, agent.session.inheritedEventCount),
      ...agent.session.snapshotEvents().map(event => sessionFormatCatalog.encodeCurrentEvent({
        ...event, data: snapshotSessionFormatJson(event.data),
      })),
    ]
    const raw = rows.map(row => JSON.stringify(row)).join('\n') + '\n'
    const redacted = redactSessionSnapshotIds([raw])[0]
    if (redacted === undefined) throw new Error('Missing native nested Session log')
    const recorded = normalizeSessionLog(redacted, { sessionIds: [], cwd: root }, { identityMode: 'preserve' })
    const golden = new URL('./fixtures/recorded/nested-session.v4.jsonl', import.meta.url)
    if (process.env['DSH_SNAPSHOT'] === 'record') writeFileSync(golden, recorded)
    expect(recorded).toBe(readFileSync(golden, 'utf8'))
  } finally { await fixture.close() }
})

it.each(['parent', 'prefix-sibling', 'account-directory'] as const)(
  'refuses the committed %s cwd before any instruction file read', async (location) => {
    const fixture = await instructionFixture()
    const { ctx, root, temporary, preferences, project, account } = fixture
    try {
      const outside = location === 'parent' ? temporary : location === 'account-directory' ? preferences : `${root}-other`
      if (location === 'prefix-sibling') await mkdir(outside)
      project.files.set(join(root, 'AGENTS.md'), { chunks: ['must not read'] })
      account.files.set(join(preferences, 'AGENTS.md'), { chunks: ['must not read'] })
      const { agent, adapter, reservations, errors } = await mountInstructionConsumer(ctx, { project, account }, root)
      await ctx.workingDirectory.set(agent, outside)
      await enterInstructionTurn(agent)
      expect(errors).toEqual([expect.objectContaining({ code: 'FS_SANDBOX_DENIED' })])
      expect(project.reads).toEqual([])
      expect(account.probes).toEqual([])
      expect(adapter.requests).toEqual([])
      expect(acceptedInstructions(agent)).toEqual([])
      expect(reservations).toMatchObject({ held: 0, releases: 1 })
    } finally { await fixture.close() }
  },
)

it.each(['count', 'labels'] as const)('bounds the complete %s of the root-to-cwd chain before candidate I/O', async (budget) => {
  const fixture = await instructionFixture()
  const { ctx, root, project } = fixture
  try {
    const parts = budget === 'count' ? Array.from({ length: 8 }, (_, index) => `level-${index}`) : ['界'.repeat(40), '界'.repeat(40)]
    const cwd = join(root, ...parts)
    await mkdir(cwd, { recursive: true })
    project.files.set(join(root, 'AGENTS.md'), { chunks: ['must not read before complete budget approval'] })
    const configuration = budget === 'count' ? 'cordis.yml' : 'small-labels.cordis.yml'
    const { agent, adapter, reservations, errors } = await mountInstructionConsumer(ctx, { project }, root, configuration)
    await ctx.workingDirectory.set(agent, cwd)
    await enterInstructionTurn(agent)
    expect(errors).toEqual([expect.objectContaining({ code: 'FS_TOO_LARGE' })])
    expect(project.probes).toEqual([root])
    expect(project.reads).toEqual([])
    expect(adapter.requests).toEqual([])
    expect(acceptedInstructions(agent)).toEqual([])
    expect(reservations).toMatchObject({ held: 0, prepared: 1, releases: 1 })
  } finally { await fixture.close() }
})
