import { afterEach, describe, expect, it, vi } from 'vitest'
import { Context } from '@deepseek-ai/cordis'
import { brandString } from '@deepseek-ai/dsh-brand'
import { ConfigEditor } from '@deepseek-ai/dsh-config-editor'
import type { AccountBinding, AccountId, OwnerEpoch } from '@deepseek-ai/dsh-pe-cloud-runtime/types'
import { ConfigSaveCoordinator, ConfigSaveOutcomeUnknown } from '../src/config-saves.ts'
import { installNativeDefaultModelSaveHook } from '../src/native-save-hook.ts'
import type { ConfigSaveLimits } from '../src/save-hooks.ts'

const limits: ConfigSaveLimits = {
  maxAccounts: 3, maxRunning: 2, maxQueued: 3, maxQueuedPerAccount: 2,
  maxTrackedOperations: 8, maxTrackedOperationsPerAccount: 4,
  maxNestedPerOperation: 2, maxWaitersPerAccount: 2,
}
const nowDeadline = () => Date.now() + 1_000

function deferred() {
  const state = Promise.withResolvers<undefined>()
  return {
    promise: state.promise,
    resolve: () => { state.resolve(undefined) },
    reject: (error: unknown) => { state.reject(error) },
  }
}

function binding(id = 'a', epoch = '1', lifetime = new AbortController()): AccountBinding {
  return {
    accountId: brandString<AccountId>(id), epoch: brandString<OwnerEpoch>(epoch),
    recipeVersion: 'd08-m1', lifetime: lifetime.signal,
  }
}

afterEach(() => { vi.useRealTimers() })

