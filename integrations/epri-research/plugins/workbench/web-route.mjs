import http from 'node:http';
import {connection} from '../../src/server/client.mjs';
import {publicConfiguration} from '../../src/public-addresses.mjs';

// The local Host authenticates its browser; research credentials never leave the Host.
export function registerWorkbenchRoute(ctx) {
  const config = publicConfiguration(process.env);
  const publicUrls = {harnessUrl:config.harnessUrl || '/',workbenchUrl:config.workbenchUrl || '/research/',platformIdentity:true};
  ctx.on('webserver/index-inject', rows => rows.push({kind:'global',name:'__DS_RESEARCH_PUBLIC__',value:publicUrls}));
  return ctx.webServer.register({kind:'prefix',path:'/research',handler(req,res) {
    const send = (status,error) => {res.writeHead(status,{'Content-Type':'application/json','Cache-Control':'no-store'});res.end(JSON.stringify({error}));};
    const admission = ctx.connection.admit(req);
    if (admission.rejection) return send(admission.rejection,'请先登录平台后继续。');
    if (admission.peer !== ctx.connection.browserPeer || admission.peer.principal.kind !== 'owner') return send(403,'科研页面仅供已认证的平台浏览器使用。');
    // A shared cloud Web root must not map every account to the local administrator.
    if (ctx.get('peAccount',false) || ctx.get('peAuth',false)) return send(503,'科研服务等待平台账号权限适配。');
    const url = new URL(req.url,'http://internal');
    if (url.pathname === '/research') {res.writeHead(308,{Location:'research/'+url.search});res.end();return;}
    const path = url.pathname.slice('/research'.length);
    if (!['GET','POST'].includes(req.method) || !['/','/app.js','/app.css','/public-config.js','/api','/auth','/health'].includes(path)) return send(404,'Not found');
    if (path === '/auth') return send(403,'账号与权限由平台统一管理，无需单独登录科研空间。');
    if (req.method !== (path === '/api' ? 'POST' : 'GET')) return send(405,'Method not allowed');
    // No external browser origin may borrow this gateway's same-origin position.
    const allowed = new Set([ctx.webServer.getOrigin(),...Object.values(config).filter(x=>/^https?:/.test(x)).map(x=>new URL(x).origin)]);
    if (req.headers.origin && !allowed.has(req.headers.origin)) return send(403,'Origin rejected');
    if (path === '/public-config.js' && req.method === 'GET') {
      res.writeHead(200,{'Content-Type':'text/javascript','Cache-Control':'no-store','X-Content-Type-Options':'nosniff'});
      res.end('window.__DS_RESEARCH_PUBLIC__='+JSON.stringify(publicUrls).replaceAll('<','\\u003c')+';');return;
    }
    let upstream;
    try {
      const selected = connection(), target = new URL(selected.url);
      if (target.protocol !== 'http:' || !['127.0.0.1','localhost','[::1]'].includes(target.hostname)) return send(503,'Research service must use a private loopback connection');
      const headers = {'content-type':req.headers['content-type'] || 'application/json',host:target.host};
      // Browser-supplied research tokens, cookies and identity headers are never forwarded.
      if (path === '/api') headers.authorization='Bearer '+selected.humanToken;
      if (req.headers.origin) headers.origin=target.origin;
      upstream=http.request(target.origin+path+url.search,{method:req.method,headers},response=>{
        const outgoing={...response.headers};
        delete outgoing['content-security-policy'];
        delete outgoing['set-cookie'];
        res.writeHead(response.statusCode,{...outgoing,'Content-Security-Policy':"default-src 'self'; script-src 'self'; style-src 'self' 'unsafe-inline'; img-src 'self' data: blob: https:; frame-ancestors 'self'",'Cache-Control':'no-store'});
        response.pipe(res);
      });
      upstream.setTimeout(60000,()=>upstream.destroy(new Error('Research request timed out')));
      upstream.on('error',()=>{if(!res.headersSent)send(502,'科研服务尚未就绪，请稍后重试。');else res.destroy();});
      req.on('aborted',()=>upstream.destroy());
      res.on('close',()=>{if(!res.writableEnded)upstream.destroy();});
      req.pipe(upstream);
    } catch {upstream?.destroy();send(503,'科研服务尚未连接。');}
  }});
}
