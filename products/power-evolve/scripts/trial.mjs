/** Start and stop only the local trial processes named by their verified readiness records. */
import { spawn, spawnSync } from 'node:child_process'
import { openSync, closeSync } from 'node:fs'
import { readFile, mkdir, rm } from 'node:fs/promises'
import { join, resolve } from 'node:path'
import { fileURLToPath } from 'node:url'
import { homedir } from 'node:os'
import { setTimeout as delay } from 'node:timers/promises'
const root = resolve(fileURLToPath(new URL('../../..', import.meta.url)))
const trialName = process.env.PE_TRIAL_NAME ?? 'slice1'
if (!/^[a-z0-9-]{1,32}$/.test(trialName)) throw new Error('Invalid trial name')
const privateDir = process.env.PE_PRIVATE_DIR ?? join(homedir(), '.config/power-evolve', `shared-host-${trialName}`)
const output = join(root, '.artifacts/power-evolve', trialName === 'slice1' ? '' : trialName)
const env = { PATH: process.env.PATH, HOME: process.env.HOME, PE_PRIVATE_DIR: privateDir, PE_TRIAL_NAME: trialName,
  PE_DATABASE_PORT: process.env.PE_DATABASE_PORT, PE_HOST_PORT: process.env.PE_HOST_PORT,
  PE_PLATFORM_PORT: process.env.PE_PLATFORM_PORT, PE_TARGET_PORT: process.env.PE_TARGET_PORT }
const command = process.argv[2] ?? 'status'
const targets = ['api', 'platform', 'host']
const home = name => join(output, 'trial', name)
const readyPath = name => join(home(name), 'ready.json')
async function readReady(name) { try { return JSON.parse(await readFile(readyPath(name), 'utf8')) } catch (error) { if (error.code === 'ENOENT') return null; throw error } }
async function health(record) {
  if (!record) return null
  try { const response = await fetch(record.url+'/health', { signal: AbortSignal.timeout(2000) }); return response.ok ? response.json() : null }
  catch (_unreachable) { return null }
}
function alive(pid) { try { process.kill(pid, 0); return true } catch (error) { if (error.code === 'ESRCH') return false; throw error } }
async function stop(name) {
  const record = await readReady(name)
  if (!record) return
  if (!alive(record.pid)) { await rm(readyPath(name), { force:true }); return }
  const status = await health(record)
  if (!status || status.instanceId !== record.instanceId) throw new Error(`Refusing to signal an unverified ${name} process; inspect ${readyPath(name)}`)
  process.kill(record.pid, 'SIGTERM')
  const deadline = Date.now()+20000
  while (alive(record.pid) && Date.now()<deadline) await delay(100)
  if (alive(record.pid)) throw new Error(`${name} did not stop; process retained for inspection`)
  await rm(readyPath(name), { force:true })
}
async function start(name) {
  const previous = await readReady(name)
  if (previous && alive(previous.pid)) {
    const status = await health(previous)
    if (status?.instanceId === previous.instanceId) return
    throw new Error(`Existing ${name} record does not match its endpoint`)
  }
  await rm(readyPath(name), { force:true })
  const log = openSync(join(output, `${name}.log`), 'a', 0o600)
  const child = spawn(process.execPath, name === 'api'
    ? ['products/power-evolve/scripts/trial-api.mjs']
    : ['apps/cli/lib/bin.js', '--profile', `power-evolve-${name}`], {
    cwd:root, env:{...env, DSH_HOME:home(name), PE_READY_FILE:readyPath(name)}, detached:true, stdio:['ignore',log,log],
  })
  closeSync(log);child.unref()
  const deadline=Date.now()+20000
  while (Date.now()<deadline) {
    const record=await readReady(name)
    if (record?.pid===child.pid && (await health(record))?.instanceId===record.instanceId) return
    if (child.exitCode!==null || child.signalCode!==null) throw new Error(`${name} exited; inspect ${join(output,name+'.log')}`)
    await delay(100)
  }
  child.kill('SIGTERM')
  throw new Error(`${name} startup deadline exceeded; inspect its log`)
}
if (command === 'stop' || command === 'restart') for (const name of [...targets].reverse()) await stop(name)
if (command === 'up' || command === 'restart') {
  await mkdir(output, { recursive:true, mode:0o700 })
  const prepared=spawnSync(process.execPath,['products/power-evolve/scripts/prepare-trial.mjs'],{cwd:root,env,stdio:'inherit'})
  if (prepared.status!==0) throw new Error('Trial preparation failed')
  const database=spawnSync('docker',['compose','-p',`pe-shared-host-${trialName}`,'-f','products/power-evolve/compose.yaml','up','-d','--wait'],{cwd:root,env:{...process.env,PE_PRIVATE_DIR:privateDir},stdio:'inherit'})
  if (database.status!==0) throw new Error('Trial PostgreSQL startup failed')
  for (const name of targets) await start(name)
}
if (!['up','stop','restart','status'].includes(command)) throw new Error('Use up, stop, restart, or status')
for (const name of targets) {
  const record=await readReady(name),status=await health(record)
  console.log(`${name}: ${status?.ready ? record.url : 'stopped'}`)
}
