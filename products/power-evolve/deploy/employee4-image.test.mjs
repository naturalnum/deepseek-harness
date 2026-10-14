/** Cold Linux image acceptance with real flock, isolated credentials, exact Profile exits and ordinary-role restore. */
import assert from 'node:assert/strict'
import { spawnSync } from 'node:child_process'
import { createHash, randomBytes, randomUUID } from 'node:crypto'
import { closeSync, openSync, writeFileSync } from 'node:fs'
import { cp, mkdir, mkdtemp, readFile, rm, stat, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join, resolve } from 'node:path'
import { test } from 'node:test'
import { cloudImageContext } from './cloud-image-context.mjs'
import { prepareNativeCoverageContext } from '../scripts/cloud-coverage.mjs'

const repository = new URL('../../..', import.meta.url).pathname.replace(/\/$/u, '')
const evidence = process.env.PE_IMAGE_EVIDENCE_DIR
function docker(args, input) {
  const run = spawnSync('docker', args, { encoding: 'utf8', input, timeout: 120000, maxBuffer: 16 * 1024 * 1024 })
  if (run.error || run.signal || run.status !== 0) {
    const diagnostics = join(evidence ?? tmpdir(), 'employee4-image-docker-' + randomUUID() + '-private.log')
    writeFileSync(diagnostics, (run.stdout ?? '') + (run.stderr ?? '') + '\n' + String(run.error ?? ''), { mode: 0o600, flag: 'wx' })
    throw new Error('Owned image Docker action failed: ' + args[0] + '; private diagnostics: ' + diagnostics)
  }
  return run.stdout.trim()
}
function image() {
  const value = process.env.PE_TEST_CLOUD_IMAGE
  if (!value || !/^pe-employee4-cloud:[a-f0-9-]{36}$/u.test(value)) throw new Error('PE_TEST_CLOUD_IMAGE must name the owned cold image')
  assert.equal(docker(['image', 'inspect', '--format', '{{index .Config.Labels "org.power-evolve.employee4"}}', value]), value.slice('pe-employee4-cloud:'.length))
  return value
}
async function ownedImage() {
  const runtime = image(), owned = JSON.parse(await readFile(process.env.PE_IMAGE_BUILD_MANIFEST, 'utf8'))
  assert.equal(owned.id, runtime.slice('pe-employee4-cloud:'.length))
  const source = await readFile(join(owned.context, 'source/image-source.json'))
  return { runtime, sourceSha256: createHash('sha256').update(source).digest('hex') }
}
async function observed(check) {
  const deadline = Date.now() + 60000
  for (;;) {
    if (await check()) return
    if (Date.now() > deadline) throw new Error('Owned Linux deployment did not reach the required real state')
    await new Promise(resolve => setTimeout(resolve, 50))
  }
}

