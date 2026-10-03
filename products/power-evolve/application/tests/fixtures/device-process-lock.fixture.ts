/** OS-only fixture: plain Node erasable TypeScript, no Cordis profile or source-path resolver. */
import { DeviceProcessLock } from '../../src/device/process-lock.ts'

let held: DeviceProcessLock | undefined
try {
  held = await DeviceProcessLock.acquire(process.argv[2]!)
} catch (error: unknown) {
  const code = error instanceof Error && 'code' in error ? error.code : 'fixture_acquire_failed'
  process.send?.({ event: 'refused', code })
  process.disconnect?.()
  process.exitCode = 1
}

if (held) {
  const lock = held
  process.on('message', async message => {
    if (message !== 'release') return
    try {
      await lock.release()
      process.send?.({ event: 'released' })
    } catch {
      process.exitCode = 1
    } finally { process.disconnect?.() }
  })
  process.once('disconnect', () => { void lock.release().catch(() => { process.exitCode = 1 }) })
  process.send?.({ event: 'held' })
}
