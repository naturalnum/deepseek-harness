import { describe, expect, it } from 'vitest'
import {
  personalMcpSessionOptions,
  resolvePersonalMcpCheckSession,
  personalMcpSessionSource,
  type PersonalMcpNativeSessionSource,
  type PersonalMcpSessionListState,
} from '../src/client/personal-mcp-session-view.ts'

describe('Personal MCP Session selection', () => {
  it('defaults to the current existing Session', () => {
    expect(resolvePersonalMcpCheckSession(snapshot('session-current'), '')).toBe('session-current')
  })

  it('requires an explicit choice when there is no current Session', () => {
    const value = snapshot(undefined)
    expect(value.ids).toEqual(['session-current', 'session-other'])
    expect(resolvePersonalMcpCheckSession(value, '')).toBe('')
    expect(resolvePersonalMcpCheckSession(value, 'session-other')).toBe('session-other')
  })

  it('drops a removed selection instead of inventing or creating a Session', () => {
    expect(resolvePersonalMcpCheckSession(snapshot(undefined), 'session-removed')).toBe('')
    expect(personalMcpSessionOptions(snapshot(undefined))).toEqual([
      { id: 'session-current', label: 'Current task', current: false },
      { id: 'session-other', label: 'Other task', current: false },
    ])
  })

  it('caches the public native projection and follows mainView counts without a private selection', () => {
    type NativeSnapshot = ReturnType<PersonalMcpNativeSessionSource['list']['getSnapshot']>
    let state: NativeSnapshot = { ids: ['one', 'two'], byId: {
      one: { displayTitle: 'First', retainedBy: {} }, two: { displayTitle: 'Second', retainedBy: {} },
    }, phase: 'ready' }
    const listeners = new Set<() => void>()
    const source = personalMcpSessionSource({ list: { getSnapshot: () => state,
      subscribe: listener => { listeners.add(listener); return () => { listeners.delete(listener) } },
    } })
    expect(source.list.getSnapshot().current).toBeUndefined()
    expect(source.list.getSnapshot()).toBe(source.list.getSnapshot())
    let notifications = 0
    const stop = source.list.subscribe(() => { notifications += 1 })
    state = { ...state, byId: { ...state.byId, one: { displayTitle: 'First', retainedBy: { mainView: 1 } } } }
    listeners.forEach(listener => listener())
    expect(source.list.getSnapshot().current).toBe('one')
    state = { ...state, byId: { one: { displayTitle: 'First', retainedBy: {} },
      two: { displayTitle: 'Second', retainedBy: { mainView: 1 } } } }
    listeners.forEach(listener => listener())
    expect(source.list.getSnapshot().current).toBe('two')
    state = { ids: ['one'], byId: { one: { displayTitle: 'First', retainedBy: {} } }, phase: 'ready' }
    listeners.forEach(listener => listener())
    expect(resolvePersonalMcpCheckSession(source.list.getSnapshot(), 'two')).toBe('')
    expect(notifications).toBe(3)
    stop()
    expect(listeners.size).toBe(0)
  })
})

function snapshot(current: string | undefined): PersonalMcpSessionListState {
  return {
    ids: ['session-current', 'session-other'],
    byId: {
      'session-current': { displayTitle: 'Current task' },
      'session-other': { displayTitle: 'Other task' },
    },
    current,
    phase: 'ready',
  }
}
