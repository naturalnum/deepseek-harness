/** Real Node pipe closure remains an owned relay failure and joins the original transport. */
import { spawn } from 'node:child_process'
import { setTimeout } from 'node:timers/promises'
import type { SubprocessHandle, SubprocessOutcome } from '@deepseek-ai/dsh-subprocess'
import { expect, test } from 'vitest'
import { NativeExecutionRelay } from '../src/platform/native-execution-relay.ts'

function transport(script: string) {
  const child = spawn(process.execPath, ['-e', script], { stdio: ['pipe', 'pipe', 'pipe'] })
  let terminations = 0
  const done = new Promise<SubprocessOutcome>((resolve, reject) => {
    child.once('error', reject)
    child.once('exit', (exitCode, signal) => { resolve({ exitCode, signal }) })
  })
  const exited = new Promise<boolean>((resolve) => { child.once('close', () => { resolve(true) }) })
  const handle: SubprocessHandle = { stdin: child.stdin, stdout: child.stdout, stderr: child.stderr,
    control: undefined, collected: {}, done, waitForExit: () => exited,
    terminate: () => { terminations++; child.kill('SIGTERM') } }
  return { child, handle, exited, terminations: () => terminations }
}

const closedPipe = String.raw`require('node:fs').closeSync(0);
process.stdout.write(JSON.stringify({kind:'ready',pid:process.pid})+'\n');
setInterval(()=>{},1000);`

for (const input of ['stdin', 'control', 'request'] as const) test(`real closed transport pipe retains ${input} failure and joins`, async () => {
  const local = transport(closedPipe)
  const relay = new NativeExecutionRelay(local.handle, { stdio: { stdin: 'pipe', stdout: 'pipe', stderr: 'pipe', control: 'pipe' } }, 4096)
  const completed = relay.done.then(() => undefined, (error: unknown) => error)
  try {
    await relay.ready
    const failure = input === 'request' ? await relay.write('owned input').then(() => undefined, (error: unknown) => error)
      : await new Promise<Error | null | undefined>((resolve) => {
        const stream = input === 'stdin' ? relay.stdin : relay.control
        if (!stream) throw new Error('Missing declared native input')
        // Intentionally no consumer error listener: the provider owns its underlying pipe failure.
        stream.write(Buffer.from('owned input'), resolve)
      })
    expect(failure).toMatchObject({ code: 'EPIPE' })
    const result = await Promise.race([completed, setTimeout(1000, 'transport did not join')])
    expect(result).toBe(failure)
    expect(await local.exited).toBe(true)
    expect(local.child.stdin.closed).toBe(true)
    expect(local.terminations()).toBe(1)
  } finally {
    local.child.kill('SIGKILL')
    await local.exited
    await completed
  }
})

test('normal real relay input preserves outcome and joins without terminating transport', async () => {
  const local = transport(String.raw`process.stdout.write(JSON.stringify({kind:'ready',pid:process.pid})+'\n');
require('node:readline').createInterface({input:process.stdin}).once('line',line=>{
const request=JSON.parse(line);
process.stdout.write(JSON.stringify({kind:'reply',id:request.id,ok:true})+'\n');
process.stdout.write(JSON.stringify({kind:'exit',exitCode:23,signal:null})+'\n',()=>process.exit(0));});`)
  const relay = new NativeExecutionRelay(local.handle, { stdio: { stdin: 'pipe', stdout: 'pipe', stderr: 'pipe' } }, 4096)
  const completed = relay.done
  try {
    await relay.write('normal input')
    expect(await completed).toEqual({ exitCode: 23, signal: null })
    expect(await local.exited).toBe(true)
    expect(local.terminations()).toBe(0)
  } finally {
    local.child.kill('SIGKILL')
    await local.exited
    await completed.catch(() => {})
  }
})
