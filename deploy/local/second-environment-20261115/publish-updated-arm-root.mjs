/** Correct only the known public ARM settings after a normal stop; retain the existing SDK and records. */
import fs from 'node:fs'
import {armValidationParameters,armValidationCredentials} from './arm-validation-settings.mjs'
import http from 'node:http'
import {createHash} from 'node:crypto'
import {createRequire} from 'node:module'
import {pathToFileURL} from 'node:url'
import {renderAccountBase} from './profile-composition.mjs'
import {spawn,spawnSync} from 'node:child_process'
import {setTimeout as delay} from 'node:timers/promises'
const A='/opt/dsh-features/arm-native-01',D='/dsh-state/namespace-arm-04',H='/run/dsh-feature-root',T='/tmp/dsh-feature-home/sdk-validation'
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
 if(process.argv.length===2){console.log(JSON.stringify({inert:true,entry:'--publish-normal-product-update-01'}));process.exit(0)}
 need(process.argv.length===3&&process.argv[2]==='--publish-normal-product-update-01','exact-execution-argument-required')
 need(process.platform==='linux'&&process.arch==='arm64'&&process.getuid()===0,'actual-linux-arm64-root-required')
 const OLD='/dsh-state/namespace-arm-03',B=A+'/product-upgrade-root-01';keeper=read(OLD+'/current.json');current()
 need(keeper.pid===563&&keeper.startTicks==='167746955','exact-original-root-required')
 const Pold='/proc/'+keeper.pid+'/root',priorReady=read(OLD+'/ROOT-READY.public.json'),oldParams=read(A+'/root-parameters.config-corrected-01.json'),planInput=read(A+'/plan.json')
 const failure=read(Pold+T+'/driver-failed.json'),result=read(Pold+T+'/native-results.json');need(failure.code==='cloud/account-unavailable'&&result.steps.length===0&&!result.sessionId&&!result.workspaceId,'known-pre-session-native-refusal-required')
 const all=await engine('GET','/containers/json?all=1'),topology=read(A+'/SDK-INITIAL-TOPOLOGY.json');SDK=priorReady.sdkContainerId
 need(JSON.stringify(all.map(x=>x.Id).sort())===JSON.stringify(topology.containerIds)&&JSON.stringify(all.filter(x=>x.State==='running').map(x=>x.Id).sort())===JSON.stringify(topology.runningContainerIds)&&!all.some(x=>x.ImageID===planInput.images.workload||x.Image===planInput.images.workload),'unchanged-sdk-no-workload-required')
 const {Pool}=createRequire('/opt/dsh-installed-products/packages/cloud/pe-cloud-runtime/package.json')('pg')
 async function emptyAccounts(){const pool=new Pool({host:'10.247.121.3',port:5432,user:planInput.pgRole,database:planInput.database,password:fs.readFileSync('/new-secrets/pg-password','utf8').trim(),max:1,connectionTimeoutMillis:3000,statement_timeout:3000});try{const c=await pool.connect();try{await c.query('BEGIN READ ONLY');for(const name of ['pe_sandbox_allocations','pe_account_owners']){const found=await c.query('SELECT to_regclass($1) AS relation',['public.'+name]);need(found.rows[0].relation===null||Number((await c.query('SELECT count(*)::integer AS count FROM public.'+name)).rows[0].count)===0,'account-or-allocation-responsibility-present')}await c.query('ROLLBACK')}finally{c.release()}}finally{await pool.end()}}
 await emptyAccounts();need(!fs.existsSync(D)&&!fs.existsSync(B),'new-correction-attempt-required');fs.mkdirSync(B,{mode:0o700})
 const oldPlan=read(Pold+H+'/storage-plan.json'),oldDeployment=fs.readFileSync(Pold+H+'/rootDeployment.json'),backups=[]
 for(const slot of oldPlan.slots){const dir='/proc/'+keeper.pid+'/root'+slot.private.rootPath,names=fs.readdirSync(dir).filter(x=>x.startsWith('.pe-env-'));need(names.length===1,'exact-one-existing-environment-record-required');for(const n of names){const value=read(dir+'/'+n);need(value.schema===1&&value.state==='free'&&value.slotGeneration===1&&value.bankId===slot.environmentBank.bankId&&value.slotId===slot.environmentBank.slots[0].slotId,'original-initial-free-record-required')}
  const name=slot.private.rootPath+'/profile/cordis.patch.yml',bytes=fs.readFileSync(Pold+name);write(B+'/'+slot.slotId+'.profile.json',bytes,0o400);backups.push({slotId:slot.slotId,path:name,sha256:sha(bytes)})}
 write(B+'/prior-rootDeployment.private.json',oldDeployment,0o400);write(B+'/prior-root-profile.public.json',fs.readFileSync(Pold+H+'/profiles/cloud/cordis.patch.yml'),0o400)
 write(B+'/prior-native-results.public.json',fs.readFileSync(Pold+T+'/native-results.json'),0o400);write(B+'/prior-native-failure.public.json',fs.readFileSync(Pold+T+'/driver-failed.json'),0o400)
 const oldBase=fs.readFileSync('/opt/dsh-features/account-base.yml');need(sha(oldBase)===oldParams.nativeBaseSha256,'original-base-pin-required');write(B+'/prior-account-base.public.json',oldBase,0o400)
 write(B+'/intent.public.json',JSON.stringify({at:new Date().toISOString(),oldKeeper:keeper,sdkId:SDK,normalSignal:'SIGTERM',allocationRows:0,ownerRows:0,nativeSteps:0,backups})+'\n')
 stage='normal-stop-known-refused-root';process.kill(keeper.pid,'SIGTERM');const stopDeadline=Date.now()+130000
 while(Date.now()<stopDeadline&&fs.existsSync('/proc/'+keeper.pid)){await delay(100)}need(!fs.existsSync('/proc/'+keeper.pid),'original-application-stop-unconfirmed')
 need(fs.existsSync(OLD+'/launcher.exit.code')&&fs.readFileSync(OLD+'/launcher.exit.code','utf8').trim()==='0','normal-original-launcher-exit-required');await emptyAccounts()
 stage='normal-install-reviewed-product';const installed=spawnSync(N,[A+'/update-owned-arm-product-bind.mjs','--install'],{encoding:'utf8',timeout:120000});write(B+'/product-install.public.log',(installed.stdout??'')+(installed.stderr??''));need(installed.status===0&&!installed.error,'normal-product-install-unconfirmed');
 const correctedParams=armValidationParameters(oldParams),base=renderAccountBase(fs.readFileSync(correctedParams.accountBase.path),correctedParams.model.apiKeyRef);correctedParams.nativeBaseSha256=sha(base)
 write('/opt/dsh-features/account-base.product-upgrade-01.yml',base,0o444);fs.renameSync('/opt/dsh-features/account-base.product-upgrade-01.yml','/opt/dsh-features/account-base.yml')
 write(A+'/root-parameters.product-upgrade-01.json',JSON.stringify(correctedParams,null,2)+'\n',0o400)
 const {parseRootDeploymentInput}=await import(pathToFileURL(req.resolve('@deepseek-ai/dsh-pe-opensandbox')).href)
 fs.mkdirSync(D,{mode:0o700});journal=fs.openSync(D+'/operator.journal.jsonl','wx',0o600)
 observe('intent:normal-configuration-correction',{carrierId:read(A+'/carrier.identity.public.json').id,existingSdkId:SDK,existingAmdSdkUntouched:true})
 const fds=['plan-final.json','ready.json','journal.jsonl'].map(n=>fs.openSync(D+'/'+n,'wx+',0o600))
 const log=fs.openSync(D+'/launcher.private.log','wx',0o600),input=A+'/namespace-launch.input.json',inputSha=sha(fs.readFileSync(input))
 stage='launch-original-namespace'
 child=spawn('/bin/sh',['-c',"/bin/sh \"$1\" launch --input \"$2\" --sha256 \"$3\"; code=$?; printf '%s\\n' \"$code\" > \"$4\"; exit \"$code\"",'owned-root-04',R+'/launch-feature-namespace.v3.sh',input,inputSha,D+'/launcher.exit.code'],{detached:true,stdio:['ignore',log,log,...fds]})
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
 const params=read(A+'/root-parameters.product-upgrade-01.json');params.storage.planSourcePath=I+'/storage-plan.json';params.storage.planSha256=state.planSha256
 params.executionDeployment={sourcePath:I+'/rootDeployment.json',path:H+'/rootDeployment.json',sha256:sha(depBytes)}
 params.sourceTemplate={path:A+'/root-with-validation.public-template.json.in',sha256:sha(fs.readFileSync(A+'/root-with-validation.public-template.json.in'))}
 const paramBytes=Buffer.from(JSON.stringify(params,null,2)+'\n');write(P+I+'/root-parameters.complete.json',paramBytes)
 inside('prepare-search-inputs',['/opt/dsh-installed-products/deploy/local/second-environment-20261115/prepare-native-search-inputs.mjs','--input',I+'/root-parameters.complete.json','--sha256',sha(paramBytes),'--output-dir',I+'/search-inputs'])
 const finalParams=P+I+'/search-inputs/root-parameters.native-search.json'
 inside('generate-root-profile',[R+'/generate-feature-root-profile-v3.mjs','--input',I+'/search-inputs/root-parameters.native-search.json','--sha256',sha(fs.readFileSync(finalParams)),'--output-dir',H])
 stage='normal-update-three-unmounted-account-profiles';current();const installation=read(P+H+'/ACCOUNT-INSTALLATION.json');need(installation.slots.length===3,'three-generated-slots-required')
 for(const slot of installation.slots){const previous=backups.find(x=>x.slotId===slot.slotId);need(previous&&previous.path===slot.target,'original-account-profile-target-required');const target=P+slot.target,newBytes=fs.readFileSync(P+H+'/account-slots/'+slot.slotId+'/cordis.patch.yml');need(sha(fs.readFileSync(target))===previous.sha256&&sha(newBytes)===slot.sha256,'exact-normal-profile-update-input-required');if(!fs.readFileSync(target).equals(newBytes)){const temp=target+'.product-upgrade-01';write(temp,newBytes,0o600,2000,2000);fs.renameSync(temp,target);}const dir=fs.openSync(target.slice(0,target.lastIndexOf('/')),fs.constants.O_RDONLY|fs.constants.O_DIRECTORY);try{fs.fsyncSync(dir)}finally{fs.closeSync(dir)}}
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
