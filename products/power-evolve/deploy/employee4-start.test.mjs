/** Real OS process regressions for deployment identity, reservation and exact-child shutdown. */
import assert from 'node:assert/strict'
import { spawn, spawnSync } from 'node:child_process'
import { randomUUID } from 'node:crypto'
import { once } from 'node:events'
import { chmod, lstat, mkdtemp, mkdir, readFile, rename, rm, symlink, writeFile } from 'node:fs/promises'
import { createServer } from 'node:http'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { fileURLToPath } from 'node:url'
import { test } from 'node:test'
import { load, JSON_SCHEMA, Type } from 'js-yaml'
import { nativeDockerCoverageArguments } from '../scripts/cloud-coverage.mjs'
import { deployment, launch, renderProfile } from './start.mjs'
import { durableJson, durableText, privateDirectory, privateJson, processIdentity, reserveProfile, superviseChild } from './lifecycle.mjs'

const supervisor = fileURLToPath(new URL('./lifecycle.mjs', import.meta.url))
const patchSchema = JSON_SCHEMA.extend(new Type('tag:yaml.org,2002:js', {
  kind: 'scalar', construct: value => ({ __jsExpr: value }),
}))
async function patchRows(path) { return load(await readFile(path, 'utf8'), { schema: patchSchema }) }
async function fixture(t) {
  const root = await mkdtemp(join(tmpdir(), 'pe-employee4-start-'))
  t.after(() => rm(root, { recursive: true, force: true }))
  const config = { mode: 'local-http', privateDir: join(root, 'private'), dshHome: join(root, 'dsh'),
    hostOrigin: 'http://127.0.0.1:18880', platformOrigin: 'http://127.0.0.1:18881',
    platformInternalUrl: 'http://127.0.0.1:18881', rows: {} }
  return { root, config, directory: join(config.dshHome, 'profiles/power-evolve-cloud-host') }
}
async function observed(check) {
  const deadline = Date.now() + 10000
  for (;;) {
    if (await check()) return
    if (Date.now() >= deadline) throw new Error('Owned fixture state was not observed')
    await new Promise(resolve => setTimeout(resolve, 10))
  }
}
function ownChild(t, args, limitDescriptors = false, env = process.env) {
  const executable = limitDescriptors ? '/usr/bin/python3' : process.execPath
  const argv = limitDescriptors ? ['-I', '-B', '-c',
    'import os,resource,sys;resource.setrlimit(resource.RLIMIT_NOFILE,(64,64));os.execv(sys.argv[1],sys.argv[1:])', process.execPath, ...args] : args
  const child = spawn(executable, argv, { stdio: ['pipe', 'pipe', 'pipe'], env })
  const done = once(child, 'close').then(([code, signal]) => ({ code, signal }))
  let output = ''
  child.stdout.on('data', (data) => { output += data })
  child.stderr.on('data', (data) => { output += data })
  t.after(async () => { if (child.exitCode === null && child.signalCode === null) child.kill('SIGKILL'); await done })
  return { child, done, output: () => output }
}

