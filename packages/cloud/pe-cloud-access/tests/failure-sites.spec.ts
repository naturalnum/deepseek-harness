/** Deployment diagnostics retain code positions while excluding request and credential text. */
import { describe, expect, it } from 'vitest'
import { runInThisContext } from 'node:vm'
import { cloudFailureSites } from '../src/failure-sites.ts'

describe('compiled Cloud failure locations', () => {
  it('reads a real native Error stack on the current Node runtime', () => {
    const error: unknown = runInThisContext('new Error("private text")', {
      filename: '/opt/dsh-installed-products/packages/cloud/pe-cloud-api/lib/root.js',
    })
    expect(cloudFailureSites(error)).toEqual(['pe-cloud-api/root.js:1:1'])
  })

  it('omits messages and private paths while locating the actual Cloud guard', () => {
    const error = { stack: 'Error: secret-cookie\n    at private (/srv/user/secret.js:1:2)\n    at unavailable (file:///opt/dsh-installed-products/packages/cloud/pe-cloud-api/lib/index.js:702:12)' }
    expect(cloudFailureSites(error)).toEqual(['pe-cloud-api/index.js:702:12'])
  })

  it('does not invoke an untrusted stack accessor', () => {
    let read = false
    expect(cloudFailureSites({ get stack() { read = true; throw new Error('private') } })).toEqual([])
    expect(read).toBe(false)
  })

  it('normalizes actual compiled chunks without copying their hash text', () => {
    expect(cloudFailureSites({ stack: 'Error\n at guard (file:///opt/dsh-installed-products/packages/cloud/pe-cloud-api/lib/root-B1cD_ef8.js:704:9)' }))
      .toEqual(['pe-cloud-api/root*.js:704:9'])
    expect(cloudFailureSites({ stack: 'Error\n at unavailable (file:///opt/dsh-installed-products/packages/cloud/pe-cloud-api/lib/account-service-Dcy-jnMJ.js:580:12)' }))
      .toEqual(['pe-cloud-api/account-service*.js:580:12'])
    expect(cloudFailureSites({ stack: 'Error\n at unavailable (file:///opt/dsh-installed-products/packages/cloud/pe-opensandbox/lib/closed-owner-k22_zw-q.js:81:7)' }))
      .toEqual(['pe-opensandbox/closed-owner*.js:81:7'])
    expect(cloudFailureSites({ stack: 'Error\n at /packages/cloud/pe-cloud-access/lib/account-service-Dcy-jnMJ.js:2:3' })).toEqual([])
  })

  it('rejects unknown files, oversized stacks and unreadable objects', () => {
    expect(cloudFailureSites({ stack: 'Error\n at /packages/cloud/pe-cloud-api/lib/secret-token.js:2:3' })).toEqual([])
    expect(cloudFailureSites({ stack: 'x'.repeat(16385) })).toEqual([])
    expect(cloudFailureSites(new Proxy({}, { getOwnPropertyDescriptor() { throw new Error('private') } }))).toEqual([])
  })

  it('bounds retained positions across repeated frames', () => {
    const line = '\n at /opt/dsh-installed-products/packages/cloud/pe-cloud-access/lib/root.js:10:20'
    expect(cloudFailureSites({ stack: 'Error' + line.repeat(30) })).toEqual(Array(6).fill('pe-cloud-access/root.js:10:20'))
  })
})