describe('actual configuration submission responsibility', () => {
  it('registers before submit, serializes queued saves, and retains capacity through mandatory apply', async () => {
    const root = new ConfigSaveCoordinator(limits)
    const a = root.createAccount(binding())
    const persisted = Promise.withResolvers<number>()
    const applied = deferred()
    const order: string[] = []
    const first = a.admitWithApply('default-model', () => {
      expect(a.snapshot().pending).toHaveLength(1)
      expect(root.snapshot().tracked).toBe(1)
      order.push('persist')
      return persisted.promise
    }, async (value) => {
      expect(value).toBe(7)
      order.push('apply')
      await applied.promise
    })
    const second = a.admit('settings', async () => { order.push('second'); return 9 })
    expect(a.snapshot().pending).toHaveLength(2)
    expect(root.snapshot()).toMatchObject({ running: 1, queued: 1, tracked: 2 })
    persisted.resolve(7)
    await Promise.resolve()
    expect(order).toEqual(['persist', 'apply'])
    expect(root.snapshot().tracked).toBe(2)
    applied.resolve()
    expect(await first).toBe(7)
    expect(await second).toBe(9)
    expect(order).toEqual(['persist', 'apply', 'second'])
    expect(root.snapshot()).toMatchObject({ running: 0, queued: 0, tracked: 0 })
  })

  it('bounds per-account queues without blocking an independent account', async () => {
    const root = new ConfigSaveCoordinator({ ...limits, maxQueuedPerAccount: 1 })
    const a = root.createAccount(binding())
    const b = root.createAccount(binding('b'))
    const slow = deferred()
    const first = a.admit('default-model', () => slow.promise)
    const second = a.admit('default-model', async () => {})
    const rejected = vi.fn(async () => {})
    expect(() => a.admit('settings', rejected)).toThrow(expect.objectContaining({ code: 'cloud/capacity' }))
    expect(rejected).not.toHaveBeenCalled()
    expect(await b.admit('settings', async () => 'b')).toBe('b')
    slow.resolve()
    await Promise.all([first, second])
  })

  it('bounds global running and queued work, rejecting excess before any writer queue', async () => {
    const root = new ConfigSaveCoordinator({ ...limits, maxRunning: 1, maxQueued: 1 })
    const a = root.createAccount(binding())
    const b = root.createAccount(binding('b'))
    const slow = deferred()
    const first = a.admit('default-model', () => slow.promise)
    const secondSubmit = vi.fn(async () => {})
    const second = b.admit('default-model', secondSubmit)
    expect(secondSubmit).not.toHaveBeenCalled()
    const third = vi.fn(async () => {})
    expect(() => a.admit('settings', third)).toThrow()
    expect(third).not.toHaveBeenCalled()
    slow.resolve()
    await Promise.all([first, second])
    expect(secondSubmit).toHaveBeenCalledOnce()
  })

  it('pauses synchronously, drains admitted queued work, resumes only quiescent pause, and never reopens stop', async () => {
    const root = new ConfigSaveCoordinator(limits)
    const a = root.createAccount(binding())
    const slow = deferred()
    const first = a.admit('default-model', () => slow.promise)
    const secondSubmit = vi.fn(async () => {})
    const second = a.admit('default-model', secondSubmit)
    const paused = a.pauseAccountChanges(nowDeadline())
    expect(a.snapshot().admission).toBe('paused')
    const denied = vi.fn(async () => {})
    expect(() => a.admit('credentials', denied)).toThrow()
    expect(denied).not.toHaveBeenCalled()
    expect(() => { a.resumeAccountChanges() }).toThrow()
    slow.resolve()
    await Promise.all([first, second])
    expect(await paused).toMatchObject({ status: 'confirmed', admission: 'paused', pendingOperationIds: [] })
    expect(secondSubmit).toHaveBeenCalledOnce()
    a.resumeAccountChanges()
    expect(await a.admit('settings', async () => 3)).toBe(3)
    expect(await a.stopConfigSaves(nowDeadline())).toMatchObject({ status: 'confirmed', admission: 'stopped' })
    expect(() => { a.resumeAccountChanges() }).toThrow()
    expect(() => a.admit('settings', denied)).toThrow()
    expect(await a.stopConfigSaves(nowDeadline())).toMatchObject({ status: 'confirmed', admission: 'stopped' })
    expect(denied).not.toHaveBeenCalled()
  })

  it('returns unknown at a deadline without releasing actual work or terminal admission', async () => {
    vi.useFakeTimers()
    const root = new ConfigSaveCoordinator(limits)
    const a = root.createAccount(binding())
    const slow = deferred()
    const work = a.admit('default-model', () => slow.promise)
    const stopped = a.stopConfigSaves(Date.now() + 20)
    await vi.advanceTimersByTimeAsync(20)
    const receipt = await stopped
    expect(receipt).toMatchObject({ status: 'unknown', reason: 'deadline', admission: 'stopped' })
    expect(receipt.pendingOperationIds).toHaveLength(1)
    expect(root.snapshot().tracked).toBe(1)
    expect(() => { root.releaseAccount(a) }).toThrow()
    expect(() => { a.resumeAccountChanges() }).toThrow()
    slow.resolve()
    await work
    expect(await a.stopConfigSaves(nowDeadline())).toMatchObject({ status: 'confirmed' })
    root.releaseAccount(a)
    root.close()
  })

  it('cancels only an observer and bounds concurrent observers', async () => {
    const root = new ConfigSaveCoordinator({ ...limits, maxWaitersPerAccount: 1 })
    const a = root.createAccount(binding())
    const slow = deferred()
    const work = a.admit('settings', () => slow.promise)
    const observer = new AbortController()
    const waiting = a.pauseAccountChanges(nowDeadline(), observer.signal)
    expect(() => a.stopConfigSaves(nowDeadline())).toThrow(expect.objectContaining({ code: 'cloud/capacity' }))
    observer.abort()
    expect(await waiting).toMatchObject({ status: 'unknown', reason: 'observer-cancelled' })
    expect(a.snapshot().pending).toHaveLength(1)
    expect(root.snapshot().tracked).toBe(1)
    slow.resolve()
    await work
    expect(await a.stopConfigSaves(nowDeadline())).toMatchObject({ status: 'confirmed' })
  })

  it('retains failures even when a caller catches them, redacts receipts and prevents capacity or generation reuse', async () => {
    const root = new ConfigSaveCoordinator({ ...limits, maxTrackedOperations: 1 })
    const a = root.createAccount(binding())
    const secret = new Error('SECRET key and private path')
    await expect(a.admit('default-model', () => Promise.reject(secret))).rejects.toBe(secret)
    const receipt = await a.pauseAccountChanges(nowDeadline())
    expect(receipt).toMatchObject({ status: 'unknown', reason: 'failed', failures: [{ outcome: 'failed' }] })
    expect(JSON.stringify(receipt)).not.toContain('SECRET')
    expect(root.snapshot().tracked).toBe(1)
    expect(() => { a.resumeAccountChanges() }).toThrow()
    await a.stopConfigSaves(nowDeadline())
    expect(() => { root.releaseAccount(a) }).toThrow()
    expect(() => root.createAccount(binding('a', '2'))).toThrow()
    const b = root.createAccount(binding('b'))
    const denied = vi.fn(async () => {})
    expect(() => b.admit('settings', denied)).toThrow()
    expect(denied).not.toHaveBeenCalled()
  })

  it('retains a settled native unknown outcome without claiming pending work or clean', async () => {
    const root = new ConfigSaveCoordinator(limits)
    const a = root.createAccount(binding())
    await expect(a.admit('settings', () => Promise.reject(new ConfigSaveOutcomeUnknown()))).rejects.toBeInstanceOf(ConfigSaveOutcomeUnknown)
    expect(await a.stopConfigSaves(nowDeadline())).toMatchObject({
      status: 'unknown', pendingOperationIds: [], failures: [{ outcome: 'unknown', code: 'config-save/outcome-unknown' }],
    })
    expect(() => { root.releaseAccount(a) }).toThrow()
  })

  it('retains mandatory apply failures after successful persistence', async () => {
    const root = new ConfigSaveCoordinator(limits)
    const a = root.createAccount(binding())
    const applied = new Error('mandatory apply failed')
    let persisted = false
    await expect(a.admitWithApply('settings', async () => {
      persisted = true
      return 5
    }, () => Promise.reject(applied))).rejects.toBe(applied)
    expect(persisted).toBe(true)
    expect(await a.stopConfigSaves(nowDeadline())).toMatchObject({ status: 'unknown', failures: [{ outcome: 'failed' }] })
  })

  it('preserves unknown evidence from later nested failures while returning the original first failure', async () => {
    const root = new ConfigSaveCoordinator(limits)
    const a = root.createAccount(binding())
    const first = new Error('first native failure')
    const work = a.admit('default-model', async () => {
      await a.admit('settings', () => Promise.reject(first)).catch(() => {})
      await a.admit('settings', () => Promise.reject(new ConfigSaveOutcomeUnknown())).catch(() => {})
    })
    await expect(work).rejects.toBe(first)
    expect(await a.stopConfigSaves(nowDeadline())).toMatchObject({ status: 'unknown', failures: [{ outcome: 'unknown' }] })
  })

  it('joins nested native writes without waiting for its own serial turn', async () => {
    const root = new ConfigSaveCoordinator({ ...limits, maxRunning: 1, maxQueued: 0, maxQueuedPerAccount: 0 })
    const a = root.createAccount(binding())
    const result = await a.admit('default-model', () => a.admit('settings', async () => {
      expect(root.snapshot()).toMatchObject({ running: 1, queued: 0, tracked: 1 })
      return 42
    }))
    expect(result).toBe(42)
    expect(root.snapshot().tracked).toBe(0)
  })

  it('releases nested capacity before an awaited native continuation starts the next one', async () => {
    const root = new ConfigSaveCoordinator({ ...limits, maxNestedPerOperation: 1 })
    const a = root.createAccount(binding())
    const values = await a.admit('default-model', async () => {
      const result: number[] = []
      for (let i = 0; i < 3; i++) result.push(await a.admit('settings', () => Promise.resolve(i)))
      return result
    })
    expect(values).toEqual([0, 1, 2])
  })

  it('tracks non-awaited enrolled application work and preserves its caught failure', async () => {
    const root = new ConfigSaveCoordinator(limits)
    const a = root.createAccount(binding())
    const child = deferred()
    const original = new Error('required apply failed')
    const work = a.admit('default-model', async () => {
      void a.admit('settings', () => child.promise).catch(() => {})
      return 'persisted'
    })
    const failed = expect(work).rejects.toBe(original)
    await Promise.resolve()
    expect(a.snapshot().pending).toHaveLength(1)
    child.reject(original)
    await failed
    expect(await a.stopConfigSaves(nowDeadline())).toMatchObject({ status: 'unknown', failures: [{ outcome: 'failed' }] })
  })

  it('rejects self pause/stop before changing admission and denies cross-account nested work', async () => {
    const root = new ConfigSaveCoordinator(limits)
    const a = root.createAccount(binding())
    const b = root.createAccount(binding('b'))
    const neverSubmit = vi.fn(async () => {})
    await a.admit('default-model', async () => {
      expect(() => a.pauseAccountChanges(nowDeadline())).toThrow('own submission turn')
      expect(() => a.stopConfigSaves(nowDeadline())).toThrow('own submission turn')
      expect(a.snapshot().admission).toBe('open')
      expect(() => b.admit('settings', neverSubmit)).toThrow()
    })
    expect(neverSubmit).not.toHaveBeenCalled()
    expect(a.snapshot().failures).toHaveLength(0)
  })

  it('bounds nested enrollment and records a refused required continuation against its admitted parent', async () => {
    const root = new ConfigSaveCoordinator({ ...limits, maxNestedPerOperation: 1 })
    const a = root.createAccount(binding())
    const child = deferred()
    const denied = vi.fn(async () => {})
    const work = a.admit('default-model', async () => {
      void a.admit('settings', () => child.promise)
      expect(() => a.admit('settings', denied)).toThrow()
    })
    const rejected = expect(work).rejects.toMatchObject({ code: 'cloud/capacity' })
    child.resolve()
    await rejected
    expect(denied).not.toHaveBeenCalled()
    expect(a.snapshot().failures).toHaveLength(1)
  })

  it('never starts queued old-generation writes but continues observing already-running work', async () => {
    const root = new ConfigSaveCoordinator(limits)
    const lifetime = new AbortController()
    const a = root.createAccount(binding('a', '1', lifetime))
    const slow = deferred()
    const first = a.admit('default-model', () => slow.promise)
    const queued = vi.fn(async () => {})
    const second = a.admit('default-model', queued)
    const rejection = expect(second).rejects.toMatchObject({ code: 'cloud/stale-generation' })
    lifetime.abort()
    expect(a.snapshot().pending).toHaveLength(2)
    slow.resolve()
    await first
    await rejection
    expect(queued).not.toHaveBeenCalled()
    expect(await a.stopConfigSaves(nowDeadline())).toMatchObject({ status: 'unknown', failures: [{ outcome: 'failed' }] })
  })

  it('requires terminal confirmation to release a barrier and bounds root registrations', async () => {
    const root = new ConfigSaveCoordinator({ ...limits, maxAccounts: 1 })
    const a = root.createAccount(binding())
    expect(() => root.createAccount(binding('b'))).toThrow()
    expect(() => { root.releaseAccount(a) }).toThrow()
    expect(() => { root.close() }).toThrow()
    await a.stopConfigSaves(nowDeadline())
    root.releaseAccount(a)
    const next = root.createAccount(binding('a', '2'))
    await next.stopConfigSaves(nowDeadline())
    root.releaseAccount(next)
    root.close()
    expect(() => root.createAccount(binding('b'))).toThrow()
  })

  it('rejects invalid and missing limits rather than infer deployment capacity', () => {
    expect(() => new ConfigSaveCoordinator({ ...limits, maxRunning: 0 })).toThrow()
    expect(() => new ConfigSaveCoordinator({ ...limits, maxQueued: Infinity })).toThrow()
    const root = new ConfigSaveCoordinator(limits)
    const a = root.createAccount(binding())
    expect(() => a.stopConfigSaves(Infinity)).toThrow()
    expect(a.snapshot().admission).toBe('open')
  })
})

