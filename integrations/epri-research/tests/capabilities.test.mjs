import {test} from 'node:test';
import assert from 'node:assert/strict';
import {mkdtempSync,rmSync,writeFileSync,readFileSync,existsSync,unlinkSync} from 'node:fs';
import {execFileSync} from 'node:child_process';
import {join,dirname,resolve} from 'node:path';
import {tmpdir} from 'node:os';
import {randomUUID} from 'node:crypto';
import {openStore} from '../dist/server/service.mjs';
import {startServer} from '../dist/server/main.mjs';

test('Airalogy archive restores editable engineering research, pinned history and draft skills across conversations',async()=>{
 const parent=resolve(tmpdir()),dir=mkdtempSync(join(parent,'epri-restore-'));let store=openStore(dir);
 const call=(session,op,args={})=>store.execute(op,args,'human',undefined,session);
 const put=(session,op,args)=>call(session,op,{requestId:randomUUID(),...args});
 try{
  const file=await put('source','attachment_put',{name:'synthetic.csv',contentBase64:Buffer.from('synthetic engineering fixture\nx,y\n1,2\n').toString('base64')});
  await put('source','evidence_put',{id:'e',expectedRevision:0,title:'合成工程测试',observation:'测试数据',basis:'synthetic',source:{kind:'attachment',reference:file.reference}});
  await put('source','evidence_review',{id:'e',expectedRevision:1,result:'accepted',reason:'仅复核测试输入'});
  await put('source','claim_put',{id:'c',expectedRevision:0,title:'测试结论',statement:'仅用于软件测试',limitations:'不是实际工程结论',status:'supported',evidenceIds:['e']});
  await put('source','report_put',{id:'r',expectedRevision:0,title:'测试报告',markdown:'仅用于归档恢复验收。',evidenceIds:['e'],claimIds:['c']});
  await put('source','lab_skill_put',{id:'s',expectedRevision:0,title:'测试方法',markdown:'读取合成文件并核对内容。',evidenceIds:['e']});
  await put('source','lab_skill_publish',{id:'s',expectedRevision:1,published:true,reason:'仅在临时测试库发布'});
  await put('source','roadmap_put',{id:'route',expectedRevision:0,route:{schema:'deepscientist.science.research_route.v1',roadmapId:'route',rootNodeId:'root',objective:'归档恢复测试',updatedAt:Date.now(),nodes:[{id:'root',title:'核对',summary:'核对合成数据',order:0,lifecycle:'verified',evidenceIds:['e']}]}});
  const archive=await call('source','workspace_export'),preview=await call('destination','archive_inspect',{contentBase64:archive.contentBase64});assert.equal(preview.researchRevisions,7);
  const args={requestId:randomUUID(),contentBase64:archive.contentBase64,sha256:preview.sha256,restoreResearch:true};
  const result=await call('destination','workspace_import',args);assert.equal(result.research.entities,5);assert.equal(result.research.revisions,12);
  assert.deepEqual(await call('destination','workspace_import',args),result);
  const state=await call('destination','science_state');
  assert.equal(state.evidence[0].data.review.status,'pending');assert.equal(state.evidence[0].revision,3);
  assert.equal(state.labskill[0].data.published,false);assert.equal(state.claim[0].data.status,'proposed');assert.equal(state.roadmap[0].data.route.nodes[0].lifecycle,'completed');
  assert.equal(state.report[0].data.evidence[0].id,state.evidence[0].id);assert.equal(state.report[0].data.evidence[0].revision,2);assert.equal(state.report[0].data.evidence[0].data.review.imported,true);
  assert.equal(state.report[0].data.claims[0].data.evidence[0].id,state.evidence[0].id);
  assert.equal(state.roadmap[0].data.route.nodes[0].evidenceIds[0],state.evidence[0].id);
  assert.equal((await call('source','science_state')).labskill[0].data.published,true);
  const e=state.evidence[0];await put('destination','evidence_review',{id:e.id,expectedRevision:e.revision,result:'accepted',reason:'在目标环境核对测试文件'});
  const skill=state.labskill[0];await put('destination','lab_skill_publish',{id:skill.id,expectedRevision:skill.revision,published:true,reason:'目标环境重新批准'});
  store.close();store=openStore(dir);assert.equal((await call('destination','science_state')).labskill[0].data.published,true);
  const second=await call('destination','workspace_export'),p=await call('third','archive_inspect',{contentBase64:second.contentBase64});
  assert.equal((await put('third','workspace_import',{contentBase64:second.contentBase64,sha256:p.sha256})).research.entities,5);
 }finally{store.close();assert.equal(dirname(dir),parent);rmSync(dir,{recursive:true,force:true,maxRetries:3});}
});

