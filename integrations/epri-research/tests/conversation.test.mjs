import { test } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { randomUUID } from 'node:crypto';
import { createHash } from 'node:crypto';
import { DatabaseSync } from 'node:sqlite';
import { openStore } from '../dist/server/service.mjs';
import { startServer } from '../dist/server/main.mjs';
import { openAiraArchive } from '../src/reused/aira/index.ts';
import { Context, Service } from '../harness-runtime/node_modules/@deepseek-ai/cordis/lib/index.js';
import { SystemPrompt } from '../harness-runtime/node_modules/@deepseek-ai/dsh-system-prompt/lib/index.js';
import { ToolRuntime } from '../harness-runtime/node_modules/@deepseek-ai/dsh-tools/lib/index.js';
import { LocalFileSystem } from '../harness-runtime/node_modules/@deepseek-ai/dsh-fs-local/lib/index.js';
import { Session } from '../harness-runtime/node_modules/@deepseek-ai/dsh-session/lib/index.js';
import { SessionProjectionRegistry } from '../harness-runtime/node_modules/@deepseek-ai/dsh-session-projection/lib/index.js';
import { agentPresetProjectionDefinition } from '../harness-runtime/node_modules/@deepseek-ai/dsh-agent-preset-registry/lib/index.js';
import * as plugin from '../plugins/airalogy/index.mjs';
import * as workbench from '../plugins/workbench/index.mjs';

test('legacy attachments migrate once and retain bytes, names and explicit association', async () => {
  const directory=mkdtempSync(join(tmpdir(),'conversation-migration-'));
  const bytes=Buffer.from('legacy measurement'), reference='attachment:'+createHash('sha256').update(bytes).digest('hex');
  const db=new DatabaseSync(join(directory,'research.sqlite'));
  db.exec('CREATE TABLE state(id INTEGER PRIMARY KEY,body TEXT NOT NULL); CREATE TABLE attachments(reference TEXT PRIMARY KEY,name TEXT NOT NULL,body BLOB NOT NULL,createdAt TEXT NOT NULL)');
  db.prepare('INSERT INTO state VALUES(1,?)').run(JSON.stringify({protocols:[],records:[],artifacts:[]}));
  db.prepare('INSERT INTO attachments VALUES(?,?,?,?)').run(reference,'legacy.csv',bytes,new Date().toISOString()); db.close();
  let store=openStore(directory);
  try {
    const first=await store.execute('history_list',{},'human'); assert.equal(first.artifacts.length,1);
    assert.equal((await store.execute('state',{},'human',undefined,'A')).artifacts.length,0);
    await store.execute('history_associate',{kind:'artifact',id:first.artifacts[0].id,requestId:'associate'},'human',undefined,'A');
    assert.equal((await store.execute('state',{},'human',undefined,'A')).artifacts.length,1);
    store.close();store=openStore(directory);
    assert.equal((await store.execute('history_list',{},'human')).artifacts.length,0);
    assert.equal((await store.execute('state',{},'human',undefined,'A')).artifacts.length,1);
    const read=await store.execute('attachment_get',{reference},'human',undefined,'A');
    assert.equal(read.name,'legacy.csv');assert.deepEqual(Buffer.from(read.contentBase64,'base64'),bytes);
    await store.execute('attachment_put',{name:'other-name.csv',contentBase64:bytes.toString('base64'),requestId:'rename'},'human',undefined,'B');
    assert.equal((await store.execute('attachment_get',{reference},'human',undefined,'B')).name,'other-name.csv');
    assert.equal((await store.execute('attachment_get',{reference},'human',undefined,'A')).name,'legacy.csv');
  } finally {store.close();rmSync(directory,{recursive:true,force:true});}
});

