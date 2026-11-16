/** Correct only the known public ARM settings after a normal stop; retain the existing SDK and records. */
import fs from 'node:fs'
import {armValidationParameters,armValidationCredentials} from './arm-validation-settings.mjs'
import {managedRootParameters} from './arm-managed-composition.mjs'
import http from 'node:http'
import {createHash} from 'node:crypto'
import {createRequire} from 'node:module'
import {pathToFileURL} from 'node:url'
import {renderAccountBase} from './profile-composition.mjs'
import {spawn,spawnSync} from 'node:child_process'
import {setTimeout as delay} from 'node:timers/promises'
const A='/opt/dsh-features/arm-native-01',D='/dsh-state/namespace-arm-13',H='/run/dsh-feature-root',T='/tmp/dsh-feature-home/sdk-validation'
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
 if(process.argv.length===2){console.log(JSON.stringify({inert:true,entry:'--publish-preview010-observer-01'}));process.exit(0)}
 need(process.argv.length===3&&process.argv[2]==='--publish-preview010-observer-01','exact-execution-argument-required')
 need(process.platform==='linux'&&process.arch==='arm64'&&process.getuid()===0,'actual-linux-arm64-root-required')
 const OLD='/dsh-state/namespace-arm-12',B=A+'/preview010-observer-correction-01'
 const prior=read(OLD+'/current.json');need(prior.pid===2325&&prior.startTicks==='168450754'&&!fs.existsSync('/proc/2325'),'Original Native08 Root must be gone')
 const priorReady=read(OLD+'/ROOT-READY.public.json'),oldParams=read(A+'/root-parameters.preview010-session-log-01.json'),planInput=read(A+'/plan.json')
 need(read(B+'/normal-stop-terminal.public.json').launcherExit==='0','Original failed shutdown must remain recorded')
 const all=await engine('GET','/containers/json?all=1'),topology=read(A+'/SDK-INITIAL-TOPOLOGY.json');SDK=priorReady.sdkContainerId
 need(JSON.stringify(all.map(x=>x.Id).sort())===JSON.stringify(topology.containerIds)&&JSON.stringify(all.filter(x=>x.State==='running').map(x=>x.Id).sort())===JSON.stringify(topology.runningContainerIds)&&!all.some(x=>x.ImageID===planInput.images.workload||x.Image===planInput.images.workload),'Original SDK topology and no-workload proof required')
 const {Pool}=createRequire('/opt/dsh-installed-products/packages/cloud/pe-cloud-runtime/package.json')('pg')
 const pool=new Pool({host:'10.247.121.3',port:5432,user:planInput.pgRole,database:planInput.database,password:fs.readFileSync('/new-secrets/pg-password','utf8').trim(),max:1,connectionTimeoutMillis:3000,statement_timeout:3000})
 let observation
 try{const c=await pool.connect();try{await c.query('BEGIN READ ONLY');const owners=(await c.query('SELECT account_id,epoch::text,phase,owner_instance_id FROM public.pe_account_owners')).rows;const allocationRows=(await c.query('SELECT allocation_id,session_id,state,sandbox_id,failure_code FROM public.pe_sandbox_allocations ORDER BY allocation_id')).rows;const allocations=allocationRows.length;need(allocations===4&&allocationRows.every(x=>['session-4a490947-ab2a-4443-ab76-fca228f10dfa','session-9fbb6b68-40f8-47bb-adca-3c9c20681f02','session-f9abea8e-de2e-418e-80f6-c721321b3412'].includes(x.session_id)&&x.state==='released'&&x.failure_code===null)&&allocationRows.map(x=>x.allocation_id).join(',')==='3631120d-fc1e-49c4-b7cb-01a21814aba9,55257da4-c30e-4a09-be0c-c668edf21594,e4aca24a-bcda-4232-9504-fa4824e99912,f787a6b3-4b19-467e-b3a5-8433c15cbd5f','Original Native08 two allocations must have actual normal release');const writers=Number((await c.query("SELECT count(*)::integer AS count FROM pg_stat_activity WHERE usename=current_user AND backend_type='client backend' AND pid<>pg_backend_pid()")).rows[0].count);const prepared=Number((await c.query('SELECT count(*)::integer AS count FROM pg_prepared_xacts WHERE owner=current_user')).rows[0].count);await c.query('ROLLBACK');need(owners.length===2&&owners.every(x=>x.phase==='unowned'&&x.owner_instance_id===null)&&owners.some(x=>x.account_id==='cGs0QwbhlDSd2nLggngfDyMxjkUtGMHr'&&x.epoch==='9')&&owners.some(x=>x.account_id==='J3gLhSHDOc7Y99G4lipJdphVIcEGYw91'&&x.epoch==='3')&&allocations===4&&writers===0&&prepared===0,'Exact retired original writer and two normally released allocations required');observation={owners,allocations,writers,prepared}}finally{c.release()}}finally{await pool.end()}
 for(const pid of fs.readdirSync('/proc').filter(x=>/^\d+$/.test(x))){try{need(!/^Uid:\s+(.+)$/m.exec(fs.readFileSync('/proc/'+pid+'/status','utf8'))?.[1].trim().split(/\s+/).includes('2000'),'Original UID2000 writer remains')}catch(e){if(!['ENOENT','ESRCH'].includes(e.code))throw e}}
 write(B+'/normal-runtime-reconcile-preflight-02.public.json',JSON.stringify({at:new Date().toISOString(),...observation,mechanism:'installed SingleInstanceControl.start, original singleInstance=true; no operator SQL mutation'})+'\n')
 const oldPlan=read(B+'/root-inputs/storage-plan.json'),oldDeployment=fs.readFileSync(B+'/root-inputs/rootDeployment.json'),backups=[]
 for(const slot of oldPlan.slots){const recordName='.pe-env-'+slot.slotId+'-env-slot-0.json';need(fs.readdirSync(slot.private.rootPath).includes(recordName),'Original fixed bank record required');const value=read(slot.private.rootPath+'/'+recordName);need(value.state==='free'&&value.slotGeneration===1,'Original free record changed');const name=slot.private.rootPath+'/profile/cordis.patch.yml',bytes=fs.readFileSync(name);write(B+'/'+slot.slotId+'.profile.json',bytes,0o400);backups.push({slotId:slot.slotId,path:name,sha256:sha(bytes)})}
 const correctedParams=managedRootParameters(armValidationParameters(oldParams));correctedParams.runtime.singleInstance=true
 correctedParams.accountBase.sha256=sha(fs.readFileSync(correctedParams.accountBase.path));correctedParams.accountSkeleton.sha256=sha(fs.readFileSync(correctedParams.accountSkeleton.path))
 const base=renderAccountBase(fs.readFileSync(correctedParams.accountBase.path),correctedParams.model.apiKeyRef);correctedParams.nativeBaseSha256=sha(base)
 write('/opt/dsh-features/account-base.managed-composition-01.yml',base,0o444);fs.renameSync('/opt/dsh-features/account-base.managed-composition-01.yml','/opt/dsh-features/account-base.yml')
 write(A+'/root-parameters.preview010-observer-01.json',JSON.stringify(correctedParams,null,2)+'\n',0o400)
 const {parseRootDeploymentInput}=await import(pathToFileURL(req.resolve('@deepseek-ai/dsh-pe-opensandbox')).href)
 fs.mkdirSync(D,{mode:0o700});journal=fs.openSync(D+'/operator.journal.jsonl','wx',0o600)
 observe('intent:normal-configuration-correction',{carrierId:read(A+'/carrier.identity.public.json').id,existingSdkId:SDK,existingAmdSdkUntouched:true})
 const fds=['plan-final.json','ready.json','journal.jsonl'].map(n=>fs.openSync(D+'/'+n,'wx+',0o600))
 const log=fs.openSync(D+'/launcher.private.log','wx',0o600),input=A+'/namespace-launch.input.json',inputSha=sha(fs.readFileSync(input))
 stage='launch-original-namespace'
 child=spawn('/bin/sh',['-c',"/bin/sh \"$1\" launch --input \"$2\" --sha256 \"$3\"; code=$?; printf '%s\\n' \"$code\" > \"$4\"; exit \"$code\"",'owned-root-13',R+'/launch-feature-namespace.v3.sh',input,inputSha,D+'/launcher.exit.code'],{detached:true,stdio:['ignore',log,log,...fds]})
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
 const dep=JSON.parse(oldDeployment);dep.storage.plan={path:H+'/storage-plan.json',sha256:state.planSha256};parseRootDeploymentInput(dep)
 const depBytes=Buffer.from(JSON.stringify(dep,null,2)+'\n');write(P+I+'/rootDeployment.json',depBytes,0o600)
 const params=read(A+'/root-parameters.preview010-observer-01.json');params.storage.planSourcePath=I+'/storage-plan.json';params.storage.planSha256=state.planSha256
 params.executionDeployment={sourcePath:I+'/rootDeployment.json',path:H+'/rootDeployment.json',sha256:sha(depBytes)}
 params.sourceTemplate={path:A+'/root-with-validation.public-template.json.in',sha256:sha(fs.readFileSync(A+'/root-with-validation.public-template.json.in'))}
 const paramBytes=Buffer.from(JSON.stringify(params,null,2)+'\n');write(P+I+'/root-parameters.complete.json',paramBytes)
 inside('prepare-search-inputs',['/opt/dsh-installed-products/deploy/local/second-environment-20261115/prepare-native-search-inputs.mjs','--input',I+'/root-parameters.complete.json','--sha256',sha(paramBytes),'--output-dir',I+'/search-inputs'])
 const finalParams=P+I+'/search-inputs/root-parameters.native-search.json'
 inside('generate-root-profile',[R+'/generate-feature-root-profile-v3.mjs','--input',I+'/search-inputs/root-parameters.native-search.json','--sha256',sha(fs.readFileSync(finalParams)),'--output-dir',H])
 stage='normal-update-three-unmounted-account-profiles';current();const installation=read(P+H+'/ACCOUNT-INSTALLATION.json');need(installation.slots.length===3,'three-generated-slots-required')
 for(const slot of installation.slots){const previous=backups.find(x=>x.slotId===slot.slotId);need(previous&&previous.path===slot.target,'original-account-profile-target-required');const target=P+slot.target,newBytes=fs.readFileSync(P+H+'/account-slots/'+slot.slotId+'/cordis.patch.yml');need(sha(fs.readFileSync(target))===previous.sha256&&sha(newBytes)===slot.sha256,'exact-normal-profile-update-input-required');if(!fs.readFileSync(target).equals(newBytes)){const temp=target+'.managed-composition-01';write(temp,newBytes,0o600,2000,2000);fs.renameSync(temp,target);}const dir=fs.openSync(target.slice(0,target.lastIndexOf('/')),fs.constants.O_RDONLY|fs.constants.O_DIRECTORY);try{fs.fsyncSync(dir)}finally{fs.closeSync(dir)}}
 stage='install-same-account-canonical-credentials';write(P+H+'/credentials.json',JSON.stringify(armValidationCredentials(read('/new-secrets/root-credentials.json')))+'\n',0o600,2000,2000)
 write(D+'/sdk-created.public.json',JSON.stringify({id:SDK,reusedExistingSdk:true})+'\n')
 stage='publish-original-fd4-inode';current();const generation=read(P+H+'/GENERATION.json')
 const ready={schema:'dsh-feature-namespace-ready/v1',resourceId:RESOURCE,planSha256:state.planSha256,rootDeploymentSha256:sha(fs.readFileSync(P+H+'/rootDeployment.json')),profileSha256:sha(fs.readFileSync(P+H+'/profiles/cloud/cordis.patch.yml')),baseConfigSha256:state.baseConfigSha256,configurationComplete:true}
 need(ready.profileSha256===generation.profileSha256&&ready.planSha256===generation.storagePlanSha256,'original-generation-inputs-changed')
 const expected=state.administratorDescriptors[1],fd=fs.openSync(D+'/ready.json',fs.constants.O_RDWR|fs.constants.O_NOFOLLOW)
 try{const st=fs.fstatSync(fd);need(String(st.dev)===expected.device&&String(st.ino)===expected.inode&&st.uid===0&&st.nlink===1&&st.size===0&&(st.mode&0o7777)===0o600,'original-empty-fd4-inode-required');const bytes=Buffer.from(JSON.stringify(ready)+'\n');let n=0;while(n<bytes.length)n+=fs.writeSync(fd,bytes,n,bytes.length-n,n);fs.fsyncSync(fd)}finally{fs.closeSync(fd)}
 observe('observed:ready-published',{...ready,originalInodePreserved:true,existingAmdSdkUntouched:true})
 stage='observe-original-seal-appcheck-cli';const limit=Date.now()+180000
 while(Date.now()<limit){need(child.exitCode===null,'original-launcher-exited-before-app-ready');current();if(fs.existsSync(P+T+'/application-ready.json')){const readyEvent=read(P+T+'/application-ready.json');const logs=fs.readFileSync(D+'/launcher.private.log','utf8');need(logs.includes('sealed-new-root-inputs-not-application-ready')&&logs.includes('kernel-app-preflight-passed-not-application-ready'),'original-seal-and-kernel-app-check-not-observed');const result={status:'normal-root-application-ready',at:new Date().toISOString(),keeper,planSha256:state.planSha256,rootDeploymentSha256:ready.rootDeploymentSha256,profileSha256:ready.profileSha256,sdkContainerId:SDK,existingAmdSdkUntouched:true,testOutputDirectory:T,appReady:readyEvent,nativeBusinessStarted:false};write(D+'/ROOT-READY.public.json',JSON.stringify(result)+'\n');observe('complete:root-ready',result);console.log(JSON.stringify(result));child.unref();fs.closeSync(journal);process.exit(0)}await delay(250)}
 need(false,'application-ready-not-observed-within-finite-budget')
}catch(error){observe('failed-or-unknown-no-retry',{check:error.check,errorCode:error.code});console.error(JSON.stringify({status:'configuration-correction-failed-retained-no-replay',stage,check:error.check,errorCode:error.code,keeper,launcherPid:child?.pid,launcherExit:child?.exitCode,cleanupAttempted:false,secretsPrinted:false}));if(child)child.unref();process.exitCode=1}
