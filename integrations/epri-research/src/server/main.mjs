import {localAdministrator} from './access.mjs';
import http from "node:http";
import {
  readFileSync,
  writeFileSync,
  existsSync,
  mkdirSync,
  chmodSync,
} from "node:fs";
import { resolve, join, dirname } from "node:path";
import { fileURLToPath } from "node:url";
import { suitePaths } from "./paths.mjs";
import { randomBytes, timingSafeEqual } from "node:crypto";
import { openStore } from "./service.mjs";
import { validateArgs } from "./contracts.mjs";
import { publicConfiguration, configuredOrigins } from '../public-addresses.mjs';
export const defaultDataDir = () => suitePaths().directory;
export async function startServer({
  directory = defaultDataDir(),
  port = Number(process.env.DS_RESEARCH_PORT || 43127),
  publicUrls = publicConfiguration(process.env),
} = {}) {
  const publicOrigins = configuredOrigins(publicUrls);
  mkdirSync(directory, { recursive: true, mode: 0o700 });
  const credentialsPath = join(directory, "connection.json");
  const credentials = existsSync(credentialsPath)
    ? JSON.parse(readFileSync(credentialsPath, "utf8"))
    : {
        humanToken: randomBytes(32).toString("hex"),
        agentToken: randomBytes(32).toString("hex"),
      };
  const store = openStore(directory),
    ui = resolve(dirname(fileURLToPath(import.meta.url)), "../ui");
  const equal = (a, b) =>
    typeof a === "string" &&
    Buffer.byteLength(a) === Buffer.byteLength(b) &&
    timingSafeEqual(Buffer.from(a), Buffer.from(b));
  const server = http.createServer(async (req, res) => {
    const controller = new AbortController();
    res.on("close", () => { if (!res.writableEnded) controller.abort(); });
    res.setHeader("X-Content-Type-Options", "nosniff");
    res.setHeader("Referrer-Policy", "no-referrer");
    res.setHeader("Cache-Control", "no-store");
    const send = (code, value) => {
      if (res.destroyed || res.writableEnded) return;
      res.writeHead(code, { "Content-Type": "application/json" });
      res.end(JSON.stringify(value));
    };
    try {
      if (
        ![
          "127.0.0.1:" + server.address().port,
          "localhost:" + server.address().port,
        ].includes(req.headers.host)
      )
        return send(403, { error: "Host rejected" });
      const origin = req.headers.origin;
      if (
        origin &&
        ![
          "http://127.0.0.1:" + server.address().port,
          "http://localhost:" + server.address().port,
          ...publicOrigins,
        ].includes(origin)
      )
        return send(403, { error: "Origin rejected" });
      const path = new URL(req.url, "http://127.0.0.1").pathname;
      if (req.method === 'GET' && path === '/public-config.js') {
        res.writeHead(200, {'Content-Type':'text/javascript'});
        return res.end('window.__DS_RESEARCH_PUBLIC__ = ' + JSON.stringify(publicUrls).replaceAll('<', '\\u003c') + ';');
      }
      if (req.method === "GET" && path === "/health")
        return send(200, {
          service: "deepscientist-harness-suite",
          version: "0.2.0",
          build: "20261026-capabilities",
        });
      const bearer=req.headers.authorization?.replace(/^Bearer /,'');
      const cookies=Object.fromEntries((req.headers.cookie || '').split(';').map(x=>x.trim().split('=')));
      const accountToken=cookies.ds_account;
      const who=equal(bearer,credentials.humanToken)?localAdministrator:accountToken?store.access.authenticate(accountToken):equal(cookies.ds_research,credentials.humanToken)?localAdministrator:null;
      if(req.method==='POST'&&path==='/auth'){
        let body='';for await(const chunk of req){body+=chunk;if(Buffer.byteLength(body)>65536)return send(413,{error:'Request too large'});}
        const {op,args={}}=JSON.parse(body);const response=await store.access.handle(op,args,who,accountToken,req.socket.remoteAddress);
        if(response.setToken)res.setHeader('Set-Cookie',['ds_account='+response.setToken+'; HttpOnly; SameSite=Strict; Path=/; Max-Age=43200','ds_research=; HttpOnly; SameSite=Strict; Path=/; Max-Age=0']);
        if(response.clearToken)res.setHeader('Set-Cookie',['ds_account=; HttpOnly; SameSite=Strict; Path=/; Max-Age=0','ds_research=; HttpOnly; SameSite=Strict; Path=/; Max-Age=0']);
        return send(200,{result:response.result});
      }
      if (req.method === 'POST' && path === '/api') {
        const actor=equal(bearer,credentials.agentToken)?'agent':who?'human':null;
        if(!actor)return send(401,{error:'Connect with the local workspace access key or a named account.'});
        let body = "";
        for await (const chunk of req) {
          body += chunk;
          if (Buffer.byteLength(body) > 96 * 1024 * 1024)
            return send(413, { error: "Request too large" });
        }
        const { op, args = {}, sessionId = null } = JSON.parse(body);
        if(who)store.access.authorize(who,op,sessionId,args);
        let result = who&&!who.admin&&op==='state'&&!sessionId?{protocols:[],records:[],artifacts:[]}:await store.execute(op, validateArgs(op, args), who&&!who.admin&&['roadmap_put','record_update'].includes(op)&&store.access.role(who,sessionId)==='editor'?'agent':actor, controller.signal, sessionId);
        if(who){
          if(op==='state'){
            result.access={user:who,role:sessionId?store.access.role(who,sessionId):null};
            if(!who.admin)result.protocols=result.protocols.filter(p=>p.sessionId===sessionId||result.records.some(r=>r.protocolId===p.id&&r.protocolVersion===p.version));
          }
          if(op==='lab_skills'&&!who.admin)result=result.filter(s=>store.access.canRead(who,s.sessionId));
          if(!store.access.isRead(op))store.access.audit(who,op,sessionId);
        }
        if (actor === "human" && equal(bearer, credentials.humanToken))
          res.setHeader(
            "Set-Cookie",
            ["ds_research=" + credentials.humanToken + "; HttpOnly; SameSite=Strict; Path=/", "ds_account=; HttpOnly; SameSite=Strict; Path=/; Max-Age=0"],
          );
        return send(200, { result });
      }
      const assets = {
        "/": "index.html",
        "/app.js": "app.js",
        "/app.css": "app.css",
      };
      if (req.method === "GET" && assets[path]) {
        res.setHeader(
          "Content-Security-Policy",
          "default-src 'self'; script-src 'self'; style-src 'self' 'unsafe-inline'; img-src 'self' data: blob: https:; connect-src 'self'; font-src 'self' data:; frame-ancestors 'self' http://127.0.0.1:* http://localhost:* " + publicOrigins.join(' '),
        );
        res.writeHead(200, {
          "Content-Type": path.endsWith(".js")
            ? "text/javascript"
            : path.endsWith(".css")
              ? "text/css"
              : "text/html",
        });
        return res.end(readFileSync(join(ui, assets[path])));
      }
      send(404, { error: "Not found" });
    } catch (e) {
      send(
        e.code === "UNAUTHORIZED" ? 401 : e.code === "CONFLICT"
          ? 409
          : e.code === "FORBIDDEN"
            ? 403
            : e.code === "NOT_FOUND"
              ? 404
              : 400,
        { error: e.message, code: e.code || "INVALID" },
      );
    }
  });
  await new Promise((ok, no) => {
    server.once("error", no);
    server.listen(port, "127.0.0.1", ok);
  }).catch((e) => {
    store.close();
    throw e;
  });
  const url = "http://127.0.0.1:" + server.address().port;
  writeFileSync(
    credentialsPath,
    JSON.stringify({ ...credentials, url }, null, 2),
    { mode: 0o600 },
  );
  chmodSync(credentialsPath, 0o600);
  return {
    url,
    credentialsPath,
    credentials,
    close: () =>
      new Promise((ok, no) =>
        server.close((e) => {
          store.close();
          e ? no(e) : ok();
        }),
      ),
  };
}
if (
  process.argv[1] &&
  resolve(process.argv[1]) === fileURLToPath(import.meta.url)
) {
  const app = await startServer();
  console.log(
    "Research Studio: " +
      app.url +
      "\nAccess keys: " +
      app.credentialsPath +
      "\nLocal single-workspace service; stop with Ctrl+C.",
  );
  for (const sig of ["SIGINT", "SIGTERM"])
    process.once(sig, () => void app.close().then(() => process.exit(0)));
}
