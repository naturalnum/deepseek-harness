/** Fixed deployment preparation for the original transport; no account, login or owner authority is created. */
import { constants } from 'node:fs'
import { lstat, open } from 'node:fs/promises'
import { dirname, isAbsolute } from 'node:path'
import { createSecureContext } from 'node:tls'
import { X509Certificate } from 'node:crypto'
import type { AccountId, AccountOwnerResolution, InstanceId } from '@deepseek-ai/dsh-pe-cloud-runtime/types'
import { OwnerForwarder } from './owner-forwarder.ts'
import type { ForwardTarget, ForwardTargetConfig, ForwardTlsIdentity } from './forward-types.ts'
import type { OwnerForwardingConfig } from './root-config.ts'
import { selectOwnerDestination } from './owner-destination.ts'

/** Actual Root-owned transport and fixed metadata mapping; never returned through public auth metadata. */
export class OwnerRouting {
  /** Root-owned transport retaining accepted local carrier work through actual closure. */
  readonly transport: OwnerForwarder
  /** Configured peer leaf-certificate digests for incoming node-hop authentication. */
  readonly peerPins: ReadonlySet<string>
  private readonly addresses = new Map<string, { readonly id: string; readonly serviceIdentityRef: string }>()
  private closing: Promise<void> | undefined

  private constructor(readonly config: OwnerForwardingConfig, targets: readonly ForwardTargetConfig[]) {
    this.transport = new OwnerForwarder(config.limits, targets)
    this.peerPins = new Set(config.peerCertificateSha256)
    for (const target of config.targets) {
      if (this.addresses.has(target.origin)) throw new TypeError('Owner forwarding requires unique fixed HTTPS targets.')
      this.addresses.set(target.origin, { id: target.id, serviceIdentityRef: target.serviceIdentityRef })
    }
  }

  /**
   * Read finite protected PEM files before admission; every opened original handle closes even after Root cancellation.
   * @param config Explicit deployment limits and material paths, never PG/request data.
   * @param current Original resource-owner check after each asynchronous read.
   * @returns The transport with copied TLS identities and a fixed address allowlist.
   */
  static async prepare(config: OwnerForwardingConfig, current: () => void): Promise<OwnerRouting> {
    let remaining = config.maxPemBytes
    const identities = new Map<string, ForwardTlsIdentity>()
    const read = async (path: string, key: boolean): Promise<Buffer> => {
      if (!isAbsolute(path) || Buffer.byteLength(path) > config.maxPemPathBytes) throw new TypeError('Owner PEM path is invalid.')
      for (let parent = dirname(path); ; parent = dirname(parent)) {
        const stat = await lstat(parent); current()
        if (stat.isSymbolicLink() || !stat.isDirectory()) throw new TypeError('Owner PEM paths require ordinary directories.')
        if (parent === dirname(parent)) break
      }
      const handle = await open(path, constants.O_RDONLY | constants.O_NOFOLLOW | constants.O_NONBLOCK)
      let bytes: Buffer
      try {
        current()
        const stat = await handle.stat(); current()
        if (!stat.isFile() || stat.nlink !== 1 || stat.uid !== process.geteuid?.() || stat.size < 1 || stat.size > remaining
          || (stat.mode & (key ? 0o077 : 0o022)) !== 0) throw new TypeError('Owner PEM file protection or size is invalid.')
        const buffer = Buffer.alloc(stat.size + 1)
        let length = 0
        while (length < buffer.length) {
          const result = await handle.read(buffer, length, buffer.length - length, length); current()
          if (result.bytesRead === 0) break
          length += result.bytesRead
        }
        const after = await handle.stat(); current()
        if (length !== stat.size || after.size !== stat.size || after.mtimeMs !== stat.mtimeMs) throw new TypeError('Owner PEM file changed during reading.')
        remaining -= length
        bytes = Buffer.from(buffer.subarray(0, length))
      } finally { await handle.close() }
      current()
      return bytes
    }
    for (const identity of config.identities) {
      if (identities.has(identity.id) || Buffer.byteLength(identity.id) > config.limits.maxTargetBytes) throw new TypeError('Owner identity reference is invalid.')
      const ca = await read(identity.caFile, false); current()
      const cert = await read(identity.certFile, false); current()
      const key = await read(identity.keyFile, true); current()
      try { new X509Certificate(ca); createSecureContext({ ca, cert, key }) }
      catch (_error) { throw new TypeError('Owner TLS identity is invalid.') }
      identities.set(identity.id, { ca, cert, key, serverCertificateSha256: identity.serverCertificateSha256,
        ...(identity.servername === undefined ? {} : { servername: identity.servername }) })
    }
    const targets: ForwardTargetConfig[] = []
    for (const target of config.targets) {
      const tlsIdentity = identities.get(target.serviceIdentityRef), url = new URL(target.origin)
      if (tlsIdentity === undefined || url.protocol !== 'https:') throw new TypeError('Owner target requires a fixed HTTPS identity.')
      targets.push({ id: target.id, origin: target.origin, tlsIdentity })
    }
    current()
    return new OwnerRouting(config, targets)
  }

  /** Select only an exact configured address after the original resolver has rechecked its instance metadata.
   * @param accountId Original authenticated account, not a destination supplied by the request.
   * @param localInstanceId Actual current process identity.
   * @param recipeVersion Original Root recipe requirement.
   * @param resolution Original resolver result; PG cannot add an address or identity.
   * @returns A fixed opaque transport handle; actual connection authentication still precedes dispatch.
   */
  target(accountId: AccountId, localInstanceId: InstanceId, recipeVersion: string, resolution: AccountOwnerResolution): ForwardTarget {
    const fixed = this.addresses.get(resolution.instance.internalAddress)
    if (this.closing !== undefined || fixed === undefined) throw new TypeError('Owner destination is unavailable.')
    const selected = selectOwnerDestination({ accountId, localInstanceId, recipeVersion, ...resolution,
      trustedTargets: new Map([[resolution.instance.instanceId, { internalAddress: resolution.instance.internalAddress,
        serviceIdentityRef: fixed.serviceIdentityRef }]]) })
    if (selected.kind !== 'remote-candidate') throw new TypeError('Owner destination is unavailable.')
    return this.transport.target(fixed.id)
  }

  /** Stop admission synchronously; retain actual original transport closure beyond its first unknown observation.
   * @returns The same actual local-resource closure; this does not certify remote business outcome or authorize replay.
   */
  closeActual(): Promise<void> {
    if (this.closing !== undefined) return this.closing
    this.closing = this.transport.whenClosed()
    void this.transport.close()
    return this.closing
  }
}
