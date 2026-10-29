import { spawn } from 'node:child_process'
import { fileURLToPath, pathToFileURL } from 'node:url'
import { describe, expect, it } from 'vitest'

const source = pathToFileURL(fileURLToPath(new URL('../src/process-shutdown.ts', import.meta.url))).href

/** Run an isolated synthetic process: it never connects to a profile or customer data. */
async function observe(mode: 'resolve' | 'reject' | 'timeout' | 'double'): Promise<number | null> {
  const script = `
    import { createProcessShutdown } from ${JSON.stringify(source)};
    const mode = ${JSON.stringify(mode)};
    const shutdown = createProcessShutdown(() => {
      process.stdout.write('DISPOSE\\n');
      if (mode === 'resolve') return Promise.resolve();
      if (mode === 'reject') return Promise.reject(new Error('synthetic failure'));
      return new Promise(() => {});
    }, undefined, undefined, mode === 'timeout' ? 50 : 2000);
    process.on('SIGTERM', () => shutdown.interrupt(0));
    setInterval(() => {}, 1000);
    process.stdout.write('READY\\n');
  `
  const child = spawn(process.execPath, ['--experimental-strip-types', '--input-type=module', '-e', script],
    { stdio: ['ignore', 'pipe', 'pipe'] })
  let output = '', errors = '', sent = false, sentSecond = false
  child.stderr.setEncoding('utf8')
  child.stderr.on('data', (value: string) => { errors += value })
  child.stdout.setEncoding('utf8')
  child.stdout.on('data', (value: string) => {
    output += value
    if (!sent && output.includes('READY\n')) { sent = true; child.kill('SIGTERM') }
    if (mode === 'double' && !sentSecond && output.includes('DISPOSE\n')) {
      sentSecond = true; child.kill('SIGTERM')
    }
  })
  return new Promise((resolve, reject) => {
    const timeout = setTimeout(() => { child.kill('SIGKILL'); reject(new Error('synthetic process timed out')) }, 5000)
    child.once('error', (error) => { clearTimeout(timeout); reject(error) })
    child.once('exit', (code, signal) => {
      clearTimeout(timeout)
      if (!sent || !output.includes('DISPOSE\n') || signal !== null) {
        reject(new Error(`synthetic shutdown did not finish: ${signal ?? code}; ${errors}`))
      } else resolve(code)
    })
  })
}

describe.skipIf(process.platform === 'win32')('process shutdown in a real subprocess', () => {
  it.each([['resolve', 0], ['reject', 1], ['timeout', 1], ['double', 1]] as const)(
    'reports %s as %i', async (mode, code) => { expect(await observe(mode)).toBe(code) },
  )
})
