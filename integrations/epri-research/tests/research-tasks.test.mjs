import {test} from 'node:test';
import assert from 'node:assert/strict';
import {mkdtempSync,rmSync,readFileSync} from 'node:fs';
import {tmpdir} from 'node:os';
import {join} from 'node:path';
import {randomUUID} from 'node:crypto';
import {openStore} from '../dist/server/service.mjs';
import {startServer} from '../dist/server/main.mjs';
import {reviewInConversation} from '../plugins/airalogy/conversation-review.mjs';

test('method matching, pending scenarios, task CAS, session isolation, archive and explicit human method approval',async()=>{
  const directory=mkdtempSync(join(tmpdir(),'power-tasks-'));let store=openStore(directory);
  const call=(op,args={},actor='agent',session='A')=>store.execute(op,args,actor,undefined,session);
  try{
    assert.equal((await call('method_catalog')).methods.length,3);
    assert.equal((await call('method_catalog',{query:'测点缺失率'})).methods[0].id,'power-data-quality-interactive');
    assert.equal((await call('method_catalog',{query:'继电保护整定与潮流仿真'})).unmatched,true);
    const source=await call('method_get',{id:'power-linear-calibration',version:'1.0.0'});
    await call('engine_package_put',{id:'broken-metadata',version:'1.0.0',title:'Malformed optional metadata',kind:'protocol',files:{...source.files,'method.json':'{broken'},requestId:randomUUID()},'human');
    const catalog=await call('method_catalog');assert.equal(catalog.methods.length,3);assert.equal(catalog.warnings[0].id,'broken-metadata');
    await assert.rejects(call('method_get',{id:'broken-metadata',version:'1.0.0'}));
    const args={objective:'潮流仿真任务，等待连接客户计算工具',basis:'synthetic',requirements:'尚无方法和设备连接',requestId:randomUUID()};
    const t=await call('task_create',args);assert.equal(t.stage,'method');assert.equal((await call('task_create',args)).id,t.id);
    await assert.rejects(call('task_create',{...args,objective:'改了内容'}),{code:'CONFLICT'});
    assert.equal((await call('tasks',{},'agent','B')).length,0);assert.equal((await call('state',{},'agent','B')).tasks.length,0);
    await assert.rejects(call('task_get',{id:t.id},'agent','B'),{code:'NOT_FOUND'});
    const selected=await call('task_select_method',{id:t.id,expectedRevision:t.revision,methodId:'power-linear-calibration',methodVersion:'1.0.0',requestId:randomUUID()});assert.equal(selected.stage,'open');
    await assert.rejects(call('task_select_method',{id:t.id,expectedRevision:t.revision,methodId:'power-forecast-assessment',methodVersion:'1.0.0',requestId:randomUUID()}),{code:'CONFLICT'});
    await assert.rejects(call('task_open',{id:t.id,reason:'Agent cannot approve',requestId:randomUUID()}),{code:'FORBIDDEN'});
    await assert.rejects(call('task_report',{id:t.id,requestId:randomUUID()}),{code:'INCOMPLETE'});
    const archive=await call('workspace_export'),inspection=await call('archive_inspect',{contentBase64:archive.contentBase64});
    await call('workspace_import',{contentBase64:archive.contentBase64,sha256:inspection.sha256,requestId:randomUUID()},'human','B');
    const restored=(await call('tasks',{},'agent','B'))[0];assert.equal(restored.objective,t.objective);assert.equal(restored.stage,'open');assert.notEqual(restored.id,t.id);assert.equal(restored.selectedMethod.approved,false);
    store.close();store=openStore(directory);assert.equal((await call('tasks')).length,1);
  }finally{store.close();rmSync(directory,{recursive:true,force:true});}
});

test('task approval previews exact sources and a decline never imports or approves code',async()=>{
  const directory=mkdtempSync(join(tmpdir(),'task-question-')),prior=process.env.DS_RESEARCH_DATA_DIR;process.env.DS_RESEARCH_DATA_DIR=directory;
  const app=await startServer({directory,port:0}),sessionId='synthetic-task-review';
  const call=async(op,args={})=>{const r=await fetch(app.url+'/api',{method:'POST',headers:{'Content-Type':'application/json',Authorization:'Bearer '+app.credentials.humanToken},body:JSON.stringify({op,args,sessionId})});const body=await r.json();assert.ok(r.ok,body.error);return body.result;};
  try{
    const task=await call('task_create',{objective:'合成标定界面测试',basis:'synthetic',methodId:'power-linear-calibration',methodVersion:'1.0.0',requestId:randomUUID()});
    const ctx={get:()=>({ask:async request=>{assert.match(request.questions[0].detail,/assigner/);assert.match(request.questions[0].detail,/SHA/);return {answers:[{id:request.questions[0].id,selected:[request.questions[0].options[0].label]}]};}})};
    const result=await reviewInConversation(ctx,'task_open',{id:task.id,reason:'合成测试，等待人工核对',requestId:randomUUID()},{agent:{ctx:{get:()=>undefined}},callId:'synthetic-task-open',signal:new AbortController().signal},sessionId);
    assert.equal(result.executed,false);assert.deepEqual(await call('engine_packages'),[]);assert.equal((await call('task_get',{id:task.id})).record,undefined);
  }finally{await app.close();if(prior===undefined)delete process.env.DS_RESEARCH_DATA_DIR;else process.env.DS_RESEARCH_DATA_DIR=prior;rmSync(directory,{recursive:true,force:true});}
});