test('deployment rejects noncanonical paths and unrelated override roles', () => {
  assert.throws(() => deployment({ mode: 'local-http', privateDir: '/', dshHome: '/tmp/dsh', rows: {} }))
})
test('public origins and override rows reject unsupported deployment input before rendering', async (t) => {
  const { config } = await fixture(t)
  for (const changed of [
    { mode: 'https', hostOrigin: 'http://public.example' },
    { hostOrigin: 'http://public.example' },
    { hostOrigin: config.platformOrigin },
    { platformOrigin: 'http://localhost:18881' },
    { platformInternalUrl: 'ftp://127.0.0.1' },
    { rows: { unrelated: {} } },
    { rows: { host: { INVALID: {} } } },
    { rows: { host: { valid: [] } } },
  ]) assert.throws(() => deployment({ ...config, ...changed }))
  await assert.rejects(renderProfile('unrelated', config), /supported cloud Profile role/u)
  await assert.rejects(launch('unrelated', config), /supported cloud Profile role/u)
})
test('private metadata refuses public files, directories, malformed JSON and symlink aliases', async (t) => {
  const { root } = await fixture(t), file = join(root, 'metadata.json')
  await writeFile(file, '{}', { mode: 0o644 })
  await chmod(file, 0o644)
  await assert.rejects(privateJson(file), /private regular/u)
  await chmod(file, 0o600); await writeFile(file, '{')
  await assert.rejects(privateJson(file), SyntaxError)
  await mkdir(join(root, 'directory'), { mode: 0o700 })
  await assert.rejects(privateJson(join(root, 'directory')), /private regular/u)
  await symlink(file, join(root, 'alias'))
  await assert.rejects(privateJson(join(root, 'alias')), /ELOOP/u)
  await assert.rejects(privateDirectory(join(root, 'alias')), /EEXIST/u)
  await chmod(join(root, 'directory'), 0o755)
  await assert.rejects(privateDirectory(join(root, 'directory')), /private and real/u)
  await assert.rejects(processIdentity(0), /Invalid process identity/u)
})
test('private text and JSON retain atomic replacement bytes and private permissions', async (t) => {
  const { root } = await fixture(t), path = join(root, 'metadata')
  await writeFile(path, 'prior public bytes', { mode: 0o644 })
  await durableText(path, '- config: !!js process.env.PRIVATE_FIXTURE\n')
  assert.equal(await readFile(path, 'utf8'), '- config: !!js process.env.PRIVATE_FIXTURE\n')
  assert.equal((await lstat(path)).mode & 0o777, 0o600)
  await durableJson(path, { phase: 'stopped' })
  assert.equal(await readFile(path, 'utf8'), '{"phase":"stopped"}\n')
  assert.deepEqual(await privateJson(path), { phase: 'stopped' })
})
test('default Host expressions stay YAML scalars until the original Loader activates the real Profile', { timeout: 45000 }, async (t) => {
  const { root, config, directory } = await fixture(t), worker = randomUUID()
  let credentialsMatched = true
  const platform = createServer((req, res) => {
    credentialsMatched &&= req.headers.authorization === `Bearer ${worker}`
    req.resume()
    res.writeHead(200, { 'content-type': 'application/json' }); res.end('null')
  })
  t.after(() => new Promise((resolve, reject) => {
    platform.close(error => error ? reject(error) : resolve())
    platform.closeAllConnections()
  }))
  await new Promise((resolve, reject) => { platform.once('error', reject); platform.listen(0, '127.0.0.1', resolve) })
  config.platformInternalUrl = `http://127.0.0.1:${platform.address().port}`
  config.rows.host = { 'web-server': { port: 0 } }
  await mkdir(config.privateDir, { mode: 0o700 })
  await writeFile(join(config.privateDir, 'worker-token'), worker, { mode: 0o600 })
  const profile = await renderProfile('host', config), patchFile = join(directory, 'cordis.patch.yml')
  const rows = await patchRows(patchFile), host = rows.find(row => row.id === 'power-evolve-host')
  const input = join(root, 'deployment.json')
  await durableJson(input, config)
  const child = ownChild(t, [fileURLToPath(new URL('./start.mjs', import.meta.url)), 'host', input], false,
    { ...process.env, PE_NATIVE_SHELL_ENABLED: '0', PE_OFFICE_PREVIEW_ENABLED: '0' })
  try {
    await observed(async () => {
      assert.equal(child.child.exitCode, null, 'Default Host exited before readiness')
      return !!await privateJson(profile.readyFile)
    })
    const ready = await privateJson(profile.readyFile)
    const response = await fetch(ready.url + '/health')
    assert.equal(response.status, 200)
    assert.equal((await response.json()).service, 'host')
    assert.deepEqual(host.config.operationTimeoutMs, { __jsExpr: "process.env.PE_NATIVE_SHELL_ENABLED === '1' ? 600000 : 150000" })
    assert.match(await readFile(patchFile, 'utf8'), /operationTimeoutMs: !!js/u)
    assert.equal((await lstat(patchFile)).mode & 0o777, 0o600)
    assert.equal(credentialsMatched, true)
    child.child.kill('SIGTERM')
    assert.deepEqual(await child.done, { code: 0, signal: null })
    const stopped = await privateJson(join(directory, 'lifecycle.json'))
    assert.equal(stopped.phase, 'stopped')
    assert.equal(stopped.child.pid, ready.pid)
    assert.equal(await privateJson(join(directory + '.lifecycle-lock', 'instance.json')), null)
  } catch (error) {
    const diagnostics = join(process.env.PE_IMAGE_EVIDENCE_DIR ?? tmpdir(), `employee4-default-host-${randomUUID()}-private.log`)
    await writeFile(diagnostics, child.output(), { mode: 0o600, flag: 'wx' })
    throw new Error('Default Host Profile failed; private diagnostics: ' + diagnostics, { cause: error })
  } finally {
    if (child.child.exitCode === null && child.child.signalCode === null) child.child.kill('SIGTERM')
    await child.done
  }
})
test('reservation replacement cannot release the new owner or erase its record', async (t) => {
  const { directory } = await fixture(t), lock = await reserveProfile(directory, { role: 'host' })
  const path = join(directory + '.lifecycle-lock', 'instance.json')
  await durableJson(path, { ...lock.record, token: randomUUID() })
  await assert.rejects(lock.release(), /identity changed/u)
  assert.notEqual((await privateJson(path)).token, lock.record.token)
})
test('unowned nonempty Profile is rejected without changing its bytes', async (t) => {
  const { config, directory } = await fixture(t)
  await mkdir(directory, { recursive: true, mode: 0o700 })
  await writeFile(join(directory, 'unrelated'), 'owned elsewhere')
  await assert.rejects(renderProfile('host', config), /unowned/u)
  await assert.rejects(launch('host', config), /unowned/u)
  assert.equal(await privateJson(join(directory + '.lifecycle-lock', 'instance.json')), null)
  assert.equal(await readFile(join(directory, 'unrelated'), 'utf8'), 'owned elsewhere')
})
test('another deployment config cannot rewrite the same Profile', async (t) => {
  const { config } = await fixture(t), profile = await renderProfile('host', config)
  const before = await readFile(join(profile.directory, 'cordis.patch.yml'))
  await assert.rejects(renderProfile('host', { ...config, privateDir: config.privateDir + '-other' }), /another deployment/u)
  assert.deepEqual(await readFile(join(profile.directory, 'cordis.patch.yml')), before)
})
test('tenant Profile preserves native configuration while launch identity changes by generation', async (t) => {
  const { config } = await fixture(t), userId = randomUUID(), firstRuntimeId = randomUUID()
  const native = { ...config, runtimeIdentity: { userId, runtimeId: firstRuntimeId, generation: 1 },
    rows: { 'native-runtime': { 'power-evolve-runtime': { runtimeUserId: userId, workerId: firstRuntimeId,
      runtimeTokenFile: '/runtime/private/runtime-token', workerTokenFile: '' },
    webserver: { host: '0.0.0.0', port: 8080 } } } }
  const first = await renderProfile('native-runtime', native)
  const packageFile = join(first.directory, 'package.json'), patchFile = join(first.directory, 'cordis.patch.yml')
  const manifest = JSON.parse(await readFile(packageFile, 'utf8'))
  assert.deepEqual(manifest.dsh.profile.bundles, ['@deepseek-ai/dsh-base', '@deepseek-ai/dsh-web-app', '@power-evolve/native-runtime'])
  manifest.dependencies['user-native-plugin'] = '1.0.0'
  await durableJson(packageFile, manifest)
  const patches = await patchRows(patchFile)
  patches.push({ id: 'sandbox-policy', config: { mode: 'read-only', workspaceRoot: '/workspace' } },
    { id: 'native-custom-settings', config: { expression: { __jsExpr: '1 + 2' }, chosenPreset: 'minimal' } })
  await durableJson(patchFile, patches)
  await durableJson(join(first.lifecycleDirectory, 'lifecycle.json'), { phase: 'running', child: { pid: process.pid, birth: 'former-pod' } })
  const secondRuntimeId = randomUUID()
  const second = await renderProfile('native-runtime', { ...native,
    runtimeIdentity: { userId, runtimeId: secondRuntimeId, generation: 2 },
    rows: { 'native-runtime': { ...native.rows['native-runtime'],
      'power-evolve-runtime': { ...native.rows['native-runtime']['power-evolve-runtime'], workerId: secondRuntimeId } } } })
  assert.equal(second.directory, first.directory)
  assert.notEqual(second.lifecycleDirectory, first.lifecycleDirectory)
  assert.equal(JSON.parse(await readFile(packageFile, 'utf8')).dependencies['user-native-plugin'], '1.0.0')
  const retained = await patchRows(patchFile)
  assert.deepEqual(retained.find(row => row.id === 'sandbox-policy').config, { mode: 'read-only', workspaceRoot: '/workspace' })
  assert.deepEqual(retained.find(row => row.id === 'native-custom-settings').config,
    { expression: { __jsExpr: '1 + 2' }, chosenPreset: 'minimal' })
  assert.equal(retained.findLast(row => row.id === 'power-evolve-runtime').config.workerId, secondRuntimeId)
  assert.equal(JSON.parse(await readFile(join(first.lifecycleDirectory, 'lifecycle.json'), 'utf8')).phase, 'running')
  const before = await readFile(patchFile)
  await assert.rejects(renderProfile('native-runtime', { ...native,
    runtimeIdentity: { userId: randomUUID(), runtimeId: randomUUID(), generation: 1 } }), /another deployment/u)
  assert.deepEqual(await readFile(patchFile), before)
})
test('native runtime role refuses missing or malformed account process identity', async (t) => {
  const { config } = await fixture(t)
  await assert.rejects(renderProfile('native-runtime', config), /account process identity/u)
  for (const runtimeIdentity of [null, {}, { userId: randomUUID(), runtimeId: randomUUID(), generation: 0 },
    { userId: randomUUID(), runtimeId: 'not-a-process', generation: 1 }]) {
    assert.throws(() => deployment({ ...config, runtimeIdentity }), /native runtime process identity/u)
  }
})
test('old ready file without stop identity cannot be overwritten', async (t) => {
  const { config } = await fixture(t), profile = await renderProfile('host', config)
  await writeFile(profile.readyFile, JSON.stringify({ pid: process.pid }), { mode: 0o600 })
  await assert.rejects(renderProfile('host', config), /no exact stop evidence/u)
  assert.equal(JSON.parse(await readFile(profile.readyFile, 'utf8')).pid, process.pid)
})
test('persistent uncertain reservation refuses render without signaling a reused PID', async (t) => {
  const { config, directory } = await fixture(t)
  const lock = await reserveProfile(directory, { role: 'host' })
  await lock.save({ parent: { pid: process.pid, birth: 'old-incarnation' }, phase: 'running' })
  await assert.rejects(renderProfile('host', config), /reserved/u)
  assert.ok(await processIdentity(process.pid))
  await lock.release()
})
test('stopped record with a reused active PID is refused', async (t) => {
  const { config } = await fixture(t), profile = await renderProfile('host', config)
  const owner = await privateJson(join(profile.directory, 'power-evolve-owner.json'))
  await durableJson(join(profile.directory, 'lifecycle.json'), { owner, phase: 'stopped', exit: { code: 0, signal: null }, child: { pid: process.pid, birth: 'reused' } })
  await assert.rejects(renderProfile('host', config), /reused PID/u)
})
test('uncertain lifecycle evidence cannot render another Profile', async (t) => {
  const { config } = await fixture(t), profile = await renderProfile('host', config)
  const owner = await privateJson(join(profile.directory, 'power-evolve-owner.json'))
  await durableJson(join(profile.directory, 'lifecycle.json'), { owner, phase: 'running' })
  await assert.rejects(renderProfile('host', config), /uncertain/u)
})
test('a stopped owned incarnation removes only its stale ready file before rerender', async (t) => {
  const { root, config } = await fixture(t), profile = await renderProfile('host', config)
  const owner = await privateJson(join(profile.directory, 'power-evolve-owner.json'))
  const child = ownChild(t, ['-e', "console.log('ready');process.stdin.once('data',()=>process.exit(0))"])
  await observed(() => child.output().includes('ready'))
  const identity = await processIdentity(child.child.pid)
  child.child.stdin.write('exit\n')
  assert.deepEqual(await child.done, { code: 0, signal: null })
  await durableJson(join(profile.directory, 'lifecycle.json'), { owner, phase: 'stopped', exit: { code: 0, signal: null }, child: identity })
  await writeFile(profile.readyFile, '{}', { mode: 0o600 })
  await writeFile(join(root, 'unrelated-ready.json'), 'preserved', { mode: 0o600 })
  await renderProfile('host', config)
  assert.equal(await privateJson(profile.readyFile), null)
  assert.equal(await readFile(join(root, 'unrelated-ready.json'), 'utf8'), 'preserved')
})

