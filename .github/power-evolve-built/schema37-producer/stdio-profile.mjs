/** Produce only an owned Schema37 compatibility cohort through the fixed original service source. */
import { readFile,writeFile,mkdir } from 'node:fs/promises'
import { randomUUID,randomBytes } from 'node:crypto'
import { createRequire } from 'node:module'
import { pathToFileURL } from 'node:url'
import { setTimeout as delay } from 'node:timers/promises'
export const name='ci-schema37-stdio'
/** Run the exact original service fixture and exit after its resources drain.
 * @param ctx Official launcher readiness and exit services.
 * @param config Current-job protected parameter file.
 */
export async function apply(ctx, config) {
  try {
    const p=JSON.parse(await readFile(config.parameterFile,'utf8'))
    if(!new URL(p.sourceUrl).pathname.startsWith('/pe_ci_schema37_'))throw new Error('Unowned original database')
    const load=file=>import(pathToFileURL(p.sourceRoot+'/products/power-evolve/application/src/'+file).href)
    const [,
      {
        transaction }
      ,
      {
        createStdioCloudServicesV2 }
      ,
      {
        loadStdioPlatformConfigV2 }
      ,
      {
        StdioOperationAdmissionV2 }
      ,
      {
        FileService }
      ,
      {
        SandboxManager }
      ,

      { KubernetesClient,KubernetesError },{ TaskStore },{ IdentityService },{ kubernetesPodStopStatus }]=await Promise.all([
      load('platform/stdio-v2-worker-store.ts'),
      load('platform/database.ts'),
      load('platform/stdio-v2-services.ts'),
      load('platform/stdio-v2-platform-config.ts'),
      load('platform/stdio-v2-operation-admission.ts'),

      load('platform/files.ts'),
      load('platform/sandbox.ts'),
      load('platform/kubernetes.ts'),
      load('platform/tasks.ts'),
      load('platform/identity.ts'),
      load('platform/pod-stop-status.ts')])
    const { Pool }=createRequire(p.targetRoot+'/products/power-evolve/application/package.json')('pg')
    const pool=new Pool({ connectionString:p.sourceUrl,max:6 }),kube=await KubernetesClient.fromFile(p.kubeconfig),raw=kube.call.bind(kube)
    const namespace='pe-ci-stdio-'+randomUUID().replaceAll('-',
        ''),
      pv='pe-ci-pv-'+randomUUID().replaceAll('-',
        ''),
      claim='owned-data',
      observations=[]
    const ns=await raw('POST',
      '/api/v1/namespaces',
      {
        apiVersion:'v1',
        kind:'Namespace',
        metadata:{
          name:namespace,
          labels:{
            'powerevolve.owner':p.owner },
        },
      },
    )
    const resources={
      namespace,
      namespaceUid:ns.metadata.uid,
      pv,
      dataRoot:p.dataRoot,
      claim }

    await writeFile(p.root+'/physical-resources.json',
      JSON.stringify(resources,
        null,
        2)+'\n',
      {
        mode:0o600,
        flag:'wx' },
    )
    try{
      await raw('POST',
        '/apis/node.k8s.io/v1/runtimeclasses',
        {
          apiVersion:'node.k8s.io/v1',
          kind:'RuntimeClass',
          metadata:{
            name:'gvisor',
            labels:{
              'powerevolve.owner':p.owner },
          }
          ,
          handler:'runsc' },
      )}
    catch(e){
      if(!(e instanceof KubernetesError&&e.status===409))throw e}

    await mkdir(p.dataRoot,{ recursive:true,mode:0o750 })
    const volume=await raw('POST',
      '/api/v1/persistentvolumes',
      {
        apiVersion:'v1',
        kind:'PersistentVolume',
        metadata:{
          name:pv,
          labels:{
            'powerevolve.owner':p.owner },
        }
        ,
        spec:{
          capacity:{
            storage:'1Gi' }
          ,
          volumeMode:'Filesystem',
          accessModes:['ReadWriteMany'],
          persistentVolumeReclaimPolicy:'Retain',
          storageClassName:'',
          hostPath:{
            path:p.dataRoot,
            type:'Directory' }
          ,
          claimRef:{
            name:claim,
            namespace },
        },
      },
    )
    const pvc=await raw('POST',
      '/api/v1/namespaces/'+namespace+'/persistentvolumeclaims',
      {
        apiVersion:'v1',
        kind:'PersistentVolumeClaim',
        metadata:{
          name:claim,
          namespace,
          labels:{
            'powerevolve.owner':p.owner },
        }
        ,
        spec:{
          accessModes:['ReadWriteMany'],
          storageClassName:'',
          volumeName:pv,
          resources:{
            requests:{
              storage:'1Gi' },
          },
        },
      },
    )
    resources.pvUid=volume.metadata.uid
    resources.pvcUid=pvc.metadata.uid
    await writeFile(p.root+'/physical-resources.json',
      JSON.stringify(resources,
        null,
        2)+'\n',
      {
        mode:0o600 },
    )
    await raw('POST',
      '/api/v1/namespaces/'+namespace+'/serviceaccounts',
      {
        apiVersion:'v1',
        kind:'ServiceAccount',
        metadata:{
          name:'power-evolve-runner',
          namespace }
        ,
        automountServiceAccountToken:false },
    )
    kube.call=async(method,path,...args)=>{
      if(!path.startsWith('/api/v1/namespaces/'+namespace+'/')&&!path.startsWith('/apis/agents.x-k8s.io/v1beta1/namespaces/'+namespace+'/')&&!(/^\/api\/v1\/nodes\/[^/]+$/.test(path)&&method==='GET'))throw new Error('Unowned original Kubernetes request: '+path)
      const result=await raw(method,path,...args)
      if(method==='GET'&&(path.includes('/pods/')||path.includes('/sandboxes/')))observations.push({ path,result:structuredClone(result) })
      return result}
    const files=new FileService(pool,
      p.dataRoot+'/workspaces',
      {
        uid:1000,
        gid:1000 },
    )
    await files.init()
    await files.safe.ensureWorkspace(p.workspaceId)
    const pin={
      kind:'cloud',
      deploymentId:randomUUID(),
      protocolVersion:2,
      platform:p.image.platform,
      imageReference:p.image.imageReference,
      configImageId:p.image.configImageId,
      runtimeImageIds:p.image.runtimeImageIds }

    const approvalKeyFile=p.root+'/original-approval-key',
      configFile=p.root+'/original-policy.json'
    await writeFile(approvalKeyFile,
      randomBytes(32).toString('hex')+'\n',
      {
        mode:0o600,
        flag:'wx' },
    )
    const settings={
      approvalKeyFile,
      limits:p.limits,
      management:p.management,
      admission:{
        maxConnections:8,
        maxTools:16,
        maxSnapshotBytes:65536,
        maxDescriptionBytes:8192 }
      ,
      cloudDeployment:pin,
      maxReplyBytes:262144,
      maxPendingPerUser:8,
      maxCallsPerChain:8,
      chainLifetimeMs:60000,
      approvalLifetimeMs:60000,
      worker:{
        pollMs:100,
        renewMs:1000,
        leaseMs:30000,
        maxActive:2,
        maxCandidates:8 }
      ,
      transport:{
        requestTimeoutMs:2000,
        maxTrackedActions:8 },
    }

    await writeFile(configFile,
      JSON.stringify(settings)+'\n',
      {
        mode:0o600,
        flag:'wx' },
    )
    const stdioConfig=await loadStdioPlatformConfigV2(configFile)
    const selection=new StdioOperationAdmissionV2(files,
      {
        limits:p.limits,
        admission:settings.admission,
        maxReplyBytes:settings.maxReplyBytes,
        cloudDeployment:pin },
    )
    const tasks=new TaskStore(pool,
      {
        maxEventBytes:262144,
        leaseMs:60000,
        maxPendingPerUser:8,
        maxActivePerUser:1,
        executionEnabled:true,
        stdioV2Admission:{
          selection,
          reservedNames:[] },
      },
    )
    const manager=new SandboxManager(kube,
      files,
      pool,
      'E'.repeat(43),
      {
        namespace,
        image:pin.imageReference,
        localRoot:p.dataRoot,
        nodeRoot:'',
        volumeClaimName:claim,
        readyTimeoutMs:45000,
        stdioV2:{
          limits:p.limits,
          maxReplyBytes:settings.maxReplyBytes }
        ,
        fileScan:{
          maxEntries:100,
          maxHashBytes:1048576,
          timeoutMs:1000,
          maxSnapshotBytes:1048576,
          maxFiles:100 },
      },
    )
    const captures=[],
      capture=manager.captureStdioV2.bind(manager)
    manager.captureStdioV2=async(...args)=>{
      const result=await capture(...args)
      captures.push(structuredClone(result))
      return result}

    const identities=new IdentityService(pool,
        180000),
      stop=new AbortController(),
      stopCall=new AbortController()
    let actor,
      approval,
      services,
      running
    const cohorts=[],takeovers=[],mutations=[];let firstWorkerId,created,createRequest
    async function drive(accepted,mode) {
      const controller=new AbortController();running=services.worker.run(controller.signal);let approvalView,decision,terminal
      try{const until=Date.now()+45000
        while(Date.now()<until){terminal=(await pool.query('SELECT * FROM pe_stdio_v2_actions WHERE id=$1',[accepted.actionId])).rows[0]
          if(terminal?.state==='pending'&&!approvalView){approvalView=await services.authorization.inspect(approval.token,accepted.actionId)
            decision=mode==='cancel'?await services.actions.cancel(actor.token,
              {
                actionId:accepted.actionId },
            ):await services.authorization.decide(approval.token,
              {
                actionId:accepted.actionId,
                fingerprint:approvalView.fingerprint,
                decision:mode==='reject'?'reject':'once' },
            )}

          if(['succeeded','failed','cancelled','uncertain','quarantined'].includes(terminal?.state))break;await delay(50)}
      }finally{controller.abort();await running;await services.worker.stop()}
      if(!terminal||!['succeeded','failed','cancelled'].includes(terminal.state))throw new Error('Original mixed action not closed')
      return { accepted,approvalView,decision,terminalState:terminal.state }
    }
    async function discover(revision){
      const input={
        requestId:randomUUID(),
        connectionId:created.connectionId,
        expectedRevision:revision,
        sessionId:p.sessionId,
        target:{
          kind:'cloud' },
      }

      const accepted=await services.discovery.check(actor.token,
          input),
        outcome=await drive(accepted,
          'once')
      if(outcome.terminalState!=='succeeded')throw new Error('Mixed discovery failed')
      cohorts.push({
        ...outcome,
        input,
        phase:'discover' },
      )
      const toggle={
        requestId:randomUUID(),
        connectionId:created.connectionId,
        expectedRevision:revision,
        enabled:true }

      mutations.push({
        input:toggle,
        receipt:await services.connections.toggle(actor.token,
          toggle) },
      )
    }

    try{
      actor=await identities.login(p.username,
        p.password)
      p.sessionId=(await tasks.create(actor.user,
        randomUUID(),
        actor.token,
        p.workspaceId)).sessionId
      approval=await identities.login(p.username,
        p.password,
        'approval')
      firstWorkerId=randomUUID();services=createStdioCloudServicesV2(pool,tasks,selection,files,manager,stdioConfig,firstWorkerId)
      createRequest={
        requestId:randomUUID(),
        configuration:{
          name:'Original mixed initial catalog',
          invocation:{
            program:'node',
            argv:['/opt/power-evolve/ci-stdio-v2-fixture.mjs',
              'good',
              '/tmp/ci-stdio-trace.jsonl'],
            cwd:'.' },
        },
      }

      created=await services.connections.create(actor.token,
        createRequest)
      await discover(1)
      const currentSelection=await transaction(pool,client=>selection.select(client,actor.user.userId,p.sessionId,{ kind:'cloud' },[]))
      let instance,slot;const until=Date.now()+45000
      while(Date.now()<until){
        await manager.recycleIdle(0)
        instance=(await pool.query('SELECT * FROM pe_sandbox_instances WHERE session_id=$1',
          [p.sessionId])).rows[0]
        slot=(await pool.query('SELECT * FROM pe_mount_slots WHERE user_id=$1',
          [p.userId])).rows[0]
        if(instance?.state==='deleted'&&slot?.state==='free')break
        await delay(100)}

      if(instance?.state!=='deleted'||slot?.state!=='free'||instance.stop_evidence?.status!=='KUBELET_STOPPED')throw new Error('Mixed writer closure absent')
      const pods=observations.filter(x=>x.path.includes('/pods/')).map(x=>x.result),
        podReady=pods.find(x=>x.metadata.uid===instance.stop_pod_uid&&x.status?.containerStatuses?.[0]?.ready),
        podStopped=pods.find(x=>x.metadata.uid===instance.stop_pod_uid&&kubernetesPodStopStatus(x)==='KUBELET_STOPPED')
      if(!podReady||!podStopped)throw new Error('Mixed raw stop absent')
      for(const resource of ['sandboxes',
        'pods',
        'services',
        'secrets'])try{
        await kube.call('GET',
          kube.resourcePath(namespace,
            resource,
            instance.name))
        throw new Error('Mixed resource remains')}
      catch(error){
        if(!(error instanceof KubernetesError&&error.status===404))throw error}

      const cut=(await pool.query("SELECT to_char(clock_timestamp() AT TIME ZONE 'UTC','YYYY-MM-DD\"T\"HH24:MI:SS.US\"Z\"') AS cut")).rows[0].cut
      await writeFile(p.root+'/original-ready-stdio-results.json',
        JSON.stringify({
          ownedFixture:true,
          productionSource:false,
          userId:p.userId,
          sessionId:p.sessionId,
          workspaceId:p.workspaceId,
          created,
          createRequest,
          cohorts,
          takeovers,
          mutations,
          currentSelection,
          captures,
          podReady,
          podStopped,
          pvc:await raw('GET',
            '/api/v1/namespaces/'+namespace+'/persistentvolumeclaims/'+claim),
          pv:await raw('GET',
            '/api/v1/persistentvolumes/'+pv),
          resources,
          resourcesAbsentAfterManagerStop:true,
          deploymentPin:pin,
          limits:p.limits,
          management:p.management,
          cut,
          originalStopStatus:kubernetesPodStopStatus(podStopped) },
        )+'\n',
        {
          mode:0o600,
          flag:'wx' },
      )
      console.log(JSON.stringify({
        cohorts:cohorts.map(x=>({
          phase:x.phase,
          state:x.terminalState,
          mode:x.mode }
        )),
        stop:instance.stop_evidence.status },
      ))
    }
    finally{
      stop.abort()
      stopCall.abort()
      if(running)await running
      if(services)await services.worker.stop()
      if(actor)await identities.logout(actor.token)
      if(approval)await identities.logout(approval.token)
      await writeFile(p.root+'/diagnostic-rows.json',
        JSON.stringify({
          actions:(await pool.query('SELECT * FROM pe_stdio_v2_actions')).rows,
          executions:(await pool.query('SELECT * FROM pe_cloud_executions')).rows,
          instances:(await pool.query('SELECT * FROM pe_sandbox_instances')).rows,
          slots:(await pool.query('SELECT * FROM pe_mount_slots')).rows,
          captures,
          observations },
        )+'\n',
        {
          mode:0o600,
          flag:'wx' },
      )
      await pool.end()}

  } catch (error) { ctx.appExit(1); throw error }
  ctx.effect(() => ctx.appReady.onReady(() => ctx.appExit(0)))
}