test('two conversations isolate records, protocols, attachments and idempotency; history and Airalogy preserve bytes', async () => {
  const directory=mkdtempSync(join(tmpdir(),'conversation-test-'));
  let app=await startServer({directory,port:0});
  const call=async (sessionId,op,args={},actor='human') => {
    const response=await fetch(app.url+'/api',{method:'POST',headers:{'Content-Type':'application/json',Authorization:'Bearer '+app.credentials[actor+'Token']},body:JSON.stringify({sessionId,op,args})});
    const body=await response.json(); if(!response.ok) throw Object.assign(new Error(body.error),{code:body.code}); return body.result;
  };
  const write=(sid,op,args={},actor) => call(sid,op,{requestId:randomUUID(),...args},actor);
  try {
    const content='# Shared protocol\n\n{{var|result: str, owner="agent"}}\n\n{{var|file: file}}\n\n{{check|reviewed, title="Human review"}}';
    await write(null,'protocol_put',{id:'shared',version:'1',content});
    await write(null,'protocol_put',{id:'unrelated-template',version:'1',content});
    const legacy=await write(null,'record_create',{protocolId:'shared',protocolVersion:'1'});
    const create={protocolId:'shared',protocolVersion:'1',requestId:'identical-key'};
    let a=await call('A','record_create',create), b=await call('B','record_create',create);
    assert.notEqual(a.id,b.id); assert.equal((await call('A','record_create',create)).id,a.id);
    assert.deepEqual((await call('A','state')).records.map(r=>r.id),[a.id]);
    for(const [op,args] of [['record_get',{id:a.id}],['record_export',{id:a.id}],['record_update',{id:a.id,expectedRevision:1,requestId:randomUUID(),run:a.run}],['record_archive',{id:a.id,expectedRevision:1,requestId:randomUUID(),reason:'test'}]]) await assert.rejects(call('B',op,args),e=>e.code==='NOT_FOUND');
    await assert.rejects(call(null,'record_get',{id:a.id}),e=>e.code==='NOT_FOUND');
    await write('A','protocol_put',{id:'private',version:'1',content});
    await assert.rejects(call('B','protocol_get',{id:'private',version:'1'}),e=>e.code==='NOT_FOUND');
    await assert.rejects(write('A','protocol_put',{id:'shared',version:'1',content}),e=>e.code==='CONFLICT');
    const bytes=Buffer.from('真实实验数据\n1,12.3\n');
    const attachment=await write('A','attachment_put',{name:'数据.csv',contentBase64:bytes.toString('base64')});
    await assert.rejects(call('B','attachment_get',{reference:attachment.reference}),e=>e.code==='NOT_FOUND');
    await assert.rejects(write('B','record_update',{id:b.id,expectedRevision:1,run:{...b.run,status:'running',values:{file:attachment.reference}}}),e=>e.code==='INVALID');
    a=await write('A','record_update',{id:a.id,expectedRevision:1,run:{...a.run,status:'running',values:{file:attachment.reference}}});
    await write('A','chart_render',{spec:{schema:'deepscientist.report_chart.v1',kind:'bar',title:'Verification chart',data:[{id:'a',label:'A',value:12},{id:'b',label:'B',value:18}]}});
    assert.equal((await call('B','state')).artifacts.length,0);
    await assert.rejects(write('A','history_associate',{kind:'record',id:legacy.id},'agent'),e=>e.code==='FORBIDDEN');
    await write('A','history_associate',{kind:'record',id:legacy.id});
    assert.equal((await call('A','history_list')).records.length,0);
    await assert.rejects(write('B','history_associate',{kind:'record',id:legacy.id}),e=>e.code==='CONFLICT');
    const exported=await call('A','workspace_export');
    const archive=await openAiraArchive(Buffer.from(exported.contentBase64,'base64'));
    assert.deepEqual(await archive.validate(),{ok:true,issues:[]});
    assert.equal(archive.summary().recordCount,3);
    const blob=archive.manifest.blobs.find(b=>b.blob_id==='sha256:'+attachment.reference.slice(11));
    assert.deepEqual(Buffer.from(await archive.readBytes(blob.archive_path)),bytes);
    assert.ok(archive.manifest.protocols.some(p=>p.protocol_id==='shared'));
    assert.ok(!archive.manifest.protocols.some(p=>p.protocol_id==='unrelated-template'));
    assert.equal((await call('B','workspace_export')).summary.blobCount,0);
    await app.close(); app=await startServer({directory,port:0});
    assert.deepEqual(Buffer.from((await call('A','attachment_get',{reference:attachment.reference})).contentBase64,'base64'),bytes);
    assert.equal((await call('A','state')).records.length,2);
  } finally {await app.close();rmSync(directory,{recursive:true,force:true});}
});

