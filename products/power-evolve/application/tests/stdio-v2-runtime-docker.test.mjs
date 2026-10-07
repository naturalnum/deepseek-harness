/** Real private Docker/HTTP/SDK/UID cleanup; Platform grants and Cloud image-manifest observations are explicit substitutes. */
import assert from 'node:assert/strict'
import test from 'node:test'
import { execFile } from 'node:child_process'
import { promisify } from 'node:util'
import { randomBytes, randomUUID } from 'node:crypto'
import { mkdtemp, mkdir, copyFile, readFile, writeFile, rm, realpath } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { fileURLToPath } from 'node:url'
import { setTimeout as delay } from 'node:timers/promises'
import { stdioDispatchV2, stdioTaskSchemasV2 } from '@power-evolve/contracts/stdio-mcp'
import { stdioCatalogFingerprintV2, stdioSha256V2 } from '@power-evolve/connector-runner/stdio-v2-digest'
import { catalog } from '../../connector-runner/tests/stdio-v2-fixture.mjs'

const execute = promisify(execFile), base = process.env.PE_STDIO_RUNTIME_BASE_IMAGE
const sandbox = fileURLToPath(new URL('../../sandbox/', import.meta.url))
const limits = { runtimeMs: 5000, requestMs: 600, stdinGraceMs: 50, terminateGraceMs: 50, killGraceMs: 600,
  maxInputBytes: 262144, maxMessageBytes: 32768, maxProtocolBytes: 262144, maxProtocolMessages: 100,
  maxJsonDepth: 40, maxJsonNodes: 10000, maxPages: 4, maxTools: 10, maxCatalogBytes: 32768,
  maxToolBytes: 16384, maxResultBytes: 32768, maxStderrBytes: 4096 }
const budget = { maxDepth: limits.maxJsonDepth, maxNodes: limits.maxJsonNodes, maxBytes: limits.maxInputBytes }
const sha = (domain, value) => stdioSha256V2(domain, value, budget)
const docker = async args => (await execute('docker', args, { timeout: 30000, maxBuffer: 1048576 })).stdout.trim()
const dockerInput = (args, input) => new Promise((resolve, reject) => {
  const child = execFile('docker', args, { timeout: 30000, maxBuffer: 1048576 },
    (error, stdout) => error ? reject(error) : resolve(stdout.trim()))
  child.stdin.end(input)
})
async function eventually(check) {
  const deadline = Date.now() + 12000
  do { const value = await check(); if (value) return value; await delay(30) } while (Date.now() < deadline)
  throw new Error('owned_stdio_runtime_timeout')
}

