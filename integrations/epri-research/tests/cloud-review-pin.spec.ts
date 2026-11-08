import {mkdtempSync,rmSync} from 'node:fs'
import {tmpdir} from 'node:os'
import {join} from 'node:path'
import {randomUUID} from 'node:crypto'
import {expect,it} from 'vitest'
import {openStore} from '../src/server/service.mjs'

it('rejects a method changed during the engine probe before installing any package or creating records',async()=>{
  const path=mkdtempSync(join(tmpdir(),'approved-method-race-'))
  const reached=Promise.withResolvers<void>(),resume=Promise.withResolvers<void>()
  const store=openStore(path,{engine:{status:async()=>{reached.resolve();await resume.promise;return {ready:true}},run:async()=>{throw new Error('No execution expected')}}})
  const call=(op:string,args:Record<string,unknown>,actor='agent')=>store.execute(op,args,actor,undefined,'race-session')
  try {
    const task=await call('task_create',{objective:'Synthetic approval race',basis:'synthetic',methodId:'power-data-quality-interactive',methodVersion:'1.0.0',requestId:randomUUID()})
    const method=await call('method_get',{id:task.methodId,version:task.methodVersion})
    const pending=call('task_open',{id:task.id,reason:'Synthetic approval',requestId:randomUUID(),expectedTaskRevision:task.revision,
      expectedMethodId:method.id,expectedMethodVersion:method.version,expectedMethodSha256:method.sha256},'human')
    await reached.promise
    const changed=await call('task_select_method',{id:task.id,expectedRevision:task.revision,methodId:'power-linear-calibration',methodVersion:'1.0.0',requestId:randomUUID()})
    resume.resolve()
    await expect(pending).rejects.toMatchObject({code:'CONFLICT'})
    expect((await call('task_get',{id:task.id})).methodId).toBe(changed.methodId)
    expect(await call('engine_packages',{})).toEqual([])
    expect((await call('state',{})).records).toEqual([])
  } finally {resume.resolve();await store.close();rmSync(path,{recursive:true,force:true})}
})
