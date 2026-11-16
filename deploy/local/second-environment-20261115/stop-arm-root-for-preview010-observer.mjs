/** Preserve Native08 and join the original Root's normal shutdown before changing its account composition. */
import fs from 'node:fs'
import {setTimeout as delay} from 'node:timers/promises'
const A='/opt/dsh-features/arm-native-01',D='/dsh-state/namespace-arm-12',B=A+'/preview010-observer-correction-01'
const need=(v,m)=>{if(!v)throw Error(m)}
if(process.argv.length===2){console.log(JSON.stringify({inert:true}));process.exit(0)}
need(process.argv.length===3&&process.argv[2]==='--normal-stop-preview010-pre-service-observer-refusal','Exact normal stop argument required')
need(process.platform==='linux'&&process.arch==='arm64'&&process.getuid()===0,'Original ARM carrier Root required')
const current=JSON.parse(fs.readFileSync(D+'/current.json')),p='/proc/'+current.pid
const stat=fs.readFileSync(p+'/stat','utf8')
need(current.pid===2325&&current.startTicks==='168450754'&&stat.slice(stat.lastIndexOf(')')+2).split(/\s+/)[19]===current.startTicks&&fs.readlinkSync(p+'/ns/mnt')===current.mountNamespace,'Original Native08 Root identity changed')
const t=p+'/root/tmp/dsh-feature-home/sdk-validation',result=JSON.parse(fs.readFileSync(t+'/preview010-results.json'))
need(result.status==='failed-retained'&&result.sessionId==='session-f9abea8e-de2e-418e-80f6-c721321b3412'&&result.steps.length===1&&result.steps[0].label==='fixture-hash'&&result.steps[0].outcome.isError===false,'Exact native-prepared fixture and no submitted service required')
fs.mkdirSync(B,{mode:0o700});fs.mkdirSync(B+'/root-inputs',{mode:0o700});fs.mkdirSync(B+'/root-inputs/profiles',{mode:0o700});fs.mkdirSync(B+'/root-inputs/profiles/cloud',{mode:0o700})
for(const name of ['storage-plan.json','rootDeployment.json','credentials.json','GENERATION.json','profiles/cloud/cordis.patch.yml','profiles/cloud/cordis.yml','profiles/cloud/package.json']){fs.copyFileSync(p+'/root/run/dsh-feature-root/'+name,B+'/root-inputs/'+name,fs.constants.COPYFILE_EXCL);fs.chmodSync(B+'/root-inputs/'+name,0o400)}
for(const name of ['PREVIEW010-PREPARE.json','PREVIEW010-START.json','preview010-results.json','preview010-failed.json']){fs.copyFileSync(t+'/'+name,B+'/'+name,fs.constants.COPYFILE_EXCL);fs.chmodSync(B+'/'+name,0o400)}
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
