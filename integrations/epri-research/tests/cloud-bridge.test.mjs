import {test} from 'node:test';
import assert from 'node:assert/strict';
import {bindResearchBridge,requestResearch} from '../src/cloud-bridge.mjs';

function browser() {
  const listeners=new Set();
  return {location:{origin:'https://research.example'},crypto:{randomUUID:()=> 'request-1'},
    __DS_RESEARCH_PUBLIC__:{requestTimeoutMs:1000},
    addEventListener:(_type,fn)=>listeners.add(fn),removeEventListener:(_type,fn)=>listeners.delete(fn),
    receive(event){for(const listener of listeners)listener(event);},listeners};
}

test('only the mounted same-origin conversation frame can call the account Remote; disposal cancels pending calls',async()=>{
  const host=browser(),replies=[],source={postMessage:message=>replies.push(message)},other={};
  let called=0,control;
  const dispose=bindResearchBridge(host,{contentWindow:source},'session-A',async(session,op,args,signal)=>{
    called++;assert.equal(session,'session-A');control=signal;
    await new Promise(resolve=>signal.addEventListener('abort',resolve,{once:true}));
    throw new Error('closed');
  },1);
  const data={type:'research-call',sessionId:'session-A',requestId:'request-1',op:'state',args:{}};
  for(const change of [{origin:'https://outside.example'},{source:other},{data:{...data,sessionId:'session-B'}}])host.receive({origin:host.location.origin,source,data,...change});
  await Promise.resolve();assert.equal(called,0);
  host.receive({origin:host.location.origin,source,data});await Promise.resolve();assert.equal(called,1);
  host.receive({origin:host.location.origin,source,data:{...data,requestId:'request-2'}});
  assert.match(replies[0].error,/稍后/);
  dispose();assert.equal(control.aborted,true);
  await new Promise(resolve=>setImmediate(resolve));assert.equal(replies.length,1);assert.equal(host.listeners.size,0);
});

test('the child accepts only its parent response and removes listeners on cancellation',async()=>{
  const child=browser(),sent=[],parent={postMessage:message=>sent.push(message)};child.parent=parent;
  const signal=new AbortController(),pending=requestResearch(child,'session-A','state',{},signal.signal);
  const data={type:'research-result',sessionId:'session-A',requestId:sent[0].requestId,result:{secret:'wrong'}};
  for(const change of [{source:{}},{origin:'https://outside.example'},{data:{...data,sessionId:'session-B'}}])child.receive({origin:child.location.origin,source:parent,data,...change});
  child.receive({origin:child.location.origin,source:parent,data:{...data,result:{accepted:true}}});
  assert.deepEqual(await pending,{accepted:true});assert.equal(child.listeners.size,0);
  const cancelling=requestResearch(child,'session-A','state',{},signal.signal),reject=assert.rejects(cancelling);
  signal.abort();await reject;
  assert.equal(sent.at(-1).type,'research-cancel');assert.equal(child.listeners.size,0);
});
