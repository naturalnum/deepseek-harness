/** One request to the original real AccountUse/Workspace/Session/tools consumer after actual app ready. */
import fs from 'node:fs'
import {randomBytes} from 'node:crypto'
const A='/opt/dsh-features/arm-native-01',D='/dsh-state/namespace-arm-09',H='/run/dsh-feature-root',T='/tmp/dsh-feature-home/sdk-validation'
if(process.argv.length!==3||process.argv[2]!=='--submit-once-to-ready-app')throw Error('Explicit one-shot request required')
const ready=JSON.parse(fs.readFileSync(D+'/ROOT-READY.public.json')),k=ready.keeper
const t=fs.readFileSync('/proc/'+k.pid+'/stat','utf8')
if(t.slice(t.lastIndexOf(')')+2).split(/\s+/)[19]!==k.startTicks||fs.readlinkSync('/proc/'+k.pid+'/ns/mnt')!==k.mountNamespace)throw Error('Original ready keeper changed')
const P='/proc/'+k.pid+'/root',plan=JSON.parse(fs.readFileSync(P+H+'/storage-plan.json'))
const first=plan.slots.find(s=>s.slotId==='account-slot-a'),second=plan.slots.find(s=>s.slotId==='account-slot-b')
const output=P+T+'/application-ready.json'
if(!fs.existsSync(output)||fs.existsSync(P+T+'/SDK-TEST-REQUEST.json'))throw Error('App not ready or original Native request already issued')
const marker=randomBytes(18).toString('hex')
const privateMarker=first.private.rootPath+'/sdk-owned-private-boundary-08.txt',foreignMarker=second.projects.rootPath+'/sdk-owned-foreign-boundary-08.txt'
for(const name of [privateMarker,foreignMarker]){fs.writeFileSync(P+name,marker,{flag:'wx',mode:0o600});fs.chownSync(P+name,2000,2000)}
const auth=JSON.parse(fs.readFileSync('/opt/dsh-features/auth-result.public.json'))
const request={accountId:auth.userId,searchProgramPath:'/opt/dsh-installed-products/node_modules/@vscode/ripgrep-linux-arm64/bin/rg',privateMarkerPath:privateMarker,foreignMarkerPath:foreignMarker}
fs.writeFileSync(P+T+'/SDK-TEST-REQUEST.json',JSON.stringify(request)+'\n',{flag:'wx',mode:0o600});fs.chownSync(P+T+'/SDK-TEST-REQUEST.json',2000,2000)
console.log(JSON.stringify({submitted:true,accountAlias:'ARM-A',accountId:auth.userId,originalAccountUseConsumer:true,modelRequestIssued:false,nativeSuccessNotYetObserved:true}))
