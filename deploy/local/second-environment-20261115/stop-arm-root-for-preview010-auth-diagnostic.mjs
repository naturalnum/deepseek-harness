/** Preserve the exact Root15 service and join the original Root's normal shutdown before changing its account composition. */
import fs from 'node:fs'
import {setTimeout as delay} from 'node:timers/promises'
const A='/opt/dsh-features/arm-native-01',D='/dsh-state/namespace-arm-15',B=A+'/preview010-auth-diagnostic-01'
const need=(v,m)=>{if(!v)throw Error(m)}
if(process.argv.length===2){console.log(JSON.stringify({inert:true}));process.exit(0)}
need(process.argv.length===3&&process.argv[2]==='--normal-stop-preview010-auth-diagnostic-01','Exact normal stop argument required')
need(process.platform==='linux'&&process.arch==='arm64'&&process.getuid()===0,'Original ARM carrier Root required')
const current=JSON.parse(fs.readFileSync(D+'/current.json')),p='/proc/'+current.pid
const stat=fs.readFileSync(p+'/stat','utf8')
need(current.pid===3042&&current.startTicks==='168740879'&&stat.slice(stat.lastIndexOf(')')+2).split(/\s+/)[19]===current.startTicks&&fs.readlinkSync(p+'/ns/mnt')===current.mountNamespace,'Original Root15 Root identity changed')
const t=p+'/root/tmp/dsh-feature-home/sdk-validation',result=JSON.parse(fs.readFileSync(t+'/preview010-results.json'))
need(result.status==='service-stop-returned-physical-release-not-inferred'&&result.sessionId==='session-f48fbf06-d510-4850-80f4-5d43bad379d0'&&result.serviceHandle==='fbaac6be-9429-42a5-8671-6b52db4b070a'&&result.steps.length===3&&result.steps[2].label==='service-stop'&&result.steps[2].outcome.value.observation.confirmed===true,'Exact original Root15 service stop must be confirmed')
fs.mkdirSync(B,{mode:0o700});fs.mkdirSync(B+'/root-inputs',{mode:0o700});fs.mkdirSync(B+'/root-inputs/profiles',{mode:0o700});fs.mkdirSync(B+'/root-inputs/profiles/cloud',{mode:0o700})
for(const name of ['storage-plan.json','rootDeployment.json','credentials.json','GENERATION.json','profiles/cloud/cordis.patch.yml','profiles/cloud/cordis.yml','profiles/cloud/package.json']){fs.copyFileSync(p+'/root/run/dsh-feature-root/'+name,B+'/root-inputs/'+name,fs.constants.COPYFILE_EXCL);fs.chmodSync(B+'/root-inputs/'+name,0o400)}
for(const name of ['PREVIEW010-PREPARE.json','PREVIEW010-START.json','preview010-results.json','PREVIEW010-STOP.json']){fs.copyFileSync(t+'/'+name,B+'/'+name,fs.constants.COPYFILE_EXCL);fs.chmodSync(B+'/'+name,0o400)}
fs.copyFileSync('/opt/dsh-features/account-base.yml',B+'/prior-account-base.json',fs.constants.COPYFILE_EXCL);fs.chmodSync(B+'/prior-account-base.json',0o400)
fs.writeFileSync(B+'/normal-stop-intent.public.json',JSON.stringify({at:new Date().toISOString(),current,native08Retained:true,signal:'SIGTERM'})+'\n',{flag:'wx',mode:0o400})
process.kill(current.pid,'SIGTERM')
const deadline=Date.now()+150000
while(Date.now()<deadline&&fs.existsSync(p))await delay(100)
need(!fs.existsSync(p),'Original Root normal stop not confirmed; retained without force')
const exit=fs.readFileSync(D+'/launcher.exit.code','utf8').trim()
fs.writeFileSync(B+'/normal-stop-terminal.public.json',JSON.stringify({at:new Date().toISOString(),current,launcherExit:exit,resourceReleaseNotInferred:true})+'\n',{flag:'wx',mode:0o400})
console.log(JSON.stringify({normalRootExit:exit,backupDirectory:B,resourceReleaseNotInferred:true}))
need(exit==='0','Original launcher reported failure; preserve responsibility and inspect original Runtime close')
