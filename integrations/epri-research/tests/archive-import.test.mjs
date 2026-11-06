import {test} from 'node:test';
import assert from 'node:assert/strict';
import {mkdtempSync,rmSync} from 'node:fs';
import {tmpdir} from 'node:os';
import {join} from 'node:path';
import {randomUUID} from 'node:crypto';
import {openStore} from '../dist/server/service.mjs';
test('Airalogy import preserves bytes, original record and research ledger, is atomic and idempotent, and resets human review',async()=>{
 const dir=mkdtempSync(join(tmpdir(),'archive-import-')),store=openStore(dir);
 const call=(op,a={},session='source',actor='human')=>store.execute(op,a,actor,undefined,session);
 const put=(op,a,session='source',actor='human')=>call(op,{requestId:randomUUID(),...a},session,actor);
 try{
  const content='# Import test\n\n> 嵌套字段 {{var|sample: str}}\n\n- {{step|measured, check=True}}\n\n{{var|file: File}}\n\n{{check|checked}}\n';
  await put('protocol_put',{id:'import-test',version:'1',content});
  const a=await put('attachment_put',{name:'实验.csv',contentBase64:Buffer.from('x,y\n1,2').toString('base64')});
  let r=await put('record_create',{protocolId:'import-test',protocolVersion:'1'});
  r=await put('record_update',{id:r.id,expectedRevision:1,run:{...r.run,status:'running',values:{sample:'sample-A',file:a.reference},steps:{measured:true},checks:{checked:true}}});
  await put('evidence_put',{id:'e',expectedRevision:0,title:'Evidence',observation:'Sample recorded',basis:'measured',source:{kind:'attachment',reference:a.reference}});
  const archive=await call('workspace_export');const preview=await call('archive_inspect',{contentBase64:archive.contentBase64},'target');
  assert.equal(preview.records,1);
  const args={contentBase64:archive.contentBase64,sha256:preview.sha256,requestId:randomUUID()};
  await assert.rejects(call('workspace_import',args,'target','agent'),{code:'FORBIDDEN'});
  const imported=await call('workspace_import',args,'target');assert.deepEqual(await call('workspace_import',args,'target'),imported);
  const result=await call('record_get',{id:imported.records[0]},'target');assert.equal(result.run.checks.checked,false);assert.equal(result.imported.original.data.check.checked.checked,true);assert.equal(result.run.values.sample,'sample-A');
  const bytes=await call('attachment_get',{reference:result.run.values.file},'target');assert.equal(bytes.contentBase64,Buffer.from('x,y\n1,2').toString('base64'));
  assert.ok((await call('state',{},'target')).artifacts.some(x=>x.name==='research-ledger.json'));
  await put('protocol_put',{id:'import-test',version:'1',content:content+'\nConflict'},'conflict');const before=await call('state',{},'conflict');
  await assert.rejects(call('workspace_import',args,'conflict'),{code:'CONFLICT'});assert.deepEqual(await call('state',{},'conflict'),before);
  const corrupted=Buffer.from(archive.contentBase64,'base64');const index=corrupted.indexOf('sample-A');assert.ok(index>0);corrupted[index]=88;
  await assert.rejects(call('archive_inspect',{contentBase64:corrupted.toString('base64')},'target'),/sha256 mismatch/);
 }finally{store.close();rmSync(dir,{recursive:true,force:true});}
});