describe('explicit native writer adapter', () => {
  it('uses public ConfigEditor submitSave, blocks unknown writers and keeps the hook until terminal confirmation', async () => {
    const ctx = new Context()
    try {
      const editor = new ConfigEditor(ctx)
      const root = new ConfigSaveCoordinator(limits)
      const a = root.createAccount(binding())
      expect(() => installNativeDefaultModelSaveHook(ctx, a)).toThrow(expect.objectContaining({ code: 'cloud/stale-generation' }))
      ctx.provide('peAccount', a.binding)
      const remove = installNativeDefaultModelSaveHook(ctx, a)
      const slow = deferred()
      let submitted = 0
      const work = editor.submitSave('agent-default-model/saveSelection', () => {
        expect(a.snapshot().pending).toHaveLength(1)
        submitted++
        return slow.promise
      })
      const unknown = vi.fn(async () => {})
      expect(() => editor.submitSave('not-reviewed', unknown)).toThrow()
      expect(unknown).not.toHaveBeenCalled()
      await expect(remove()).rejects.toMatchObject({ code: 'cloud/config-busy' })
      expect(await a.stopConfigSaves(Date.now())).toMatchObject({ status: 'unknown' })
      expect(submitted).toBe(1)
      slow.resolve()
      await work
      expect(await a.stopConfigSaves(nowDeadline())).toMatchObject({ status: 'confirmed' })
      await remove()
      root.releaseAccount(a)
      root.close()
    } finally { await ctx.fiber.dispose() }
  })
})


