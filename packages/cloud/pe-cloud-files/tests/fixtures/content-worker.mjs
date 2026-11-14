/** Worker reply validation fixture; it grants no filesystem authority. */
import { parentPort, workerData } from 'node:worker_threads'
const { mode = 'normal', abiVersion = 8, gate } = workerData
const pageVersion = '1:2:3:4:5:6:7'
let enumeration
const metadata = { identity: '1:2', version: '1:2:3:4:5', type: 'file', size: 3 }
parentPort.postMessage({ kind: 'ready', abiVersion,
  ...mode.startsWith('paging-') ? { directoryPagingVersion: mode === 'paging-unknown-version' ? 2 : 1 } : {},
  ...mode === 'unknown-directory-version' ? { directoryListingVersion: 2 }
    : abiVersion === 8 && mode !== 'missing-directory-version' ? { directoryListingVersion: 1 } : {} })
parentPort.on('message', request => {
  if (request.kind === 'directory-open') {
    enumeration = { id: request.id, sequence: 0 }
    parentPort.postMessage({ kind: 'directory-ready', id: request.id, version: pageVersion })
    return
  }
  if (request.kind === 'directory-close') {
    if (mode === 'paging-close-unknown') throw Object.assign(new Error('TEST ONLY native close unconfirmed'), { code: 'DSH_FD_CLOSE' })
    if (mode === 'paging-block-close') {
      const state = new Int32Array(gate)
      Atomics.store(state, 0, 1)
      Atomics.wait(state, 1, 0)
    }
    enumeration = undefined
    parentPort.postMessage({ kind: 'directory-closed', id: request.id, version: pageVersion, closed: true })
    return
  }
  if (request.kind === 'directory-pull') {
    if (mode === 'paging-operation-failure') {
      enumeration = undefined
      parentPort.postMessage({ kind: 'reply', id: request.id, ok: false, code: 'FS_STALE_VERSION', syscallCode: 'ESTALE' })
      return
    }
    const sequence = enumeration.sequence++, eof = sequence === 1
    const entries = [{ name: eof ? 'b' : 'a', ...metadata }]
    const page = { entries, version: pageVersion, eof, closed: eof }
    if (mode === 'paging-version') page.version = '1:2:3:4:5:6:8'
    if (mode === 'paging-false-close') page.closed = !eof
    if (mode === 'paging-empty') page.entries = []
    if (mode === 'paging-extra') page.cursor = 'unexpected'
    if (mode === 'paging-duplicate') page.entries.push({ name: entries[0].name, ...metadata })
    if (mode === 'paging-name') page.entries[0].name = 'z'.repeat(256)
    parentPort.postMessage({ kind: 'directory-page', id: request.id,
      sequence: mode === 'paging-sequence' ? sequence + 1 : sequence, page })
    return
  }
  if (mode === 'close-unknown') throw Object.assign(new Error('TEST ONLY unconfirmed descriptor closure'), { code: 'DSH_FD_CLOSE' })
  if (mode === 'blocked') {
    const state = new Int32Array(gate)
    Atomics.store(state, 0, 1)
    Atomics.wait(state, 1, 0)
    parentPort.postMessage({ kind: 'reply', id: request.id, ok: false, code: 'FS_ABORTED' })
    return
  }
  if (request.kind === 'lstat') {
    parentPort.postMessage({ kind: 'lstat-reply', id: request.id,
      metadata: request.relativePath === 'absent' ? undefined : { ...metadata, type: 'symlink' } })
  } else if (request.kind === 'list') {
    let entries = [{ name: 'a', ...metadata }, { name: '你.txt', ...metadata }]
    if (mode === 'escaped') entries[1].name = '你"\n.txt'
    if (mode === 'duplicate') entries[1].name = 'a'
    if (mode === 'escape') entries[1].name = '../outside'
    if (mode === 'surrogate') entries[1].name = '\ud800'
    if (mode === 'unsorted') entries.reverse()
    if (mode === 'invalid-size') entries[1].size = -1
    if (mode === 'identity-mismatch') entries[1].version = '9:9:3:4:5'
    if (mode === 'over-count') entries.push({ name: 'z', ...metadata })
    if (mode === 'over-bytes') entries[1].name = 'z'.repeat(2048)
    if (mode === 'legacy-list') { parentPort.postMessage({ kind: 'list-reply', id: request.id, entries }); return }
    const listing = { entries, truncated: mode === 'partial' || mode === 'empty-partial' }
    if (mode === 'missing-truncated') delete listing.truncated
    if (mode === 'invalid-truncated') listing.truncated = 'false'
    if (mode === 'empty-partial') listing.entries = []
    if (mode === 'extra-listing-field') listing.cursor = 'unreviewed'
    parentPort.postMessage({ kind: 'list-reply', id: request.id, listing,
      ...mode === 'extra-field' ? { extra: { nested: 'unreviewed' } } : {} })
  } else {
    const bytes = mode === 'range-overrun' ? new Uint8Array(request.length + 1)
      : mode === 'range-backing' ? new Uint8Array(new ArrayBuffer(8), 2, 2) : new Uint8Array([2, 3])
    parentPort.postMessage({ kind: 'range-reply', id: request.id, bytes }, [bytes.buffer])
  }
})