test('a changed bundle symlink cannot redirect Profile dependencies', async (t) => {
  const { root, config } = await fixture(t), profile = await renderProfile('host', config)
  const link = join(profile.directory, 'node_modules/@power-evolve/host')
  await rm(link); await symlink(root, link)
  await assert.rejects(renderProfile('host', config), /EEXIST/u)
  assert.equal(await privateJson(join(root, 'package.json')), null)
})
test('unknown bundle rows fail before creating an owner marker', async (t) => {
  const { config, directory } = await fixture(t)
  await assert.rejects(renderProfile('host', { ...config, rows: { host: { 'wrong-row': {} } } }), /Unknown bundle row/u)
  assert.equal(await privateJson(join(directory, 'power-evolve-owner.json')), null)
})

test('metadata failure waits for its exact child and preserves an uncertain reservation', async (t) => {
  const { root, directory } = await fixture(t)
  const lock = await reserveProfile(directory, { role: 'host' })
  const child = spawn(process.execPath, ['-e', 'setInterval(()=>{},1000)'], { stdio: 'ignore' })
  const done = once(child, 'close')
  t.after(async () => { if (child.exitCode === null && child.signalCode === null) child.kill('SIGKILL'); await done })
  await assert.rejects(superviseChild(child, lock, join(root, 'absent-parent/lifecycle.json')), /ENOENT/u)
  assert.equal(await processIdentity(child.pid), null)
  const record = await privateJson(join(directory + '.lifecycle-lock', 'instance.json'))
  assert.equal(record.phase, 'running')
  assert.equal(record.child.pid, child.pid)
  await lock.release()
})