test('source context refuses checkout writes and excludes host outputs and private inputs', { timeout: 1200000 }, async () => {
  await assert.rejects(cloudImageContext(repository, repository + '/employee4-forbidden-context'), /outside/u)
  const owned = JSON.parse(await readFile(process.env.PE_IMAGE_BUILD_MANIFEST, 'utf8'))
  if (owned.coldBuild === true) {
    assert.match(owned.id, /^[a-f0-9-]{36}$/u)
    assert.equal(process.env.PE_TEST_CLOUD_IMAGE, 'pe-employee4-cloud:' + owned.id)
    const originalMask = process.umask(0o077)
    try { await cloudImageContext(repository, owned.context) } finally { process.umask(originalMask) }
    const captures = {}
    if (process.env.PE_CLOUD_COVERAGE_INPUT) {
      for (const phase of ['build', 'pack']) {
        const capture = prepareNativeCoverageContext(process.env.PE_CLOUD_COVERAGE_INPUT,
          { executionRoot: '/build', executionDirectory: '/build/.pe-native-coverage/' + phase })
        const destination = join(owned.context, 'native-coverage', phase)
        await mkdir(join(destination, 'raw'), { recursive: true, mode: 0o700 })
        await mkdir(join(destination, 'code'), { mode: 0o700 })
        await cp(capture.inputPath, join(destination, 'inputs.json'))
        captures[phase] = capture
      }
    }
    const log = join(evidence ?? owned.context, 'cold-build.log'), fd = openSync(log, 'wx', 0o600)
    let built
    try {
      built = spawnSync('docker', ['build', '--no-cache', '--progress=plain', '--target', 'runtime',
        '--label', 'org.power-evolve.employee4=' + owned.id, '--iidfile', join(owned.context, 'image.id'),
        '--tag', process.env.PE_TEST_CLOUD_IMAGE, owned.context], { stdio: ['ignore', fd, fd], timeout: 1200000 })
    } finally { closeSync(fd) }
    await writeFile(join(owned.context, 'cold-build-result.json'), JSON.stringify({ exitCode: built.status,
      signal: built.signal, error: String(built.error ?? ''), sourceTest: true, captures }) + '\n', { mode: 0o600 })
    assert.equal(built.status, 0, 'Cold Linux build failed; private log: ' + log)
    assert.equal(built.signal, null)
    if (Object.keys(captures).length > 0) {
      const output = join(owned.context, 'native-export')
      docker(['build', '--target', 'native-coverage-evidence', '--output', 'type=local,dest=' + output, owned.context])
      for (const [phase, capture] of Object.entries(captures)) {
        assert.deepEqual(await readFile(join(output, phase, 'inputs.json')), await readFile(capture.inputPath))
        for (const directory of ['raw', 'code']) await cp(join(output, phase, directory), join(capture.directory, directory), { recursive: true })
      }
    }
  }
  const manifest = JSON.parse(await readFile(join(owned.context, 'source/image-source.json'), 'utf8'))
  assert.equal(manifest.officialTag, 'dsh-v0.2.1-alpha.1')
  assert.equal((await stat(owned.context)).mode & 0o777, 0o700)
  assert.equal((await stat(join(owned.context, 'source/image-source.json'))).mode & 0o777, 0o644)
  for (const path of ['source', 'source/native/system/packages/entry/src', 'source/products/power-evolve/scripts']) {
    assert.equal((await stat(join(owned.context, path))).mode & 0o777, 0o755)
  }
  for (const path of ['native/system/packages/entry/src/flock.ts', 'products/power-evolve/scripts/cloud-capture.mjs']) {
    assert.equal((await stat(join(owned.context, 'source', path))).mode & 0o777, (await stat(join(repository, path))).mode & 0o777)
  }
  assert.ok(!manifest.files.some(file => /^native\/system\/packages\/[^/]+\/lib\//u.test(file.path)))
  assert.ok(manifest.files.some(file => file.path === 'pnpm-lock.yaml'))
  assert.ok(manifest.files.some(file => file.path.startsWith('patches/')))
  for (const file of manifest.files) {
    assert.doesNotMatch(file.path, /(?:^|\/)(?:node_modules|\.git|\.env[^/]*)(?:\/|$)/u)
    assert.doesNotMatch(file.path,
      /^(?:packages\/[^/]+\/[^/]+|vendor\/[^/]+|apps\/(?:cli|web)|products\/power-evolve\/[^/]+)\/(?:lib|dist)\//u)
    assert.doesNotMatch(file.path, /^apps\/desktop(?:-host)?\/(?!package\.json$)/u)
  }
  const dockerfile = await readFile(join(owned.context, 'Dockerfile'), 'utf8')
  assert.doesNotMatch(dockerfile, /^COPY\s+\./mu)
  assert.match(dockerfile, /pnpm install --frozen-lockfile/u)
  assert.match(dockerfile, /snapshot\.debian\.org\/archive\/debian\/20260901T000000Z/u)
})

test('cold Linux native flock excludes another process and releases on exact descriptor close', async (t) => {
  const { runtime, sourceSha256 } = await ownedImage()
  const owner = randomUUID(), id = 'pe-employee4-flock-' + owner
  t.after(() => {
    const result = spawnSync('docker', ['inspect', '--format', '{{index .Config.Labels "org.power-evolve.employee4"}}', id], { encoding: 'utf8' })
    if (result.status === 0) { assert.equal(result.stdout.trim(), owner); docker(['rm', '--force', id]) }
    else { assert.equal(result.status, 1); assert.match(result.stderr, /[Nn]o such (?:object|container)/u) }
  })
  const program = `import assert from 'node:assert/strict';import{spawn}from'node:child_process';import{createHash}from'node:crypto';import{once}from'node:events';import{open,readFile}from'node:fs/promises';import{createRequire}from'node:module';import{pathToFileURL}from'node:url';import{tryLockExclusive}from'./native/system/packages/entry/lib/flock.js';
    assert.equal(createHash('sha256').update(await readFile('image-source.json')).digest('hex'),${JSON.stringify(sourceSha256)});
    const build=JSON.parse(await readFile('image-build.json','utf8'));assert.equal(build.platform,'linux');assert.equal(build.desktopBuilt,false);
    const pack=JSON.parse(await readFile('image-pack.json','utf8'));assert.equal(pack.schemaVersion,12);assert.match(pack.applicationManifestSha256,/^[a-f0-9]{64}$/);assert.match(pack.applicationArchiveSha256,/^[a-f0-9]{64}$/);
    for(const role of ['host','platform','native-runtime']){const consumer=createRequire(process.cwd()+'/products/power-evolve/'+role+'/package.json');assert.ok(pack.profileEntries[role].length>0);for(const entry of pack.profileEntries[role])await import(pathToFileURL(consumer.resolve(entry)).href)}
    assert.deepEqual(pack.queryExports,['@deepseek-ai/dsh-session-query','@deepseek-ai/dsh-session-query-sqlite','@deepseek-ai/dsh-session-format-catalog','@deepseek-ai/dsh-session-format-catalog/message-projections']);
    const queryConsumer=createRequire(process.cwd()+'/products/power-evolve/application/package.json');for(const entry of pack.queryExports)await import(pathToFileURL(queryConsumer.resolve(entry)).href);
    for(const version of Array.from({length:12},(_,index)=>index+1))for(const suffix of ['sql','manifest.json'])assert.ok((await readFile('products/power-evolve/application/assets/cloud-schema-v'+version+'.'+suffix)).length>0);
    assert.equal(Object.keys(JSON.parse(await readFile('products/power-evolve/application/assets/cloud-schema-v12.manifest.json','utf8'))).length,89);
    const file=await open('/tmp/owned-flock','w+');await tryLockExclusive(file.fd);
    const probe="import{open}from'node:fs/promises';import{tryLockExclusive}from'./native/system/packages/entry/lib/flock.js';const file=await open('/tmp/owned-flock','r+');try{await tryLockExclusive(file.fd);console.log('acquired')}catch(error){if(!['EAGAIN','EWOULDBLOCK'].includes(error.code))throw error;console.log('contended')}finally{await file.close()}";
    async function child(){const p=spawn(process.execPath,['--input-type=module','--eval',probe],{stdio:['ignore','pipe','inherit']});let output='';p.stdout.on('data',bytes=>output+=bytes);const[code,signal]=await once(p,'close');assert.equal(code,0);assert.equal(signal,null);return output.trim()}
    assert.equal(await child(),'contended');await file.close();assert.equal(await child(),'acquired');console.log(JSON.stringify({linux:true,nativeFlock:true,contention:true,closeReleased:true}));`
  const result = docker(['run', '--rm', '--name', id, '--label', 'org.power-evolve.employee4=' + owner,
    '--network', 'none', '--entrypoint', 'node', runtime, '--input-type=module', '--eval', program])
  assert.deepEqual(JSON.parse(result), { linux: true, nativeFlock: true, contention: true, closeReleased: true })
})

test('real Linux Host and Platform keep separate credentials and restore bytes with ordinary roles', { timeout: 300000 }, async (t) => {
  const { runtime, sourceSha256 } = await ownedImage()
  const suffix = randomUUID(), prefix = 'pe-employee4-img-' + suffix
  const root = await mkdtemp(join(tmpdir(), 'pe-employee4-image-input-'))
  const containers = [], volumes = []
  let completed = false, backupVolume = null, anchor = null, network = null
  const nativeContexts = {}
  t.after(async () => {
    const captureErrors = []
    const discovered = docker(['ps', '--no-trunc', '-aq', '--filter', 'label=org.power-evolve.employee4=' + suffix]).split('\n').filter(Boolean)
    for (const id of new Set([...containers.toReversed(), ...discovered])) {
      assert.equal(docker(['inspect', '--format', '{{index .Config.Labels "org.power-evolve.employee4"}}', id]), suffix)
      const logs = spawnSync('docker', ['logs', id], { encoding: 'utf8' })
      if (evidence) await writeFile(join(evidence, 'container-' + id + '-private.log'), logs.stdout + logs.stderr, { mode: 0o600 })
      if (id === anchor) {
        for (const capture of Object.values(nativeContexts)) {
          try {
            const expected = await readFile(capture.inputPath)
            docker(['cp', anchor + ':' + capture.executionDirectory + '/.', capture.directory])
            assert.deepEqual(await readFile(capture.inputPath), expected)
          } catch (error) { captureErrors.push(error) }
        }
      }
      docker(['rm', '--force', '--volumes', id])
    }
    for (const name of volumes.toReversed()) if (completed || name !== backupVolume) {
      assert.equal(docker(['volume', 'inspect', '--format', '{{index .Labels "org.power-evolve.employee4"}}', name]), suffix)
      docker(['volume', 'rm', name])
    }
    if (network) {
      assert.equal(docker(['network', 'inspect', '--format', '{{index .Labels "org.power-evolve.employee4"}}', network]), suffix)
      docker(['network', 'rm', network])
    }
    if (!completed && backupVolume && evidence) await writeFile(join(evidence, 'retained-fault-stage.json'), JSON.stringify({ backupVolume, owner: suffix }) + '\n')
    assert.equal(docker(['ps', '--no-trunc', '-aq', '--filter', 'label=org.power-evolve.employee4=' + suffix]), '')
    if (evidence) await writeFile(join(evidence, 'image-cleanup.json'), JSON.stringify({ owner: suffix, containersRemaining: 0,
      retainedVolumes: !completed && backupVolume ? [backupVolume] : [], networkRemoved: true, completed }) + '\n')
    await rm(root, { recursive: true, force: true })
    if (captureErrors.length > 0) throw new AggregateError(captureErrors, 'Owned native evidence transport failed after resource cleanup')
  })
  if (evidence) await writeFile(join(evidence, 'owned-runtime-input-root.json'), JSON.stringify({ root, owner: suffix }) + '\n', { mode: 0o600 })
  network = docker(['network', 'create', ...(process.env.PE_IMAGE_TEST_SUBNET ? ['--subnet', process.env.PE_IMAGE_TEST_SUBNET] : []),
    '--label', 'org.power-evolve.employee4=' + suffix, prefix])
  const volume = (name) => { const value = docker(['volume', 'create', '--label', 'org.power-evolve.employee4=' + suffix, prefix + '-' + name]); volumes.push(value); return value }
  const privateVolume = volume('private'), hostState = volume('host-state'), platformState = volume('platform-state'), settings = volume('settings')
  const labels = ['workspaces', 'homes', 'skillPackages', 'attachments', 'officeCache']
  const roots = Object.fromEntries(labels.map(label => [label, volume(label)]))
  backupVolume = volume('backup'); const restoreVolume = volume('restore')
  const scopeMount = []
  if (process.env.PE_CLOUD_COVERAGE_INPUT) {
    const input = JSON.parse(await readFile(process.env.PE_CLOUD_COVERAGE_INPUT, 'utf8'))
    const executionRoot = '/opt/power-evolve'
    if (input.scope) {
      const scope = await readFile(resolve(input.physicalRoot, input.scope.manifest))
      assert.equal(createHash('sha256').update(scope).digest('hex'), input.scope.hash)
      const scopeFile = join(root, 'native-scope.json')
      await writeFile(scopeFile, scope, { mode: 0o444, flag: 'wx' })
      scopeMount.push('--mount', `type=bind,source=${scopeFile},target=${resolve(executionRoot, input.scope.manifest)},readonly`)
    }
    for (const [role, uid] of [['anchor', 0], ['host', 1001], ['platform', 1000]]) {
      const executionDirectory = '/pe-native-' + role
      nativeContexts[role] = { ...prepareNativeCoverageContext(process.env.PE_CLOUD_COVERAGE_INPUT,
        { executionRoot, executionDirectory }), executionDirectory, uid, volume: volume('native-' + role) }
    }
    const seeds = await Promise.all(Object.values(nativeContexts).map(async capture =>
      ({ directory: capture.executionDirectory, uid: capture.uid, bytes: (await readFile(capture.inputPath)).toString('base64') })))
    docker(['run', '-i', '--rm', '--name', prefix + '-native-setup', '--label', 'org.power-evolve.employee4=' + suffix,
      '--network', 'none', '--user', '0:0', ...Object.values(nativeContexts).flatMap(capture =>
        ['--mount', `type=volume,source=${capture.volume},target=${capture.executionDirectory}`]),
      '--entrypoint', 'node', runtime, '--input-type=module'],
    `import{mkdir,writeFile,chown,chmod}from'node:fs/promises';for(const seed of ${JSON.stringify(seeds)}){
      await chmod(seed.directory,0o700);await chown(seed.directory,seed.uid,seed.uid);
      await writeFile(seed.directory+'/inputs.json',Buffer.from(seed.bytes,'base64'),{mode:0o444});
      for(const name of ['raw','code']){const path=seed.directory+'/'+name;await mkdir(path,{mode:0o700});await chown(path,seed.uid,seed.uid)}}`)
  }
  const nativeEnvironment = role => Object.entries(nativeContexts[role]?.environment ?? {}).flatMap(([key, value]) => ['--env', key + '=' + value])
  const nativeMount = role => nativeContexts[role] ? ['--mount', `type=volume,source=${nativeContexts[role].volume},target=${nativeContexts[role].executionDirectory}`, ...scopeMount] : []
  const mounts = Object.entries(roots).flatMap(([label, source]) => ['--mount', `type=volume,source=${source},target=/data/${label}`])
  const allMounts = ['--mount', `type=volume,source=${privateVolume},target=/run/privateConfig`,
    '--mount', `type=volume,source=${hostState},target=/state/host`,
    '--mount', `type=volume,source=${platformState},target=/state/platform`,
    '--mount', `type=volume,source=${settings},target=/settings`, '--mount', `type=volume,source=${backupVolume},target=/backup`,
    '--mount', `type=volume,source=${restoreVolume},target=/restore`, ...mounts,
    ...Object.values(nativeContexts).flatMap(capture => ['--mount', `type=volume,source=${capture.volume},target=${capture.executionDirectory}`]), ...scopeMount]
  anchor = docker(['run', '-d', '--name', prefix + '-anchor', '--label', 'org.power-evolve.employee4=' + suffix,
    '--network', network, '--user', '0:0', ...allMounts, ...nativeEnvironment('anchor'), '--entrypoint', 'node', runtime, '-e', 'setInterval(()=>{},1000)'])
  containers.push(anchor)
  const exec = program => docker(['exec', '-i', anchor, 'node', '--input-type=module'], program)
  exec(`import assert from'node:assert/strict';import{createHash}from'node:crypto';import{readFile}from'node:fs/promises';assert.equal(createHash('sha256').update(await readFile('image-source.json')).digest('hex'),${JSON.stringify(sourceSha256)});console.log('Frozen image source manifest matched');`)
  const password = randomUUID(), sourcePassword = randomUUID(), targetPassword = randomUUID(), worker = randomUUID()
  await writeFile(join(root, 'postgres-password'), password, { mode: 0o600 })
  const pgName = prefix + '-pg'
  const pg = docker(['run', '-d', '--name', pgName, '--label', 'org.power-evolve.employee4=' + suffix,
    '--network', network, '--mount', `type=bind,source=${join(root, 'postgres-password')},target=/run/postgres-password,readonly`,
    '--env', 'POSTGRES_PASSWORD_FILE=/run/postgres-password', 'postgres:16-bookworm@sha256:0ea6700a3b4f0ae6ce746519073558aed4d88a79d8d07622a9a644946c7319c4'])
  containers.push(pg)
  await observed(() => spawnSync('docker', ['exec', pg, 'pg_isready', '--host', '127.0.0.1', '-U', 'postgres'], { encoding: 'utf8' }).status === 0)
  docker(['exec', '-i', '--user', 'postgres', pg, 'psql', '--no-psqlrc', '--set', 'ON_ERROR_STOP=1'],
    `CREATE ROLE employee4_source LOGIN PASSWORD '${sourcePassword}' NOSUPERUSER NOCREATEDB NOCREATEROLE;
    CREATE ROLE employee4_target LOGIN PASSWORD '${targetPassword}' NOSUPERUSER NOCREATEDB NOCREATEROLE;
    CREATE DATABASE employee4_source OWNER employee4_source;CREATE DATABASE employee4_target OWNER employee4_target;`)
  const hostName = prefix + '-host', platformName = prefix + '-platform'
  const common = { mode: 'https', hostOrigin: 'https://host.employee4.invalid', platformOrigin: 'https://platform.employee4.invalid',
    platformInternalUrl: 'http://' + platformName + ':18881' }
  const hostConfig = { ...common, privateDir: '/run/host', dshHome: '/state/host/dsh', rows: { host: { 'web-server': { host: '0.0.0.0', port: 18880 } } } }
  const platformConfig = { ...common, privateDir: '/run/platform', dshHome: '/state/platform/dsh', rows: { platform: {
    'web-server': { host: '0.0.0.0', port: 18881 }, 'power-evolve-platform': { workspaceRoot: '/data/workspaces',
      attachmentRoot: '/data/attachments', skillLibraryRoot: '/data/skillPackages', nativeIntentKeyFile: '/run/platform/native-intent-key', preinstalledSkills: [], seedUsersFile: '',
      accountManagementFile: '', databasePoolSize: 2 } } } }
  const sourceUrl = `postgres://employee4_source:${sourcePassword}@${pgName}:5432/employee4_source`
  const targetUrl = `postgres://employee4_target:${targetPassword}@${pgName}:5432/employee4_target`
  exec(`import{mkdir,writeFile,chown,chmod}from'node:fs/promises';
    const entries=${JSON.stringify({ host: { 'worker-token': worker }, 'host-config': { 'deployment.json': JSON.stringify(hostConfig) }, platform: {
      'worker-token': worker, 'model-key': randomUUID(), 'connector-key': randomUUID(), 'runner-key': randomUUID(),
      'native-intent-key': randomBytes(32).toString('base64url') + '\n',
      'database-url': sourceUrl, 'deployment.json': JSON.stringify(platformConfig) } })};
    for(const[role,files]of Object.entries(entries)){const uid=role==='platform'?1000:1001,path='/run/privateConfig/'+role;await mkdir(path,{mode:0o700});await chown(path,uid,uid);
      for(const[name,bytes]of Object.entries(files)){await writeFile(path+'/'+name,bytes,{mode:0o600});await chown(path+'/'+name,uid,uid)}}
    for(const[path,uid]of [['/state/host',1001],['/state/platform',1000],...${JSON.stringify(labels)}.map(label=>['/data/'+label,1000])]){await chmod(path,0o700);await chown(path,uid,uid)}
    for(const path of ['/run/privateConfig','/settings','/backup','/restore'])await chmod(path,0o700);
    await writeFile('/settings/target-url',${JSON.stringify(targetUrl)},{mode:0o600});`)
  const platform = docker(['run', '-d', '--name', platformName, '--label', 'org.power-evolve.employee4=' + suffix,
    '--network', network, '--pid', 'container:' + anchor, '--user', '1000:1000', '--cap-drop', 'ALL',
    '--mount', `type=volume,source=${privateVolume},volume-subpath=platform,target=/run/platform,readonly`,
    '--mount', `type=volume,source=${platformState},target=/state/platform`, ...mounts,
    ...nativeMount('platform'), ...nativeEnvironment('platform'),
    runtime, 'platform', '/run/platform/deployment.json'])
  containers.push(platform)
  await observed(() => exec(`const r=await fetch('http://${platformName}:18881/health').catch(()=>null);console.log(r?.status===200)`) === 'true')
  const host = docker(['run', '-d', '--name', hostName, '--label', 'org.power-evolve.employee4=' + suffix,
    '--network', network, '--pid', 'container:' + anchor, '--user', '1001:1001', '--cap-drop', 'ALL',
    '--mount', `type=volume,source=${privateVolume},volume-subpath=host,target=/run/host,readonly`,
    '--mount', `type=volume,source=${privateVolume},volume-subpath=host-config,target=/run/host-config,readonly`,
    '--mount', `type=volume,source=${hostState},target=/state/host`, ...nativeMount('host'), ...nativeEnvironment('host'),
    runtime, 'host', '/run/host-config/deployment.json'])
  containers.push(host)
  await observed(() => exec(`const r=await fetch('http://${hostName}:18880/health').catch(()=>null);console.log(r?.status===200)`) === 'true')
  for (const id of [host, platform]) assert.equal(/did not activate|failed to import/u.test(docker(['logs', id])), false,
    'Named Profile activation failed; inspect the retained private container log')
  const platformPid = Number(exec("import{readFile}from'node:fs/promises';console.log(JSON.parse(await readFile('/state/platform/dsh/profiles/power-evolve-cloud-platform/lifecycle.json','utf8')).parent.pid)"))
  assert.ok(platformPid > 1)
  docker(['exec', '-i', host, 'node', '--input-type=module'], `import assert from'node:assert/strict';import{readFile,readdir}from'node:fs/promises';
    assert.deepEqual(await readdir('/run/host'),['worker-token']);assert.equal((await readFile('/run/host/worker-token','utf8')).length,36);await assert.rejects(readFile('/run/platform/model-key'),{code:'ENOENT'});
    await assert.rejects(readFile('/proc/${platformPid}/root/run/platform/model-key'),error=>['EACCES','EPERM'].includes(error.code));console.log('Host credential isolation verified');`)
  const native = JSON.parse(exec(`const r=await fetch('http://${hostName}:18880/native/');console.log(JSON.stringify({status:r.status,body:(await r.text()).includes('PowerEvolve')}))`))
  assert.deepEqual(native, { status: 200, body: true })
  for (const id of [host, platform]) { docker(['kill', '--signal', 'SIGTERM', id]); assert.equal(docker(['wait', id]), '0') }
  const profiles = ['/state/host/dsh/profiles/power-evolve-cloud-host', '/state/platform/dsh/profiles/power-evolve-cloud-platform']
  exec(`import assert from'node:assert/strict';import{privateJson,processIdentity}from'./products/power-evolve/deploy/lifecycle.mjs';for(const path of ${JSON.stringify(profiles)}){const state=await privateJson(path+'/lifecycle.json');assert.equal(state.phase,'stopped');assert.equal(state.exit.code,0);assert.equal(await processIdentity(state.parent.pid),null);assert.equal(await processIdentity(state.child.pid),null)}console.log('Same PID namespace stop evidence verified');`)
  exec("import{writeFile,link,chown}from'node:fs/promises';await writeFile('/data/attachments/original','native-original中文',{mode:0o600});await chown('/data/attachments/original',0,0);await link('/data/attachments/original','/data/attachments/alias');await writeFile('/data/workspaces/owned','tenant-byte',{mode:0o640});await chown('/data/workspaces/owned',1000,1000);")
  const config = { format: 1, bundle: '/backup/archive', nativeIntentKeyFile: '/run/privateConfig/platform/native-intent-key', postgres: { urlFile: '/run/privateConfig/platform/database-url', database: 'employee4_source', role: 'employee4_source' },
    roots: { privateConfig: '/run/privateConfig', ...Object.fromEntries(labels.map(label => [label, '/data/' + label])) }, profiles }
  const targetConfig = { ...config, nativeIntentKeyFile: '/restore/privateConfig/platform/native-intent-key', postgres: { urlFile: '/settings/target-url', database: 'employee4_target', role: 'employee4_target' },
    roots: Object.fromEntries(['privateConfig', ...labels].map(label => [label, '/restore/' + label])), profiles: ['/restore/host', '/restore/platform'] }
  exec(`import{writeFile}from'node:fs/promises';await writeFile('/settings/create.json',${JSON.stringify(JSON.stringify(config))},{mode:0o600});await writeFile('/settings/restore.json',${JSON.stringify(JSON.stringify(targetConfig))},{mode:0o600});`)
  const capture = JSON.parse(docker(['exec', anchor, 'node', 'products/power-evolve/deploy/backup.mjs', 'create', '/settings/create.json']))
  assert.equal(capture.schema, 12); assert.equal(capture.tables, 89)
  const restored = JSON.parse(docker(['exec', anchor, 'node', 'products/power-evolve/deploy/backup.mjs', 'restore', '/settings/restore.json']))
  assert.equal(restored.schema, 12); assert.equal(restored.tables, 89)
  assert.equal(restored.allFilesVerified, true); assert.equal(restored.allRowsVerified, true)
  assert.equal(restored.readinessChecked, false)
  exec(`import assert from'node:assert/strict';import{lstat,readFile}from'node:fs/promises';import{connectDatabase,requireCurrentSchema}from'./products/power-evolve/deploy/backup-postgres.mjs';
    for(const config of [${JSON.stringify(config.postgres)},${JSON.stringify(targetConfig.postgres)}]){const db=await connectDatabase(config);try{
      const{rows:[r]}=await db.client.query('SELECT rolsuper,rolcreatedb,rolcreaterole FROM pg_roles WHERE rolname=current_user');assert.deepEqual(r,{rolsuper:false,rolcreatedb:false,rolcreaterole:false});
      await requireCurrentSchema(db.client);const before=(await db.client.query('SELECT family,version FROM pe_schema')).rows;assert.deepEqual(before,[{family:'cloud-native',version:12}]);
      const{rows:[temporary]}=await db.client.query('SELECT (SELECT count(*)::text FROM pe_native_presentations) AS presentations,(SELECT count(*)::text FROM pe_native_presentation_entries) AS entries');assert.deepEqual(temporary,{presentations:'0',entries:'0'});
      assert.equal((await db.client.query('SELECT count(*)::text AS count FROM pe_native_writers WHERE expires_at>clock_timestamp()')).rows[0].count,'0');
      for(const oldVersion of [2,3,4,5,6,7,8,9,10,11]){await db.client.query('BEGIN');try{assert.equal((await db.client.query('UPDATE pe_schema SET version=$1 WHERE version=12',[oldVersion])).rowCount,1);await assert.rejects(requireCurrentSchema(db.client),/Schema 12/)}finally{await db.client.query('ROLLBACK')}
        assert.deepEqual((await db.client.query('SELECT family,version FROM pe_schema')).rows,before);}
    }finally{await db.client.end()}}
    assert.deepEqual(await readFile('/restore/privateConfig/platform/native-intent-key'),await readFile('/run/privateConfig/platform/native-intent-key'));assert.equal((await lstat('/restore/privateConfig/platform/native-intent-key')).mode&0o7777,0o600);
    const original=await lstat('/restore/attachments/original'),alias=await lstat('/restore/attachments/alias');assert.equal(original.uid,0);assert.equal(original.gid,0);assert.equal(original.ino,alias.ino);assert.equal(original.dev,alias.dev);assert.equal(await readFile('/restore/attachments/original','utf8'),'native-original中文');const tenant=await lstat('/restore/workspaces/owned');assert.equal(tenant.uid,1000);assert.equal(tenant.gid,1000);assert.equal(tenant.mode&0o777,0o640);console.log('Ordinary roles and actual owners/hardlinks verified');`)
  if (evidence) await writeFile(join(evidence, 'linux-image-acceptance.json'), JSON.stringify({ sourceRoleOrdinary: true, targetRoleOrdinary: true,
    samePidNamespace: true, exactHostPlatformStops: true, hostCredentialsIsolated: true, nativeWeb: true, schema: 12, tables: 89,
    schema2VersionRefused: true, schema3VersionRefused: true, schema4VersionRefused: true, schema5VersionRefused: true,
    temporaryTablesEmpty: true, liveWritersAbsent: true,
    originalRootUidPreserved: true, tenantUid1000Preserved: true, hardlinkPreserved: true, businessReadinessChecked: false,
    sourceSha256, image: runtime }, null, 2) + '\n')
  completed = true
})
