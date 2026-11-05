// Each mounted frame owns its calls and cancellation. A reply from another
// frame, origin or conversation never settles an operation.
export function requestResearch(browser,sessionId,op,args,signal) {
  if(browser.parent===browser)return Promise.reject(new Error('请从平台当前对话的科研工作台进入。'));
  const requestId=browser.crypto.randomUUID(),origin=browser.location.origin;
  const timeout=browser.__DS_RESEARCH_PUBLIC__?.requestTimeoutMs;
  if(!Number.isSafeInteger(timeout)||timeout<1)return Promise.reject(new Error('科研请求时限未配置。'));
  return new Promise((resolve,reject)=>{
    let settled=false;
    const finish=(error,value)=>{
      if(settled)return;settled=true;clearTimeout(timer);
      browser.removeEventListener('message',receive);signal?.removeEventListener('abort',abort);
      if(error)reject(error);else resolve(value);
    };
    const receive=event=>{
      const data=event.data;
      if(event.origin!==origin||event.source!==browser.parent||data?.type!=='research-result'||data.requestId!==requestId||data.sessionId!==sessionId)return;
      finish(data.error?new Error(data.error):null,data.result);
    };
    const abort=()=>{
      browser.parent.postMessage({type:'research-cancel',sessionId,requestId},origin);
      finish(signal?.reason || new Error('科研请求已取消。'));
    };
    const timer=setTimeout(()=>{browser.parent.postMessage({type:'research-cancel',sessionId,requestId},origin);finish(new Error('科研请求超时，请刷新状态后重试。'));},timeout);
    browser.addEventListener('message',receive);signal?.addEventListener('abort',abort,{once:true});
    if(signal?.aborted){abort();return;}
    browser.parent.postMessage({type:'research-call',sessionId,requestId,op,args},origin);
  });
}

export function bindResearchBridge(browser,frame,sessionId,request,maximum) {
  if(!Number.isSafeInteger(maximum)||maximum<1)throw new Error('科研并发请求上限未配置。');
  const calls=new Map(),origin=browser.location.origin;let closed=false;
  const receive=event=>{
    const data=event.data;
    if(closed||event.origin!==origin||event.source!==frame.contentWindow||data?.sessionId!==sessionId||typeof data.requestId!=='string'||data.requestId.length>80)return;
    if(data.type==='research-cancel'){calls.get(data.requestId)?.abort();return;}
    if(data.type!=='research-call'||calls.has(data.requestId))return;
    const respond=payload=>{if(!closed)event.source.postMessage({type:'research-result',sessionId,requestId:data.requestId,...payload},origin);};
    if(calls.size>=maximum){respond({error:'科研请求较多，请稍后重试。'});return;}
    if(typeof data.op!=='string'||data.op.length>100){respond({error:'科研操作名称无效。'});return;}
    const controller=new AbortController();calls.set(data.requestId,controller);
    Promise.resolve().then(()=>request(sessionId,data.op,data.args,controller.signal))
      .then(result=>respond({result}),error=>respond({error:String(error.message || '科研操作未完成。')}))
      .finally(()=>calls.delete(data.requestId));
  };
  browser.addEventListener('message',receive);
  return ()=>{closed=true;browser.removeEventListener('message',receive);for(const controller of calls.values())controller.abort();calls.clear();};
}
