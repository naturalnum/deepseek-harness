import {mkdtempSync,rmSync} from 'node:fs'
import {tmpdir} from 'node:os'
import {join} from 'node:path'
import {randomUUID} from 'node:crypto'
import {DatabaseSync} from 'node:sqlite'
import {expect,it} from 'vitest'
import {openStore} from '../src/server/service.mjs'

it.each(['method','source-hash','missing-record','protocol-content','unbound-protocol-content'] as const)('preserves mismatched legacy record and refuses workbench writes: %s',async mismatch=>{
 const path=mkdtempSync(join(tmpdir(),'mismatched-task-'))
 const store=openStore(path,{engine:{status:async()=>({ready:true}),run:async()=>({success:true,data:{assigners:{missing_rate:{mode:'auto'}}}})}})
 const call=(op:string,args:Record<string,unknown>,actor='agent')=>store.execute(op,args,actor,undefined,'mismatch-session')
 try {
  const oldTask=await call('task_create',{objective:'Old',basis:'synthetic',methodId:'power-data-quality-interactive',methodVersion:'1.0.0',requestId:randomUUID()})
  const oldMethod=await call('method_get',{id:oldTask.methodId,version:oldTask.methodVersion})
  const old=await call('task_open',{id:oldTask.id,reason:'Reviewed',requestId:randomUUID(),expectedTaskRevision:oldTask.revision,expectedMethodId:oldMethod.id,expectedMethodVersion:oldMethod.version,expectedMethodSha256:oldMethod.sha256},'human')
  const wanted=mismatch==='method'?'power-linear-calibration':'power-data-quality-interactive'
  const task=await call('task_create',{objective:'New',basis:'synthetic',methodId:wanted,methodVersion:'1.0.0',requestId:randomUUID()})
  const chosen=await call('method_get',{id:task.methodId,version:task.methodVersion})
  const db=new DatabaseSync(join(path,'research.sqlite'))
  try {const row=db.prepare('SELECT body FROM state WHERE id=1').get() as {body:string};const state=JSON.parse(row.body);state.tasks.find((t:{id:string})=>t.id===task.id).recordId=mismatch==='missing-record'?'nonexistent-record':old.record.id;if(mismatch==='source-hash')state.records.find((r:{id:string})=>r.id===old.record.id).calculationBinding.sha256='f'.repeat(64);if(mismatch.includes('protocol-content'))state.protocols.find((p:{id:string})=>p.id===old.record.protocolId).content+='\n# changed';if(mismatch==='unbound-protocol-content')delete state.records.find((r:{id:string})=>r.id===old.record.id).calculationBinding;db.prepare('UPDATE state SET body=? WHERE id=1').run(JSON.stringify(state))}finally{db.close()}
  const before=await call('state',{}),packages=await call('engine_packages',{})
  const view=await call('task_get',{id:task.id})
  expect(view.bindingConflict).toBe(true);expect(view.next).toContain('不一致');expect(view.reportCurrent).toBe(false);expect(view.record?.id).toBe(mismatch==='missing-record'?undefined:old.record.id)
  const open={id:task.id,reason:'Review',requestId:randomUUID(),expectedTaskRevision:task.revision,expectedMethodId:chosen.id,expectedMethodVersion:chosen.version,expectedMethodSha256:chosen.sha256}
  await expect(call('task_open',open,'human')).rejects.toMatchObject({code:'CONFLICT'})
  await expect(call('task_import_csv',{id:task.id,reference:'attachment:'+'a'.repeat(64),table:'measurements',expectedRecordRevision:old.record.revision,requestId:randomUUID()},'human')).rejects.toMatchObject({code:'CONFLICT'})
  await expect(call('task_evidence',{id:task.id,requestId:randomUUID()})).rejects.toMatchObject({code:'CONFLICT'})
  await expect(call('task_report',{id:task.id,requestId:randomUUID()})).rejects.toMatchObject({code:'CONFLICT'})
  expect(await call('state',{})).toEqual(before);expect(await call('engine_packages',{})).toEqual(packages)
 }finally{await store.close();rmSync(path,{recursive:true,force:true})}
})

it('shows an unavailable method as unverified and refuses task writes',async()=>{
 const path=mkdtempSync(join(tmpdir(),'missing-method-'))
 const store=openStore(path,{engine:{status:async()=>({ready:true}),run:async()=>({success:true,data:{assigners:{missing_rate:{mode:'auto'}}}})}})
 const call=(op:string,args:Record<string,unknown>,actor='agent')=>store.execute(op,args,actor,undefined,'missing-session')
 try {
  const base=await call('method_get',{id:'power-data-quality-interactive',version:'1.0.0'})
  await call('engine_package_put',{id:'custom-method',version:'1',title:'Custom',kind:'protocol',files:base.files,requestId:randomUUID()},'human')
  const custom=await call('method_get',{id:'custom-method',version:'1'})
  const task=await call('task_create',{objective:'Synthetic',basis:'synthetic',methodId:custom.id,methodVersion:custom.version,requestId:randomUUID()})
  const opened=await call('task_open',{id:task.id,reason:'Reviewed',requestId:randomUUID(),expectedTaskRevision:task.revision,expectedMethodId:custom.id,expectedMethodVersion:custom.version,expectedMethodSha256:custom.sha256},'human')
  const db=new DatabaseSync(join(path,'research.sqlite'))
  try{db.prepare('DELETE FROM engine_packages WHERE session=? AND id=? AND version=?').run('missing-session',custom.id,custom.version)}finally{db.close()}
  const before=await call('state',{}),view=await call('task_get',{id:task.id})
  expect(view.bindingConflict).toBe(true);expect(view.next).toContain('无法核验');expect(view.record.id).toBe(opened.record.id);expect(view.reportCurrent).toBe(false)
  await expect(call('task_open',{id:task.id,reason:'Review',requestId:randomUUID()},'human')).rejects.toBeDefined()
  await expect(call('task_evidence',{id:task.id,requestId:randomUUID()})).rejects.toBeDefined()
  await expect(call('task_report',{id:task.id,requestId:randomUUID()})).rejects.toBeDefined()
  expect(await call('state',{})).toEqual(before)
 }finally{await store.close();rmSync(path,{recursive:true,force:true})}
})