test('actual private Runner executes frozen SDK calls once as UID1000 and confirms full writer cleanup', {
  timeout: 180000, skip: !base && 'Set PE_STDIO_RUNTIME_BASE_IMAGE to an already-local operator-selected image',
}, async () => {
  const suffix = randomUUID(), label = `power-evolve.stdio-runtime-qa=${suffix}`
  const baseAlias = `pe-stdio-runtime-base:${suffix}`, imageAlias = `pe-stdio-runtime-qa:${suffix}`
  const name = `pe-stdio-runtime-${suffix}`, secretVolume = `pe-stdio-runtime-secret-${suffix}`
  const root = await mkdtemp(join(await realpath(tmpdir()), 'pe-stdio-runtime-'))
  let containerId, baseTagged = false, imageBuilt = false, volumeCreated = false
  try {
    const image = JSON.parse(await docker(['image', 'inspect', '--format', '{{json .}}', base]))
    assert.match(image.Id, /^sha256:[a-f0-9]{64}$/u)
    assert.equal(image.Os, 'linux'); assert(['arm64', 'amd64'].includes(image.Architecture))
    await docker(['image', 'tag', image.Id, baseAlias]); baseTagged = true
    await mkdir(join(root, 'lib'))
    for (const file of ['runner.mjs', 'file-scan.mjs', 'file-scan.py', 'lib/stdio-v2-runtime.mjs']) {
      await copyFile(join(sandbox, file), join(root, file))
    }
    await writeFile(join(root, 'Dockerfile'), `FROM ${baseAlias}\nCOPY runner.mjs file-scan.mjs file-scan.py /opt/power-evolve/\nCOPY lib/stdio-v2-runtime.mjs /opt/power-evolve/lib/stdio-v2-runtime.mjs\n`)
    await docker(['build', '--pull=false', '--network', 'none', '--label', label, '--tag', imageAlias, root]); imageBuilt = true
    const actualImageId = await docker(['image', 'inspect', '--format', '{{.Id}}', imageAlias])
    const token = randomBytes(32).toString('base64url')
    await docker(['volume', 'create', '--label', label, secretVolume]); volumeCreated = true
    await dockerInput(['run', '--rm', '-i', '--label', label, '--network', 'none', '--read-only',
      '--memory', '128m', '--cpus', '0.2', '--mount', `type=volume,source=${secretVolume},target=/run/power-evolve`,
      '--user', '0:0', '--entrypoint', 'node', actualImageId, '-e',
      "const fs=require('node:fs');fs.writeFileSync('/run/power-evolve/runner-token',fs.readFileSync(0),{mode:0o400});fs.chownSync('/run/power-evolve/runner-token',0,0)"], token)
    await writeFile(join(root, 'config.json'), JSON.stringify({ limits, maxReplyBytes: 262144 }))
    let peer = await readFile(new URL('../../connector-runner/tests/stdio-v2-fixture.mjs', import.meta.url), 'utf8')
    peer = peer.replace("import { appendFileSync } from 'node:fs'", "import { appendFileSync, readFileSync } from 'node:fs'")
      .replace("trace({ event: 'spawn', pid: process.pid, argv: literalArgs,", `let tokenReadable = false
  try { readFileSync('/run/power-evolve/runner-token'); tokenReadable = true } catch (_denied) { /* controlled secret access probe */ }
  trace({ event: 'spawn', pid: process.pid, uid: process.getuid(), gid: process.getgid(), cwd: process.cwd(), tokenReadable, argv: literalArgs,`)
      .replace("if (mode === 'held-pipe')", `if (mode === 'detached-writer') spawn(process.execPath, [fileURLToPath(import.meta.url), 'pipe-holder', record], {
    cwd: process.cwd(), env: { ...process.env }, detached: true, stdio: 'ignore',
  }).unref()
  if (mode === 'held-pipe')`)
    await writeFile(join(root, 'stdio-v2-fixture.mjs'), peer)
    containerId = await docker(['create', '--name', name, '--label', label, '--network', 'none',
      '--read-only', '--cap-drop', 'ALL', '--cap-add', 'SETUID', '--cap-add', 'SETGID',
      '--cap-add', 'DAC_OVERRIDE', '--cap-add', 'KILL', '--security-opt', 'no-new-privileges',
      '--pids-limit', '128', '--memory', '512m', '--cpus', '0.5', '--user', '0:0',
      '--tmpfs', '/workspace:rw,uid=1000,gid=1000,mode=755', '--tmpfs', '/home/agent:rw,uid=1000,gid=1000,mode=750',
      '--tmpfs', '/tmp:rw,nosuid,mode=1777,size=64m',
      '--mount', `type=bind,source=${root},target=/qa,readonly`,
      '--mount', `type=volume,source=${secretVolume},target=/run/power-evolve,readonly`,
      '--env', 'PE_RUNNER_STDIO_V2_CONFIG_FILE=/qa/config.json', '--env', 'ROOT_ONLY_AMBIENT=must-not-inherit',
      actualImageId])
    assert.match(containerId, /^[a-f0-9]{64}$/u)
    await docker(['start', containerId])
    // The private root control client uses real loopback HTTP inside the network-none container.
    // Control headers enter its stdin, never Docker argv or user-process environment.
    const fetch = async (url, options = {}) => {
      const result = JSON.parse(await dockerInput(['exec', '-i', containerId, 'node', '--input-type=module', '-e',
          "import{readFileSync}from'node:fs';const{url,options}=JSON.parse(readFileSync(0,'utf8'));const r=await fetch(url,options);console.log(JSON.stringify({status:r.status,body:await r.json()}))"],
        JSON.stringify({ url, options })))
      return { status: result.status, ok: result.status >= 200 && result.status < 300, json: async () => result.body }
    }
    const url = 'http://127.0.0.1:8080', headers = { 'content-type': 'application/json', 'x-power-evolve-runner-token': token }
    const health = await eventually(async () => {
      try { const res = await fetch(`${url}/health`, { headers }); if (res.ok) return res.json() }
      catch (_booting) { /* Own container readiness only. */ }
    })
    assert.equal(health.ready, true)
    const inspected = JSON.parse(await docker(['inspect', '--format', '{{json .}}', containerId]))
    assert.equal(inspected.Image, actualImageId); assert.equal(inspected.HostConfig.ReadonlyRootfs, true)
    assert.equal(inspected.HostConfig.NetworkMode, 'none')
    const post = input => fetch(`${url}/stdio/v2/executions`, { method: 'POST', headers, body: JSON.stringify(input) })
    const get = async id => (await fetch(`${url}/stdio/v2/executions/${id}`, { headers })).json()
    const terminal = id => eventually(async () => { const value = await get(id); return value.state !== 'running' && value })
    const trace = async id => JSON.parse(await docker(['exec', containerId, 'node', '--input-type=module', '-e',
      "import{readFileSync}from'node:fs'; console.log(JSON.stringify(readFileSync(process.argv[1],'utf8').trim().split('\\n').filter(Boolean).map(JSON.parse)))", `/workspace/${id}.jsonl`]))
    function packet(phase = 'discover', mode = 'good') {
      const executionId = randomUUID(), userId = randomUUID(), now = Date.now()
      const pin = { kind: 'cloud', deploymentId: randomUUID(), protocolVersion: 2,
        platform: { os: 'linux', architecture: image.Architecture }, imageReference: `qa.invalid/runner@${actualImageId}`,
        configImageId: actualImageId, runtimeImageIds: [`qa.invalid/runner@${actualImageId}`] }
      // This pin is a DTO substitute, not a captured real registry manifest or Kubernetes observation.
      const rawTask = { formatVersion: 2, actionId: randomUUID(), userId, sessionId: randomUUID(), connectionId: randomUUID(),
        configRevision: 1, configDigest: sha('configuration', { mode }), scopeBinding: { kind: 'cloud', userId,
          workspaceId: randomUUID(), bindingGeneration: 1, target: { spaceId: randomUUID(), rootRelativePath: 'qa' },
          home: { kind: 'user', userId } }, expectedDeploymentPin: pin,
        invocation: { program: 'node', argv: ['/qa/stdio-v2-fixture.mjs', mode, `/workspace/${executionId}.jsonl`, 'literal;$(not-a-shell)', '中文'], cwd: '.' },
        limits, phase, origin: phase === 'discover' ? { kind: 'stdio_discovery', requestId: randomUUID() }
          : { kind: 'operation', operationId: randomUUID(), rootOperationId: randomUUID(), callKey: 'qa:sum' } }
      if (phase === 'call') rawTask.selection = { catalogId: randomUUID(), catalogDigest: stdioCatalogFingerprintV2(catalog, limits),
        rawCatalog: catalog, catalogImageExpectation: { kind: 'cloud', platform: pin.platform,
          imageReference: pin.imageReference, runtimeImageId: pin.runtimeImageIds[0] }, rawName: 'sum', rawDescriptor: catalog[0], arguments: { left: 4, right: 9 } }
      const task = stdioTaskSchemasV2(limits).task.parse(rawTask), taskDigest = sha('task', task)
      const permit = { actionId: task.actionId, taskDigest, preparedDigest: sha('prepared', { qa: executionId }), approvalEpoch: 1,
        expiresAt: new Date(now + 60000).toISOString(), permitId: randomUUID(), authorizationRequestId: randomUUID(),
        executionRef: { kind: 'cloud', executionId }, executorOwner: { kind: 'cloud', runnerInstanceId: health.instanceId },
        approvalFingerprint: sha('prepared', { approved: executionId }), issuedAt: new Date(now - 100).toISOString() }
      const dispatch = stdioDispatchV2(limits).parse({ formatVersion: 2, task, taskDigest,
        executionRef: permit.executionRef, preparedDigest: permit.preparedDigest, permit })
      return { dispatch, authorization: { grantOnce: true, permit } }
    }
    function query(input) { return { ...input, authorization: { ...input.authorization, grantOnce: false } } }
    const denied = packet(); assert.equal((await post(query(denied))).status, 403)
    assert.equal((await fetch(`${url}/stdio/v2/executions`, { method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify(packet()) })).status, 401)
    const discovered = packet()
    const [first, retry] = await Promise.all([post(discovered), post(discovered)])
    assert.equal(first.status, 202); assert([200, 202].includes(retry.status))
    const d = await terminal(discovered.dispatch.executionRef.executionId)
    assert.equal(d.state, 'completed'); assert.equal(d.writerStopConfirmed, true); assert.deepEqual(d.outcome.catalog, catalog)
    assert.equal(d.outcome.pages.length, 2); assert.equal(d.outcome.initializeResult._meta['qa/initialize'], 'preserved')
    const events = await trace(d.executionRef.executionId), spawned = events.filter(e => e.event === 'spawn')
    assert.equal(spawned.length, 1); assert.equal(spawned[0].uid, 1000); assert.equal(spawned[0].gid, 1000)
    assert.equal(spawned[0].tokenReadable, false); assert.equal(spawned[0].cwd, '/workspace')
    assert.deepEqual(spawned[0].envKeys, ['HOME', 'LANG', 'PATH']); assert.deepEqual(spawned[0].argv, ['literal;$(not-a-shell)', '中文'])
    assert.deepEqual(await (await post(query(discovered))).json(), d)
    const called = packet('call'), cfirst = await post(called); assert.equal(cfirst.status, 202)
    const c = await terminal(called.dispatch.executionRef.executionId)
    assert.equal(c.state, 'completed'); assert.equal(c.writerStopConfirmed, true)
    assert.deepEqual(c.outcome.result.structuredContent, { sum: 13, raw: 'structured\u0000value' })
    assert.equal(c.outcome.result.content[0].text, 'sum:13\u0000'); assert.deepEqual(c.outcome.result['x-result'], { full: ['preserved', null] })
    const changed = structuredClone(called); changed.dispatch.task.invocation.argv.push('different')
    changed.dispatch.taskDigest = sha('task', changed.dispatch.task); changed.dispatch.permit.taskDigest = changed.dispatch.taskDigest
    changed.authorization.permit.taskDigest = changed.dispatch.taskDigest
    assert.equal((await post(changed)).status, 409)
    assert.equal((await trace(c.executionRef.executionId)).filter(e => e.method === 'tools/call').length, 1)
    const detached = packet('call', 'detached-writer'); assert.equal((await post(detached)).status, 202)
    const detachedResult = await terminal(detached.dispatch.executionRef.executionId)
    assert.equal(detachedResult.state, 'completed'); assert.equal(detachedResult.writerStopConfirmed, true)
    const uidWriters = await docker(['exec', containerId, 'node', '--input-type=module', '-e',
      "import{readdirSync,readFileSync}from'node:fs'; console.log(JSON.stringify(readdirSync('/proc').filter(v=>/^\\d+$/.test(v)).filter(v=>{try{const s=readFileSync('/proc/'+v+'/status','utf8');return /^Uid:\\s+1000\\s/m.test(s)&&!/^State:\\s+[ZX]/m.test(s)}catch{return false}})))"])
    assert.deepEqual(JSON.parse(uidWriters), [])
    const lost = packet('call', 'call-lost'); assert.equal((await post(lost)).status, 202)
    const legacy = { id: randomUUID(), instanceId: health.instanceId, command: 'sleep 1; printf legacy-after-cleanup', cwd: '', timeoutMs: 3000 }
    assert.equal((await fetch(`${url}/executions`, { method: 'POST', headers, body: JSON.stringify(legacy) })).status, 409)
    const lostResult = await terminal(lost.dispatch.executionRef.executionId)
    assert.equal(lostResult.state, 'failed'); assert.equal(lostResult.writerStopConfirmed, true)
    assert.equal(lostResult.outcome.facts.effectMayHaveOccurred, true); assert.equal(lostResult.outcome.facts.toolsCallAttempted, true)
    assert.deepEqual(await (await post(query(lost))).json(), lostResult)
    assert.equal((await trace(lostResult.executionRef.executionId)).filter(e => e.method === 'tools/call').length, 1)
    const legacyAccepted = await fetch(`${url}/executions`, { method: 'POST', headers, body: JSON.stringify(legacy) })
    assert.equal(legacyAccepted.status, 202)
    assert.deepEqual(await (await post(query(called))).json(), c, 'Retained queries remain readable while a legacy writer runs')
    assert.equal((await post(packet())).status, 409, 'A fresh generic writer cannot overlap the legacy writer')
    const legacyDone = await eventually(async () => { const v = await (await fetch(`${url}/executions/${legacy.id}`, { headers })).json(); return v.state !== 'running' && v })
    assert.equal(legacyDone.state, 'succeeded')
    const cancel = packet('call', 'call-lost'); assert.equal((await post(cancel)).status, 202)
    assert.equal((await fetch(`${url}/stdio/v2/executions/${cancel.dispatch.executionRef.executionId}/cancel`, { method: 'POST', headers })).status, 200)
    const cancelled = await terminal(cancel.dispatch.executionRef.executionId)
    assert.equal(cancelled.state, 'cancelled'); assert.equal(cancelled.writerStopConfirmed, true)
    const shutdown = packet('call', 'call-lost'); assert.equal((await post(shutdown)).status, 202)
    await docker(['stop', '--time', '5', containerId])
    const stopped = JSON.parse(await docker(['inspect', '--format', '{{json .State}}', containerId]))
    assert.equal(stopped.Running, false); assert.equal(stopped.Pid, 0); assert.equal(stopped.ExitCode, 0)
  } catch (error) {
    if (containerId) {
      console.error('Own fixture state:', await docker(['inspect', '--format', '{{json .State}}', containerId]))
      console.error('Own fixture Runner logs:', await docker(['logs', '--tail', '30', containerId]))
    }
    throw error
  } finally {
    if (containerId) {
      const owner = await docker(['inspect', '--format', '{{index .Config.Labels "power-evolve.stdio-runtime-qa"}}', containerId])
      assert.equal(owner, suffix)
      await docker(['stop', '--time', '5', containerId])
      await docker(['rm', containerId])
    }
    if (imageBuilt) await docker(['image', 'rm', imageAlias])
    if (volumeCreated) await docker(['volume', 'rm', secretVolume])
    if (baseTagged) await docker(['image', 'rm', baseAlias])
    await rm(root, { recursive: true })
  }
})
