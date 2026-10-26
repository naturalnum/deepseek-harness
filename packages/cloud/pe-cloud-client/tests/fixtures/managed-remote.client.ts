/** Exact generated-method test answers; no real Peer, API publication or files owner is simulated. */
import { vi } from 'vitest'
import { brandString } from '@deepseek-ai/dsh-brand'
import type { ManagedSkillRemote } from '../../src/client/managed-skill-remote.ts'
type State=Extract<Awaited<ReturnType<ManagedSkillRemote['installed']>>,{ ok:true }>['value']
type Entry=State['entries'][number]
export const directoryVersion=(token:string):State['version']=>({ epoch:brandString<State['version']['epoch']>('34'),editToken:brandString<State['version']['editToken']>(token) })
export function remoteFixture(){
  const entry:Entry={ skillId:brandString<Entry['skillId']>('installed-one'),name:'one',description:'Original native description',source:'custom',provider:'native-account-provider',invocation:{ modelInvocable:true,userInvocable:true },contentVersion:brandString<Entry['contentVersion']>('content-one'),fileCount:2,contentBytes:15,legacySample:false,selection:{ kind:'effective' },mutable:true,actions:{ update:true,uninstall:true,download:true } }
  const state:State={ entries:[entry],version:directoryVersion('original-directory'),complete:true,actions:{ install:true },limits:{ maxSkills:4,maxFilesPerBundle:8,maxDirectoriesPerBundle:8,maxFileBytes:4096,maxBundleBytes:8192,maxZipBytes:8192,maxPathBytes:128,maxPathDepth:4,maxRequestBytes:32768,maxReplyBytes:32768 } }
  const installed=vi.fn<ManagedSkillRemote['installed']>(async()=>({ ok:true,value:state }))
  const details=vi.fn<ManagedSkillRemote['details']>(async()=>({ ok:true,value:{ entry,version:directoryVersion('opened-directory'),files:[{ relativePath:'SKILL.md',bytes:12,sha256:'a'.repeat(64) },{ relativePath:'references/data.bin',bytes:3,sha256:'b'.repeat(64) }] } }))
  const install=vi.fn<ManagedSkillRemote['install']>(async()=>({ ok:true,value:{ persisted:true,applied:true,version:directoryVersion('after-install'),entry } }))
  const update=vi.fn<ManagedSkillRemote['update']>(async()=>({ ok:true,value:{ persisted:true,applied:false,version:directoryVersion('after-update'),entry } }))
  const uninstall=vi.fn<ManagedSkillRemote['uninstall']>(async()=>({ ok:true,value:{ persisted:true,applied:true,version:directoryVersion('after-remove'),entry:null } }))
  const download=vi.fn<ManagedSkillRemote['download']>(async()=>({ ok:true,value:{ skillId:entry.skillId,contentVersion:entry.contentVersion,fileName:'one.zip',mediaType:'application/zip',bytes:243,sha256:'5fc10acae80837d5ef43dd80a39927f65d73943887ab0c280df66c1366ac6be2',dataBase64:'UEsDBBQAAAAAAGYIWF0rgX2ZDAAAAAwAAAAIAAAAU0tJTEwubWRpbnN0cnVjdGlvbnNQSwMEFAAAAAAAZghYXfYUYhsDAAAAAwAAABMAAAByZWZlcmVuY2VzL2RhdGEuYmluAP8BUEsBAhQDFAAAAAAAZghYXSuBfZkMAAAADAAAAAgAAAAAAAAAAAAAAIABAAAAAFNLSUxMLm1kUEsBAhQDFAAAAAAAZghYXfYUYhsDAAAAAwAAABMAAAAAAAAAAAAAAIABMgAAAHJlZmVyZW5jZXMvZGF0YS5iaW5QSwUGAAAAAAIAAgB3AAAAZgAAAAAA' } }))
  const remote:ManagedSkillRemote={ installed,details,install,update,uninstall,download }
  const parent=new AbortController();let active=true
  const assertCurrent=vi.fn(()=>{if(!active)throw new Error('original page revoked')})
  return{ remote,entry,state,installed,details,install,update,uninstall,download,parent,
    input:{ signal:parent.signal,timeoutMs:1000,assertCurrent },revoke:()=>{active=false;parent.abort()} }
}
