/** Immutable research assets only; all account data uses the existing native Connection carrier. */
import schema from '@deepseek-ai/schemastery';
import {readFileSync} from 'node:fs';
import {fileURLToPath} from 'node:url';
export const name='research-suite/cloud-assets';
export const inject=['webServer'];
export const Config=schema.object({requestTimeoutMs:schema.number().step(1).min(1000).max(300000).required()});
export function apply(ctx,input) {
  const config=Config(input);
  const publicConfig={cloudRequestTimeoutMs:config.requestTimeoutMs,cloud:true,platformIdentity:true,workbenchUrl:'/research/',harnessUrl:'/'};
  ctx.on('webserver/index-inject',rows=>rows.push({kind:'global',name:'__DS_RESEARCH_PUBLIC__',value:publicConfig}));
  const assets=new Map([
    ['/research/', ['text/html; charset=utf-8',readFileSync(fileURLToPath(new URL('../../dist/ui/index.html',import.meta.url)))]],
    ['/research/app.js',['application/javascript; charset=utf-8',readFileSync(fileURLToPath(new URL('../../dist/ui/app.js',import.meta.url)))]],
    ['/research/app.css',['text/css; charset=utf-8',readFileSync(fileURLToPath(new URL('../../dist/ui/app.css',import.meta.url)))]],
    ['/research/public-config.js',['application/javascript; charset=utf-8',Buffer.from('window.__DS_RESEARCH_PUBLIC__='+JSON.stringify(publicConfig)+';')]],
  ]);
  ctx.webServer.register({kind:'prefix',path:'/research',handler(req,res){
    const path=new URL(req.url,'http://internal').pathname;
    if(path==='/research'){res.writeHead(308,{Location:'/research/'});res.end();return;}
    const value=assets.get(path);
    if(!value||!['GET','HEAD'].includes(req.method)){res.writeHead(404);res.end();return;}
    res.writeHead(200,{'Content-Type':value[0],'Cache-Control':'no-cache','X-Content-Type-Options':'nosniff',
      'Content-Security-Policy':"default-src 'self'; script-src 'self'; style-src 'self' 'unsafe-inline'; img-src 'self' data: blob: https:; frame-ancestors 'self'"});
    res.end(req.method==='HEAD'?undefined:value[1]);
  }});
}
