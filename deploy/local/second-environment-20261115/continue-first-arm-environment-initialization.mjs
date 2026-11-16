/** Trusted operator for this owned, existing SDK. Inert without --execute-owned-arm-root-01. */
import fs from 'node:fs'
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
 if(process.argv.length===2){console.log(JSON.stringify({inert:true,entry:'--continue-unsubmitted-environment-initialization-01'}));process.exit(0)}
 need(process.argv.length===3&&process.argv[2]==='--continue-unsubmitted-environment-initialization-01','exact-execution-argument-required')
 need(process.platform==='linux'&&process.arch==='arm64'&&process.getuid()===0,'actual-linux-arm64-root-required')
 keeper=read(D+'/current.json');current();const P='/proc/'+keeper.pid+'/root',state=read(P+'/run/dsh-feature-launch-v1/state.json'),planInput=read(A+'/plan.json');SDK=read(D+'/sdk-created.public.json').id
 const previous=read(D+'/operator-failure.public.json');need(previous.stage==='initialize-three-environment-records','original-unsubmitted-stage-required')
 const failed=fs.readFileSync(D+'/initialize-three-environment-records.private.log','utf8').trim().split('\n').map(x=>JSON.parse(x));need(failed.length===1&&failed[0].recordCreationAttempted===false,'original-no-record-attempt-required')
 need(!fs.existsSync(A+'/private-control/environment-record-initialization.journal.jsonl')&&!fs.existsSync(A+'/private-control/environment-record-initialization.receipt.json')&&!fs.existsSync(D+'/launcher.exit.code'),'no-initialization-or-launcher-exit-required')
 need(fs.statSync(D+'/ready.json').size===0,'ready-must-still-be-unpublished')
 const topology=read(A+'/SDK-INITIAL-TOPOLOGY.json'),all=await engine('GET','/containers/json?all=1'),expectedIds=topology.containerIds,expectedRunning=topology.runningContainerIds
 need(JSON.stringify(all.map(x=>x.Id).sort())===JSON.stringify(expectedIds)&&JSON.stringify(all.filter(x=>x.State==='running').map(x=>x.Id).sort())===JSON.stringify(expectedRunning),'exact-existing-topology-required')
 need(!all.some(x=>x.ImageID===planInput.images.workload||x.Image===planInput.images.workload),'qualified-arm-workload-already-present')
 const facts={at:new Date().toISOString()}
 journal=fs.openSync(D+'/continuation-01.journal.jsonl','wx',0o600);observe('intent:continue-unsubmitted-record-initialization',{sdkId:SDK,keeper})
 stage='collect-first-deployment-read-only-proof';current()
 const {Pool}=createRequire('/opt/dsh-installed-products/packages/cloud/pe-cloud-runtime/package.json')('pg'),password=fs.readFileSync('/new-secrets/pg-password','utf8').trim();const pool=new Pool({host:'10.247.121.3',port:5432,user:planInput.pgRole,database:planInput.database,password,max:1,connectionTimeoutMillis:3000,statement_timeout:3000})
 let pg;try{const c=await pool.connect();try{await c.query('BEGIN READ ONLY');const names=['pe_sandbox_allocations','pe_account_owners'];const counts=[];for(const name of names){const p=await c.query('SELECT to_regclass($1) AS relation',['public.'+name]);counts.push(p.rows[0].relation===null?{name,present:false,count:0}:{name,present:true,count:Number((await c.query('SELECT count(*)::integer AS count FROM public.'+name)).rows[0].count)})}const others=await c.query("SELECT count(*)::integer AS count FROM pg_stat_activity WHERE datname=current_database() AND backend_type='client backend' AND pid<>pg_backend_pid()");await c.query('ROLLBACK');pg={database:planInput.database,allocationCount:counts[0].count,ownedAccountCount:counts[1].count,otherBackendCount:others.rows[0].count,readOnlyObservation:true};write(D+'/postgres-observation-continuation-01.json',JSON.stringify({at:new Date().toISOString(),counts,...pg})+'\n')}finally{c.release()}}finally{await pool.end()}
 need(pg.allocationCount===0&&pg.ownedAccountCount===0&&pg.otherBackendCount===0,'first-deployment-pg-not-empty')
 let uid2000=0;for(const p of fs.readdirSync('/proc').filter(p=>/^\d+$/.test(p))){try{if(/^Uid:\s+(.+)$/m.exec(fs.readFileSync('/proc/'+p+'/status','utf8'))?.[1].trim().split(/\s+/).includes('2000'))uid2000++}catch(e){if(!['ENOENT','ESRCH'].includes(e.code))throw e}}
 need(uid2000===0,'application-uid-already-present');need(Date.now()-Date.parse(facts.at)<120000,'backend-facts-expired-before-initialization')
 const proof={schema:'dsh-feature-first-environment-evidence/v1',resourceId:RESOURCE,carrier:'dsh-sdk-arm-587be4cb',keeper,bootId:fs.readFileSync('/proc/sys/kernel/random/boot_id','utf8').trim(),observedAt:new Date().toISOString(),application:{neverStarted:true,cliLaunchIntentCount:0,uid2000ProcessCount:uid2000},postgres:pg,sdk:{backendContainerId:BACKEND,qualifiedWorkloadImage:planInput.images.workload,qualifiedWorkloadContainers:0,containerIds:expectedIds,runningContainerIds:expectedRunning,readOnlyObservation:true}}
 write(A+'/root-evidence-continuation-01.json',JSON.stringify(proof)+'\n')
 const pin=path=>({path,sha256:sha(fs.readFileSync(path))});const env={schema:'dsh-environment-record-initialization/v1',resourceId:RESOURCE,originalProvisionInput:pin(A+'/static-arm-existing.json'),originalProvisionOwner:pin('/srv/dsh-features-'+RESOURCE+'/owner.json'),rootEvidence:pin(A+'/root-evidence-continuation-01.json')}
 write(A+'/environment-input-continuation-01.json',JSON.stringify(env)+'\n')
 const tokens={KEEPER_PID:String(keeper.pid),KEEPER_START_TICKS:keeper.startTicks,KEEPER_NAMESPACE:keeper.mountNamespace,PLAN_SHA:state.planSha256,OWNER_SHA:env.originalProvisionOwner.sha256,PROVISION_SHA:env.originalProvisionInput.sha256,SDK_ID:SDK,WORKLOAD_IMAGE:planInput.images.workload,SDK_ALL_IDS_JSON:JSON.stringify(expectedIds),SDK_ALL_COUNT:String(expectedIds.length),SDK_RUNNING_IDS_JSON:JSON.stringify(expectedRunning)};
 let initializer=fs.readFileSync(A+'/initialize-environment-records.public-template.mjs.in','utf8');for(const [key,value]of Object.entries(tokens))initializer=initializer.replaceAll('@@'+key+'@@',value);need(!initializer.includes('@@'),'live-initializer-identity-placeholder-remains');write(A+'/initialize-environment-records-continuation-01.mjs',initializer,0o444);
 command('initialize-three-environment-records-continuation-01',[N,A+'/initialize-environment-records-continuation-01.mjs','--initialize','--input',A+'/environment-input-continuation-01.json','--sha256',sha(fs.readFileSync(A+'/environment-input-continuation-01.json'))])
 stage='publish-original-fd4-inode';current();const generation=read(P+H+'/GENERATION.json')
 const ready={schema:'dsh-feature-namespace-ready/v1',resourceId:RESOURCE,planSha256:state.planSha256,rootDeploymentSha256:sha(fs.readFileSync(P+H+'/rootDeployment.json')),profileSha256:sha(fs.readFileSync(P+H+'/profiles/cloud/cordis.patch.yml')),baseConfigSha256:state.baseConfigSha256,configurationComplete:true}
 need(ready.profileSha256===generation.profileSha256&&ready.planSha256===generation.storagePlanSha256,'original-generation-inputs-changed')
 const expected=state.administratorDescriptors[1],fd=fs.openSync(D+'/ready.json',fs.constants.O_RDWR|fs.constants.O_NOFOLLOW)
 try{const st=fs.fstatSync(fd);need(String(st.dev)===expected.device&&String(st.ino)===expected.inode&&st.uid===0&&st.nlink===1&&st.size===0&&(st.mode&0o7777)===0o600,'original-empty-fd4-inode-required');const bytes=Buffer.from(JSON.stringify(ready)+'\n');let n=0;while(n<bytes.length)n+=fs.writeSync(fd,bytes,n,bytes.length-n,n);fs.fsyncSync(fd)}finally{fs.closeSync(fd)}
 observe('observed:ready-published',{...ready,originalInodePreserved:true,existingAmdSdkUntouched:true})
 stage='observe-original-seal-appcheck-cli';const limit=Date.now()+180000
 while(Date.now()<limit){need(!fs.existsSync(D+'/launcher.exit.code'),'original-launcher-exited-before-app-ready');current();if(fs.existsSync(P+T+'/application-ready.json')){const readyEvent=read(P+T+'/application-ready.json');const logs=fs.readFileSync(D+'/launcher.private.log','utf8');need(logs.includes('sealed-new-root-inputs-not-application-ready')&&logs.includes('kernel-app-preflight-passed-not-application-ready'),'original-seal-and-kernel-app-check-not-observed');const result={status:'normal-root-application-ready',at:new Date().toISOString(),keeper,planSha256:state.planSha256,rootDeploymentSha256:ready.rootDeploymentSha256,profileSha256:ready.profileSha256,sdkContainerId:SDK,existingAmdSdkUntouched:true,testOutputDirectory:T,appReady:readyEvent,nativeBusinessStarted:false};write(D+'/ROOT-READY.public.json',JSON.stringify(result)+'\n');observe('complete:root-ready',result);console.log(JSON.stringify(result));fs.closeSync(journal);process.exit(0)}await delay(250)}
 need(false,'application-ready-not-observed-within-finite-budget')
}catch(error){observe('failed-or-unknown-no-retry',{check:error.check,errorCode:error.code});console.error(JSON.stringify({status:'failed-or-unknown-no-retry',stage,check:error.check,errorCode:error.code,keeper,cleanupAttempted:false,secretsPrinted:false}));process.exitCode=1}finally{if(journal!==undefined)try{fs.closeSync(journal)}catch{}}
