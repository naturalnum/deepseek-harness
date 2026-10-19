/** Bounded observation of receipt growth despite native zero-byte storage deduplication. */
import { Context } from '@deepseek-ai/cordis'
import { mountAgentLoopTestDependencies, mountAgentLoopTestHarness } from '@deepseek-ai/dsh-agent-loop-testkit'
import LocalAttachmentStore from '@deepseek-ai/dsh-attachment-local'
import CommandRuntime from '@deepseek-ai/dsh-commands'
import { SessionId } from '@deepseek-ai/dsh-session'
import { mkdtemp, rm, stat } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { expect, it } from 'vitest'
import FileUploads from '../src/index.ts'

it('currently retains three distinct receipts while all three zero-byte uploads share one native file', async () => {
  const home = await mkdtemp(join(tmpdir(), 'dsh-zero-byte-receipts-')), ctx = new Context()
  try {
    await mountAgentLoopTestDependencies(ctx)
    await ctx.plugin(CommandRuntime)
    const native = await mountAgentLoopTestHarness(ctx)
    const agent = await native.create(SessionId('zero-byte-owner'))
    const store = new LocalAttachmentStore(ctx, { dshHome: home })
    ctx.provide('connection', { fetch: { register: () => () => {} } } as never)
    const uploads = new FileUploads(ctx), receipts = []
    for (let index = 0; index < 3; index++) {
      receipts.push(await uploads.uploadStream({
        sessionId: agent.id, name: 'empty.bin',
        data: (async function* () { yield new Uint8Array() })(),
      }))
    }
    expect(new Set(receipts.map(value => value.receiptId)).size).toBe(3)
    expect(new Set(receipts.map(value => store.fileHostPath(value.file))).size).toBe(1)
    for (const value of receipts) {
      expect(value.file.bytes).toBe(0)
      expect((await stat(store.fileHostPath(value.file))).size).toBe(0)
      expect(uploads.resolve(agent, value.receiptId)).toBe(value.file)
    }
    console.info('zero-byte-receipts', JSON.stringify({ retainedReceipts: 3, storedPaths: 1, bytesPerFile: 0 }))
  } finally {
    await ctx.fiber.dispose()
    await rm(home, { recursive: true, force: true })
  }
})
