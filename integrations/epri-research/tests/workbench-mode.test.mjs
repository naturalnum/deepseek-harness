import { test } from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { createRequire } from 'node:module';
import { runInNewContext } from 'node:vm';
import { transform } from 'esbuild';
import React from 'react';
import { renderToStaticMarkup } from 'react-dom/server';
import { applyWorkbenchTheme } from '../src/ui/workbench-theme.mjs';

test('workbench renders only for the current research conversation, including before preset loading', async () => {
  const { code } = await transform(readFileSync(new URL('../plugins/workbench/client.jsx',import.meta.url),'utf8'), {loader:'jsx',format:'cjs'});
  const module = {exports:{}};
  runInNewContext(code,{module,exports:module.exports,require:createRequire(new URL('../plugins/workbench/client.jsx',import.meta.url)),URL,URLSearchParams,queueMicrotask,window:{location:{href:'http://127.0.0.1:43128/'}}});
  const components = {};
  let draft='',phase='plain',attachmentIds=[];
  const input={state:{getSnapshot:()=>({draft,phase,attachmentIds})},setDraft:value=>{draft=value;},focus:()=>{}};
  const scoped={get:()=>({input:{for:()=>input}})},draftCtx={sidebarRight:{mounted:{getSnapshot:()=> 'research'}},sessions:{scope:()=>scoped}};
  module.exports.draftTaskRequest(draftCtx,'research','task-fixture','open');assert.match(draft,/research_task_open/);
  assert.throws(()=>module.exports.draftTaskRequest(draftCtx,'research','task-fixture','review'),/已有草稿/);
  draft='';attachmentIds=['existing-file'];assert.throws(()=>module.exports.draftTaskRequest(draftCtx,'research','task-fixture','review'),/已有草稿/);
  attachmentIds=[];assert.throws(()=>module.exports.draftTaskRequest(draftCtx,'other','task-fixture','review'),/切换/);
  assert.throws(()=>module.exports.draftTaskRequest(draftCtx,'research','task-fixture','arbitrary-send'),/不支持/);
  module.exports.apply({effect:()=>{},slots:{inject:(_name,register)=>register(),register:(options,component)=>{components[options.name]=component;}}});
  const Dock = components['conversation.input.dock'];
  const Guide = components['sidebar.right.tab.guide.entry'];
  const byId = {research:{projectionValues:{agentPreset:'research-suite'}}};
  const render = id => renderToStaticMarkup(React.createElement(Dock,{researchSessionId:id,useSessions:select=>select({byId})}));
  const renderGuide = id => renderToStaticMarkup(React.createElement(Guide,{researchSessionId:id,useSessions:select=>select({byId}),useTabInfo:()=>({tab:{actions:{openTab:()=>{}}}})}));
  assert.equal(render('loading'),'');
  assert.doesNotMatch(renderGuide('loading'),/<button/);
  for (const preset of ['standard','ptc','minimal','cordis','custom-mode',null]) {
    byId.other={projectionValues:{agentPreset:preset}};
    assert.equal(render('other'),'','A different research conversation must not enable this dock');
    assert.doesNotMatch(renderGuide('other'),/<button/,'The DeepScientist card belongs only to research mode');
  }
  assert.match(render('research'),/iframe/);
  byId.research.projectionValues.agentPreset='standard';
  assert.equal(render('research'),'');
  byId.research.projectionValues.agentPreset='research-suite';
  assert.match(render('research'),/session=research/);
  assert.match(renderGuide('research'),/DeepScientist 科研工作台/);
  assert.doesNotMatch(renderGuide('research'),/target="_blank"|href=/);
  assert.doesNotMatch(render('research'),/完整工作台/,'The full workbench entry moved out of the compact dock');
  byId['second/research']={projectionValues:{agentPreset:'research-suite'}};
  assert.match(render('second/research'),/session=second%2Fresearch/,'Each dock uses its own encoded conversation ID');
  const tabs=[];
  module.exports.openResearchTarget({openTab:(...args)=>tabs.push(args)},{view:'detail',kind:'chart',item:'plot-1',title:'图表一'});
  module.exports.openResearchTarget({openTab:(...args)=>tabs.push(args)},{view:'detail',kind:'file',item:'file-1',title:'文件一'});
  module.exports.openResearchTarget({openTab:(...args)=>tabs.push(args)},{view:'detail',kind:'script',item:'bad'});
  assert.equal(tabs.length,2);
  assert.equal(tabs[0][0],'research-detail');
  for(const tab of ['reviews','domains'])module.exports.openResearchTarget({openTab:(...args)=>tabs.push(args)},{tab});
  assert.equal(tabs.length,2,'Removed workbench pages cannot be opened through native frame messages');

  // A return link must restore its own session even if another was last viewed.
  let catalog = {phase:'loading',ids:[]}, notify, unsubscribed = false;
  const opened = [], cleanedUrls = [];
  const ctx = {sessions:{list:{getSnapshot:()=>catalog,subscribe:fn=>{notify=fn;return()=>{unsubscribed=true;};}}},uiWorkspace:{openSession:id=>opened.push(id)}};
  const browser = {location:{href:'http://127.0.0.1:43128/?researchSession=research'},history:{state:null,replaceState:(_state,_title,url)=>cleanedUrls.push(url)}};
  const dispose = module.exports.restoreResearchConversation(ctx,browser);
  await Promise.resolve();
  assert.equal(opened.length,0);
  catalog = {phase:'ready',ids:['research','other']};
  notify(); notify();
  assert.equal(opened.length,0,'Do not interrupt Harness selection while catalog listeners are running');
  await Promise.resolve();
  assert.deepEqual(opened,['research']);
  assert.deepEqual(cleanedUrls,['http://127.0.0.1:43128/']);
  dispose(); assert.ok(unsubscribed);
  browser.location.href='http://127.0.0.1:43128/?researchSession=missing';
  const disposeMissing = module.exports.restoreResearchConversation(ctx,browser);
  await Promise.resolve(); disposeMissing();
  assert.deepEqual(opened,['research'],'An unknown return target must not create or open a conversation');
  browser.location.href='http://127.0.0.1:43128/?researchSession=other';
  module.exports.restoreResearchConversation(ctx,browser)();
  await Promise.resolve();
  assert.deepEqual(opened,['research'],'Disposal must cancel queued navigation');
});

