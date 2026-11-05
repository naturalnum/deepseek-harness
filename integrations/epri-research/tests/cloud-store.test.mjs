import {test} from 'node:test';
import assert from 'node:assert/strict';
import {mkdtempSync,rmSync} from 'node:fs';
import {tmpdir} from 'node:os';
import {join} from 'node:path';
import {openCloudStore} from '../dist/server/cloud-store.mjs';

function account(t,name,allowed,run=async()=>({exitCode:0,stdout:'{}',stderr:''})) {
  const directory=mkdtempSync(join(tmpdir(),'epri-cloud-'+name+'-')), lifetime=new AbortController();
  let current=true;
  const check=()=>{if(!current)throw new Error('stale account');};
  const value=openCloudStore({directory,lifetime:lifetime.signal,assertCurrent:check,python:'/usr/bin/python3',
    async authorizeSession(sessionId,signal){
      signal.throwIfAborted();check();
      if(!allowed.includes(sessionId))throw new Error('foreign session');
      return {check,workspaceRoot:'/workspace/'+name,run:(...args)=>run(sessionId,...args),
        readBytes:async()=>{throw new Error('unexpected file read');},stat:async()=>{throw new Error('unexpected file stat');}};
    },
  });
  t.after(async()=>{await value.close();rmSync(directory,{recursive:true,force:true});});
  return {value,lifetime,revoke(){current=false;},directory};
}

test('cloud accounts isolate identical session/object/request ids and reject another account session',async t=>{
  const a=account(t,'a',['same','a-only']),b=account(t,'b',['same','b-only']);
  const put=(owner,label)=>owner.value.execute('protocol_put',{id:'p',version:'1',content:'# '+label+'\n\n{{var|value: str}}',requestId:'same-request'},'human','same');
  await Promise.all([put(a,'account A'),put(b,'account B')]);
  assert.match((await a.value.execute('protocol_get',{id:'p',version:'1'},'agent','same')).content,/account A/);
  assert.match((await b.value.execute('protocol_get',{id:'p',version:'1'},'agent','same')).content,/account B/);
  await assert.rejects(a.value.execute('state',{},'human','b-only'),/foreign session/);
  await assert.rejects(b.value.execute('state',{},'human','a-only'),/foreign session/);
  await assert.rejects(a.value.execute('record_archive',{},'agent','same'),/requires human/);
  await assert.rejects(a.value.execute('state',{},'human',null),/平台会话/);
  a.revoke();
  await assert.rejects(a.value.execute('state',{},'human','same'),/stale account/);
  assert.equal((await b.value.execute('state',{},'agent','same')).protocols.length,1);
});

test('revocation while OCR waits cannot publish extracted data and a later instance sees no result',async t=>{
  let release,entered;
  const started=new Promise(resolve=>{entered=resolve;});
  const a=account(t,'ocr',['s'],async()=>{
    entered();await new Promise(resolve=>{release=resolve;});
    return {exitCode:0,stdout:JSON.stringify({pages:[{page:1,text:'private OCR',method:'ocr'}]}),stderr:''};
  });
  const file=await a.value.execute('attachment_put',{name:'private.png',contentBase64:Buffer.from('fake image').toString('base64'),requestId:'file'},'human','s');
  const extracting=a.value.execute('document_extract',{reference:file.reference,language:'eng'},'human','s');
  await started;a.revoke();release();
  await assert.rejects(extracting,/stale account|文字提取失败/);
  await a.value.close();
  const reopened=openCloudStore({directory:a.directory,lifetime:new AbortController().signal,assertCurrent(){},python:'/usr/bin/python3',
    authorizeSession:async()=>({check(){},workspaceRoot:'/workspace/a',run:async()=>{throw new Error('must not extract again');}})});
  t.after(()=>reopened.close());
  await assert.rejects(reopened.execute('document_text',{reference:file.reference},'human','s'),/请先提取/);
  await reopened.close();
});

test('cloud status and cancellation use only the selected session executor and join before close',async t=>{
  let didStop=false,entered;
  const started=new Promise(resolve=>{entered=resolve;});
  const a=account(t,'run',['s'],async(session,argv,input,signal)=>{
    assert.equal(session,'s');assert.equal(argv[0],'/usr/bin/python3');
    if(argv.at(-1).includes('importlib.metadata'))return {exitCode:0,stdout:'{"python":"3.13","airalogy":"0.0.5"}',stderr:''};
    entered();
    await new Promise(resolve=>signal.addEventListener('abort',resolve,{once:true}));
    await new Promise(resolve=>setTimeout(resolve,15));didStop=true;
    throw signal.reason;
  });
  assert.equal((await a.value.execute('engine_status',{},'agent','s')).execution,'cloud');
  const file=await a.value.execute('attachment_put',{name:'document.pdf',contentBase64:Buffer.from('input').toString('base64'),requestId:'file'},'human','s');
  const work=a.value.execute('document_extract',{reference:file.reference,language:'eng'},'human','s');
  const rejected=assert.rejects(work);
  await started;await a.value.close();await rejected;
  assert.equal(didStop,true);
  await assert.rejects(a.value.execute('state',{},'human','s'),/正在关闭/);
});
