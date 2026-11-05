import {test} from 'node:test';
import assert from 'node:assert/strict';
import {mkdtempSync,rmSync} from 'node:fs';
import {tmpdir} from 'node:os';
import {join} from 'node:path';
import {randomUUID} from 'node:crypto';
import {openCloudStore} from '../dist/server/cloud-store.mjs';
import {reviewInConversation} from '../plugins/airalogy/conversation-review.mjs';

test('cloud review uses the trusted native question continuation and refuses changed or cancelled decisions',async t=>{
  const directory=mkdtempSync(join(tmpdir(),'epri-review-')),lifetime=new AbortController();
  const store=openCloudStore({directory,lifetime:lifetime.signal,assertCurrent(){},python:'/usr/bin/python3',
    authorizeSession:async()=>({check(){},workspaceRoot:'/account/project'})});
  t.after(async()=>{await store.close();rmSync(directory,{recursive:true,force:true});});
  const put=(op,args,actor='human')=>store.execute(op,{requestId:randomUUID(),...args},actor,'review');
  const file=await put('attachment_put',{name:'evidence.txt',contentBase64:Buffer.from('reviewed source').toString('base64')});
  const evidence={id:'e',title:'Synthetic evidence',observation:'Test only',basis:'synthetic',source:{kind:'attachment',reference:file.reference}};
  await put('evidence_put',{...evidence,expectedRevision:0});
  let answer=async request=>({answers:[{id:request.questions[0].id,selected:[request.questions[0].options[0].label]}]});
  const ctx={get:()=>({ask:request=>answer(request)})},signal=new AbortController();
  const execution={agent:{ctx:{get:key=>key==='peAccount'?{}:ctx.get(key)}},callId:'review',signal:signal.signal};
  const transport={read:(op,args)=>store.execute(op,args,'agent','review',signal.signal),human:(op,args)=>store.execute(op,args,'human','review',signal.signal)};
  const args={id:'e',expectedRevision:1,result:'accepted',reason:'Checked exact source',requestId:randomUUID()};
  assert.equal((await reviewInConversation(ctx,'evidence_review',args,execution,'review',transport)).executed,false);
  answer=async request=>({answers:[{id:request.questions[0].id,selected:[request.questions[0].options[1].label]}]});
  assert.equal((await reviewInConversation(ctx,'evidence_review',args,execution,'review',transport)).data.review.status,'accepted');
  await put('evidence_put',{...evidence,expectedRevision:2});
  answer=async request=>{
    await put('evidence_put',{...evidence,title:'Changed while waiting',expectedRevision:3});
    return {answers:[{id:request.questions[0].id,selected:[request.questions[0].options[1].label]}]};
  };
  await assert.rejects(reviewInConversation(ctx,'evidence_review',{...args,expectedRevision:3,requestId:randomUUID()},execution,'review',transport),/内容已变化/);
  answer=async request=>{signal.abort();return {answers:[{id:request.questions[0].id,selected:[request.questions[0].options[1].label]}]};};
  await assert.rejects(reviewInConversation(ctx,'evidence_review',{...args,expectedRevision:4,requestId:randomUUID()},execution,'review',transport));
  assert.equal((await store.execute('science_state',{},'agent','review')).evidence[0].data.review.status,'pending');
});
