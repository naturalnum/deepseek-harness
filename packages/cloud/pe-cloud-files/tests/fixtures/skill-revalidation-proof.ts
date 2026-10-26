/** Synthetic Root attestation bytes for scoped parser/owner tests; these never attest an actual Linux retirement. */
import type { StaticStorageAccount } from '../../src/storage-types.ts'

export function skillRevalidationProof(account: StaticStorageAccount) {
  const volume = (domain: StaticStorageAccount['private']) => ({ uuid: '11111111-1111-4111-8111-111111111111',
    device: domain.rootDevice, inode: domain.rootInode, mountId: '614', filesystem: '61267',
    blockBytes: '4096', blocks: String(BigInt(domain.minimumBytes) / 4096n), inodes: domain.minimumInodes, backing: { ...domain.backing } })
  const before = { private: volume(account.private), projects: volume(account.projects) }
  const previous = { instanceId: 'previous-instance', epoch: '1', process: { pid: 23456, startTicks: '456' } }
  return { schema: 1, accountId: account.accountId, storageKey: account.storageKey, workspaceId: 'workspace',
    recordSha256: '1'.repeat(64), recordRevision: '1:2:3:4:5', previous,
    retirement: {
      processExit: { process: previous.process, kind: 'normal-exit', exitCode: 0, receiptSha256: '2'.repeat(64) },
      filesTerminal: { kind: 'lane-joined', instanceId: previous.instanceId, epoch: previous.epoch,
        pendingOperationIds: [], receiptSha256: '3'.repeat(64) },
      writersTerminal: { kind: 'complete-scope-terminal', process: previous.process, receiptSha256: '4'.repeat(64) },
      ownerRecoverySha256: '5'.repeat(64),
    },
    lineage: { oldArchiveSha256: '6'.repeat(64), oldRetirementSha256: '7'.repeat(64), oldJournalSha256: '8'.repeat(64),
      newJournalSha256: '9'.repeat(64), newManifestSha256: 'a'.repeat(64), before, after: structuredClone(before) },
  }
}
