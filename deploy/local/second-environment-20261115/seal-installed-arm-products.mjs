/** Seal the already verified normal ARM product directory in its owned carrier; no product or native file changes. */
import fs from 'node:fs'
import {execFileSync} from 'node:child_process'
import {createRequire} from 'node:module'
import {isDeepStrictEqual} from 'node:util'
const ROOT='/opt/dsh-installed-products',A='/opt/dsh-features/arm-native-01'
const need=(value,message)=>{if(!value)throw Error(message)}
need(process.platform==='linux'&&process.arch==='arm64'&&process.getuid()===0,'Actual owned Linux ARM Root required')
const manifest=JSON.parse(fs.readFileSync(A+'/manifest.json','utf8'))
need(manifest.sourceCommit==='63bd14cf7ab9b2debcf6a8f8b62eac8ccc0572fe','Exact normal product source required')
const product=createRequire(ROOT+'/package.json')(ROOT+'/deploy/local/product-files.cjs')
const expected=new Map(manifest.files.map(row=>[row.path,row]))
const actual=product.collectManagedFiles(ROOT,[],manifest.files)
need(actual.length===expected.size&&actual.every(row=>isDeepStrictEqual(row,expected.get(row.path))),'Installed normal product rows differ')
const mounts=()=>fs.readFileSync('/proc/self/mountinfo','utf8').trim().split(String.fromCharCode(10)).filter(row=>row.split(' - ')[0].split(' ')[4]===ROOT)
need(mounts().length===0,'Product already has a mount; retain it and inspect ownership')
fs.writeFileSync(A+'/PRODUCT-BIND-INTENT.json',JSON.stringify({at:new Date().toISOString(),sourceCommit:manifest.sourceCommit,files:actual.length,namespace:fs.readlinkSync('/proc/self/ns/mnt')})+'\n',{flag:'wx',mode:0o600})
execFileSync('/usr/bin/mount',['--bind',ROOT,ROOT],{stdio:'pipe'})
execFileSync('/usr/bin/mount',['-o','remount,bind,ro',ROOT],{stdio:'pipe'})
const rows=mounts();need(rows.length===1,'Product mount is ambiguous after seal')
const [prefix,suffix]=rows[0].split(' - '),flags=prefix.split(' ')[5].split(',')
need(flags.includes('ro')&&!flags.includes('rw'),'Product mount is not read only')
const result={status:'normal-installed-products-readonly-bind-confirmed',sourceCommit:manifest.sourceCommit,files:actual.length,mount:rows[0],filesystem:suffix.split(' ')[0],readOnly:true,blockDevice:false,blockReadOnly:null,loopDevice:null,namespace:fs.readlinkSync('/proc/self/ns/mnt'),underlyingProductBytesChanged:false}
fs.writeFileSync(A+'/PRODUCT-BIND-READY.public.json',JSON.stringify(result)+'\n',{flag:'wx',mode:0o444})
console.log(JSON.stringify(result))
