import {test} from 'node:test';
import assert from 'node:assert/strict';
import {readFileSync,mkdtempSync,rmSync} from 'node:fs';
import {tmpdir} from 'node:os';
import {join} from 'node:path';
import {randomUUID} from 'node:crypto';
import {apply} from '../plugins/deepscientist/index.mjs';
import {excludedSkills} from '../plugins/deepscientist/customer-scope.mjs';
import {openStore} from '../dist/server/service.mjs';

test('customer catalog excludes specialist life-science skills and retains engineering tools; power protocol creates a valid record',async()=>{
  let provider;
  apply({get:()=>undefined,skills:{registerProvider(factory){provider=factory();}}});
  const skills=await provider.list({signal:AbortSignal.abort()});
  const names=new Set(skills.map(s=>s.name));
  for(const name of excludedSkills)assert.ok(!names.has('v2-'+name),name);
  for(const name of ['research-science','research-protocol','research-literature','v2-kdense-matlab','v2-kdense-fluidsim','v2-kdense-pymoo','v2-kdense-statsmodels'])assert.ok(names.has(name),name);
  const dir=mkdtempSync(join(tmpdir(),'engineering-protocol-')),store=openStore(dir);
  try{
    const content=readFileSync(new URL('../dist/server/example.aimd',import.meta.url),'utf8');
    assert.match(content,/电力设备运行数据质量检查/);
    await store.execute('protocol_put',{id:'power-data-quality',version:'1',content,requestId:randomUUID()},'human',undefined,'power-test');
    const record=await store.execute('record_create',{protocolId:'power-data-quality',protocolVersion:'1',requestId:randomUUID()},'human',undefined,'power-test');
    assert.equal(record.status,'draft');
    assert.equal(record.protocolId,'power-data-quality');
  }finally{store.close();rmSync(dir,{recursive:true,force:true});}
});
