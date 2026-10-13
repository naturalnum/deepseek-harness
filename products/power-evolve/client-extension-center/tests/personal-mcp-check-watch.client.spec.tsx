import { afterEach, describe, expect, it, vi } from 'vitest'
import type {
  PersonalMcpConnection,
  PersonalMcpConnectionCheck,
} from '../src/client/personal-mcp-client.ts'
import {
  personalMcpDraftCheckKey,
  PersonalMcpDraftCheckGuard,
  pendingPersonalMcpCheckTarget,
  updatePersonalMcpCheck,
  watchPersonalMcpCheck,
} from '../src/client/personal-mcp-check-watch.ts'

afterEach(() => { vi.useRealTimers() })

describe('Personal MCP check watcher', () => {
  it('surfaces a status-read failure once and ignores a failure after the view closes', async () => {
    vi.useFakeTimers()
    const failure = new Error('status unavailable'), onError = vi.fn(), onUpdate = vi.fn()
    const load = vi.fn<Parameters<typeof watchPersonalMcpCheck>[1]>().mockRejectedValue(failure)
    const stop = watchPersonalMcpCheck({ connectionId: CONNECTION_ID, checkId: 'check-1' }, load, onUpdate, onError)
    await vi.advanceTimersByTimeAsync(1000)
    await vi.advanceTimersByTimeAsync(5000)
    expect(onError).toHaveBeenCalledExactlyOnceWith(failure)
    expect(load).toHaveBeenCalledOnce()
    expect(onUpdate).not.toHaveBeenCalled()
    stop()
    const pending = Promise.withResolvers<PersonalMcpConnectionCheck>()
    const lateError = vi.fn()
    const close = watchPersonalMcpCheck({ connectionId: CONNECTION_ID, checkId: 'check-1' },
      () => pending.promise, onUpdate, lateError)
    await vi.advanceTimersByTimeAsync(1000)
    close()
    pending.reject(failure)
    await Promise.resolve()
    expect(lateError).not.toHaveBeenCalled()
    expect(onUpdate).not.toHaveBeenCalled()
  })

  it('uses canonical draft identity and invalidates late results after a semantic change', () => {
    const first = {
      display_name: 'Private MCP', server_url: 'https://mcp.example.test/mcp',
      authentication: { kind: 'headers' as const },
      headers: [{ name: 'Authorization', value: 'secret' }], enabled: false,
    }
    const reordered = {
      enabled: false, headers: [{ value: 'secret', name: 'Authorization' }],
      authentication: { kind: 'headers' as const },
      server_url: 'https://mcp.example.test/mcp', display_name: 'Private MCP',
    }
    expect(personalMcpDraftCheckKey(first, undefined, 'session-1'))
      .toBe(personalMcpDraftCheckKey(reordered, undefined, 'session-1'))
    expect(personalMcpDraftCheckKey(first, undefined, 'session-1'))
      .not.toBe(personalMcpDraftCheckKey({ ...first, server_url: 'https://other.test/mcp' }, undefined, 'session-1'))

    const guard = new PersonalMcpDraftCheckGuard()
    const old = guard.begin()
    guard.invalidate()
    expect(guard.accepts(old)).toBe(false)
  })

  it('refreshes one check until the authoritative state becomes terminal', async () => {
    vi.useFakeTimers()
    const load = vi.fn()
      .mockResolvedValueOnce(check('running'))
      .mockResolvedValueOnce(check('succeeded', 0))
    const updates: PersonalMcpConnectionCheck[] = []
    const stop = watchPersonalMcpCheck(
      { connectionId: CONNECTION_ID, checkId: 'check-1' },
      load,
      (value) => { updates.push(value) },
      (cause) => { throw cause },
    )

    await vi.advanceTimersByTimeAsync(1000)
    await vi.advanceTimersByTimeAsync(1000)
    await vi.advanceTimersByTimeAsync(5000)

    expect(updates.map(value => value.state)).toEqual(['running', 'succeeded'])
    expect(updates[1]?.discovered_tools).toBe(0)
    expect(load).toHaveBeenCalledTimes(2)
    stop()
  })

  it('does not publish a superseded in-flight response', async () => {
    vi.useFakeTimers()
    let resolve!: (value: PersonalMcpConnectionCheck) => void
    const load = vi.fn((_connectionId: string, _checkId: string, _signal: AbortSignal) =>
      new Promise<PersonalMcpConnectionCheck>((land) => { resolve = land }))
    const onUpdate = vi.fn()
    const stop = watchPersonalMcpCheck(
      { connectionId: CONNECTION_ID, checkId: 'check-1' }, load, onUpdate, vi.fn(),
    )

    await vi.advanceTimersByTimeAsync(1000)
    stop()
    resolve(check('canceled'))
    await Promise.resolve()

    expect(onUpdate).not.toHaveBeenCalled()
    expect(load.mock.calls[0]?.[2]?.aborted).toBe(true)
  })

  it('keeps a newer latest check when an older watched result returns late', () => {
    const newer = { ...check('running'), check_id: 'check-new' }
    const connection = connectionWithCheck(newer)
    const lateOlder = { ...check('succeeded', 2), check_id: 'check-old' }

    const afterLateResult = updatePersonalMcpCheck([connection], lateOlder, 'current-check')

    expect(afterLateResult[0]).toBe(connection)
    expect(afterLateResult[0]?.latest_check?.check_id).toBe('check-new')
    expect(pendingPersonalMcpCheckTarget(afterLateResult, CONNECTION_ID)).toEqual({
      connectionId: CONNECTION_ID,
      checkId: 'check-new',
    })
    expect(pendingPersonalMcpCheckTarget(afterLateResult, undefined)).toBeUndefined()
  })

  it('allows an explicit new-check response to replace the prior latest check', () => {
    const previous = connectionWithCheck({ ...check('running'), check_id: 'check-old' })
    const created = { ...check('queued'), check_id: 'check-new' }

    const updated = updatePersonalMcpCheck([previous], created, 'new-check')

    expect(updated[0]?.latest_check).toEqual(created)
  })

  it('does not regress a terminal current check when an older pending response arrives', () => {
    const canceled = connectionWithCheck({ ...check('canceled'), check_id: 'check-current' })
    const lateRunning = { ...check('running'), check_id: 'check-current' }

    const updated = updatePersonalMcpCheck([canceled], lateRunning, 'current-check')

    expect(updated[0]).toBe(canceled)
    expect(updated[0]?.latest_check?.state).toBe('canceled')
    expect(pendingPersonalMcpCheckTarget(updated, CONNECTION_ID)).toBeUndefined()
  })

  it('keeps a recorded cancellation request when an earlier running poll arrives', () => {
    const cancelling = connectionWithCheck({ ...check('running'), cancel_requested: true })
    const updated = updatePersonalMcpCheck([cancelling], { ...check('running'), cancel_requested: false }, 'current-check')
    expect(updated[0]).toBe(cancelling)
    expect(updated[0]?.latest_check?.cancel_requested).toBe(true)
  })
})

function connectionWithCheck(latestCheck: PersonalMcpConnectionCheck): PersonalMcpConnection {
  return {
    connection_id: CONNECTION_ID,
    revision: 1,
    display_name: 'Private MCP',
    server_name: 'mcp_00000000',
    server_url: 'https://mcp.example.test/mcp',
    authentication: { kind: 'none', secret_configured: false },
    enabled: false,
    latest_check: latestCheck,
    created_at: '2026-09-19T10:00:00.000Z',
    updated_at: '2026-09-19T10:00:00.000Z',
  }
}

function check(
  state: PersonalMcpConnectionCheck['state'],
  tools: number | null = null,
): PersonalMcpConnectionCheck {
  return {
    check_id: 'check-1', connection_id: CONNECTION_ID, configuration_revision: 1,
    state, error_code: state === 'canceled' ? 'MCP_CANCELED' : null,
    discovered_tools: tools, started_at: null, finished_at: null,
  }
}

const CONNECTION_ID = '00000000-0000-4000-8000-000000000001'
