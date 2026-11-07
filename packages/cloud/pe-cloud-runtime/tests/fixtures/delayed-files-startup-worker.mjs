/** Delay only the external worker's initial handshake; all protocol replies use the original fixture. */
import { workerData } from 'node:worker_threads'
Atomics.wait(new Int32Array(workerData.readyGate), 0, 0)
if (workerData.failStartup) throw new Error('Synthetic worker startup failure')
await import('../../../pe-cloud-files/tests/fixtures/storage-lifetime-worker.mjs')
