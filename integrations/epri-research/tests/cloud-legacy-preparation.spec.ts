import {mkdtempSync,rmSync} from 'node:fs'
import {tmpdir} from 'node:os'
import {join} from 'node:path'
import {randomUUID} from 'node:crypto'
import {DatabaseSync} from 'node:sqlite'
import {expect,it} from 'vitest'
import {openStore} from '../src/server/service.mjs'

it.each(['same','bound-draft','changed-method','modified-draft','hash-mismatch','linked-other','concurrent-change'] as const)('safely handles an unbound legacy draft: %s',async mode=>{
 const path=mkdtempSync(join(tmpdir(),'legacy-method-'))
 let target='missing_rate'
 const reached=Promise.withResolvers<void>(),resume=Promise.withResolvers<void>()
 const store=openStore(path,{engine:{status:async()=>({ready:true}),run:async()=>{if(mode==='concurrent-change'){reached.resolve();await resume.promise}return {success:true,data:{assigners:{[target]:{mode:'auto'}}}}}}})
 const call=(op:string,args:Record<string,unknown>,actor='agent')=>store.execute(op,args,actor,undefined,'legacy-session')
 try {
  let task=await call('task_create',{objective:'Synthetic',basis:'synthetic',methodId:'power-data-quality-interactive',methodVersion:'1.0.0',requestId:randomUUID()})
  const original=await call('method_get',{id:task.methodId,version:task.methodVersion})
  await call('engine_package_put',{id:original.id,version:original.version,title:original.title,kind:original.kind,files:original.files,requestId:task.id+'.package'},'human')
  await call('engine_package_review',{id:original.id,version:original.version,sha256:original.sha256,approved:true,reason:'Reviewed'},'human')
  await call('protocol_put',{id:original.id,version:original.version,content:original.files['protocol.aimd'],requestId:task.id+':protocol'},'human')
  let prior=await call('record_create',{protocolId:original.id,protocolVersion:original.version,requestId:task.id+':record'},'human')
  if(mode==='hash-mismatch'||mode==='linked-other') {
   const other=mode==='linked-other'?await call('task_create',{objective:'Other',basis:'synthetic',methodId:original.id,methodVersion:original.version,requestId:randomUUID()}):undefined
   const db=new DatabaseSync(join(path,'research.sqlite'))
   try {
    if(mode==='hash-mismatch')db.prepare('UPDATE requests SET hash=? WHERE id=?').run('f'.repeat(64),JSON.stringify(['legacy-session','human'])+':'+task.id+':record')
    else {const state=JSON.parse((db.prepare('SELECT body FROM state WHERE id=1').get() as {body:string}).body);state.tasks.find((item:{id:string})=>item.id===other.id).recordId=prior.id;db.prepare('UPDATE state SET body=? WHERE id=1').run(JSON.stringify(state))}
   } finally {db.close()}
  } else if(mode==='bound-draft') {
   prior=await call('record_bind_engine',{id:prior.id,expectedRevision:prior.revision,packageId:original.id,version:original.version,requestId:task.id+':binding'},'human')
  } else if(mode==='changed-method'){
   task=await call('task_select_method',{id:task.id,expectedRevision:task.revision,methodId:'power-linear-calibration',methodVersion:'1.0.0',requestId:randomUUID()})
   target='slope'
  } else if(mode==='modified-draft') {
   prior=await call('record_update',{id:prior.id,expectedRevision:prior.revision,requestId:randomUUID(),run:{...prior.run,status:'running'}},'human')
  }
  const chosen=await call('method_get',{id:task.methodId,version:task.methodVersion})
  const args={id:task.id,reason:'Reviewed',requestId:randomUUID(),expectedTaskRevision:task.revision,
    expectedMethodId:chosen.id,expectedMethodVersion:chosen.version,expectedMethodSha256:chosen.sha256}
  if(mode==='concurrent-change') {
   const pending=call('task_open',args,'human');void pending.catch(()=>{})
   await reached.promise
   const updated=await call('record_update',{id:prior.id,expectedRevision:prior.revision,requestId:randomUUID(),run:{...prior.run,status:'running'}},'human')
   resume.resolve();await expect(pending).rejects.toMatchObject({code:'CONFLICT'})
   expect((await call('task_get',{id:task.id})).recordId).toBeUndefined()
   expect((await call('record_get',{id:prior.id},'human')).revision).toBe(updated.revision)
   return
  }
  const opened=await call('task_open',args,'human')
  expect(opened.record.protocolId).toBe(chosen.id)
  expect(opened.record.id===prior.id).toBe(mode==='same'||mode==='bound-draft')
  expect((await call('task_open',args,'human')).record.id).toBe(opened.record.id)
  const state=await call('state',{})
  expect(state.records).toHaveLength(mode==='same'||mode==='bound-draft'?1:2)
  if(mode==='changed-method'||mode==='modified-draft'||mode==='hash-mismatch'||mode==='linked-other')expect(state.records.find((item:{id:string})=>item.id===prior.id)).toEqual(prior)
 }finally{resume.resolve();await store.close();rmSync(path,{recursive:true,force:true})}
})
