import { expect, it, vi } from 'vitest'
import { FsError } from '@deepseek-ai/dsh-fs'
import type { FsTarget } from '@deepseek-ai/dsh-fs'
import { acceptedInstructions, enterInstructionTurn, mountInstructionConsumer, instructionFixture } from './loader-harness.ts'

it('consumes account fallback and an existing empty project AGENTS without promoting its CLAUDE or parent', async () => {
  const fixture = await instructionFixture()
  const { ctx, account, project, root, preferences } = fixture
  account.files.set(`${preferences}/CLAUDE.md`, { chunks: ['account preference'] })
  project.files.set(`${root}/AGENTS.md`, { chunks: [] })
  project.files.set(`${root}/CLAUDE.md`, { chunks: ['excluded sibling'] })
  project.files.set('/AGENTS.md', { chunks: ['excluded ancestor'] })
  try {
    const { agent, adapter, reservations } = await mountInstructionConsumer(ctx, { account, project }, root)
    await enterInstructionTurn(agent)
    expect(adapter.requests).toHaveLength(1)
    const [message] = acceptedInstructions(agent)
    expect(message?.source.form).toBe('instructions')
    expect(message?.source.snapshot.sources.map(source => [source.kind, source.relativeName, source.text])).toEqual([
      ['account', 'CLAUDE.md', 'account preference'], ['project', 'AGENTS.md', ''],
    ])
    expect(project.probes).not.toContain(`${root}/CLAUDE.md`)
    expect(project.probes).not.toContain('/AGENTS.md')
    expect(reservations).toMatchObject({ held: 0, prepared: 1, releases: 1 })
    expect(agent.session.deriveMessages().filter(value => value.source.kind === 'user')).toHaveLength(1)
  } finally { await fixture.close() }
})

it.each(['metadata-denied', 'invalid-text', 'special', 'vanished-after-stat'] as const)(
  'rejects %s without CLAUDE fallback, partial native context or a model request', async (failure) => {
    const fixture = await instructionFixture()
    const { ctx, account, project, root, preferences } = fixture
    account.files.set(`${preferences}/AGENTS.md`, { chunks: ['valid account source'] })
    project.files.set(`${root}/AGENTS.md`, { chunks: ['unavailable project source'], ...failure === 'special' ? { type: 'other' } : {} })
    project.files.set(`${root}/CLAUDE.md`, { chunks: ['must not load'] })
    if (failure === 'metadata-denied') {
      vi.spyOn(project, 'stat').mockRejectedValue(new FsError('denied', 'FS_PERMISSION_DENIED'))
    } else if (failure === 'invalid-text' || failure === 'vanished-after-stat') {
      const code = failure === 'invalid-text' ? 'FS_NOT_TEXT' : 'FS_NOT_FOUND'
      vi.spyOn(project, 'streamText').mockRejectedValue(new FsError('selected source failed', code))
    }
    try {
      const { agent, adapter, reservations, errors } = await mountInstructionConsumer(ctx, { account, project }, root)
      await enterInstructionTurn(agent)
      expect(account.reads).toEqual([`${preferences}/AGENTS.md`])
      expect(project.probes).not.toContain(`${root}/CLAUDE.md`)
      const expectedCode = { 'metadata-denied': 'FS_PERMISSION_DENIED', 'invalid-text': 'FS_NOT_TEXT',
        special: 'FS_NOT_REGULAR_FILE', 'vanished-after-stat': 'FS_NOT_FOUND' }[failure]
      expect(errors).toEqual([expect.objectContaining({ code: expectedCode })])
      expect(adapter.requests).toEqual([])
      expect(acceptedInstructions(agent)).toEqual([])
      expect(reservations).toMatchObject({ held: 0, prepared: 1, releases: 1 })
    } finally { await fixture.close() }
  },
)

it('closes a cancelled source iterator and releases only after its actual pending read settles', async () => {
  const fixture = await instructionFixture()
  const { ctx, project, root } = fixture
  project.files.set(`${root}/AGENTS.md`, { chunks: [] })
  project.files.set(`${root}/CLAUDE.md`, { chunks: ['must not load'] })
  const entered = Promise.withResolvers<undefined>(), gate = Promise.withResolvers<undefined>()
  let closed = false
  vi.spyOn(project, 'streamText').mockImplementation(async (_file: FsTarget) => (async function* () {
    try { entered.resolve(undefined); await gate.promise; yield 'late source' }
    finally { closed = true }
  })())
  try {
    const { agent, adapter, reservations } = await mountInstructionConsumer(ctx, { project }, root)
    const turn = enterInstructionTurn(agent)
    await entered.promise
    agent.cancel({ kind: 'user' })
    expect(reservations.held).toBe(400000)
    expect(reservations.releases).toBe(0)
    expect(closed).toBe(false)
    gate.resolve(undefined)
    await turn
    expect(closed).toBe(true)
    expect(project.probes).not.toContain(`${root}/CLAUDE.md`)
    expect(adapter.requests).toEqual([])
    expect(acceptedInstructions(agent)).toEqual([])
    expect(reservations).toMatchObject({ held: 0, releases: 1 })
  } finally { gate.resolve(undefined); await fixture.close() }
})

it.each(['file', 'complete-message'] as const)('rejects an oversized %s after a successful native turn and returns its reservation', async (budget) => {
  const fixture = await instructionFixture()
  const { ctx, account, project, root, preferences } = fixture
  account.files.set(`${preferences}/AGENTS.md`, { chunks: ['account'] })
  project.files.set(`${root}/AGENTS.md`, { chunks: ['project'] })
  project.files.set(`${root}/CLAUDE.md`, { chunks: ['must not replace oversized AGENTS'] })
  try {
    const { agent, adapter, reservations, errors } = await mountInstructionConsumer(ctx, { account, project }, root)
    await enterInstructionTurn(agent)
    expect(adapter.requests).toHaveLength(1)
    expect(acceptedInstructions(agent)).toHaveLength(1)
    if (budget === 'file') project.files.set(`${root}/AGENTS.md`, { size: 1025, chunks: ['unread'] })
    else {
      // Each valid text file fits 1024 raw bytes; repeated escaped message copies exceed 8192 encoded bytes.
      account.files.set(`${preferences}/AGENTS.md`, { chunks: ['"'.repeat(1024)] })
      project.files.set(`${root}/AGENTS.md`, { chunks: ['"'.repeat(1024)] })
    }
    await enterInstructionTurn(agent)
    expect(errors).toEqual([expect.objectContaining({ code: 'FS_TOO_LARGE' })])
    expect(adapter.requests).toHaveLength(1)
    expect(acceptedInstructions(agent)).toHaveLength(1)
    expect(reservations).toMatchObject({ held: 0, prepared: 2, releases: 2 })
    expect(project.probes).not.toContain(`${root}/CLAUDE.md`)
  } finally { await fixture.close() }
})