test('workbench accepts visual tokens only from its Harness parent', () => {
  const properties = {};
  const parent = {};
  const style = {setProperty:(name,value)=>{properties[name]=value;}};
  const browser = {parent,location:{href:'http://127.0.0.1:43127/'},document:{documentElement:{style}},CSS:{supports:(_property,value)=>value === '#123456'}};
  const event = {source:parent,origin:'http://127.0.0.1:43128',data:{type:'research-theme',dark:true,tokens:{'--research-text':'#123456','--research-surface':'url(https://example.invalid/tracker)','--unrelated':'#123456'}}};
  applyWorkbenchTheme({...event,origin:'https://example.invalid'},browser);
  applyWorkbenchTheme({...event,source:{}},browser);
  assert.deepEqual(properties,{});
  applyWorkbenchTheme(event,browser);
  assert.deepEqual(properties,{'--research-text':'#123456'});
  assert.equal(style.colorScheme,'dark');
});

test('workbench authentication errors are Chinese and retain HTTP status', async () => {
  const {code} = await transform(readFileSync(new URL('../src/ui/adapters/api.ts',import.meta.url),'utf8'),{loader:'ts',format:'cjs'});
  const module = {exports:{}};
  runInNewContext(code,{module,exports:module.exports,window:{},require:specifier=>{if(specifier==='../../public-addresses.mjs')return {};throw new Error('Unexpected dependency')},URLSearchParams,location:{search:'?session=one'},fetch:async()=>({ok:false,status:401,json:async()=>({error:'Connect with the local workspace access key.'})})});
  await assert.rejects(module.exports.api('state'),e=>e.status === 401 && e.message === '登录已失效，请在平台登录后重新载入。');
  await assert.rejects(module.exports.api('state',{},'invalid'),e=>e.status === 401 && e.message === '访问密钥不正确，请检查后重试。');
});
