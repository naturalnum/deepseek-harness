import {mkdtempSync,rmSync} from 'node:fs'
import {tmpdir} from 'node:os'
import {join} from 'node:path'
import {randomUUID} from 'node:crypto'
import {DatabaseSync} from 'node:sqlite'
import {expect,it} from 'vitest'
import {openStore} from '../src/server/service.mjs'

it('allows a newly reviewed method after an earlier open loses its task CAS',async()=>{
  const directory=mkdtempSync(join(tmpdir(),'approved-method-retry-'))
  const reached=Promise.withResolvers<void>(),resume=Promise.withResolvers<void>()
  let calls=0, closed=false
  const store=openStore(directory,{engine:{status:async()=>({ready:true}),run:async()=>{
    calls++
    if(calls===1){reached.resolve();await resume.promise}
    return {success:true,data:{assigners:{[calls===1?'missing_rate':'slope']:{mode:'auto'}}}}
  }}})
  const call=(op:string,args:Record<string,unknown>,actor='agent')=>store.execute(op,args,actor,undefined,'retry-session')
  try {
    const task=await call('task_create',{objective:'Synthetic',basis:'synthetic',methodId:'power-data-quality-interactive',methodVersion:'1.0.0',requestId:randomUUID()})
    const original=await call('method_get',{id:task.methodId,version:task.methodVersion})
    const pending=call('task_open',{id:task.id,reason:'Reviewed old source',requestId:randomUUID(),expectedTaskRevision:task.revision,
      expectedMethodId:original.id,expectedMethodVersion:original.version,expectedMethodSha256:original.sha256},'human')
    await reached.promise
    const changed=await call('task_select_method',{id:task.id,expectedRevision:task.revision,methodId:'power-linear-calibration',methodVersion:'1.0.0',requestId:randomUUID()})
    resume.resolve()
    await expect(pending).rejects.toMatchObject({code:'CONFLICT'})
    const orphanState=await call('state',{})
    expect(orphanState.records).toHaveLength(1)
    const selected=await call('method_get',{id:changed.methodId,version:changed.methodVersion})
    const request={id:task.id,reason:'Reviewed new source',requestId:randomUUID(),expectedTaskRevision:changed.revision,
      expectedMethodId:selected.id,expectedMethodVersion:selected.version,expectedMethodSha256:selected.sha256}
    const opened=await call('task_open',request,'human')
    expect(opened.record.protocolId).toBe(selected.id)
    expect(opened.record.id).not.toBe(orphanState.records[0].id)
    expect((await call('task_open',request,'human')).record.id).toBe(opened.record.id)
    expect((await call('task_open',{...request,requestId:randomUUID()},'human')).record.id).toBe(opened.record.id)
    expect((await call('state',{})).records).toHaveLength(2)
    const db=new DatabaseSync(join(directory,'research.sqlite'),{readOnly:true})
    try {
      const ids=(db.prepare('SELECT id FROM requests').all() as Array<{id:string}>).map(row=>row.id.split(':').at(-1)!)
      const prepared=ids.filter(id=>id.startsWith('prepare-'))
      expect(prepared.length).toBeGreaterThan(0)
      expect(prepared.every(id=>id.length===72 && /^[\w.-]+$/.test(id))).toBe(true)
    } finally {db.close()}
    // A persisted existing record remains the task's authoritative record across reopening.
    await store.close();closed=true
    const reopened=openStore(directory,{engine:{status:async()=>({ready:true}),run:async()=>{throw new Error('Existing binding must not be rerun')}}})
    try {
      const existing=await reopened.execute('task_open',{...request,requestId:randomUUID()},'human',undefined,'retry-session')
      expect(existing.record.id).toBe(opened.record.id)
    } finally {await reopened.close()}

  } finally {resume.resolve();if(!closed)await store.close();rmSync(directory,{recursive:true,force:true})}
})