test('official Harness ToolRuntime imports delivered files only in research mode and propagates session identity', async () => {
  const directory=mkdtempSync(join(tmpdir(),'conversation-tool-')), previous=process.env.DS_RESEARCH_DATA_DIR;
  process.env.DS_RESEARCH_DATA_DIR=directory;
  const app=await startServer({directory,port:0}), ctx=new Context();
  class WorkingDirectory extends Service {constructor(c){super(c,'workingDirectory');} async ensure(){return directory;}}
  try {
    await ctx.plugin(SystemPrompt,{}); await ctx.plugin(ToolRuntime); await ctx.plugin(LocalFileSystem,{cwd:directory}); await ctx.plugin(WorkingDirectory); await ctx.plugin(plugin);
    await ctx.plugin(SessionProjectionRegistry);
    ctx.sessionProjections.register(agentPresetProjectionDefinition);
    await ctx.plugin(workbench);
    const agent={session:Session.create('native-A'),ctx};
    agent.session.append('agent-preset/selected',{agentPreset:'research-suite'});
    const execute=(name,args,owner=agent)=>ctx.tools.execute({callId:randomUUID(),name,arguments:args,agent:owner,signal:new AbortController().signal});
    assert.equal((await execute('research_state',{})).isError,false);
    assert.equal((await execute('research_state',{},null)).isError,true);
    assert.equal((await execute('research_state',{sessionId:'forged'})).isError,true);
    ctx.tools.register({name:'present',description:'Delivery integration test',parameters:{type:'object',properties:{},additionalProperties:false},output:{schema:{type:'object',additionalProperties:true},render:()=>[{type:'text',text:'Presented file'}]},execute:async()=>({files:[{path:join(directory,'report.csv')}]})});
    writeFileSync(join(directory,'report.csv'),'measurement,42\n');
    const result=await execute('present',{});
    assert.equal(result.isError,false,JSON.stringify(result));
    assert.match(result.content.map(x=>x.text).join(' '),/已保存文件快照/);
    const state=(await execute('research_state',{})).value;
    assert.equal(state.artifacts[0].name,'report.csv'); assert.equal(state.artifacts[0].sessionId,'native-A');
    assert.equal((await execute('research_state',{}, {session:Session.create('native-B'),ctx})).value.artifacts.length,0);
    writeFileSync(join(directory,'report.csv'),Buffer.alloc(2*1024*1024+1));
    const oversized=await execute('present',{}); assert.match(oversized.content.map(x=>x.text).join(' '),/未能收录/);
    for (const preset of ['standard','ptc','minimal','cordis','custom-mode',undefined]) {
      const other={session:Session.create('other-'+preset),ctx};
      if (preset) other.session.append('agent-preset/selected',{agentPreset:preset});
      const delivery=await execute('present',{},other);
      assert.equal(delivery.isError,false);
      assert.deepEqual(delivery.content,[{type:'text',text:'Presented file'}], 'Native delivery must stay unchanged for '+preset);
      assert.equal((await execute('research_state',{},other)).value.artifacts.length,0);
    }
  } finally {await ctx.fiber.dispose();await app.close();if(previous===undefined)delete process.env.DS_RESEARCH_DATA_DIR;else process.env.DS_RESEARCH_DATA_DIR=previous;rmSync(directory,{recursive:true,force:true});}
});