test('real descriptor exhaustion refuses process inspection and records a failed exact-child signal', async (t) => {
  const { root, directory } = await fixture(t), lifecycleFile = join(root, 'lifecycle.json')
  const program = `import assert from 'node:assert/strict';import {spawn} from 'node:child_process';import {once} from 'node:events';
    import{openSync,closeSync,writeFileSync}from'node:fs';import{reserveProfile,superviseChild,processIdentity,privateJson}from ${JSON.stringify('file://' + supervisor)};
    const lock=await reserveProfile(${JSON.stringify(directory)},{role:'host'}),fds=[];
    const file=${JSON.stringify(join(root, 'descriptor-owner'))};writeFileSync(file,'owned');
    const child=spawn(process.execPath,['-e',"process.on('SIGTERM',()=>console.log('unexpected-term'));console.log('ready');process.stdin.once('data',()=>process.exit(0));setInterval(()=>{},1000)"],{stdio:['pipe','pipe','pipe']});
    const closed=new Promise(resolve=>child.once('close',(code,signal)=>resolve({code,signal})));let childTerm=false;
    child.stdout.on('data',bytes=>{childTerm ||= bytes.toString().includes('unexpected-term')});
    try{await once(child.stdout,'data');const supervising=superviseChild(child,lock,${JSON.stringify(lifecycleFile)}).then(()=>{throw new Error('Expected real inspection failure')},error=>error);
      const deadline=Date.now()+10000;while((await privateJson(${JSON.stringify(lifecycleFile)}))?.phase!=='running'){assert.ok(Date.now()<deadline);await new Promise(resolve=>setTimeout(resolve,10))}
      // Allow the observed rename's directory fsync to complete; the assertions below prove the actual failure path.
      await new Promise(resolve=>setTimeout(resolve,100));
      let exhaustion;for(;;){try{fds.push(openSync(file,'r'))}catch(error){exhaustion=error;break}}assert.equal(exhaustion.code,'EMFILE');
      await assert.rejects(processIdentity(process.pid),error=>error.code==='EMFILE'||error.message==='Cannot establish process birth');
      const requested=once(process,'SIGTERM');process.kill(process.pid,'SIGTERM');await requested;
      await assert.rejects(processIdentity(child.pid),error=>error.code==='EMFILE'||error.message==='Cannot establish process birth');
      await new Promise(setImmediate);for(const fd of fds.splice(0))closeSync(fd);child.stdin.write('exit');
      const failure=await supervising;assert.match(failure.message,/DSH Profile failed/);assert.ok(failure.cause);assert.match(failure.cause.message,/Cannot establish process birth|EMFILE/);
      const exit=await closed;assert.deepEqual(exit,{code:0,signal:null});assert.equal(childTerm,false);
      const stopped=await privateJson(${JSON.stringify(lifecycleFile)});assert.equal(stopped.phase,'stopped');assert.equal(stopped.requestedSignal,'SIGTERM');
      assert.equal(await privateJson(${JSON.stringify(join(directory + '.lifecycle-lock', 'instance.json'))}),null);
      console.log(JSON.stringify({descriptorFailure:'EMFILE',signalRefused:true,childClosed:true,durableStop:true}));
    }finally{for(const fd of fds)closeSync(fd);if(child.exitCode===null&&child.signalCode===null)child.kill('SIGKILL');await closed}`
  const parent = ownChild(t, ['--input-type=module', '--eval', program], true)
  assert.deepEqual(await parent.done, { code: 0, signal: null }, parent.output())
  assert.deepEqual(JSON.parse(parent.output()), { descriptorFailure: 'EMFILE', signalRefused: true, childClosed: true, durableStop: true })
})

