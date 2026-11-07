import {test} from 'node:test';
import assert from 'node:assert/strict';
import {readFileSync,readdirSync,mkdtempSync,rmSync,mkdirSync} from 'node:fs';
import {join} from 'node:path';
import {randomUUID} from 'node:crypto';
import {openStore} from '../dist/server/service.mjs';
const uid=()=>randomUUID();
test('official Airalogy engine executes parse, assignment, validation and workflow with approval, cancellation and persistence',async()=>{
 mkdirSync('verification/engine-tests',{recursive:true});const dir=mkdtempSync('verification/engine-tests/run-');let store=openStore(dir);
 const call=(op,args={},actor='human',session='engine-A')=>store.execute(op,args,actor,undefined,session);
 const wait=async id=>{for(let i=0;i<300;i++){const run=await call('engine_run_get',{id});if(run.status!=='running')return run;await new Promise(r=>setTimeout(r,200));}throw new Error('Engine did not complete');};
 const upload=async(id,kind,files)=>call('engine_package_put',{id,version:'1.0.0',title:id,kind,files,requestId:uid()});
 const approve=async p=>call('engine_package_review',{id:p.id,version:p.version,sha256:p.sha256,approved:true,reason:'Test fixture source inspected'});
 const run=async(id,action,params={})=>wait((await call('engine_run',{packageId:id,version:'1.0.0',action,params,requestId:uid()})).id);
 try{
  const status=await call('engine_status');assert.equal(status.ready,true,JSON.stringify(status));
  const example='upstream/airalogy/examples/airalogy-engine';const files=Object.fromEntries(readdirSync(example).filter(f=>/\.(aimd|toml|py)$/.test(f)).map(f=>[f,readFileSync(join(example,f),'utf8')]));
  await assert.rejects(call('engine_package_put',{id:'x',version:'1',title:'x',kind:'protocol',files,requestId:uid()},'agent'),{code:'FORBIDDEN'});
  await assert.rejects(upload('escape','protocol',{...files,'../escape.py':'bad'}),{code:'INVALID'});
  const p=await upload('official','protocol',files);
  await assert.rejects(run('official','parse_protocol'),{code:'FORBIDDEN'});
  await assert.rejects(call('engine_package_get',{id:'official',version:'1.0.0'},'human','engine-B'),{code:'NOT_FOUND'});
  await approve(p);
  const parsed=await run('official','parse_protocol');assert.equal(parsed.status,'succeeded',JSON.stringify(parsed));assert.ok(parsed.result.data);
  const assignment=await run('official','assign_variable',{var_name:'duration',dependent_data:{seconds:120}});assert.equal(assignment.status,'succeeded',JSON.stringify(assignment));assert.match(JSON.stringify(assignment.result),/PT2M/);
  const invalid=await run('official','validate_variables',{seconds:'invalid'});assert.equal(invalid.status,'validation_failed',JSON.stringify(invalid));
  const good=await run('official','validate_variables',{seconds:120,duration:'PT2M',endpoint:'',user_name:'tester',current_time:'2026-10-24T12:00:00Z'});assert.equal(good.status,'succeeded',JSON.stringify(good));
  const wp={
   'workflow.aimd':'version: airalogy.workflow.v1\nid: test\nnodes:\n  - id: input\n    protocol_id: input_protocol\n  - id: result\n    protocol_id: result_protocol\nassigners:\n  - id: double\n    runtime: python\n    entrypoint: calculate.py:assign\ntransitions:\n  - id: calculate\n    from: [input]\n    to: [result]\n    run: double\n    inputs:\n      x: ${input.var.x}\n    assign:\n      result:\n        var.y: ${calculate.outputs.y}\n',
   'calculate.py':'def assign(x):\n    print("noise from protocol")\n    return {"y": x * 2}\n',
  };
  await approve(await upload('workflow','workflow',wp));
  const flow=await run('workflow','workflow',{records:{input:{var:{x:21}}}});assert.equal(flow.status,'succeeded',JSON.stringify(flow));assert.equal(flow.result.data.records.result.data.var.y,42);
  assert.equal(flow.result.data.executed_transitions[0].id,'calculate');
  const sleeping={...files,'assigner.py':files['assigner.py'].replace('seconds = dependent_fields["seconds"]','time.sleep(60)\n    seconds = dependent_fields["seconds"]')};await approve(await upload('slow','protocol',sleeping));
  const args={packageId:'slow',version:'1.0.0',action:'assign_variable',params:{var_name:'duration',dependent_data:{seconds:120}},requestId:uid()};
  const slow=await call('engine_run',args);assert.equal((await call('engine_run',args)).id,slow.id);
  await assert.rejects(call('engine_run',{...args,params:{}}),{code:'CONFLICT'});
  await assert.rejects(call('engine_cancel',{id:slow.id},'human','engine-B'),{code:'NOT_FOUND'});
  await new Promise(r=>setTimeout(r,1200));await call('engine_cancel',{id:slow.id});assert.equal((await wait(slow.id)).status,'cancelled');
  store.close();store=openStore(dir);assert.equal((await call('engine_run_get',{id:flow.id})).result.data.records.result.data.var.y,42);
 }finally{store.close();rmSync(dir,{recursive:true,force:true});}
});
