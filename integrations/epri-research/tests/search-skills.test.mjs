import {test} from 'node:test';
import assert from 'node:assert/strict';
import {mkdtempSync,rmSync} from 'node:fs';
import {join} from 'node:path';
import {tmpdir} from 'node:os';
import {randomUUID} from 'node:crypto';
import {openStore} from '../dist/server/service.mjs';

test('local search isolates source text and hashes; only reviewed published skills cross conversations and edits withdraw publication',async()=>{
  const dir=mkdtempSync(join(tmpdir(),'search-skills-'));let store=openStore(dir);
  const call=(op,args={},actor='human',session='power-A')=>store.execute(op,args,actor,undefined,session);
  const put=(op,args,actor='human',session='power-A')=>call(op,{...args,requestId:randomUUID()},actor,session);
  try{
    const file=await put('attachment_put',{name:'power.csv',contentBase64:Buffer.from('equipment,voltage\n变压器A,220\n').toString('base64')});
    const result=await call('local_search',{query:'变压器A',max_results:5});
    assert.equal(result.results[0].sha256,file.reference.slice(11));
    assert.match(result.results[0].excerpt,/变压器A,220/);
    assert.equal((await call('local_search',{query:'变压器A',max_results:5},'human','power-B')).totalMatches,0);
    await put('evidence_put',{id:'power',expectedRevision:0,title:'质量核对',observation:'已读取示例数据，非现场实测',basis:'synthetic',source:{kind:'attachment',reference:file.reference}});
    await put('lab_skill_put',{id:'quality',expectedRevision:0,title:'设备数据核查',markdown:'核对数据来源及单位。',evidenceIds:['power']},'agent');
    assert.deepEqual(await call('lab_skills',{},'agent','power-B'),[]);
    const publish={id:'quality',expectedRevision:1,published:true,reason:'检查方法及示例来源'};
    await assert.rejects(put('lab_skill_publish',publish,'agent'),{code:'FORBIDDEN'});
    await assert.rejects(put('lab_skill_publish',publish),{code:'INCOMPLETE'});
    await put('evidence_review',{id:'power',expectedRevision:1,result:'accepted',reason:'已核对测试数据'});
    await put('lab_skill_publish',publish);
    store.close();store=openStore(dir);
    const shared=await call('lab_skills',{},'agent','power-B');
    assert.equal(shared.length,1);assert.equal(shared[0].evidence[0].revision,2);
    await put('lab_skill_put',{id:'quality',expectedRevision:2,title:'设备数据核查',markdown:'修订后需重新复核。',evidenceIds:['power']});
    assert.deepEqual(await call('lab_skills',{},'agent','power-B'),[]);
    assert.equal((await call('science_revision',{kind:'labskill',id:'quality',revision:2})).data.published,true);
  }finally{store.close();rmSync(dir,{recursive:true,force:true});}
});