test('shutdown requested during running-record publication is queued until exact-child initialization', async (t) => {
  const { root, directory } = await fixture(t), lifecycleFile = join(root, 'lifecycle.json')
  const program = `import{spawn}from'node:child_process';import{once}from'node:events';import{reserveProfile,superviseChild}from ${JSON.stringify('file://' + supervisor)};
    const lock=await reserveProfile(${JSON.stringify(directory)},{role:'host'}),save=lock.save.bind(lock);
    lock.save=async fields=>{await save(fields);if(fields.phase==='running'){const received=once(process,'SIGTERM');process.kill(process.pid,'SIGTERM');await received}};
    const child=spawn(process.execPath,['-e',"process.on('SIGTERM',()=>console.log('child-stopping'));process.on('SIGINT',()=>console.log('unexpected-int'));console.log('child-ready');process.stdin.once('data',()=>process.exit(0));setInterval(()=>{},1000)"],{stdio:['pipe','pipe','pipe']});
    const closed=new Promise(resolve=>child.once('close',resolve));child.stdout.pipe(process.stdout);child.stderr.pipe(process.stderr);process.stdin.pipe(child.stdin);
    process.on('SIGINT',()=>console.log('second-signal-received'));
    try{await once(child.stdout,'data');await superviseChild(child,lock,${JSON.stringify(lifecycleFile)});}
    finally{if(child.exitCode===null&&child.signalCode===null)child.kill('SIGKILL');await closed;process.stdin.unpipe(child.stdin);process.stdin.pause()}`
  const parent = ownChild(t, ['--input-type=module', '--eval', program])
  await observed(() => parent.output().includes('child-stopping'))
  parent.child.kill('SIGINT')
  await observed(() => parent.output().includes('second-signal-received'))
  parent.child.stdin.write('exit\n')
  assert.deepEqual(await parent.done, { code: 0, signal: null }, parent.output())
  assert.equal(parent.output().includes('unexpected-int'), false)
  const stopped = await privateJson(lifecycleFile)
  assert.equal(stopped.phase, 'stopped'); assert.equal(stopped.requestedSignal, 'SIGTERM')
  assert.deepEqual(stopped.exit, { code: 0, signal: null })
})

