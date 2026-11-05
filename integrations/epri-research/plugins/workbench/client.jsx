import React, { useEffect, useState, useRef } from 'react';
import { workbenchThemeTokens } from '../../src/ui/workbench-theme.mjs';
import { publicAddresses } from '../../src/public-addresses.mjs';
import {bindResearchBridge} from '../../src/cloud-bridge.mjs';
const cloud=window.__DS_RESEARCH_PUBLIC__?.cloud===true;
export const inject = ['slots', 'uiWorkspace', 'sessions', 'sidebarRightTabs', 'sidebarRight',...(cloud?['remote.epriResearch']:[])];
const workbench = publicAddresses(window, 'harness').workbench;
const base = workbench.href;
const guideId = 'deepscientist-harness-suite/workbench';
const guideStyle = `
[data-sidebar-right-guide] > :has([data-research-guide-hidden]) { display: none; }
.research-guide-entry { display:flex; align-items:center; gap:14px; box-sizing:border-box; width:100%; min-height:68px; padding:14px 20px; border:0.5px solid var(--dsw-alias-border-l3); border-radius:var(--dsl-guide-entry-radius); background:var(--dsw-alias-bg-layer-1); color:var(--dsw-alias-label-primary); text-align:left; text-decoration:none; font:inherit; transition:background-color .15s; }
.research-guide-entry:hover { background:var(--dsw-alias-interactive-bg-hover); }
.research-guide-entry:focus-visible { outline:2px solid currentColor; outline-offset:2px; }
.research-guide-icon { display:flex; align-items:center; justify-content:center; flex:none; width:36px; height:36px; border-radius:10px; background:color-mix(in srgb,var(--dsw-alias-link) 8%,transparent); color:var(--dsw-alias-link); }
.research-guide-icon svg { width:23px; height:23px; }
.research-guide-text { display:flex; flex:1; flex-direction:column; gap:3px; min-width:0; }
.research-guide-title { overflow:hidden; text-overflow:ellipsis; white-space:nowrap; font-size:14px; font-weight:500; line-height:1.5; }
.research-guide-description { overflow:hidden; text-overflow:ellipsis; white-space:nowrap; color:var(--dsw-alias-label-tertiary); font-size:11px; line-height:1.4; }
.research-guide-arrow { color:var(--dsw-alias-label-tertiary); font-size:16px; }
.research-dock { box-sizing:border-box; width:calc(100% - 24px); max-width:var(--dsh-composer-card-max-width, 760px); flex-shrink:0; margin:0 auto 10px; overflow:hidden; border:0.5px solid var(--dsw-alias-border-l2); border-radius:var(--dsw-radius-lg, 16px); background:var(--dsw-alias-bg-layer-1); color:var(--dsw-alias-label-primary); font-family:var(--dsw-font-family); }
.research-dock-header { display:flex; align-items:center; gap:10px; min-height:42px; padding:6px 14px; }
.research-dock-header>.research-panel-close { margin:0 0 0 auto; padding:4px 6px; font-size:11px; white-space:nowrap; }
.research-dock-toggle { display:flex; align-items:center; gap:8px; min-width:0; padding:4px 0; border:0; background:none; color:inherit; font:inherit; font-size:12px; font-weight:500; cursor:pointer; }
.research-dock-toggle:hover { color:var(--dsw-alias-label-secondary); }
.research-dock-toggle:focus-visible { outline:2px solid var(--dsw-alias-link); outline-offset:3px; border-radius:4px; }
.research-dock-icon { color:var(--dsw-alias-link); flex:none; }
.research-dock-name { overflow:hidden; text-overflow:ellipsis; white-space:nowrap; }
.research-dock-count { padding:1px 6px; border-radius:5px; background:var(--dsw-alias-interactive-bg-hover); color:var(--dsw-alias-label-secondary); font-size:10px; white-space:nowrap; }
.research-dock-chevron { color:var(--dsw-alias-label-tertiary); flex:none; transition:transform .15s; }
.research-dock-toggle[aria-expanded=false] .research-dock-chevron { transform:rotate(-90deg); }
.research-dock-scope { padding-left:10px; border-left:1px solid var(--dsw-alias-border-l2); color:var(--dsw-alias-label-tertiary); font-size:10px; white-space:nowrap; }
.research-dock-frame { border:0; width:100%; background:var(--dsw-alias-bg-layer-1); }
.research-panel { display:flex; flex-direction:column; height:100%; min-height:0; background:var(--dsw-alias-bg-layer-1); }
.research-panel-header { display:flex; align-items:center; gap:12px; min-height:46px; padding:0 16px; flex-shrink:0; border-bottom:0.5px solid var(--dsw-alias-border-l2); color:var(--dsw-alias-label-primary); }
.research-panel-brand { display:flex; align-items:center; gap:9px; min-width:0; font-size:13px; }
.research-panel-brand strong { font-weight:600; }
.research-panel-brand span { padding-left:9px; border-left:1px solid var(--dsw-alias-border-l2); color:var(--dsw-alias-label-tertiary); font-size:11px; }
.research-panel-header .research-panel-close { margin-left:auto; margin-right:0; }
.research-panel iframe { border:0; flex:1; width:100%; min-height:0; }
.research-panel-close { align-self:center; padding:5px 7px; border-radius:6px; margin:6px 12px; border:0; background:transparent; color:var(--dsw-alias-label-secondary); cursor:pointer; font:inherit; font-size:11px; }
.research-panel-close:hover { background:var(--dsw-alias-interactive-bg-hover); color:var(--dsw-alias-label-primary); }
.research-panel-close:focus-visible { outline:2px solid var(--dsw-alias-link); outline-offset:2px; }
@media(max-width:1100px) { .research-dock-scope { display:none; } }
@media(prefers-reduced-motion:reduce) { .research-guide-entry,.research-dock-chevron { transition:none; } }
`;
function ResearchGuideEntry({ researchSessionId, useSessions, useTabInfo }) {
  const preset = useSessions(state => state.byId[researchSessionId]?.projectionValues?.agentPreset);
  const info = useTabInfo();
  if (preset !== 'research-suite' && !(cloud&&typeof preset==='string')) return <span hidden data-research-guide-hidden />;
  return <button type="button" className="research-guide-entry" data-sidebar-right-guide-entry="research-workbench"
    onClick={() => info.tab.actions.openTab('research-workbench',{params:{tab:'overview'}})}
    aria-label="在右侧栏打开 DeepScientist 科研工作台">
    <span className="research-guide-icon" aria-hidden="true">
      <svg width="26" height="26" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="1.7" strokeLinecap="round" strokeLinejoin="round"><path d="M9 3h6M10 3v6l-6 10a1.3 1.3 0 0 0 1.1 2h13.8a1.3 1.3 0 0 0 1.1-2L14 9V3M7 15h10"/><path d="M10 18h.01M14 17h.01"/></svg>
    </span>
    <span className="research-guide-text"><span className="research-guide-title">DeepScientist 科研工作台</span><span className="research-guide-description">研究总览、路线与证据 · 当前对话成果</span></span>
    <span className="research-guide-arrow" aria-hidden="true">→</span>
  </button>;
}
export function restoreResearchConversation(ctx, browser = window) {
  const url = new URL(browser.location.href);
  const id = url.searchParams.get('researchSession');
  if (!id) return;
  let restored = false;
  const restore = () => {
    const catalog = ctx.sessions.list.getSnapshot();
    if (restored || catalog.phase !== 'ready') return;
    restored = true;
    // Use Harness navigation only for an existing conversation; never create one.
    if (catalog.ids.includes(id)) ctx.uiWorkspace.openSession(id);
    url.searchParams.delete('researchSession');
    browser.history.replaceState(browser.history.state, '', url.href);
  };
  // Finish the native catalog/selection notification before selecting our target.
  const schedule = () => queueMicrotask(restore);
  const unsubscribe = ctx.sessions.list.subscribe(schedule);
  schedule();
  return () => { restored = true; unsubscribe(); };
}
function ResearchFrame({researchSessionId, target={}, compact=false, openTarget,requestConversation,researchCall}) {
  const frame=useRef(null);
  useEffect(()=>researchCall&&frame.current
    ? bindResearchBridge(window,frame.current,researchSessionId,researchCall,window.__DS_RESEARCH_PUBLIC__.maxPendingRequests)
    : undefined,[researchSessionId,researchCall]);
  const params=new URLSearchParams({session:researchSessionId,embed:'1',...(compact?{view:'compact'}:{}),...target});
  const syncTheme=()=>{
    const style=getComputedStyle(document.body);
    const tokens=Object.fromEntries(Object.entries(workbenchThemeTokens).map(([name,source])=>[name,name==='--research-font'?style.fontFamily:style.getPropertyValue(source).trim()]));
    frame.current?.contentWindow?.postMessage({type:'research-theme',tokens,dark:document.body.hasAttribute('data-ds-dark-theme')},workbench.origin);
  };
  useEffect(()=>{
    const observer=new MutationObserver(syncTheme);
    observer.observe(document.body,{attributes:true,attributeFilter:['data-ds-dark-theme','style','class']});
    const receive=event=>{
      if(event.origin!==workbench.origin||event.source!==frame.current?.contentWindow||event.data?.sessionId!==researchSessionId)return;
      if(event.data.type==='research-theme-ready')syncTheme();
      if(event.data.type==='research-open')openTarget?.(event.data.target);
      if(event.data.type==='research-task-request'){
        try{requestConversation?.(event.data.taskId,event.data.action);event.source.postMessage({type:'research-task-request-result',requestId:event.data.requestId,ok:Boolean(requestConversation)},event.origin);}
        catch(error){event.source.postMessage({type:'research-task-request-result',requestId:event.data.requestId,ok:false,error:error.message},event.origin);}
      }
    };
    window.addEventListener('message',receive);
    return()=>{observer.disconnect();window.removeEventListener('message',receive);};
  },[researchSessionId,openTarget,requestConversation]);
  return <iframe ref={frame} title={compact?'当前对话科研成果':target.view==='detail'?'科研成果详情':'DeepScientist 科研工作台'} src={base+'?'+params} onLoad={syncTheme} className="research-dock-frame" style={compact?{height:184}:undefined}/>;
}
export function openResearchTarget(actions,target={}) {
  if(!target||typeof target!=='object')return;
  if(target.view==='detail') {
    if(!['file','chart','record'].includes(target.kind)||typeof target.item!=='string'||!target.item||target.item.length>200)return;
    actions.openTab('research-detail',{params:{view:'detail',kind:target.kind,item:target.item,title:typeof target.title==='string'?target.title.slice(0,200):'成果详情'}});
  } else if (target.record || ['overview','deliverables','science','engine','archives','protocols','records','literature','artifacts'].includes(target.tab) || !Object.keys(target).length) {
    const params={tab:target.tab||'deliverables'};
    for(const key of ['record','section','item','node','review','task'])if(typeof target[key]==='string')params[key]=target[key].slice(0,200);
    actions.openTab('research-workbench',{params});
  }
}
function ResearchPanel({researchSessionId,useSessions,useTabInfo,requestConversation,researchCall}) {
  const preset=useSessions(state=>state.byId[researchSessionId]?.projectionValues?.agentPreset);
  const info=useTabInfo();
  if(preset!=='research-suite'&&!(cloud&&typeof preset==='string'))return <p>科研工作台仅在科学研究模式中使用。</p>;
  const target=info.tab.navigation.params || {tab:'deliverables'};
  return <section className="research-panel"><header className="research-panel-header"><div className="research-panel-brand"><strong>DeepScientist</strong><span>{target.view==='detail'?'成果详情':'科研工作台'}</span></div><button className="research-panel-close" onClick={()=>info.tab.actions.close()}>关闭此页 · 继续对话</button></header><ResearchFrame key={info.tab.navigation.revision} researchSessionId={researchSessionId} target={target} requestConversation={requestConversation} researchCall={researchCall} openTarget={value=>openResearchTarget(info.tab.actions,value)}/></section>;
}
function ResearchTitle({useTabInfo}) {
  const info=useTabInfo();
  return <span>{info.tab.navigation.params?.title || '成果详情'}</span>;
}
function ResearchDock({ researchSessionId, openTarget, researchCall }) {
  const [expanded, setExpanded] = useState(true);
  return <section aria-label="当前对话科研工作台" className="research-dock">
    <div className="research-dock-header">
      <button type="button" className="research-dock-toggle" aria-expanded={expanded} onClick={() => setExpanded(x => !x)}>
        <svg className="research-dock-icon" aria-hidden="true" width="16" height="16" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="1.6" strokeLinecap="round" strokeLinejoin="round"><path d="M9 3h6M10 3v6l-6 10a1.3 1.3 0 0 0 1.1 2h13.8a1.3 1.3 0 0 0 1.1-2L14 9V3M7 15h10"/></svg>
        <span className="research-dock-name">DeepScientist 科研工作台</span>
        <svg className="research-dock-chevron" aria-hidden="true" width="12" height="12" viewBox="0 0 16 16" fill="none" stroke="currentColor" strokeWidth="1.5"><path d="m4 6 4 4 4-4"/></svg>
      </button>
      <button type="button" className="research-panel-close" onClick={()=>openTarget({tab:'deliverables'})}>在右侧展开 →</button>
      <span className="research-dock-scope" title="仅显示本对话成果；文件位置沿用对话工作目录，可通过 Harness 的目录选择器修改。">当前对话</span>
    </div>
    <div hidden={!expanded}><ResearchFrame researchSessionId={researchSessionId} compact openTarget={openTarget} researchCall={researchCall}/></div>
  </section>;
}
function ResearchModeDock({ researchSessionId, useSessions, openTarget, researchCall }) {
  const preset = useSessions(state => state.byId[researchSessionId]?.projectionValues?.agentPreset);
  return (preset === 'research-suite'||(cloud&&typeof preset==='string')) ? <ResearchDock key={researchSessionId} researchSessionId={researchSessionId} openTarget={openTarget} researchCall={researchCall}/> : null;
}
export function apply(ctx) {
  const researchCall=cloud?async(sessionId,op,args,signal)=>JSON.parse(await ctx.remote.epriResearch.execute(sessionId,op,JSON.stringify(args),signal)):undefined;
  ctx.effect(() => restoreResearchConversation(ctx));
  ctx.effect(() => {
    const style = document.createElement('style');
    style.textContent = guideStyle;
    document.head.append(style);
    return () => style.remove();
  });
  ctx.effect(() => ctx.sidebarRightTabs.register({
    id:guideId,kind:'research-workbench',keepMounted:true,title:() => 'DeepScientist',
    guide:[{id:'workbench',order:30,title:() => 'DeepScientist 科研工作台',description:() => '研究总览、路线与证据 · 当前对话成果'}],
  }));
  ctx.effect(()=>ctx.sidebarRightTabs.register({id:guideId+'/detail',kind:'research-detail',multiple:true,keepMounted:true,title:()=> '成果详情'}));
  for(const key of [guideId,guideId+'/detail'])ctx.slots.inject('sidebar.right.pane.tab',()=>ctx.slots.register({name:'sidebar.right.pane.tab',key,inject:researchSessionId=>({researchSessionId,researchCall,requestConversation:(taskId,action)=>draftTaskRequest(ctx,researchSessionId,taskId,action)})},ResearchPanel));
  ctx.slots.inject('sidebar.right.pane.tab.title',()=>ctx.slots.register({name:'sidebar.right.pane.tab.title',key:guideId+'/detail'},ResearchTitle));
  ctx.slots.inject('sidebar.right.tab.guide.entry', () => ctx.slots.register({
    name:'sidebar.right.tab.guide.entry',key:guideId,
    inject:sessionId => ({researchSessionId:sessionId}),
  }, ResearchGuideEntry));
  ctx.slots.inject('conversation.input.dock', () => ctx.slots.register({
    name:'conversation.input.dock',id:'research-workbench',order:10,
    inject: sessionId => ({researchSessionId:sessionId,researchCall,openTarget:target=>{
      // A delayed frame from a previous conversation cannot open content in a new one.
      if(ctx.sidebarRight.mounted.getSnapshot()===sessionId)openResearchTarget(ctx.sidebarRight,target);
    }}),
  }, ResearchModeDock));
}
export function draftTaskRequest(ctx,sessionId,taskId,action){
  if(ctx.sidebarRight.mounted.getSnapshot()!==sessionId)throw new Error('当前对话已切换，请重新打开任务。');
  if(typeof taskId!=='string'||!/^task-[\w.-]{1,100}$/.test(taskId))throw new Error('任务标识无效。');
  const prompts={open:'核对方法适用范围后，调用 research_task_open，在当前对话请求确认精确方法源码并准备实验表。',review:'核对本任务的当前记录，调用 research_record_submit，在当前对话请求人工确认；不要代替我批准或跳过检查。',evidence:'核对本任务的当前证据及来源记录，调用 research_evidence_review，在当前对话请求人工复核；不要自动批准。'};
  if(!prompts[action])throw new Error('不支持的任务操作。');
  const scoped=ctx.sessions.scope(sessionId),input=scoped?.get('conversation')?.input.for(scoped);
  if(!input)throw new Error('对话输入服务尚未就绪。');
  const state=input.state.getSnapshot();if(state.phase!=='plain'||state.draft.trim()||state.attachmentIds.length)throw new Error('输入框已有草稿、附件或待处理操作，请先处理，再发起任务请求。');
  input.setDraft('请先调用 research_task_get 读取研究任务 '+taskId+'。'+prompts[action]);input.focus();
}
