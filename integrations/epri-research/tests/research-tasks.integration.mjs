import {test} from 'node:test';
import assert from 'node:assert/strict';
import {mkdtempSync,rmSync,mkdirSync,writeFileSync} from 'node:fs';
import {tmpdir} from 'node:os';
import {join,resolve} from 'node:path';
import {randomUUID} from 'node:crypto';
import {openStore} from '../dist/server/service.mjs';

test('real Airalogy methods complete CSV → calculation/chart → human submission → evidence → report and preserve failed/stale results',async()=>{
  const directory=mkdtempSync(join(tmpdir(),'power-flow-real-')),output=resolve('verification/power-research-20261031');mkdirSync(output,{recursive:true});
  let store=openStore(directory);const checks=[];
  const call=(op,args={},actor='human',session='synthetic-power-flow')=>store.execute(op,args,actor,undefined,session);
  const put=(op,args,actor='human',session)=>call(op,{...args,requestId:randomUUID()},actor,session);
  try{
    assert.equal((await call('engine_status')).ready,true,'A real Airalogy runtime is required');
    for(const [methodId,table,csv,expectedField,expected] of [
      ['power-data-quality-interactive','measurements','channel,expected,valid\r\n"测点, A",1000,950\r\nB,1000,900\r\n','missing_rate',7.5],
      ['power-linear-calibration','points','point,reference,measured\nA,0,1\nB,1,3\nC,2,5\n','slope',2],
      ['power-forecast-assessment','samples','time,actual,predicted\n2026-01-01T00:00,100,102\n2026-01-01T01:00,110,108\n','mae',2]
    ]){
      let task=await put('task_create',{objective:'合成工程验收 · '+methodId,basis:'synthetic',methodId,methodVersion:'1.0.0',requirements:'仅用于软件验证，不作为工程结论'},'agent');
      const openArgs={id:task.id,reason:'本机合成方法源码已核对',requestId:randomUUID()};
      task=await call('task_open',openArgs);const recordId=task.record.id;
      assert.equal((await call('task_open',openArgs)).record.id,recordId);
      const file=await put('attachment_put',{name:'synthetic.csv',contentBase64:Buffer.from(csv).toString('base64')});
      const importArgs={id:task.id,reference:file.reference,table,expectedRecordRevision:task.record.revision,requestId:randomUUID()};
      task=await call('task_import_csv',importArgs);assert.deepEqual(task.record.calculation.errors,[]);assert.deepEqual(task.record.calculation.pending,[]);
      assert.equal(task.record.run.values[expectedField],expected);
      assert.equal((await call('task_import_csv',importArgs)).record.revision,task.record.revision);
      assert.ok((await call('state')).artifacts.some(a=>a.kind==='chart'&&a.sourceRecordId===recordId));
      await assert.rejects(put('task_import_csv',{...importArgs,expectedRecordRevision:1}),{code:'CONFLICT'});
      const before=task.record.revision;
      const invalid=await put('attachment_put',{name:'invalid.csv',contentBase64:Buffer.from(csv.replace(/channel,expected,valid|point,reference,measured|time,actual,predicted/,'unknown')).toString('base64')});
      await assert.rejects(put('task_import_csv',{id:task.id,reference:invalid.reference,table,expectedRecordRevision:before}),{code:'INVALID'});
      assert.equal((await call('record_get',{id:recordId})).revision,before);
      await assert.rejects(put('task_report',{id:task.id}),{code:'INCOMPLETE'});
      let r=task.record;
      r=await put('record_update',{id:r.id,expectedRevision:r.revision,run:{...r.run,status:'running',steps:methodId.includes('quality')?{inspect:true}:r.run.steps,checks:{verified:true}}});
      r=await put('record_submit',{id:r.id,expectedRevision:r.revision});
      task=await put('task_evidence',{id:task.id},'agent');assert.equal(task.evidence.data.review.status,'pending');
      await assert.rejects(put('task_report',{id:task.id}),{code:'INCOMPLETE'});
      await put('evidence_review',{id:task.evidence.id,expectedRevision:task.evidence.revision,result:'accepted',reason:'合成软件验证，核对来源与计算，不是设备验收'});
      task=await put('task_report',{id:task.id},'agent');assert.equal(task.stage,'complete');assert.ok(task.report.data.markdown.includes(r.calculation.packageSha256));assert.ok(task.report.data.markdown.includes(file.reference));
      if(methodId.includes('forecast')){assert.equal(task.quality,'failed');assert.match(task.report.data.markdown,/未满足本次设定的自动判据/);}
      const firstReport=task.report;
      assert.equal((await put('task_report',{id:task.id})).report.revision,firstReport.revision);
      await put('record_reopen',{id:r.id,expectedRevision:r.revision,reason:'检查修订后的旧证据阻断'});
      const stale=await call('task_get',{id:task.id});assert.equal(stale.reportCurrent,false);assert.equal(stale.evidence,null);assert.equal(stale.report.sha256,firstReport.sha256);
      await assert.rejects(put('task_report',{id:task.id}),{code:'INCOMPLETE'});
      checks.push(methodId+': actual calculations, chart, CSV validation/CAS/retry, reviewed evidence, truthful report, amendment invalidation');
    }
    const archive=await call('workspace_export'),inspection=await call('archive_inspect',{contentBase64:archive.contentBase64});
    await put('workspace_import',{contentBase64:archive.contentBase64,sha256:inspection.sha256},'human','synthetic-import');
    const restored=await call('tasks',{},'human','synthetic-import');assert.equal(restored.length,3);assert.ok(restored.every(t=>t.stage==='open'&&!t.reportCurrent&&!t.record.calculationBinding));
    store.close();store=openStore(directory);assert.equal((await call('tasks')).length,3);
    writeFileSync(join(output,'real-engine-result.json'),JSON.stringify({status:'pass',fixture:'isolated synthetic engineering data; real pinned Airalogy runtime',checks,archiveTasksRestoredAsDrafts:true},null,2));
  }finally{store.close();rmSync(directory,{recursive:true,force:true,maxRetries:5});}
});
