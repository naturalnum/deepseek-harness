/** Ephemeral test-only PKI. No real credentials; never imported by the transport. */
import { execFileSync } from 'node:child_process'
import { mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { X509Certificate } from 'node:crypto'
import type { ServerOptions } from 'node:https'
import type { ForwardTlsIdentity } from '../src/forward-types.ts'

export function identityFixture(): {
  server: ServerOptions
  identity: ForwardTlsIdentity
  wrongCa: Buffer
  clientPin: string
  otherClient: { cert: Buffer; key: Buffer }
} {
  const own = mkdtempSync(join(tmpdir(), 'owner-mtls-'))
  const run = (...args: string[]): void => { execFileSync('openssl', args, { cwd: own, stdio: 'ignore' }) }
  const load = (name: string): Buffer => readFileSync(join(own, name))
  const pin = (pem: Buffer): string => new X509Certificate(pem).fingerprint256.replaceAll(':', '').toLowerCase()
  try {
    for (const ca of ['ca', 'wrong-ca']) run('req', '-x509', '-newkey', 'rsa:2048', '-nodes', '-sha256', '-days', '2',
      '-subj', `/CN=${ca}`, '-keyout', `${ca}.key`, '-out', `${ca}.pem`, '-addext', 'basicConstraints=critical,CA:TRUE')
    for (const [name, usage] of [['owner.test', 'serverAuth'], ['client.test', 'clientAuth'], ['other-client.test', 'clientAuth']] as const) {
      run('req', '-new', '-newkey', 'rsa:2048', '-nodes', '-subj', `/CN=${name}`, '-keyout', `${name}.key`, '-out', `${name}.csr`)
      writeFileSync(join(own, name + '.ext'), `basicConstraints=CA:FALSE\nkeyUsage=digitalSignature,keyEncipherment\nextendedKeyUsage=${usage}\nsubjectAltName=DNS:${name}\n`)
      run('x509', '-req', '-in', `${name}.csr`, '-CA', 'ca.pem', '-CAkey', 'ca.key', '-CAcreateserial', '-days', '2', '-sha256',
        '-extfile', `${name}.ext`, '-out', `${name}.pem`)
    }
    return { server: { ca: load('ca.pem'), cert: load('owner.test.pem'), key: load('owner.test.key'), requestCert: true, rejectUnauthorized: true },
      identity: { ca: load('ca.pem'), cert: load('client.test.pem'), key: load('client.test.key'),
        serverCertificateSha256: pin(load('owner.test.pem')), servername: 'owner.test' },
      wrongCa: load('wrong-ca.pem'), clientPin: pin(load('client.test.pem')),
      otherClient: { cert: load('other-client.test.pem'), key: load('other-client.test.key') } }
  } finally { rmSync(own, { recursive: true, force: true }) }
}
