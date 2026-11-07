import {test} from 'node:test';
import assert from 'node:assert/strict';
import {mkdtempSync,readdirSync,readFileSync,rmSync} from 'node:fs';
import {tmpdir} from 'node:os';
import {join} from 'node:path';
import {randomUUID} from 'node:crypto';
import {openStore} from '../dist/server/service.mjs';
import {openAiraArchive} from '../src/reused/aira/index.ts';

test('real Airalogy CSV recalculation retains all 500 rows across three complete chart pages and restores two rows',async()=>{
 const directory=mkdtempSync(join(tmpdir(),'airalogy-chart-pages-')),store=openStore(directory);
 const call=(op,args={})=>store.execute(op,args,'human',undefined,'real-chart-pages');
 const put=(op,args)=>call(op,{...args,requestId:randomUUID()});
 try{
  assert.equal((await call('engine_status')).ready,true,'A real Airalogy runtime is required');
  let task=await put('task_create',{objective:'Synthetic 500-row complete chart verification',basis:'synthetic',methodId:'power-data-quality-interactive',methodVersion:'1.0.0'});
  task=await put('task_open',{id:task.id,reason:'Explicit synthetic method source review'});
  const custom=await put('chart_render',{spec:{schema:'deepscientist.report_chart.v1',kind:'bar',title:'User chart',data:[{id:'user',label:'Retain',value:42}]}});
  const upload=name=>put('attachment_put',{name,contentBase64:readFileSync(new URL('./fixtures/'+name,import.meta.url)).toString('base64')});
  const large=await upload('power-quality-500.csv');
  task=await put('task_import_csv',{id:task.id,reference:large.reference,table:'measurements',expectedRecordRevision:task.record.revision});
  assert.equal(task.record.run.tables.measurements.length,500);
  assert.deepEqual(task.record.calculation.errors,[]);assert.deepEqual(task.record.calculation.pending,[]);
  assert.equal(task.record.run.values.expected_total,50000);assert.equal(task.record.run.values.valid_total,45000);assert.equal(task.record.run.values.missing_rate,10);
  assert.deepEqual(task.charts.map(chart=>chart.spec.data.length),[200,200,100]);
  assert.deepEqual(task.charts.flatMap(chart=>chart.spec.data),task.record.run.tables.measurements.map((row,i)=>({id:String(i),label:row.channel,value:row.missing_rate})));
  assert.ok(Buffer.byteLength(JSON.stringify(task))<1048576,'Complete 500-row view fits the component 1 MiB reply budget');
  const firstId=task.charts[0].id;
  const small=await upload('power-quality-2.csv');
  task=await put('task_import_csv',{id:task.id,reference:small.reference,table:'measurements',expectedRecordRevision:task.record.revision});
  assert.equal(task.charts.length,1);assert.equal(task.charts[0].id,firstId);assert.equal(task.charts[0].spec.data.length,2);
  assert.equal(task.record.run.values.expected_total,300);assert.equal(task.record.run.values.valid_total,270);assert.equal(task.record.run.values.missing_rate,10);
  const state=await call('state');assert.equal(state.artifacts.filter(chart=>chart.sourceRecordId===task.record.id).length,1);
  assert.deepEqual(state.artifacts.find(chart=>chart.id===custom.id),custom);
 }finally{store.close();rmSync(directory,{recursive:true,force:true});}
});

