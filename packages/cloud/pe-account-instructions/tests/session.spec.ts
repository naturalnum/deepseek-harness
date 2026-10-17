import { expect, it } from 'vitest'
import { Context } from '@deepseek-ai/cordis'
import Loader from '@deepseek-ai/cordis-plugin-loader'
import Include from '@deepseek-ai/cordis-plugin-include'
import { auditRows } from '@deepseek-ai/dsh-agent-preset-registry'
import * as instructions from '../src/session.ts'

it('records a failed Loader entry when the audited owner adapters are unavailable', async () => {
  const ctx = new Context()
  try {
    await ctx.plugin(Loader)
    ctx.loader.builtins.include = Include
    ctx.loader.builtins.instructions = instructions
    await ctx.loader.create({
      name: 'cordis:include', config: { path: new URL('./fixtures/cordis.yml', import.meta.url).href },
    })
    await ctx.loader.await()
    const entry = [...ctx.loader.entries()].find(value => value.options.id === 'instructions')
    expect(entry).toBeDefined()
    expect((await auditRows(ctx.loader)).failed).toEqual([
      expect.stringContaining('the audited account/project and read-only files adapters are not connected'),
    ])
    expect(ctx.get('fs')).toBeUndefined()
  } finally {
    await ctx.fiber.dispose()
  }
})
