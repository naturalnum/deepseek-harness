import {test} from 'node:test';
import assert from 'node:assert/strict';
import {mkdtempSync, rmSync} from 'node:fs';
import {tmpdir} from 'node:os';
import {join} from 'node:path';
import {randomUUID} from 'node:crypto';
import {startServer} from '../dist/server/main.mjs';

test('separate account stores isolate identical conversation IDs, published skills and credentials across restart', async () => {
  const parent=mkdtempSync(join(tmpdir(),'research-account-boundary-'));
  const a=await startServer({directory:join(parent,'A'),port:0});
  let b;
  const call=async(app,op,args={},token=app.credentials.humanToken)=>{
    const response=await fetch(app.url+'/api',{method:'POST',headers:{'Content-Type':'application/json',Authorization:'Bearer '+token},body:JSON.stringify({op,args,sessionId:'same-synthetic-conversation'})});
    const body=await response.json();
    return {status:response.status,...body};
  };
  const put=(app,op,args)=>call(app,op,{requestId:randomUUID(),...args});
  try {
    b=await startServer({directory:join(parent,'B'),port:0});
    const file=(await put(a,'attachment_put',{name:'private.csv',contentBase64:Buffer.from('synthetic account A').toString('base64')})).result;
    assert.ok(file);
    assert.equal((await call(b,'attachment_get',{reference:file.reference})).status,404);
    assert.equal((await call(b,'state',{},a.credentials.agentToken)).status,401);
    assert.equal((await call(b,'state',{},a.credentials.humanToken)).status,401);
    assert.equal((await put(a,'evidence_put',{id:'e',expectedRevision:0,title:'Synthetic A',observation:'Private A',basis:'synthetic',source:{kind:'attachment',reference:file.reference}})).status,200);
    assert.equal((await put(a,'evidence_review',{id:'e',expectedRevision:1,result:'accepted',reason:'Synthetic fixture'})).status,200);
    assert.equal((await put(a,'lab_skill_put',{id:'skill',expectedRevision:0,title:'Private A skill',markdown:'Synthetic reviewed procedure',evidenceIds:['e']})).status,200);
    assert.equal((await put(a,'lab_skill_publish',{id:'skill',expectedRevision:1,published:true,reason:'Synthetic fixture only'})).status,200);
    assert.equal((await call(a,'lab_skills')).result.length,1);
    assert.deepEqual((await call(b,'lab_skills')).result,[]);
    await b.close();b=await startServer({directory:join(parent,'B'),port:0});
    assert.deepEqual((await call(b,'lab_skills')).result,[]);
    assert.deepEqual((await call(b,'state')).result.artifacts,[]);
    assert.equal((await call(a,'lab_skills')).result.length,1);
  } finally {await b?.close();await a.close();rmSync(parent,{recursive:true,force:true});}
});
