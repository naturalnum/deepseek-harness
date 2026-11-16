/** Install only the pinned, missing Linux ARM system package payload into this existing RO product mount. */
import fs from 'node:fs'
import {createHash} from 'node:crypto'
import {createRequire} from 'node:module'
import {pathToFileURL} from 'node:url'
import {execFileSync} from 'node:child_process'
const A='/opt/dsh-features/arm-native-01',ROOT='/opt/dsh-installed-products',U=A+'/native-system-arm-public-01'
const need=(v,m)=>{if(!v)throw Error(m)},sha=b=>createHash('sha256').update(b).digest('hex')
if(process.argv.length===2){console.log(JSON.stringify({inert:true}));process.exit(0)}
need(process.argv.length===3&&process.argv[2]==='--install-absent-native-system','Exact native system install argument required')
need(process.platform==='linux'&&process.arch==='arm64'&&process.getuid()===0&&process.report.getReport().header.glibcVersionRuntime,'Owned Linux ARM glibc carrier required')
const pins=JSON.parse(fs.readFileSync(U+'/pins.json')),allowed=['native/system/packages/entry/lib/flock.js','native/system/packages/entry/lib/index.js','native/system/packages/entry/lib/flock.d.ts','native/system/packages/entry/lib/index.d.ts','native/system/packages/linux-arm64/bin/glibc/system.node']
need(pins.files.length===allowed.length&&pins.files.every((x,i)=>x.path===allowed[i]),'Exact native package payload required')
need(sha(fs.readFileSync(ROOT+'/native/system/packages/entry/src/flock.c'))===pins.flockCSourceSha256,'Original native flock C source must match the supplied binary build')
for(const pid of fs.readdirSync('/proc').filter(x=>/^\d+$/.test(x))){try{need(!/^Uid:\s+(.+)$/m.exec(fs.readFileSync('/proc/'+pid+'/status','utf8'))?.[1].trim().split(/\s+/).includes('2000'),'Original application writer remains')}catch(e){if(!['ENOENT','ESRCH'].includes(e.code))throw e}}
const mount=()=>{const rows=fs.readFileSync('/proc/self/mountinfo','utf8').trim().split('\n').filter(l=>l.split(' - ')[0].split(' ')[4]===ROOT);need(rows.length===1,'Exact product mount required');const [a,b]=rows[0].split(' - ');need(b.startsWith('overlay '),'Original product overlay required');return {id:a.split(' ')[0],flags:a.split(' ')[5].split(',')}}
const before=mount();need(before.flags.includes('ro'),'Original product must be readonly')
for(const x of pins.files){const b=fs.readFileSync(U+'/'+x.path);need(b.length===x.bytes&&sha(b)===x.sha256&&!fs.existsSync(ROOT+'/'+x.path),'Exact absent package payload required');if(x.path.endsWith('.node'))need(b.subarray(0,4).equals(Buffer.from([127,69,76,70]))&&b.readUInt16LE(18)===183,'Actual Linux ARM ELF required')}
fs.writeFileSync(U+'/install-intent.json',JSON.stringify({at:new Date().toISOString(),mount:before,files:pins.files.map(x=>({path:x.path,sha256:x.sha256}))})+'\n',{flag:'wx',mode:0o400})
try{execFileSync('/usr/bin/mount',['-o','remount,bind,rw',ROOT]);for(const x of pins.files){const target=ROOT+'/'+x.path;fs.mkdirSync(target.slice(0,target.lastIndexOf('/')),{recursive:true,mode:0o755});const fd=fs.openSync(target,'wx',0o444);try{fs.writeFileSync(fd,fs.readFileSync(U+'/'+x.path));fs.fsyncSync(fd)}finally{fs.closeSync(fd)}}}finally{execFileSync('/usr/bin/mount',['-o','remount,bind,ro',ROOT])}
need(mount().id===before.id&&mount().flags.includes('ro'),'Original product RO restoration required')
for(const x of pins.files)need(sha(fs.readFileSync(ROOT+'/'+x.path))===x.sha256,'Exact native payload readback required')
const req=createRequire(ROOT+'/package.json'),{tryLockExclusive}=await import(pathToFileURL(req.resolve('@deepseek-ai/node-addon-system/flock')).href)
const lock=U+'/actual-flock.lock',one=fs.openSync(lock,'wx+',0o600),two=fs.openSync(lock,'r+')
let contention=false
try{await tryLockExclusive(one);try{await tryLockExclusive(two)}catch(e){need(['EAGAIN','EWOULDBLOCK'].includes(e.code),'Actual flock contention failure required');contention=true}need(contention,'Second independent open must be refused')}finally{fs.closeSync(one)}
try{await tryLockExclusive(two)}finally{fs.closeSync(two)}
fs.unlinkSync(lock)
const result={status:'pinned-linux-arm-native-system-installed-ro',files:pins.files.length,flockAcquireContentionRelease:true,sourceCMatches:true,darwinPayloads:0,platform:'linux-arm64-glibc',productMount:mount()}
fs.writeFileSync(U+'/installed.public.json',JSON.stringify(result)+'\n',{flag:'wx',mode:0o444});console.log(JSON.stringify(result))
