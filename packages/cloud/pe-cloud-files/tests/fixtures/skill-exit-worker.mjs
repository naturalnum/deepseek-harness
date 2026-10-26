/** TEST ONLY transport loss. No filesystem operation, descriptor claim or storage authority is simulated. */
import { parentPort } from 'node:worker_threads'
parentPort.postMessage({ kind: 'ready', abiVersion: 8, skillVersionsVersion: 1 })
parentPort.once('message', () => { parentPort.close() })
