import { describe, expect, it } from 'vitest'
import type { Agent } from '@deepseek-ai/dsh-agent'
import type { AccountBinding } from '@deepseek-ai/dsh-pe-cloud-runtime/types'
import { Session, SessionId } from '@deepseek-ai/dsh-session'
import { ExecutionScopes } from '../src/scopes.ts'

function fixture(maxScopes = 2) {
  // This is a unit fixture for identity checks, not a running Agent or target evidence.
  const agent = { id: SessionId('same-name'), session: Session.create(SessionId('same-name')), status: 'idle' } as Agent
  const generation = new AbortController()
  const binding: AccountBinding = Object.freeze({
    accountId: 'a' as AccountBinding['accountId'],
    epoch: '9007199254740993' as AccountBinding['epoch'],
    recipeVersion: 'scope-unit-fixture',
    lifetime: generation.signal,
  })
  const project = Object.freeze({ identity: 'project-a' })
  const owner = new AbortController()
  let live: Agent | undefined = agent
  let current = true
  let checks = 0
  const scopes = new ExecutionScopes({
    binding,
    maxScopes,
    getAgent: () => live,
    assertCurrent(scope) {
      checks++
      if (!current || scope.binding !== binding || scope.project !== project
        || scope.consumerId !== 'bash' || scope.purpose !== 'command'
        || scope.capabilities.some(capability => capability !== 'argv-collect')) {
        throw new Error('account/project/consumer authorization refused')
      }
    },
  })
  const input = { agent, project, consumerId: 'bash', purpose: 'command' as const, capabilities: ['argv-collect' as const], lifetime: owner.signal }
  return {
    scopes, input, agent, binding, owner, generation,
    checks: () => checks,
    stale: () => { current = false },
    replaceAgent: () => { live = { ...agent } },
  }
}

describe('internal execution scope ownership', () => {
  it('retains the exact opaque account generation and native Session, without allocating', () => {
    const f = fixture()
    try {
      const scope = f.scopes.issue(f.input)
      expect(scope.binding).toBe(f.binding)
      expect(scope.sessionId).toBe(f.agent.session.id)
      expect(Object.isFrozen(scope)).toBe(true)
      expect(Object.isFrozen(scope.capabilities)).toBe(true)
      expect(f.checks()).toBe(1)
      f.scopes.assertCurrent(scope)
      expect(f.checks()).toBe(2)
      f.stale()
      expect(() => { f.scopes.assertCurrent(scope) }).toThrow('authorization refused')
    } finally { f.scopes.close() }
  })

  it('rejects copied scopes and scopes from another same-name Session issuer', () => {
    const a = fixture()
    const b = fixture()
    try {
      const scope = a.scopes.issue(a.input)
      expect(() => { a.scopes.assertCurrent({ ...scope }) }).toThrow('not owned')
      expect(() => { b.scopes.assertCurrent(scope) }).toThrow('not owned')
      a.replaceAgent()
      expect(() => { a.scopes.assertCurrent(scope) }).toThrow('exact live')
    } finally { a.scopes.close(); b.scopes.close() }
  })

  it('bounds outstanding scopes and releases capacity on owner revocation', () => {
    const f = fixture(1)
    try {
      const scope = f.scopes.issue(f.input)
      expect(() => f.scopes.issue(f.input)).toThrow('capacity')
      f.owner.abort('consumer disposed')
      expect(() => { f.scopes.assertCurrent(scope) }).toThrow('not owned')
      const nextOwner = new AbortController()
      const next = f.scopes.issue({ ...f.input, lifetime: nextOwner.signal })
      f.scopes.release(next)
      f.scopes.release(next)
      expect(() => f.scopes.issue({ ...f.input, lifetime: nextOwner.signal })).not.toThrow()
    } finally { f.scopes.close() }
  })

  it('rejects closed generations and pre-aborted owners before scope publication', () => {
    const f = fixture()
    try {
      f.owner.abort('original owner reason')
      expect(() => f.scopes.issue(f.input)).toThrow('original owner reason')
      f.generation.abort('old epoch')
      expect(() => f.scopes.issue({ ...f.input, lifetime: new AbortController().signal })).toThrow('admission is closed')
    } finally { f.scopes.close() }
  })

  it('denies project/consumer/mode changes and rejects use after close', () => {
    const f = fixture()
    try {
      expect(() => f.scopes.issue({ ...f.input, consumerId: 'lsp' })).toThrow('authorization refused')
      expect(() => f.scopes.issue({ ...f.input, capabilities: ['terminal'] })).toThrow('authorization refused')
      const scope = f.scopes.issue(f.input)
      f.scopes.close()
      expect(() => { f.scopes.assertCurrent(scope) }).toThrow('admission is closed')
      expect(() => f.scopes.issue(f.input)).toThrow('admission is closed')
    } finally { f.scopes.close() }
  })

  it('rejects non-finite or unbounded scope capacity', () => {
    for (const max of [0, -1, Infinity, NaN, 1.5, Number.MAX_SAFE_INTEGER + 1]) {
      expect(() => fixture(max)).toThrow('positive safe integer')
    }
  })
})