test('descriptor exhaustion during metadata publication waits for exact child close and retains uncertainty', async (t) => {
  const { root, directory } = await fixture(t), lifecycleFile = join(root, 'lifecycle.json')
  const program = `import assert from 'node:assert/strict';import{spawn}from'node:child_process';import{once}from'node:events';import{openSync,closeSync}from'node:fs';
    import{reserveProfile,superviseChild,privateJson,processIdentity}from ${JSON.stringify('file://' + supervisor)};
    const lock=await reserveProfile(${JSON.stringify(directory)},{role:'host'}),save=lock.save.bind(lock),fds=[];
    const child=spawn(process.execPath,['-e',"process.on('SIGTERM',()=>console.log('unexpected-term'));console.log('ready');process.stdin.once('data',()=>process.exit(0));setInterval(()=>{},1000)"],{stdio:['pipe','pipe','pipe']});
    const closed=new Promise(resolve=>child.once('close',(code,signal)=>resolve({code,signal})));let childTerm=false,timer;
    child.stdout.on('data',bytes=>{childTerm ||= bytes.toString().includes('unexpected-term')});
    lock.save=async fields=>{await save(fields);if(fields.phase==='running'){
      let exhaustion;for(;;){try{fds.push(openSync('/dev/null','r'))}catch(error){exhaustion=error;break}}assert.equal(exhaustion.code,'EMFILE');
      await assert.rejects(processIdentity(child.pid),error=>error.code==='EMFILE'||error.message==='Cannot establish process birth');
      timer=setTimeout(()=>{for(const fd of fds.splice(0))closeSync(fd);child.stdin.write('exit')},100)}};
    try{await once(child.stdout,'data');await assert.rejects(superviseChild(child,lock,${JSON.stringify(lifecycleFile)}),{code:'EMFILE'});
      assert.deepEqual(await closed,{code:0,signal:null});assert.equal(childTerm,false);assert.equal(await privateJson(${JSON.stringify(lifecycleFile)}),null);
      assert.equal((await privateJson(${JSON.stringify(join(directory + '.lifecycle-lock', 'instance.json'))})).phase,'running');
      await lock.release();console.log(JSON.stringify({metadataFailure:'EMFILE',childClosed:true,uncertainReservationRetained:true}));
    }finally{clearTimeout(timer);for(const fd of fds)closeSync(fd);if(child.exitCode===null&&child.signalCode===null)child.kill('SIGKILL');await closed}`
  const parent = ownChild(t, ['--input-type=module', '--eval', program], true)
  assert.deepEqual(await parent.done, { code: 0, signal: null }, parent.output())
  assert.deepEqual(JSON.parse(parent.output()), { metadataFailure: 'EMFILE', childClosed: true, uncertainReservationRetained: true })
})

for (const failedFile of ['lifecycle', 'reservation']) {
  test(`failed durable ${failedFile} stop write retains the reservation after exact child exit`, async (t) => {
    const { root, config, directory } = await fixture(t), lifecycleFile = join(root, 'lifecycle.json')
    const program = `import {spawn} from 'node:child_process';import {reserveProfile,superviseChild} from ${JSON.stringify('file://' + supervisor)};
      const lock=await reserveProfile(${JSON.stringify(directory)},{role:'host'});
      const child=spawn(process.execPath,['-e',"console.log('child-ready');process.stdin.once('data',()=>process.exit(0));setInterval(()=>{},1000)"],{stdio:'inherit'});
      await superviseChild(child,lock,${JSON.stringify(lifecycleFile)});`
    const parent = ownChild(t, ['--input-type=module', '--eval', program])
    await observed(async () => parent.output().includes('child-ready') && (await privateJson(lifecycleFile))?.phase === 'running')
    const active = await privateJson(lifecycleFile)
    const blocked = failedFile === 'lifecycle' ? lifecycleFile : join(directory + '.lifecycle-lock', 'instance.json')
    await rename(blocked, blocked + '.original'); await mkdir(blocked, { mode: 0o700 })
    parent.child.stdin.write('exit\n')
    assert.deepEqual(await parent.done, { code: 1, signal: null })
    assert.equal(await processIdentity(active.child.pid), null)
    assert.equal((await privateJson(blocked + '.original')).phase, 'running')
    if (failedFile === 'reservation') assert.equal((await privateJson(lifecycleFile)).phase, 'stopped')
    await assert.rejects(renderProfile('host', config), /reserved/u)
  })
}