describe('original stopped configuration commit', () => {
  it('retains nested native hooks and required application on one stopped turn without reopening admission', async () => {
    const root = new ConfigSaveCoordinator(limits), a = root.createAccount(binding()), hold = deferred()
    await a.stopConfigSaves(nowDeadline())
    const entered = deferred(), order: string[] = []
    const actual = root.commitStoppedConfiguration(a, async () => {
      expect(a.snapshot().admission).toBe('stopped')
      await a.admit('config-editor', async () => { order.push('write') })
      entered.resolve(); await hold.promise; order.push('apply')
    })
    await entered.promise
    expect(a.snapshot()).toMatchObject({ admission: 'stopped', pending: [{ kind: 'config-editor' }], failures: [] })
    expect(root.snapshot()).toMatchObject({ running: 1, tracked: 1 })
    const refused = vi.fn(async () => {})
    expect(() => a.admit('settings', refused)).toThrow()
    expect(() => { a.resumeAccountChanges() }).toThrow()
    expect(() => root.commitStoppedConfiguration(a, refused)).toThrow()
    expect(await a.stopConfigSaves(Date.now())).toMatchObject({ status: 'unknown', reason: 'deadline' })
    expect(refused).not.toHaveBeenCalled(); hold.resolve(); await actual
    expect(order).toEqual(['write', 'apply'])
    expect(await a.stopConfigSaves(nowDeadline())).toMatchObject({ status: 'confirmed', admission: 'stopped' })
    expect(() => root.commitStoppedConfiguration(a, refused)).toThrow()
    root.releaseAccount(a); root.close()
  })

  it('rejects open, paused, copied and foreign save owners before the terminal writer', async () => {
    const root = new ConfigSaveCoordinator(limits), a = root.createAccount(binding()), submit = vi.fn(async () => {})
    expect(() => root.commitStoppedConfiguration(a, submit)).toThrow()
    await a.pauseAccountChanges(nowDeadline())
    expect(() => root.commitStoppedConfiguration(a, submit)).toThrow()
    await a.stopConfigSaves(nowDeadline())
    expect(() => root.commitStoppedConfiguration({ ...a }, submit)).toThrow()
    const foreign = new ConfigSaveCoordinator(limits)
    expect(() => foreign.commitStoppedConfiguration(a, submit)).toThrow()
    expect(submit).not.toHaveBeenCalled()
    await root.commitStoppedConfiguration(a, async () => {})
    root.releaseAccount(a); root.close(); foreign.close()
  })

  it('keeps the stopped owner unavailable while original work is pending or its generation has ended', async () => {
    const root = new ConfigSaveCoordinator(limits), lifetime = new AbortController()
    const a = root.createAccount(binding('pending', '1', lifetime)), hold = deferred(), submit = vi.fn(async () => {})
    const pending = a.admit('settings', () => hold.promise)
    expect(await a.stopConfigSaves(Date.now())).toMatchObject({ status: 'unknown' })
    expect(() => root.commitStoppedConfiguration(a, submit)).toThrow()
    hold.resolve(); await pending; lifetime.abort()
    expect(() => root.commitStoppedConfiguration(a, submit)).toThrow(expect.objectContaining({ code: 'cloud/stale-generation' }))
    expect(submit).not.toHaveBeenCalled(); root.releaseAccount(a); root.close()
  })

  it('retains unknown final publication and capacity on the original owner and refuses retry or release', async () => {
    const root = new ConfigSaveCoordinator(limits), a = root.createAccount(binding()), submit = vi.fn(async () => {})
    await a.stopConfigSaves(nowDeadline())
    await expect(root.commitStoppedConfiguration(a, async () => { throw new ConfigSaveOutcomeUnknown() }))
      .rejects.toBeInstanceOf(ConfigSaveOutcomeUnknown)
    expect(a.snapshot()).toMatchObject({ admission: 'stopped', pending: [], failures: [{ outcome: 'unknown' }] })
    expect(root.snapshot()).toMatchObject({ tracked: 1 })
    expect(() => root.commitStoppedConfiguration(a, submit)).toThrow()
    expect(() => { a.resumeAccountChanges() }).toThrow()
    expect(() => { root.releaseAccount(a) }).toThrow()
    expect(() => { root.close() }).toThrow(); expect(submit).not.toHaveBeenCalled()
  })
})