test('managed engineering branches, selected checkpoints, opt-in automatic capture, merge and history-preserving revert',async()=>{
 const parent=resolve(tmpdir()),dir=mkdtempSync(join(parent,'epri-git-actions-')),repo=join(dir,'project');
 execFileSync('git',['init','-b','main',repo],{stdio:'ignore',windowsHide:true});
 const git=(path,...args)=>execFileSync('git',['-C',path,'-c','core.autocrlf=false','-c','user.name=Fixture','-c','user.email=fixture@example.invalid',...args],{windowsHide:true,encoding:'utf8',stdio:['ignore','pipe','pipe']});
 git(repo,'config','core.autocrlf','false');writeFileSync(join(repo,'input.txt'),'synthetic input\n');git(repo,'add','.');git(repo,'commit','-m','initial');
 const store=openStore(join(dir,'data')),session='synthetic-engineering';
 const call=(op,args={},actor='human')=>store.execute(op,args,actor,undefined,session);
 try{
  await call('project_git_bind',{path:repo});let state=await call('project_git_working');
  const branch=await call('project_git_branch',{name:'comparison',expectedToken:state.token,requestId:randomUUID()});
  writeFileSync(join(repo,'unrelated.txt'),'other developer draft\n');
  writeFileSync(join(branch.path,'result.txt'),'synthetic comparison 1\n');
  state=await call('project_git_working',{worktreeId:branch.id});
  const args={worktreeId:branch.id,expectedToken:state.token,files:['result.txt'],message:'save comparison',stage:'analysis',requestId:randomUUID()};
  const checkpoint=await call('project_git_checkpoint',args);assert.deepEqual(await call('project_git_checkpoint',args),checkpoint);assert.equal(readFileSync(join(repo,'unrelated.txt'),'utf8'),'other developer draft\n');
  await call('project_git_policy',{worktreeId:branch.id,files:['result.txt'],enabled:true});
  const route={schema:'deepscientist.science.research_route.v1',roadmapId:'route',rootNodeId:'root',objective:'合成工程分支测试',updatedAt:Date.now(),nodes:[{id:'root',title:'比较',summary:'仅测试阶段完成保存',order:0,lifecycle:'running'}]};
  await call('roadmap_put',{id:'route',expectedRevision:0,route,requestId:randomUUID()},'agent');
  writeFileSync(join(branch.path,'result.txt'),'synthetic comparison 2\n');route.nodes[0].lifecycle='completed';
  const completion={id:'route',expectedRevision:1,route,requestId:randomUUID()};
  const completed=await call('roadmap_put',completion,'agent');assert.ok(completed.automaticCheckpoint.sha);assert.deepEqual(await call('roadmap_put',completion,'agent'),completed);
  assert.equal(git(branch.path,'status','--porcelain').trim(),'');
  unlinkSync(join(repo,'unrelated.txt'));state=await call('project_git_working');const source=await call('project_git_working',{worktreeId:branch.id});
  await call('project_git_merge',{worktreeId:branch.id,expectedToken:state.token,sourceSha:source.head,requestId:randomUUID()});
  assert.equal(readFileSync(join(repo,'result.txt'),'utf8'),'synthetic comparison 2\n');
  state=await call('project_git_working');await call('project_git_revert',{sha:source.head,expectedToken:state.token,requestId:randomUUID()});
  assert.equal(readFileSync(join(repo,'result.txt'),'utf8'),'synthetic comparison 1\n');assert.ok(git(repo,'log','--oneline').includes('Revert'));
 }finally{store.close();assert.equal(dirname(dir),parent);rmSync(dir,{recursive:true,force:true,maxRetries:3});}
});