test('SIGINT forwards to the exact child and persists its matching signal exit', async (t) => {
  const { root, directory } = await fixture(t), lifecycleFile = join(root, 'lifecycle.json')
  const program = `import {spawn} from 'node:child_process';import {reserveProfile,superviseChild} from ${JSON.stringify('file://' + supervisor)};
    const lock=await reserveProfile(${JSON.stringify(directory)},{role:'host'});
    const child=spawn(process.execPath,['-e',"console.log('child-ready');setInterval(()=>{},1000)"],{stdio:'inherit'});
    await superviseChild(child,lock,${JSON.stringify(lifecycleFile)});`
  const parent = ownChild(t, ['--input-type=module', '--eval', program])
  await observed(async () => parent.output().includes('child-ready') && (await privateJson(lifecycleFile))?.phase === 'running')
  parent.child.kill('SIGINT')
  assert.deepEqual(await parent.done, { code: 0, signal: null })
  const stopped = await privateJson(lifecycleFile)
  assert.equal(stopped.requestedSignal, 'SIGINT')
  assert.deepEqual(stopped.exit, { code: null, signal: 'SIGINT' })
  assert.equal(await processIdentity(stopped.child.pid), null)
  assert.equal(await privateJson(join(directory + '.lifecycle-lock', 'instance.json')), null)
})

test('spawn failure saves its observed close and releases only after durable stop', async (t) => {
  const { root, directory } = await fixture(t), lock = await reserveProfile(directory, { role: 'host' })
  const child = spawn(join(root, 'absent-executable'), [], { stdio: 'ignore' })
  await assert.rejects(superviseChild(child, lock, join(root, 'lifecycle.json')), /Profile failed/u)
  const stopped = await privateJson(join(root, 'lifecycle.json'))
  assert.equal(stopped.phase, 'stopped'); assert.equal(stopped.child, null)
  assert.notEqual(stopped.exit.code, 0)
  assert.equal(await privateJson(join(directory + '.lifecycle-lock', 'instance.json')), null)
})

test('Linux process identity matches real proc birth and disappears after owned child close', { timeout: 60000 }, (t) => {
  const name = `pe-employee4-linux-${randomUUID()}`
  const program = `import assert from 'node:assert/strict';import{spawn}from'node:child_process';import{once}from'node:events';import{readFile}from'node:fs/promises';import{processIdentity}from ${JSON.stringify('file://' + supervisor)};
    assert.equal(process.platform,'linux');
    const child=spawn(process.execPath,['-e',"process.title='pe4) proc';console.log('ready');setInterval(()=>{},1000)"],{stdio:['ignore','pipe','ignore']});
    const closed=once(child,'close');
    try{await once(child.stdout,'data');const identity=await processIdentity(child.pid);
      const stat=await readFile('/proc/'+child.pid+'/stat','utf8');const boot=(await readFile('/proc/sys/kernel/random/boot_id','utf8')).trim();
      const ticks=stat.match(/\\) [A-Z] (?:\\S+ ){18}(\\d+)/)[1];assert.deepEqual(identity,{pid:child.pid,birth:boot+':'+ticks});
      assert.deepEqual(await processIdentity(child.pid),identity);child.kill('SIGTERM');assert.deepEqual(await closed,[null,'SIGTERM']);
      assert.equal(await processIdentity(child.pid),null);
      const{openSync,closeSync}=await import('node:fs'),fds=[];let exhaustion;
      try{for(;;){try{fds.push(openSync('/dev/null','r'))}catch(error){exhaustion=error;break}}assert.equal(exhaustion.code,'EMFILE');
        await assert.rejects(processIdentity(process.pid),{code:'EMFILE'});
      }finally{for(const fd of fds)closeSync(fd)}
      console.log(JSON.stringify({platform:process.platform,birthVerified:true,childClosed:true,descriptorFailure:'EMFILE'}));
    }finally{if(child.exitCode===null&&child.signalCode===null)child.kill('SIGKILL');await closed}`
  const coverage = process.env.NODE_V8_COVERAGE
  const coverageMount = process.env.PE_CLOUD_COVERAGE_INPUT
    ? nativeDockerCoverageArguments(process.env.PE_CLOUD_COVERAGE_INPUT)
    : coverage ? ['--env', `NODE_V8_COVERAGE=${coverage}`, '--mount', `type=bind,source=${coverage},target=${coverage}`] : []
  const created = spawnSync('docker', ['create', '--name', name, '--network', 'none', '--ulimit', 'nofile=64:64', '--mount',
    `type=bind,source=${supervisor},target=${supervisor},readonly`, ...coverageMount, 'node:22.23.2-bookworm-slim',
    'node', '--input-type=module', '--eval', program], { encoding: 'utf8', timeout: 30000 })
  assert.equal(created.error, undefined); assert.equal(created.signal, null); assert.equal(created.status, 0, created.stderr)
  const id = created.stdout.trim()
  t.after(() => {
    const removed = spawnSync('docker', ['rm', '--force', id], { encoding: 'utf8', timeout: 30000 })
    assert.equal(removed.status, 0, removed.stderr)
  })
  const run = spawnSync('docker', ['start', '--attach', id], { encoding: 'utf8', timeout: 30000 })
  assert.equal(run.error, undefined); assert.equal(run.signal, null); assert.equal(run.status, 0, run.stderr)
  assert.deepEqual(JSON.parse(run.stdout.trim()), { platform: 'linux', birthVerified: true, childClosed: true, descriptorFailure: 'EMFILE' })
  const state = spawnSync('docker', ['inspect', '--format', '{{.State.Running}} {{.State.ExitCode}}', id], { encoding: 'utf8', timeout: 30000 })
  assert.equal(state.status, 0); assert.equal(state.stdout.trim(), 'false 0')
})

