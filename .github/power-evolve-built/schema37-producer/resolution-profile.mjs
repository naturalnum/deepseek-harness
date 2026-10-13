/** Produce only an owned Schema37 compatibility cohort through the fixed original service source. */
import { readFile, writeFile, mkdir } from 'node:fs/promises'
import { randomUUID, randomBytes } from 'node:crypto'
import { createRequire } from 'node:module'
import { pathToFileURL } from 'node:url'
import { setTimeout as delay } from 'node:timers/promises'

export const name='ci-schema37-resolution'
/** Run the exact original service fixture and exit after its resources drain.
 * @param ctx Official launcher readiness and exit services.
 * @param config Current-job protected parameter file.
 */
export async function apply(ctx, config) {
  try {
    const p = JSON.parse(await readFile(config.parameterFile, 'utf8'))
    if (!new URL(p.sourceUrl).pathname.startsWith('/pe_ci_schema37_')
      || !p.dataRoot.startsWith('/pe-ci-data/storage/')) throw new Error('Unowned resolution fixture')
    const load = file => import(pathToFileURL(p.sourceRoot + '/products/power-evolve/application/src/platform/' + file).href)
    const [{ FileService }, { SandboxManager }, { KubernetesClient, KubernetesError }, { TaskStore },
      { IdentityService }, { ExecutionService }, { ExecutionFileFactsService }, { kubernetesPodStopStatus }] = await Promise.all([
      load('files.ts'), load('sandbox.ts'), load('kubernetes.ts'), load('tasks.ts'), load('identity.ts'),
      load('executions.ts'), load('execution-file-facts.ts'), load('pod-stop-status.ts'),
    ])
    const { Pool } = createRequire(p.targetRoot + '/products/power-evolve/application/package.json')('pg')
    const pool = new Pool({ connectionString: p.sourceUrl, max: 6 })
    const kube = await KubernetesClient.fromFile(p.kubeconfig), raw = kube.call.bind(kube)
    const namespace = 'pe-ci-resolution-' + randomUUID().replaceAll('-', '')
    const pv = 'pe-ci-resolution-pv-' + randomUUID().replaceAll('-', ''), claim = 'employee4-data'
    const ns = await raw('POST', '/api/v1/namespaces', {
      apiVersion: 'v1', kind: 'Namespace', metadata: { name: namespace, labels: { 'powerevolve.owner': p.owner } },
    })
    const resources = { namespace, namespaceUid: ns.metadata.uid, pv, claim, dataRoot: p.dataRoot }
    await writeFile(p.root + '/physical-resources.json', JSON.stringify(resources) + '\n', { mode: 0o600, flag: 'wx' })
    await mkdir(p.dataRoot, { recursive: true, mode: 0o750 })
    const volume = await raw('POST', '/api/v1/persistentvolumes', {
      apiVersion: 'v1', kind: 'PersistentVolume', metadata: { name: pv, labels: { 'powerevolve.owner': p.owner } },
      spec: { capacity: { storage: '1Gi' }, volumeMode: 'Filesystem', accessModes: ['ReadWriteMany'],
        persistentVolumeReclaimPolicy: 'Retain', storageClassName: '', hostPath: { path: p.dataRoot, type: 'Directory' },
        claimRef: { name: claim, namespace } },
    })
    const pvc = await raw('POST', '/api/v1/namespaces/' + namespace + '/persistentvolumeclaims', {
      apiVersion: 'v1', kind: 'PersistentVolumeClaim', metadata: { name: claim, namespace, labels: { 'powerevolve.owner': p.owner } },
      spec: { accessModes: ['ReadWriteMany'], storageClassName: '', volumeName: pv, resources: { requests: { storage: '1Gi' } } },
    })
    resources.pvUid = volume.metadata.uid; resources.pvcUid = pvc.metadata.uid
    await writeFile(p.root + '/physical-resources.json', JSON.stringify(resources) + '\n', { mode: 0o600 })
    await raw('POST', '/api/v1/namespaces/' + namespace + '/serviceaccounts', {
      apiVersion: 'v1', kind: 'ServiceAccount', metadata: { name: 'power-evolve-runner', namespace }, automountServiceAccountToken: false,
    })
    const observations = []
    kube.call = async (method, path, ...args) => {
      if (!path.startsWith('/api/v1/namespaces/' + namespace + '/')
        && !path.startsWith('/apis/agents.x-k8s.io/v1beta1/namespaces/' + namespace + '/')
        && !(/^\/api\/v1\/nodes\/[^/]+$/.test(path) && method === 'GET')) throw new Error('Unowned API request ' + path)
      const result = await raw(method, path, ...args)
      if (method === 'GET' && (path.includes('/pods/') || path.includes('/sandboxes/') || path.includes('/services/'))) {
        observations.push({ path, result: structuredClone(result) })
      }
      return result
    }
    const files = new FileService(pool, p.dataRoot + '/workspaces', { uid: 1000, gid: 1000 })
    await files.init(); await files.safe.ensureWorkspace(p.workspaceId)
    const managerKey = randomBytes(32).toString('base64url')
    await writeFile(p.root + '/manager-key-private', managerKey + '\n', { mode: 0o600, flag: 'wx' })
    const manager = new SandboxManager(kube, files, pool, managerKey, {
      namespace, image: p.image.imageReference, localRoot: p.dataRoot, nodeRoot: '', volumeClaimName: claim, readyTimeoutMs: 45000,
      fileScan: { maxEntries: 100, maxHashBytes: 1048576, timeoutMs: 1000, maxSnapshotBytes: 1048576, maxFiles: 100 },
    })
    const tasks = new TaskStore(pool,
      {
        maxEventBytes: 262144,
        leaseMs: 120000,
        maxPendingPerUser: 8,
        maxActivePerUser: 1,
        executionEnabled: true },
    )
    const identities = new IdentityService(pool, 120000), verification = new ExecutionFileFactsService(pool, files)
    const executions = new ExecutionService(tasks,
      manager,
      {
        service: verification,
        timeoutMs: 1000 }
      ,
      1,
      100,
      120000,
      p.commandTimeoutMs,
      30000)
    // These original TypeScript private members are emitted as ordinary JavaScript fields.
    // The original service instance supplies both resolution polling and continuation enqueueing.
    const resolutions = executions.resolutions
    let actor, approval, grant, service, routeInterrupted = false, closed = false
    const diagnostics = {}
    try {
      actor = await identities.login(p.username, p.password)
      approval = await identities.login(p.username, p.password, 'approval')
      p.sessionId = (await tasks.create(actor.user, randomUUID(), actor.token, p.workspaceId)).sessionId
      const acceptedTurn = await tasks.accept(actor.user,
        p.sessionId,
        randomUUID(),
        'Observe one owned command through original cloud resolution',
        actor.token)
      grant = await tasks.claim(randomUUID())
      if (!grant || grant.operationId !== acceptedTurn.operationId) throw new Error('Original operation grant absent')
      await writeFile(p.root + '/grant-private.json', JSON.stringify(grant) + '\n', { mode: 0o600, flag: 'wx' })
      const command = "sleep 8; printf 'employee4-original-resolution\\n'"
      const accepted = await executions.propose(grant.token, 'employee4-owned-resolution-call', command, '.')
      executions.start()
      let execution, runningResult, sandbox
      const dispatchDeadline = Date.now() + 60000
      while (Date.now() < dispatchDeadline) {
        execution = (await pool.query('SELECT * FROM pe_cloud_executions WHERE id=$1', [accepted.executionId])).rows[0]
        if (execution?.state === 'running' && execution.dispatch_request && execution.runner_instance_id) {
          sandbox = await manager.observeReady(p.sessionId, p.userId, execution.pod_uid, execution.runner_instance_id)
          try { runningResult = await manager.runner(sandbox.name, sandbox.token, 'GET', '/executions/' + execution.id) }
          catch (error) { if (!(error instanceof KubernetesError && error.status === 404)) throw error }
          if (runningResult?.state === 'running' && runningResult.instanceId === execution.runner_instance_id) break
        }
        if (['failed',
          'succeeded',
          'uncertain'].includes(execution?.state)) throw new Error('Original command did not reach running: ' + execution.state)
        await delay(50)
      }
      if (runningResult?.state !== 'running') throw new Error('Actual original Runner dispatch absent')
      const servicePath = kube.resourcePath(namespace, 'services', sandbox.name)
      service = await kube.call('GET', servicePath)
      await kube.call('PATCH', servicePath, { metadata: { resourceVersion: service.metadata.resourceVersion },
        spec: { selector: { 'powerevolve.employee4/route-block': randomUUID() } } })
      routeInterrupted = true
      const uncertainDeadline = Date.now() + 35000
      while (Date.now() < uncertainDeadline) {
        execution = (await pool.query('SELECT * FROM pe_cloud_executions WHERE id=$1', [accepted.executionId])).rows[0]
        if (execution?.state === 'uncertain') break
        await delay(50)
      }
      if (execution?.state !== 'uncertain' || execution.result !== null) throw new Error('Original worker did not issue uncertain')
      diagnostics.uncertain = structuredClone(execution)
      await executions.close(); closed = true
      await kube.call('PATCH', servicePath, { spec: { selector: { 'powerevolve.employee4/route-block': null } } })
      routeInterrupted = false
      await tasks.finish(grant.token, 'completed', null)
      let inspection
      const inspectDeadline = Date.now() + 15000
      while (Date.now() < inspectDeadline) {
        inspection = await resolutions.inspect(actor.user, execution.id)
        if (inspection.canStop) break
        await delay(200)
      }
      if (!inspection?.canStop) throw new Error('Original inspect cannot stop: ' + JSON.stringify(inspection))
      const request = { requestId: randomUUID(), executionId: execution.id, target: 'cloud', fingerprint: inspection.fingerprint,
        note: 'Employee4 owned original Runner route loss; stop the captured writer and reconcile without replay' }
      const acceptedResolution = await resolutions.resolve(actor.user, request, approval.token)
      // Let the already-dispatched command finish so the original service can preserve its terminal observation.
      let terminal
      const resultDeadline = Date.now() + 15000
      while (Date.now() < resultDeadline) {
        terminal = await manager.observeExecutionResolution({ userId: execution.user_id, sessionId: execution.session_id,
          workspaceId: p.workspaceId, generation: sandbox.generation, name: execution.sandbox_name,
          podUid: execution.pod_uid, runnerInstanceId: execution.runner_instance_id, binding: sandbox.binding }, execution.id)
        if (terminal?.state !== 'running') break
        await delay(200)
      }
      if (terminal?.state !== 'succeeded') throw new Error('Original terminal observation absent: ' + JSON.stringify(terminal))
      const polled = await resolutions.poll(new AbortController().signal)
      const status = await resolutions.status(actor.user, request.requestId)
      if (!polled || status.receipt?.state !== 'completed' || !status.receipt.stopConfirmed || !status.receipt.continuationQueued) {
        throw new Error('Original resolution did not close: ' + JSON.stringify(status))
      }
      const continuation = await tasks.claim(randomUUID())
      if (!continuation || continuation.sourceExecutionId !== execution.id) throw new Error('Unique original continuation absent')
      await tasks.finish(continuation.token, 'completed', null)
      const instance = (await pool.query('SELECT * FROM pe_sandbox_instances WHERE session_id=$1', [p.sessionId])).rows[0]
      const slot = (await pool.query('SELECT * FROM pe_mount_slots WHERE user_id=$1', [p.userId])).rows[0]
      const pods = observations.filter(x => x.path.includes('/pods/')).map(x => x.result)
      const podReady = pods.find(x => x.metadata.uid === instance.stop_pod_uid && x.status?.containerStatuses?.[0]?.ready)
      const podStopped = pods.find(x => x.metadata.uid === instance.stop_pod_uid && kubernetesPodStopStatus(x) === 'KUBELET_STOPPED')
      if (!podReady || !podStopped || instance.state !== 'deleted' || slot.state !== 'free') throw new Error('Actual original writer closure absent')
      for (const resource of ['sandboxes', 'pods', 'services', 'secrets']) {
        try {
          await kube.call('GET',
            kube.resourcePath(namespace,
              resource,
              instance.name))
          throw new Error('Owned writer resource remains') }

        catch (error) { if (!(error instanceof KubernetesError && error.status === 404)) throw error }
      }
      await identities.logout(actor.token); actor = null; await identities.logout(approval.token); approval = null
      const cut = (await pool.query("SELECT to_char(clock_timestamp() AT TIME ZONE 'UTC','YYYY-MM-DD\"T\"HH24:MI:SS.US\"Z\"') AS cut")).rows[0].cut
      await writeFile(p.root + '/original-resolution-results.json', JSON.stringify({ ownedFixture: true, productionSource: false,
        userId: p.userId, sessionId: p.sessionId, workspaceId: p.workspaceId, commandTimeoutMs: p.commandTimeoutMs,
        acceptedTurn, accepted, runningResult, uncertain: diagnostics.uncertain, inspection, request, acceptedResolution, terminal, polled,
        status,
        continuation: {
          operationId: continuation.operationId,
          source: continuation.source,
          sourceExecutionId: continuation.sourceExecutionId }
        ,

        podReady,
        podStopped,
        sandboxBeforeStop: observations.find(x => x.path.includes('/sandboxes/') && !x.result.metadata.deletionTimestamp)?.result,
        resources,
        resourcesAbsentAfterManagerStop: true,
        originalStopStatus: kubernetesPodStopStatus(podStopped),
        cut },
      ) + '\n',

      { mode: 0o600, flag: 'wx' })
      console.log(JSON.stringify({ root: p.root, uncertain: diagnostics.uncertain.state, finalState: status.receipt.finalState,
        resolution: status.receipt.state, originalStopStatus: kubernetesPodStopStatus(podStopped), namespace }))
    } finally {
      if (routeInterrupted && service) await kube.call('PATCH', kube.resourcePath(namespace, 'services', service.metadata.name),
        { spec: { selector: { 'powerevolve.employee4/route-block': null } } })
      if (!closed) await executions.close()
      if (actor) await identities.logout(actor.token)
      if (approval) await identities.logout(approval.token)
      await writeFile(p.root + '/diagnostic-rows.json', JSON.stringify({ ...diagnostics,
        executions: (await pool.query('SELECT * FROM pe_cloud_executions')).rows,
        resolutions: (await pool.query('SELECT * FROM pe_cloud_execution_resolutions')).rows,
        instances: (await pool.query('SELECT * FROM pe_sandbox_instances')).rows,
        slots: (await pool.query('SELECT * FROM pe_mount_slots')).rows, observations }) + '\n', { mode: 0o600, flag: 'wx' })
      await pool.end()
    }
  } catch (error) { ctx.appExit(1); throw error }
  ctx.effect(() => ctx.appReady.onReady(() => ctx.appExit(0)))
}