test('archive restoration remaps chart and record references while preserving their original snapshots',async()=>{
 const parent=resolve(tmpdir()),dir=mkdtempSync(join(parent,'epri-linked-archive-')),store=openStore(dir);
 const call=(session,op,args={})=>store.execute(op,args,'human',undefined,session);
 const put=(session,op,args)=>call(session,op,{requestId:randomUUID(),...args});
 try{
  await put('source','protocol_put',{id:'synthetic-engineering',version:'1',content:'# 合成工程记录\n\n输入：{{var|sample}}\n'});
  const record=await put('source','record_create',{protocolId:'synthetic-engineering',protocolVersion:'1'});
  const chart=await put('source','chart_render',{spec:{schema:'deepscientist.report_chart.v1',kind:'bar',title:'Synthetic engineering chart',data:[{id:'a',label:'Synthetic A',value:1},{id:'b',label:'Synthetic B',value:2}]}});
  for(const source of [{kind:'record',id:record.id,revision:1},{kind:'chart',id:chart.id}])await put('source','evidence_put',{id:source.kind,expectedRevision:0,title:'合成输入 '+source.kind,observation:'仅用于格式往返测试',basis:'synthetic',source});
  await put('source','report_put',{id:'report',expectedRevision:0,title:'固定来源',markdown:'仅用于软件测试',evidenceIds:['record','chart'],claimIds:[]});
  const archive=await call('source','workspace_export'),preview=await call('target','archive_inspect',{contentBase64:archive.contentBase64});
  const result=await put('target','workspace_import',{contentBase64:archive.contentBase64,sha256:preview.sha256});
  const state=await call('target','science_state'),workspace=await call('target','state');
  for(const e of state.evidence){const original=e.data.source.importedFrom;assert.equal(e.data.review.status,'pending');if(e.data.source.kind==='record'){assert.equal(e.data.source.id,result.records[0]);assert.equal(e.data.source.snapshot.id,record.id);assert.equal(original.id,record.id);}else{assert.equal(e.data.source.id,workspace.artifacts.find(a=>a.kind==='chart').id);assert.equal(original.id,chart.id);assert.equal(e.data.source.svg,chart.svg);}}
  assert.equal(state.report[0].data.evidence.length,2);
 }finally{store.close();assert.equal(dirname(dir),parent);rmSync(dir,{recursive:true,force:true,maxRetries:3});}
});

test('named project accounts complete editor, reviewer and viewer workflows through the HTTP service',async()=>{
 const parent=resolve(tmpdir()),dir=mkdtempSync(join(parent,'epri-access-')),app=await startServer({directory:dir,port:0});
 const request=async(path,op,args={},cookie,sessionId)=>{
  const response=await fetch(app.url+path,{method:'POST',headers:{'Content-Type':'application/json',...(cookie?{Cookie:cookie}:{Authorization:'Bearer '+app.credentials.humanToken})},body:JSON.stringify({op,args,sessionId})});
  const value=await response.json();assert.ok(response.ok,op+': '+value.error);return {value:value.result,cookie:response.headers.getSetCookie()[0]?.split(';')[0]};
 };
 try{
  for(const username of ['fixture_editor','fixture_reviewer','fixture_viewer'])await request('/auth','create_user',{username,password:'isolated-test-password-123'});
  const project=(await request('/auth','create_project',{name:'合成工程协作测试'})).value;
  for(const role of ['editor','reviewer','viewer'])await request('/auth','set_member',{projectId:project.id,username:'fixture_'+role,role});
  const session=(await request('/auth','new_session',{projectId:project.id,title:'合成研究资料'})).value.session;
  const cookies={};for(const role of ['editor','reviewer','viewer'])cookies[role]=(await request('/auth','login',{username:'fixture_'+role,password:'isolated-test-password-123'})).cookie;
  const write=(op,args,role='editor')=>request('/api',op,{requestId:randomUUID(),...args},cookies[role],session);
  const task=(await write('task_create',{objective:'合成数据完整性检查',basis:'synthetic',methodId:'power-data-quality-interactive',methodVersion:'1.0.0'})).value;
  for(const op of ['method_catalog','tasks'])assert.ok((await request('/api',op,{},cookies.viewer,session)).value);
  assert.equal((await request('/api','task_get',{id:task.id},cookies.viewer,session)).value.id,task.id);
  assert.equal((await request('/api','method_get',{id:task.methodId,version:task.methodVersion},cookies.viewer,session)).value.id,task.methodId);
  const denied=await fetch(app.url+'/api',{method:'POST',headers:{'Content-Type':'application/json',Cookie:cookies.editor},body:JSON.stringify({op:'task_open',args:{id:task.id,reason:'编辑者不得批准代码',requestId:randomUUID()},sessionId:session})});assert.equal(denied.status,403);
  const attachment=(await write('attachment_put',{name:'engineering.csv',contentBase64:Buffer.from('synthetic\nx,y\n1,2').toString('base64')})).value;
  await write('evidence_put',{id:'shared-evidence',expectedRevision:0,title:'协作测试',observation:'仅用于软件验收',basis:'synthetic',source:{kind:'attachment',reference:attachment.reference}});
  await write('evidence_review',{id:'shared-evidence',expectedRevision:1,result:'accepted',reason:'核对合成输入'},'reviewer');
  const viewed=(await request('/api','science_state',{},cookies.viewer,session)).value;assert.equal(viewed.evidence[0].data.review.status,'accepted');
  const projects=(await request('/auth','state',{},cookies.viewer)).value.projects;assert.equal(projects[0].role,'viewer');assert.equal(projects[0].conversations[0].session,session);
  assert.ok((await request('/auth','state')).value.audit.some(a=>a.operation==='evidence_review'));
  await request('/auth','logout',{},cookies.viewer);
 }finally{await app.close();assert.equal(dirname(dir),parent);rmSync(dir,{recursive:true,force:true,maxRetries:3});}
});