test('real Airalogy table edits recalculate rows and totals, persist calculation hashes and charts, reject stale writes and protect review',async()=>{
 const directory=mkdtempSync(join(tmpdir(),'airalogy-interactive-'));let store=openStore(directory);
 const call=(op,args={},actor='human',session='interactive-A')=>store.execute(op,args,actor,undefined,session);
 const files=Object.fromEntries(readdirSync('examples/interactive-power').map(name=>[name,readFileSync('examples/interactive-power/'+name,'utf8')]));
 try{
  assert.equal((await call('engine_status')).ready,true);
  const p=await call('engine_package_put',{id:'power',version:'1',title:'工程表格测试',kind:'protocol',files,requestId:randomUUID()});
  await call('protocol_put',{id:p.id,version:p.version,content:files['protocol.aimd'],requestId:randomUUID()});
  let r=await call('record_create',{protocolId:p.id,protocolVersion:p.version,requestId:randomUUID()});
  const bind={id:r.id,expectedRevision:r.revision,packageId:p.id,version:p.version,requestId:randomUUID()};
  await assert.rejects(call('record_bind_engine',bind),{code:'FORBIDDEN'});
  await call('engine_package_review',{id:p.id,version:p.version,sha256:p.sha256,approved:true,reason:'Synthetic fixture inspected'});
  await assert.rejects(call('record_bind_engine',bind,'agent'),{code:'FORBIDDEN'});
  r=await call('record_bind_engine',bind);
  const edit=(rows)=>({id:r.id,expectedRevision:r.revision,requestId:randomUUID(),run:{...r.run,status:'running',tables:{measurements:rows}}});
  const first=edit([{channel:'测点 A',expected:1000,valid:950}]);
  r=await call('record_update',first);
  assert.equal(r.run.tables.measurements[0].missing_rate,5);
  assert.equal(r.run.values.missing_rate,5);
  assert.equal(r.run.values.expected_total,1000);
  assert.deepEqual(r.calculation.errors,[]);
  assert.equal((await call('record_update',first)).revision,r.revision);
  await assert.rejects(call('record_update',{...first,requestId:randomUUID()}),{code:'CONFLICT'});
  r=await call('record_update',edit([{channel:'测点 A',expected:1000,valid:980},{channel:'测点 B',expected:1000,valid:900}]));
  assert.equal(r.run.tables.measurements[0].missing_rate,2);
  assert.equal(r.run.values.missing_rate,6);
  const charts=(await call('state')).artifacts;assert.equal(charts.length,1);assert.deepEqual(charts[0].spec.data.map(p=>p.value),[2,10]);
  // A forged computed cell is ignored; only the actual executor may supply it.
  const forged=edit([{channel:'测点 A',expected:1000,valid:980,missing_rate:99}]);forged.run.values.missing_rate=99;
  r=await call('record_update',forged);assert.equal(r.run.values.missing_rate,2);
  r=await call('record_update',edit([{channel:'测点 A',expected:1000,valid:1100}]));
  assert.ok(r.calculation.errors.length);assert.equal(r.run.values.missing_rate,undefined);assert.equal((await call('state')).artifacts.length,0);
  await assert.rejects(call('record_submit',{id:r.id,expectedRevision:r.revision,requestId:randomUUID()}),{code:'INCOMPLETE'});
  r=await call('record_update',edit([{channel:'测点 A',expected:1000}]));
  assert.ok(r.calculation.pending.length);assert.equal(r.run.tables.measurements[0].missing_rate,undefined);
  r=await call('record_update',edit([{channel:'测点 A',expected:1000,valid:980}]));
  const competing=await Promise.allSettled([call('record_update',edit([{channel:'测点 A',expected:1000,valid:970}])),call('record_update',edit([{channel:'测点 A',expected:1000,valid:990}]))]);
  assert.equal(competing.filter(x=>x.status==='fulfilled').length,1);
  assert.equal(competing.find(x=>x.status==='rejected').reason.code,'CONFLICT');
  r=await call('record_get',{id:r.id});
  await call('engine_package_review',{id:p.id,version:p.version,sha256:p.sha256,approved:false,reason:'Test revocation'});
  await assert.rejects(call('record_update',edit([{channel:'测点 A',expected:1000,valid:980}])),{code:'FORBIDDEN'});
  await call('engine_package_review',{id:p.id,version:p.version,sha256:p.sha256,approved:true,reason:'Test reapproval'});
  r=await call('record_update',edit([{channel:'测点 A',expected:1000,valid:980}]));
  await assert.rejects(call('record_get',{id:r.id},'human','interactive-B'),{code:'NOT_FOUND'});
  const exported=await call('record_export',{id:r.id});assert.equal(exported.extensions.deepscientist.calculation.runId,r.calculation.runId);
  const bundle=await call('workspace_export');const archive=await openAiraArchive(Buffer.from(bundle.contentBase64,'base64'));
  assert.ok(archive.entries.some(e=>e.name==='calculation-packages/'+p.sha256+'/assigner.py'));
  const imported=await call('workspace_import',{contentBase64:bundle.contentBase64,sha256:bundle.validation?.sha256 || (await call('archive_inspect',{contentBase64:bundle.contentBase64})).sha256,requestId:randomUUID()},'human','interactive-B');
  const importedRecord=await call('record_get',{id:imported.records[0]},'human','interactive-B');assert.equal(importedRecord.calculationBinding,undefined);
  r=await call('record_update',{id:r.id,expectedRevision:r.revision,requestId:randomUUID(),run:{...r.run,steps:{inspect:true},checks:{verified:true}}});
  r=await call('record_submit',{id:r.id,expectedRevision:r.revision,requestId:randomUUID()});assert.equal(r.status,'submitted');
  await assert.rejects(call('record_update',edit([])),{code:'CONFLICT'});
  store.close();store=openStore(directory);assert.equal((await call('record_get',{id:r.id})).run.values.missing_rate,2);
 }finally{store.close();rmSync(directory,{recursive:true,force:true});}
});
