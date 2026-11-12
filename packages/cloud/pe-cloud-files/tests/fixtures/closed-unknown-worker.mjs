/** Synthetic DSV1/probe transport only; no native helper, storage, confinement or deployment proof. */
import { parentPort, workerData } from 'node:worker_threads'
const { record, facts, mounts, status, counters, mode } = workerData
const counts = new Int32Array(counters)
const encode = value => new TextEncoder().encode(value)
let pendingPrepare
const replyPrepare = request => {
  const frame = new Uint8Array(128), view = new DataView(frame.buffer)
  frame.set([68, 83, 86, 49, 1, 3, 3])
  view.setUint32(8, 5, true)
  for (const [index, key] of ['rootDevice', 'rootInode', 'rootMountId'].entries()) {
    view.setBigUint64(32 + index * 8, BigInt(request.root[key]), true)
  }
  parentPort.postMessage({ kind: 'skill-prepare-reply', id: request.id, frame }, [frame.buffer])
}
parentPort.postMessage({ kind: 'ready', abiVersion: 8, storageProbeVersion: 1, skillVersionsVersion: 1 })
parentPort.on('message', request => {
  if (request.kind === 'fixture-close') { parentPort.close(); return }
  if (request.kind === 'fixture-release-prepare') {
    if (pendingPrepare === undefined) throw new Error('Missing original fixture prepare')
    replyPrepare(pendingPrepare); pendingPrepare = undefined; return
  }
  if (request.kind === 'storage-record') {
    const bytes = encode(JSON.stringify(record))
    parentPort.postMessage({ kind: 'storage-record-reply', id: request.id, bytes }, [bytes.buffer])
  } else if (request.kind === 'storage-view') {
    const mountInfo = encode(mounts), processStatus = encode(status)
    parentPort.postMessage({ kind: 'storage-view-reply', id: request.id,
      view: { mountInfo, status: processStatus } }, [mountInfo.buffer, processStatus.buffer])
  } else if (request.kind === 'storage-probe') {
    const observed = facts[request.path]
    if (observed === undefined) throw new Error('Unexpected fixture probe')
    const frame = new Uint8Array(256), view = new DataView(frame.buffer)
    frame.set([68, 83, 80, 49, 1, 1, observed.flags])
    for (const [index, key] of ['uid', 'gid', 'mode', 'appUid', 'appGid'].entries()) view.setUint32(12 + index * 4, observed[key], true)
    for (const [index, key] of ['device', 'inode', 'mountId', 'filesystem', 'blockBytes', 'blocks', 'freeBlocks',
      'availableBlocks', 'inodes', 'freeInodes', 'size', 'allocatedBytes', 'links'].entries()) {
      view.setBigUint64(32 + index * 8, BigInt(observed[key]), true)
    }
    parentPort.postMessage({ kind: 'storage-probe-reply', id: request.id, frame }, [frame.buffer])
  } else if (request.kind === 'skill-prepare') {
    Atomics.add(counts, 0, 1)
    Atomics.notify(counts, 0)
    if (mode === 'cancelled') pendingPrepare = request
    else replyPrepare(request)
  } else if (request.kind === 'lstat' && request.relativePath === 'skills') {
    Atomics.add(counts, 1, 1)
    parentPort.postMessage({ kind: 'lstat-reply', id: request.id, metadata: undefined })
    parentPort.close()
  } else throw new Error('Unexpected fixture operation')
})
