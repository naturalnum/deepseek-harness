/** Pure address checks; no directory, quota, owner, or native graph is created by these fixtures. */
import { posix } from 'node:path'
import { describe, expect, it } from 'vitest'
import { brandString } from '@deepseek-ai/dsh-brand'
import { deriveAccountLayout, defaultProjectLayout, newProjectLayout, type LayoutDeployment } from '../src/account-layout.ts'
import { AccountRuntimeError } from '../src/errors.ts'
import { createProcessInstanceIdentity } from '../src/instance-identity.ts'
import type { AccountId } from '@deepseek-ai/dsh-pe-cloud-runtime/types'

const deployment: LayoutDeployment = {
  sharedAccountsRoot: '/shared/dsh/accounts', localCacheRoot: '/var/cache/dsh', maxPathBytes: 1024,
}
const account = brandString<AccountId>('verified/account:甲')
const instance = createProcessInstanceIdentity().instanceId
const layout = () => deriveAccountLayout(account, instance, deployment)

describe('private account address derivation', () => {
  it('pins the v1 UTF-8 key and all shared and process-local addresses', () => {
    const key = 'v1-ecbfc6b7ae218dea11995dcb36b4cb64f81740be73fced8048e357ecdad87883'
    const base = `/shared/dsh/accounts/${key}`
    expect(layout()).toEqual({
      storageKey: key, accountRoot: base, privateRoot: `${base}/private`, profileRoot: `${base}/private/profile`,
      patchPath: `${base}/private/profile/cordis.patch.yml`, credentialsRoot: `${base}/private/credentials`,
      sessionsRoot: `${base}/private/sessions`, storageRoot: `${base}/private/storage`,
      attachmentsRoot: `${base}/private/attachments`, skillsRoot: `${base}/private/skills`,
      instructionsRoot: `${base}/private/instructions`, projectsRoot: `${base}/projects`,
      environmentsRoot: `${base}/environments`, localIndexRoot: `/var/cache/dsh/${instance}/${key}/session-index`,
    })
  })

  it('changes only the local index after a process restart and isolates another account', () => {
    const first = layout()
    const next = deriveAccountLayout(account, createProcessInstanceIdentity().instanceId, deployment)
    const { localIndexRoot: firstIndex, ...shared } = first
    const { localIndexRoot: nextIndex, ...nextShared } = next
    expect(nextShared).toEqual(shared)
    expect(nextIndex).not.toBe(firstIndex)
    const other = deriveAccountLayout(brandString<AccountId>('other/account:甲'), instance, deployment)
    expect(other.storageKey).not.toBe(first.storageKey)
    expect(other.accountRoot).not.toBe(first.accountRoot)
    expect(Object.isFrozen(first)).toBe(true)
    expect(Reflect.set(first, 'projectsRoot', '/replacement')).toBe(false)
  })

  it('retains exact UTF-8 identity without normalizing it or using it as a directory segment', () => {
    const ids = ['é', 'e\u0301', 'A', 'a', '../display/title']
    const layouts = ids.map(id => deriveAccountLayout(brandString<AccountId>(id), instance, deployment))
    expect(new Set(layouts.map(value => value.storageKey)).size).toBe(ids.length)
    for (const value of layouts) {
      expect(value.storageKey).toMatch(/^v1-[0-9a-f]{64}$/)
      expect(posix.dirname(value.accountRoot)).toBe(deployment.sharedAccountsRoot)
    }
  })

  it('keeps the default-workspace basename and separate UUID candidates without touching native registration', () => {
    const value = layout()
    const candidate = defaultProjectLayout(value, deployment.maxPathBytes)
    expect(candidate).toEqual({
      directoryKey: 'default-workspace', root: `${value.projectsRoot}/default-workspace`,
      attachmentsRoot: `${value.projectsRoot}/default-workspace/.pe/attachments`,
      spillRoot: `${value.projectsRoot}/default-workspace/.pe/spill`,
    })
    expect(defaultProjectLayout(value, deployment.maxPathBytes)).toEqual(candidate)
    expect(posix.basename(candidate.root)).toBe('default-workspace')
    const first = newProjectLayout(value, deployment.maxPathBytes)
    const second = newProjectLayout(value, deployment.maxPathBytes)
    expect(first.directoryKey).toMatch(/^[0-9a-f]{8}-[0-9a-f]{4}-4[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/)
    expect(second.directoryKey).not.toBe(first.directoryKey)
    expect(first.root).toBe(`${value.projectsRoot}/${first.directoryKey}`)
    expect(first.attachmentsRoot).toBe(`${first.root}/.pe/attachments`)
    expect(first.spillRoot).toBe(`${first.root}/.pe/spill`)
    expect(Object.isFrozen(candidate)).toBe(true)
    expect(Object.isFrozen(first)).toBe(true)
  })

  it.each([0, -1, 1.5, Infinity, NaN, Number.MAX_SAFE_INTEGER + 1])('rejects an invalid byte budget %s', (maxPathBytes) => {
    expect(() => deriveAccountLayout(account, instance, { ...deployment, maxPathBytes })).toThrow(AccountRuntimeError)
  })

  it.each(['relative/accounts', '/shared/../accounts', '/shared//accounts', '/shared/accounts/', '/shared/\0accounts'])
  ('rejects ambiguous or non-absolute deployment roots %s', (value) => {
    for (const field of ['sharedAccountsRoot', 'localCacheRoot']) {
      expect(() => deriveAccountLayout(account, instance, { ...deployment, [field]: value })).toThrow(AccountRuntimeError)
    }
  })

  it('bounds character and UTF-8 input sizes before hashing or deriving outputs', () => {
    for (const id of ['x'.repeat(257), '界'.repeat(100)]) {
      expect(() => deriveAccountLayout(brandString<AccountId>(id), instance, { ...deployment, maxPathBytes: 256 }))
        .toThrow('account identity')
    }
    expect(() => deriveAccountLayout(account, instance, {
      ...deployment, sharedAccountsRoot: '/' + '界'.repeat(100), maxPathBytes: 256,
    })).toThrow('sharedAccountsRoot')
  })

  it('accepts the exact maximum output byte length and rejects one byte less', () => {
    const unicode = { ...deployment, sharedAccountsRoot: '/共享/账户', localCacheRoot: '/本地/索引' }
    const value = deriveAccountLayout(account, instance, unicode)
    const bytes = Math.max(...Object.values({ ...value }).map(path => Buffer.byteLength(path, 'utf8')))
    expect(deriveAccountLayout(account, instance, { ...unicode, maxPathBytes: bytes })).toEqual(value)
    expect(() => deriveAccountLayout(account, instance, { ...unicode, maxPathBytes: bytes - 1 })).toThrow('derived path')
  })

  it.each([defaultProjectLayout, newProjectLayout])('checks every project candidate output against the byte budget', (derive) => {
    const value = layout()
    const candidate = derive(value, deployment.maxPathBytes)
    const bytes = Math.max(...Object.values({ ...candidate }).map(path => Buffer.byteLength(path, 'utf8')))
    expect(derive(value, bytes).root.startsWith(`${value.projectsRoot}/`)).toBe(true)
    expect(() => derive(value, bytes - 1)).toThrow('derived path')
  })

  it('returns typed configuration diagnostics without echoing private roots or account ids', () => {
    try {
      deriveAccountLayout(account, instance, { ...deployment, localCacheRoot: 'private-secret-location' })
      throw new Error('An invalid deployment root must reject')
    } catch (cause) {
      expect(cause).toBeInstanceOf(AccountRuntimeError)
      expect(cause).toMatchObject({ code: 'cloud/invalid-config' })
      if (!(cause instanceof Error)) throw cause
      expect(cause.message).not.toContain(account)
      expect(cause.message).not.toContain('private-secret-location')
    }
  })
})
