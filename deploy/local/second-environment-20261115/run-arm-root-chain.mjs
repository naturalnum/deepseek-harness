/** Trusted operator for this owned, existing SDK. Inert without --execute-owned-arm-root-01. */
import fs from 'node:fs'
import {armValidationCredentials} from './arm-validation-settings.mjs'
import http from 'node:http'
import {createHash} from 'node:crypto'
import {createRequire} from 'node:module'
import {pathToFileURL} from 'node:url'
import {spawn,spawnSync} from 'node:child_process'
import {setTimeout as delay} from 'node:timers/promises'
const A='/opt/dsh-features/arm-native-01',D='/dsh-state/namespace-arm-02',H='/run/dsh-feature-root',T='/tmp/dsh-feature-home/sdk-validation'
const RESOURCE='587be4cb-705f-46ce-90bf-49f1d7a346e5'
const BACKEND='e8ce05010ab49ad0a33d0a95d0eb02c4ae5ba5b56517476d130dba8ca2441a9c'
const N='/dsh-tools/node24',NS='/usr/bin/nsenter',R=A
let SDK
const sha=b=>createHash('sha256').update(b).digest('hex'),read=p=>JSON.parse(fs.readFileSync(p))
const need=(v,c)=>{if(!v)throw Object.assign(new Error(c),{check:c})}
const req=createRequire('/opt/dsh-installed-products/package.json')
const engine=(method,path,body,raw=false)=>new Promise((resolve,reject)=>{const bytes=body===undefined?undefined:Buffer.from(JSON.stringify(body));const q=http.request({socketPath:'/root/sdk-arm-control/docker.sock',method,path,headers:bytes?{'content-type':'application/json','content-length':bytes.length}:{}},res=>{const c=[];res.on('data',b=>c.push(b));res.on('end',()=>{const b=Buffer.concat(c);if(res.statusCode>=300)return reject(Object.assign(new Error('engine-status'),{check:'owned-engine-http-'+res.statusCode}));resolve(raw?b:b.length?JSON.parse(b):undefined)})});q.setTimeout(5000,()=>q.destroy(new Error('engine-timeout')));q.on('error',reject);q.end(bytes)})
const health=port=>new Promise((resolve,reject)=>{const q=http.get('http://127.0.0.1:'+port+'/health',r=>{const c=[];r.on('data',b=>c.push(b));r.on('end',()=>{try{resolve({status:r.statusCode,body:JSON.parse(Buffer.concat(c))})}catch{reject(new Error('health-not-json'))}})});q.setTimeout(3000,()=>q.destroy(new Error('health-timeout')));q.on('error',reject)})
const write=(p,b,mode=0o600,uid=0,gid=0)=>{const fd=fs.openSync(p,fs.constants.O_WRONLY|fs.constants.O_CREAT|fs.constants.O_EXCL|fs.constants.O_NOFOLLOW,mode);try{fs.fchownSync(fd,uid,gid);fs.fchmodSync(fd,mode);fs.writeFileSync(fd,b);fs.fsyncSync(fd)}finally{fs.closeSync(fd)}}
let stage='arguments',child,keeper,journal
const observe=(event,details={})=>{if(journal!==undefined){fs.writeSync(journal,JSON.stringify({at:new Date().toISOString(),event,stage,...details})+'\n');fs.fsyncSync(journal)}}
const current=()=>{const t=fs.readFileSync('/proc/'+keeper.pid+'/stat','utf8');need(t.slice(t.lastIndexOf(')')+2).split(/\s+/)[19]===keeper.startTicks&&fs.readlinkSync('/proc/'+keeper.pid+'/ns/mnt')===keeper.mountNamespace,'keeper-identity-changed')}
function command(label,args){stage=label;current();observe('intent',{args});const out=fs.openSync(D+'/'+label+'.private.log','wx',0o600);let x;try{x=spawnSync(args[0],args.slice(1),{stdio:['ignore',out,out],timeout:90000})}finally{fs.closeSync(out)}observe('terminal',{exit:x.status,signal:x.signal,errorCode:x.error?.code});need(x.status===0&&!x.error,'command-failed-'+label);current()}
const inside=(label,args)=>command(label,[NS,'--mount=/proc/'+keeper.pid+'/ns/mnt','--root=/proc/'+keeper.pid+'/root','--wd=/opt/dsh-installed-products',N,...args])
const stable=x=>Array.isArray(x)?x.map(stable):x&&typeof x==='object'?Object.fromEntries(Object.entries(x).filter(([k])=>k!=='rootMountId').map(([k,v])=>[k,stable(v)])):x
try{
 if(process.argv.length===2){console.log(JSON.stringify({inert:true,entry:'--execute-owned-arm-root-01'}));process.exit(0)}
 need(process.argv.length===3&&process.argv[2]==='--execute-owned-arm-root-01','exact-execution-argument-required')
 need(process.platform==='linux'&&process.arch==='arm64'&&process.getuid()===0,'actual-linux-arm64-root-required')
 stage='preflight-before-launch'
 const manifest=read(A+'/MANIFEST.json');for(const [name,pin]of Object.entries(manifest.files)){const target=name.startsWith('composition-v4-public/')?'/opt/dsh-features/public-inputs/'+name:A+'/'+name;need(sha(fs.readFileSync(target))===pin,'prepared-file-pin-'+name)}
 need(!fs.existsSync(D),'fresh-operation-directory-required-no-replay')
 const planInput=read(A+'/plan.json'),initial=await engine('GET','/containers/json?all=1'),self=read(A+'/carrier.identity.public.json');
 const initialIds=initial.map(x=>x.Id).sort(),initialRunning=initial.filter(x=>x.State==='running').map(x=>x.Id).sort();const known=read(A+'/known-owned-backend-topology.json');need(JSON.stringify(initialIds)===JSON.stringify([...known.allContainerIds,self.id].sort())&&JSON.stringify(initialRunning)===JSON.stringify([...known.runningContainerIds,self.id].sort()),'exact-owned-initial-topology-required');
 need(initialIds.includes(self.id)&&!initial.some(x=>x.Names.includes('/'+planInput.sdkName)),'owned-new-arm-sdk-must-not-exist');
 const protectedCredential=fs.lstatSync('/new-secrets/root-credentials.json');need(protectedCredential.isFile()&&!protectedCredential.isSymbolicLink()&&protectedCredential.uid===0&&(protectedCredential.mode&0o077)===0,'protected-new-arm-home-credentials-required');
 const {parseRootDeploymentInput}=await import(pathToFileURL(req.resolve('@deepseek-ai/dsh-pe-opensandbox')).href);
 fs.mkdirSync(D,{mode:0o700});journal=fs.openSync(D+'/operator.journal.jsonl','wx',0o600)
 observe('intent:complete-new-arm-chain',{carrierId:self.id,existingAmdSdkUntouched:true})
 const fds=['plan-final.json','ready.json','journal.jsonl'].map(n=>fs.openSync(D+'/'+n,'wx+',0o600))
 const log=fs.openSync(D+'/launcher.private.log','wx',0o600),input=A+'/namespace-launch.input.json',inputSha=sha(fs.readFileSync(input))
 stage='launch-original-namespace'
 child=spawn('/bin/sh',['-c',"/bin/sh \"$1\" launch --input \"$2\" --sha256 \"$3\"; code=$?; printf '%s\\n' \"$code\" > \"$4\"; exit \"$code\"",'owned-root-02',R+'/launch-feature-namespace.v3.sh',input,inputSha,D+'/launcher.exit.code'],{detached:true,stdio:['ignore',log,log,...fds]})
 child.on('exit',(exit,signal)=>{write(D+'/launcher.exit.json',JSON.stringify({at:new Date().toISOString(),pid:child.pid,exit,signal})+'\n')})
 for(const fd of [...fds,log])fs.closeSync(fd)
 observe('observed:launcher-spawn',{pid:child.pid,inputSha256:inputSha})
 const deadline=Date.now()+30000;let state
 while(Date.now()<deadline){need(child.exitCode===null,'launcher-exited-before-measurement');try{const events=fs.readFileSync(D+'/journal.jsonl','utf8').trim().split('\n').filter(Boolean).map(x=>JSON.parse(x));const launched=events.find(x=>x.event==='launch-original-namespace');if(launched){state=read('/proc/'+launched.shellPid+'/root/run/dsh-feature-launch-v1/state.json');break}}catch(e){if(e.code!=='ENOENT'&&!(e instanceof SyntaxError))throw e}await delay(100)}
 need(Number.isSafeInteger(state?.shellPid)&&state.resourceId===RESOURCE,'waiting-namespace-not-observed')
 const stat=fs.readFileSync('/proc/'+state.shellPid+'/stat','utf8');keeper={pid:state.shellPid,startTicks:stat.slice(stat.lastIndexOf(')')+2).split(/\s+/)[19],mountNamespace:state.mountNamespace};current()
 write(D+'/current.json',JSON.stringify(keeper)+'\n')
 const P='/proc/'+keeper.pid+'/root',I='/run/dsh-feature-input-v2';fs.mkdirSync(P+I,{mode:0o700})
 const planBytes=fs.readFileSync(D+'/plan-final.json'),plan=JSON.parse(planBytes);need(sha(planBytes)===state.planSha256,'fresh-measurement-pin-required')
 const owner=read('/srv/dsh-features-'+RESOURCE+'/owner.json');need(owner.domains.length===11&&plan.slots.length===3,'original-eleven-arm-domains-required')
 write(P+I+'/storage-plan.json',planBytes,0o444)
 const sdkParameters=read(A+'/sdk-parameters.prepared.json');sdkParameters.plan={path:I+'/storage-plan.json',sha256:state.planSha256,finalPath:H+'/storage-plan.json'};
 const sdkBytes=Buffer.from(JSON.stringify(sdkParameters,null,2)+'\n');write(P+I+'/sdk-parameters.json',sdkBytes,0o400);
 inside('assemble-new-arm-sdk',[A+'/assemble-owned-arm-sdk.mjs','--input',I+'/sdk-parameters.json','--sha256',sha(sdkBytes),'--output-dir',I+'/sdk-private']);
 for(const name of fs.readdirSync(P+I+'/sdk-private')){const source=P+I+'/sdk-private/'+name,st=fs.lstatSync(source);need(st.isFile()&&!st.isSymbolicLink()&&st.uid===0&&st.nlink===1,'ordinary-private-sdk-source-required');write('/sdk-arm-work/'+name,fs.readFileSync(source),st.mode&0o7777)}
 const body=read('/sdk-arm-work/sdk-container-create.private.json');need(body.Image===planInput.images.server,'exact-arm-sdk-body-required');body.Labels['pe.sdk-linux-owner']=RESOURCE;body.Labels['pe.sdk-linux-role']='arm-sdk';body.Labels['pe.lifecycle-owner']='Main';
 stage='create-new-arm-sdk';observe('intent:create-new-arm-sdk',{image:body.Image,name:planInput.sdkName});
 const created=await engine('POST','/containers/create?name='+encodeURIComponent(planInput.sdkName),body);SDK=created.Id;write(D+'/sdk-created.public.json',JSON.stringify({id:SDK,name:planInput.sdkName,image:body.Image})+'\n');
 await engine('POST','/containers/'+SDK+'/start');const actual=await engine('GET','/containers/'+SDK+'/json');need(actual.State.Running&&actual.Image===body.Image,'new-arm-sdk-not-running-with-exact-selector');
 let healthy=false;const healthDeadline=Date.now()+15000;while(Date.now()<healthDeadline){try{const h=await health(planInput.sdkPort);if(h.status===200&&h.body.status==='healthy'){healthy=true;break}}catch{}await delay(250)}need(healthy,'new-arm-sdk-health-failed');
 const logs=await engine('GET','/containers/'+SDK+'/logs?stdout=1&stderr=1&tail=all',undefined,true);let pos=0,chunks=[];while(pos+8<=logs.length){let n=logs.readUInt32BE(pos+4);need(n<=logs.length-pos-8,'sdk-log-framing');chunks.push(logs.subarray(pos+8,pos+8+n));pos+=8+n}
 need(Buffer.concat(chunks).toString().split('\n').some(l=>{try{const x=JSON.parse(l);return x.status==='original-sdk-model-and-selected-views-checked'&&x.viewsChecked}catch{return false}}),'original-arm-sdk-model-and-views-not-passed');
 const all=await engine('GET','/containers/json?all=1'),expectedIds=[...initialIds,SDK].sort(),expectedRunning=[...initialRunning,SDK].sort();
 need(JSON.stringify(all.map(x=>x.Id).sort())===JSON.stringify(expectedIds)&&JSON.stringify(all.filter(x=>x.State==='running').map(x=>x.Id).sort())===JSON.stringify(expectedRunning),'engine-inventory-changed-during-new-sdk-start');
 need(!all.some(x=>x.ImageID===planInput.images.workload||x.Image===planInput.images.workload),'qualified-arm-workload-already-present');
 write(A+'/SDK-INITIAL-TOPOLOGY.json',JSON.stringify({resourceId:RESOURCE,containerIds:expectedIds,runningContainerIds:expectedRunning})+'\n',0o400);
 const facts={at:new Date().toISOString(),containerIds:expectedIds,runningContainerIds:expectedRunning,qualifiedWorkloadContainers:0};
 const depBytes=fs.readFileSync(P+I+'/sdk-private/rootDeployment.json'),dep=JSON.parse(depBytes);parseRootDeploymentInput(dep);need(dep.lifecycle.platform==='arm64'&&dep.lifecycle.imageDigest===planInput.images.workload&&dep.selection.serverImageDigest===planInput.images.server,'new-exact-arm-root-deployment-required');
 write(P+I+'/rootDeployment.json',depBytes);
 const params=read(A+'/root-parameters.prepared.json');params.storage.planSourcePath=I+'/storage-plan.json';params.storage.planSha256=state.planSha256
 params.executionDeployment={sourcePath:I+'/rootDeployment.json',path:H+'/rootDeployment.json',sha256:sha(depBytes)}
 params.sourceTemplate={path:A+'/root-with-validation.public-template.json.in',sha256:sha(fs.readFileSync(A+'/root-with-validation.public-template.json.in'))}
 const paramBytes=Buffer.from(JSON.stringify(params,null,2)+'\n');write(P+I+'/root-parameters.complete.json',paramBytes)
 inside('prepare-search-inputs',['/opt/dsh-installed-products/deploy/local/second-environment-20261115/prepare-native-search-inputs.mjs','--input',I+'/root-parameters.complete.json','--sha256',sha(paramBytes),'--output-dir',I+'/search-inputs'])
 const finalParams=P+I+'/search-inputs/root-parameters.native-search.json'
 inside('generate-root-profile',[R+'/generate-feature-root-profile-v3.mjs','--input',I+'/search-inputs/root-parameters.native-search.json','--sha256',sha(fs.readFileSync(finalParams)),'--output-dir',H])
 stage='install-three-measured-slot-profiles';current();const installation=read(P+H+'/ACCOUNT-INSTALLATION.json');need(installation.slots.length===3,'three-generated-slots-required')
 const {initProfile}=await import(pathToFileURL(req.resolve('@deepseek-ai/dsh-app-boot')).href)
 for(const slot of installation.slots){const measured=plan.slots.find(s=>s.slotId===slot.slotId);need(measured&&slot.target===measured.private.rootPath+'/profile/cordis.patch.yml','measured-private-profile-path-required')
  const target=P+slot.target,dir=target.slice(0,target.lastIndexOf('/')),bytes=fs.readFileSync(P+H+'/account-slots/'+slot.slotId+'/cordis.patch.yml');need(sha(bytes)===slot.sha256,'candidate-slot-digest-changed')
  need(!fs.existsSync(dir),'fresh-profile-required-existing-state-retained');observe('intent:install-slot',{slotId:slot.slotId,target:slot.target,sha256:slot.sha256})
  fs.mkdirSync(dir,{mode:0o700});fs.chownSync(dir,2000,2000);write(target,bytes,0o600,2000,2000);initProfile(dir,[])
  for(const name of ['package.json','pnpm-workspace.yaml']){const st=fs.lstatSync(dir+'/'+name);need(st.isFile()&&!st.isSymbolicLink()&&st.nlink===1,'normal-profile-metadata-required');fs.chownSync(dir+'/'+name,2000,2000);fs.chmodSync(dir+'/'+name,0o600)}
  const st=fs.lstatSync(target);need(st.uid===2000&&st.gid===2000&&(st.mode&0o7777)===0o600&&sha(fs.readFileSync(target))===slot.sha256,'slot-installation-did-not-settle');observe('observed:install-slot',{slotId:slot.slotId})}
 stage='install-original-home-credentials';write(P+H+'/credentials.json',JSON.stringify(armValidationCredentials(read('/new-secrets/root-credentials.json')))+'\n',0o600,2000,2000)
 // The app creates test output beneath its original auxiliary HOME on each actual boot.
 stage='collect-first-deployment-read-only-proof';current()
 const {Pool}=createRequire('/opt/dsh-installed-products/packages/cloud/pe-cloud-runtime/package.json')('pg'),password=fs.readFileSync('/new-secrets/pg-password','utf8').trim();const pool=new Pool({host:'10.247.121.3',port:5432,user:planInput.pgRole,database:planInput.database,password,max:1,connectionTimeoutMillis:3000,statement_timeout:3000})
 let pg;try{const c=await pool.connect();try{await c.query('BEGIN READ ONLY');const names=['pe_sandbox_allocations','pe_account_owners'];const counts=[];for(const name of names){const p=await c.query('SELECT to_regclass($1) AS relation',['public.'+name]);counts.push(p.rows[0].relation===null?{name,present:false,count:0}:{name,present:true,count:Number((await c.query('SELECT count(*)::integer AS count FROM public.'+name)).rows[0].count)})}const others=await c.query("SELECT count(*)::integer AS count FROM pg_stat_activity WHERE datname=current_database() AND backend_type='client backend' AND pid<>pg_backend_pid()");await c.query('ROLLBACK');pg={database:planInput.database,allocationCount:counts[0].count,ownedAccountCount:counts[1].count,otherBackendCount:others.rows[0].count,readOnlyObservation:true};write(D+'/postgres-observation.json',JSON.stringify({at:new Date().toISOString(),counts,...pg})+'\n')}finally{c.release()}}finally{await pool.end()}
 need(pg.allocationCount===0&&pg.ownedAccountCount===0&&pg.otherBackendCount===0,'first-deployment-pg-not-empty')
 let uid2000=0;for(const p of fs.readdirSync('/proc').filter(p=>/^\d+$/.test(p))){try{if(/^Uid:\s+(.+)$/m.exec(fs.readFileSync('/proc/'+p+'/status','utf8'))?.[1].trim().split(/\s+/).includes('2000'))uid2000++}catch(e){if(!['ENOENT','ESRCH'].includes(e.code))throw e}}
 need(uid2000===0,'application-uid-already-present');need(Date.now()-Date.parse(facts.at)<120000,'backend-facts-expired-before-initialization')
 const proof={schema:'dsh-feature-first-environment-evidence/v1',resourceId:RESOURCE,carrier:'dsh-sdk-arm-587be4cb',keeper,bootId:fs.readFileSync('/proc/sys/kernel/random/boot_id','utf8').trim(),observedAt:new Date().toISOString(),application:{neverStarted:true,cliLaunchIntentCount:0,uid2000ProcessCount:uid2000},postgres:pg,sdk:{backendContainerId:BACKEND,qualifiedWorkloadImage:planInput.images.workload,qualifiedWorkloadContainers:facts.qualifiedWorkloadContainers,containerIds:facts.containerIds,runningContainerIds:facts.runningContainerIds,readOnlyObservation:true}}
 write(A+'/root-evidence.json',JSON.stringify(proof)+'\n')
 const pin=path=>({path,sha256:sha(fs.readFileSync(path))});const env={schema:'dsh-environment-record-initialization/v1',resourceId:RESOURCE,originalProvisionInput:pin(A+'/static-arm-existing.json'),originalProvisionOwner:pin('/srv/dsh-features-'+RESOURCE+'/owner.json'),rootEvidence:pin(A+'/root-evidence.json')}
 write(A+'/environment-input.json',JSON.stringify(env)+'\n')
 const tokens={KEEPER_PID:String(keeper.pid),KEEPER_START_TICKS:keeper.startTicks,KEEPER_NAMESPACE:keeper.mountNamespace,PLAN_SHA:state.planSha256,OWNER_SHA:env.originalProvisionOwner.sha256,PROVISION_SHA:env.originalProvisionInput.sha256,SDK_ID:SDK,WORKLOAD_IMAGE:planInput.images.workload,SDK_ALL_IDS_JSON:JSON.stringify(expectedIds),SDK_ALL_COUNT:String(expectedIds.length),SDK_RUNNING_IDS_JSON:JSON.stringify(expectedRunning)};
 let initializer=fs.readFileSync(A+'/initialize-environment-records.public-template.mjs.in','utf8');for(const [key,value]of Object.entries(tokens))initializer=initializer.replaceAll('@@'+key+'@@',value);need(!initializer.includes('@@'),'live-initializer-identity-placeholder-remains');write(A+'/initialize-environment-records.mjs',initializer,0o444);
 command('initialize-three-environment-records',[N,A+'/initialize-environment-records.mjs','--initialize','--input',A+'/environment-input.json','--sha256',sha(fs.readFileSync(A+'/environment-input.json'))])
 stage='publish-original-fd4-inode';current();const generation=read(P+H+'/GENERATION.json')
 const ready={schema:'dsh-feature-namespace-ready/v1',resourceId:RESOURCE,planSha256:state.planSha256,rootDeploymentSha256:sha(fs.readFileSync(P+H+'/rootDeployment.json')),profileSha256:sha(fs.readFileSync(P+H+'/profiles/cloud/cordis.patch.yml')),baseConfigSha256:state.baseConfigSha256,configurationComplete:true}
 need(ready.profileSha256===generation.profileSha256&&ready.planSha256===generation.storagePlanSha256,'original-generation-inputs-changed')
 const expected=state.administratorDescriptors[1],fd=fs.openSync(D+'/ready.json',fs.constants.O_RDWR|fs.constants.O_NOFOLLOW)
 try{const st=fs.fstatSync(fd);need(String(st.dev)===expected.device&&String(st.ino)===expected.inode&&st.uid===0&&st.nlink===1&&st.size===0&&(st.mode&0o7777)===0o600,'original-empty-fd4-inode-required');const bytes=Buffer.from(JSON.stringify(ready)+'\n');let n=0;while(n<bytes.length)n+=fs.writeSync(fd,bytes,n,bytes.length-n,n);fs.fsyncSync(fd)}finally{fs.closeSync(fd)}
 observe('observed:ready-published',{...ready,originalInodePreserved:true,existingAmdSdkUntouched:true})
 stage='observe-original-seal-appcheck-cli';const limit=Date.now()+180000
 while(Date.now()<limit){need(child.exitCode===null,'original-launcher-exited-before-app-ready');current();if(fs.existsSync(P+T+'/application-ready.json')){const readyEvent=read(P+T+'/application-ready.json');const logs=fs.readFileSync(D+'/launcher.private.log','utf8');need(logs.includes('sealed-new-root-inputs-not-application-ready')&&logs.includes('kernel-app-preflight-passed-not-application-ready'),'original-seal-and-kernel-app-check-not-observed');const result={status:'normal-root-application-ready',at:new Date().toISOString(),keeper,planSha256:state.planSha256,rootDeploymentSha256:ready.rootDeploymentSha256,profileSha256:ready.profileSha256,sdkContainerId:SDK,existingAmdSdkUntouched:true,testOutputDirectory:T,appReady:readyEvent,nativeBusinessStarted:false};write(D+'/ROOT-READY.public.json',JSON.stringify(result)+'\n');observe('complete:root-ready',result);console.log(JSON.stringify(result));child.unref();fs.closeSync(journal);process.exit(0)}await delay(250)}
 need(false,'application-ready-not-observed-within-finite-budget')
}catch(error){observe('failed-or-unknown-no-retry',{check:error.check,errorCode:error.code});const result={status:'failed-or-unknown-no-retry',stage,check:error.check,errorCode:error.code,keeper,launcherPid:child?.pid,launcherExit:child?.exitCode,cleanupAttempted:false,secretsPrinted:false};if(fs.existsSync(D))write(D+'/operator-failure.public.json',JSON.stringify(result)+'\n');console.error(JSON.stringify(result));if(child)child.unref();process.exitCode=1}