for (const outcome of ['clean', 'nonzero', 'wrong-signal']) {
  test(`exact child shutdown waits for exit and classifies ${outcome}`, async (t) => {
    const { root, config, directory } = await fixture(t)
    const nativeProgram = `process.on('SIGTERM',()=>{console.log('child-stopping');process.stdin.once('data',()=>process.exit(${outcome === 'nonzero' ? 7 : 0}))});console.log('child-ready');setInterval(()=>{},1000)`
    const program = `import {spawn} from 'node:child_process';import {reserveProfile,superviseChild} from ${JSON.stringify('file://' + supervisor)};
      const lock=await reserveProfile(${JSON.stringify(directory)},{role:'host'});
      const child=spawn(process.execPath,['-e',${JSON.stringify(nativeProgram)}],{stdio:'inherit'});
      await superviseChild(child,lock,${JSON.stringify(join(root, 'lifecycle.json'))});`
    const processFixture = ownChild(t, ['--input-type=module', '--eval', program])
    await observed(async () => processFixture.output().includes('child-ready') && (await privateJson(join(directory + '.lifecycle-lock', 'instance.json')))?.phase === 'running')
    const active = await privateJson(join(directory + '.lifecycle-lock', 'instance.json'))
    await assert.rejects(renderProfile('host', config), /reserved/u)
    processFixture.child.kill('SIGTERM')
    await observed(() => processFixture.output().includes('child-stopping'))
    assert.equal((await privateJson(join(directory + '.lifecycle-lock', 'instance.json'))).phase, 'running')
    if (outcome === 'wrong-signal') process.kill(active.child.pid, 'SIGKILL')
    else processFixture.child.stdin.write('exit\n')
    const exit = await processFixture.done
    assert.equal(exit.signal, null)
    assert.equal(exit.code, outcome === 'clean' ? 0 : 1)
    const evidence = await privateJson(join(root, 'lifecycle.json'))
    assert.equal(evidence.phase, 'stopped')
    assert.equal(evidence.requestedSignal, 'SIGTERM')
    assert.deepEqual(evidence.child, active.child)
    assert.deepEqual(evidence.exit, outcome === 'wrong-signal' ? { code: null, signal: 'SIGKILL' } : { code: outcome === 'nonzero' ? 7 : 0, signal: null })
    assert.equal(await privateJson(join(directory + '.lifecycle-lock', 'instance.json')), null)
    assert.equal(await processIdentity(active.child.pid), null)
  })
}

test('independent render CLI loses to an existing cross-process reservation', async (t) => {
  const { root, config, directory } = await fixture(t)
  const program = `import{reserveProfile}from ${JSON.stringify('file://' + supervisor)};const lock=await reserveProfile(${JSON.stringify(directory)},{role:'host'});console.log('reserved');process.stdin.once('data',async()=>{await lock.release();process.exit(0)});`
  const holder = ownChild(t, ['--input-type=module', '--eval', program])
  await observed(() => holder.output().includes('reserved'))
  const path = join(root, 'deployment.json')
  await writeFile(path, JSON.stringify(config), { mode: 0o600 })
  const contender = ownChild(t, [fileURLToPath(new URL('./start.mjs', import.meta.url)), 'host', path, '--render'])
  assert.deepEqual(await contender.done, { code: 1, signal: null })
  assert.match(contender.output(), /reserved/u)
  holder.child.stdin.write('release\n')
  assert.deepEqual(await holder.done, { code: 0, signal: null })
})
