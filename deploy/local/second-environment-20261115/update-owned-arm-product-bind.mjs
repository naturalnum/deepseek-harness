/** Normal product-file backup/replacement for this existing owned RO self-bind; no block-device or dependency changes. */
import fs from 'node:fs'
import {createRequire} from 'node:module'
import {pathToFileURL} from 'node:url'
import {execFileSync} from 'node:child_process'
import {isDeepStrictEqual} from 'node:util'
const ROOT='/opt/dsh-installed-products',A='/opt/dsh-features/arm-native-01',U=A+'/product-update-5b4476'
const SOURCE='5b4476bf3034d4d50e4da1cc460a319d18b36ae1'
const need=(v,m)=>{if(!v)throw Error(m)}
need(process.argv.length===3&&['--prepare','--install'].includes(process.argv[2]),'Explicit original backup/install stage required')
need(process.platform==='linux'&&process.arch==='arm64'&&process.getuid()===0&&fs.readlinkSync('/proc/self/ns/mnt')===fs.readlinkSync('/proc/1/ns/mnt'),'Owned native ARM carrier parent namespace required')
const {verifyBundle,externalDependencyHash}=await import(pathToFileURL(ROOT+'/deploy/bundle.mjs').href)
const manifest=await verifyBundle(U),previous=JSON.parse(fs.readFileSync(A+'/manifest.json'))
need(manifest.sourceCommit===SOURCE&&previous.sourceCommit==='63bd14cf7ab9b2debcf6a8f8b62eac8ccc0572fe','Exact before/after normal product source required')
need(manifest.externalDependencyHash===previous.externalDependencyHash&&manifest.researchLockHash===previous.researchLockHash
 &&externalDependencyHash(fs.readFileSync(ROOT+'/pnpm-lock.yaml','utf8'))===manifest.externalDependencyHash,'Original qualified Linux dependency fingerprints required')
const product=createRequire(ROOT+'/package.json')(ROOT+'/deploy/local/product-files.cjs')
const mounts=()=>fs.readFileSync('/proc/self/mountinfo','utf8').trim().split('\n').filter(l=>l.split(' - ')[0].split(' ')[4]===ROOT)
const row=()=>{const rows=mounts();need(rows.length===1,'Unique existing owned product bind required');const [a,b]=rows[0].split(' - ');need(b.split(' ')[0]==='overlay','Existing qualified self-bind kind changed');return {text:rows[0],id:a.split(' ')[0],flags:a.split(' ')[5].split(',')}}
const original=row();need(original.flags.includes('ro')&&!original.flags.includes('rw'),'Original product bind must be readonly')
if(process.argv[2]==='--prepare'){
 const actual=product.collectManagedFiles(ROOT,[],previous.files),expected=new Map(previous.files.map(x=>[x.path,x]))
 need(actual.length===expected.size&&actual.every(x=>isDeepStrictEqual(x,expected.get(x.path))),'Original installed product bytes changed')
 const result=product.prepare({productRoot:ROOT,archivePath:U+'/products.tar.gz',manifest,backupDir:U+'/rollback'})
 fs.writeFileSync(U+'/prepared.public.json',JSON.stringify({sourceCommit:SOURCE,previousSourceCommit:previous.sourceCommit,mount:original,...result})+'\n',{flag:'wx',mode:0o444});console.log(JSON.stringify(result))
}else{
 const prepared=JSON.parse(fs.readFileSync(U+'/prepared.public.json'));need(prepared.mount.id===original.id&&prepared.sourceCommit===SOURCE&&!fs.existsSync(U+'/install-intent.public.json'),'Original prepared product transaction required')
 for(const name of fs.readdirSync('/proc').filter(x=>/^\d+$/.test(x))){try{const status=fs.readFileSync('/proc/'+name+'/status','utf8');need(!/^Uid:\s+(.+)$/m.exec(status)?.[1].trim().split(/\s+/).includes('2000'),'Original app/worker must be normally stopped')}catch(e){if(!['ENOENT','ESRCH'].includes(e.code))throw e}}
 const state=JSON.parse(fs.readFileSync(U+'/rollback/rollback.json'));need(state.format==='pe-cloud-product-rollback/v1'&&isDeepStrictEqual(state.nextFiles,manifest.files),'Original complete rollback and new manifest required')
 fs.writeFileSync(U+'/install-intent.public.json',JSON.stringify({sourceCommit:SOURCE,at:new Date().toISOString(),mount:original})+'\n',{flag:'wx',mode:0o600})
 const names=new Set([...state.plan.changed,...state.plan.added]);let failure
 try{execFileSync('/usr/bin/mount',['-o','remount,bind,rw',ROOT]);product.installFiles({productRoot:ROOT,sourceRoot:U+'/rollback/new',files:manifest.files.filter(x=>names.has(x.path)),remove:state.plan.removed})}
 catch(e){failure=e}
 finally{execFileSync('/usr/bin/mount',['-o','remount,bind,ro',ROOT])}
 need(row().id===original.id&&row().flags.includes('ro')&&!row().flags.includes('rw'),'Original bind read-only restoration required')
 if(failure)throw failure
 const actual=product.collectManagedFiles(ROOT,[],manifest.files),expected=new Map(manifest.files.map(x=>[x.path,x]))
 need(actual.length===expected.size&&actual.every(x=>isDeepStrictEqual(x,expected.get(x.path))),'Installed normal product exact readback required')
 const result={status:'normal-product-bind-updated-and-resealed',sourceCommit:SOURCE,previousSourceCommit:previous.sourceCommit,files:actual.length,changed:state.plan.changed.length,added:state.plan.added.length,removed:state.plan.removed.length,mount:row(),dependenciesInstalled:false,nativeModulesReplaced:false,blockDevice:false,rollbackDirectory:U+'/rollback'}
 fs.writeFileSync(U+'/installed.public.json',JSON.stringify(result)+'\n',{flag:'wx',mode:0o444});console.log(JSON.stringify(result))
}
