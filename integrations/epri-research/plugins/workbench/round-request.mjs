import {roundHistory} from './round-history.mjs';
const fail=(status,message)=>{throw Object.assign(new Error(message),{status});};
const agentLoads=new WeakMap();
async function current(ctx,sessionId) {
  let agent=ctx.agents.get(sessionId);
  if(!agent) {
    if(typeof ctx.agents.resume!=='function')fail(409,'当前科研对话尚未载入，请在对话中发送一条消息后重试。');
    let pending=agentLoads.get(ctx);
    if(!pending){pending=new Map();agentLoads.set(ctx,pending);}
    let loading=pending.get(sessionId);
    if(!loading) {
      loading=ctx.agents.resume({resumeSessionId:sessionId}).then(handle=>handle.agent);
      pending.set(sessionId,loading);
    }
    try {agent=await loading;}
    catch {fail(409,'当前科研对话尚无已保存的 Agent；请先在该对话发送一条消息，再启动或恢复持续科研。');}
    finally {if(pending.get(sessionId)===loading)pending.delete(sessionId);}
  }
  if(!agent)fail(409,'当前科研对话尚未载入，请在对话中发送一条消息后重试。');
  if(ctx.sessionProjections.stateOf(agent.session,'agentPreset')!=='research-suite')fail(403,'持续科研仅适用于科研模式对话。');
  return agent;
}

export async function readRounds(ctx,body) {
  if(body?.action!=='rounds'||typeof body.sessionId!=='string'||!body.sessionId.trim()||body.sessionId.length>200 ||
     [body.item,body.before].some(value=>value!==undefined && (typeof value!=='string'||!/^\d{1,16}$/.test(value))))fail(400,'无效的轮次请求。');
  if(!ctx.agents.get(body.sessionId)&&!await ctx.sessionPersistence.stat(body.sessionId)){
    if(body.item!==undefined)fail(404,'本对话中找不到这一轮。');
    return {rows:[],more:false};
  }
  return roundHistory((await current(ctx,body.sessionId)).session,body);
}
