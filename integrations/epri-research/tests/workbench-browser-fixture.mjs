/** Execute the real client and iframe adapters with an actual MessageChannel; no browser, network or Session is created. */
import {readFileSync} from 'node:fs';
import {createRequire} from 'node:module';
import {runInNewContext} from 'node:vm';
import {MessageChannel} from 'node:worker_threads';
import {transform} from 'esbuild';
import {researchFailure} from '../src/ui/rpc-errors.mjs';
import {publicAddresses} from '../src/public-addresses.mjs';

export async function workbenchBrowserApi(call, sessionId='acceptance') {
  const client={exports:{}};
  const clientCode=await transform(readFileSync(new URL('../plugins/workbench/client.jsx',import.meta.url),'utf8'),{loader:'jsx',format:'cjs'});
  const browser={location:{href:'https://cloud.example/'},__DS_RESEARCH_PUBLIC__:{cloud:true,cloudRequestTimeoutMs:10000,harnessUrl:'https://cloud.example/',workbenchUrl:'https://cloud.example/research/'}};
  runInNewContext(clientCode.code,{module:client,exports:client.exports,require:createRequire(new URL('../plugins/workbench/client.jsx',import.meta.url)),window:browser,URL,URLSearchParams});
  const ctx={sidebarRight:{mounted:{getSnapshot:()=> sessionId}},connection:{rpc:{call}}};
  const requestResearch=client.exports.researchApi(ctx,sessionId);
  browser.parent={postMessage:(message,origin,ports)=>{
    if(origin!=='https://cloud.example')throw new Error('Unexpected parent origin');
    const port=ports[0];
    void requestResearch(message.op,message.args,message.execute).then(value=>port.postMessage({ok:true,value}),error=>port.postMessage(researchFailure(error))).finally(()=>port.close());
  }};
  const iframe={exports:{}};
  const iframeCode=await transform(readFileSync(new URL('../src/ui/adapters/api.ts',import.meta.url),'utf8'),{loader:'ts',format:'cjs'});
  runInNewContext(iframeCode.code,{module:iframe,exports:iframe.exports,require:specifier=>specifier==='../../public-addresses.mjs'?{publicAddresses:()=>publicAddresses(browser)}:createRequire(new URL('../src/ui/adapters/api.ts',import.meta.url))(specifier),window:browser,location:{search:'?session='+encodeURIComponent(sessionId)},MessageChannel,AbortSignal,URLSearchParams});
  return iframe.exports.api;
}
