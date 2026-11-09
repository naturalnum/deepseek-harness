import {randomBytes,randomUUID,scrypt as derive,timingSafeEqual,createHash} from 'node:crypto';
import {promisify} from 'node:util';
import {z} from 'zod';
const scrypt=promisify(derive),hash=value=>createHash('sha256').update(value).digest('hex');
const text=z.string().trim().min(1).max(200),password=z.string().min(12).max(200),roles=['viewer','editor','reviewer','owner'];
const readOps=new Set(['state','protocol_get','record_get','record_submit_result','attachment_get','record_export','workspace_export','science_state','science_revision','science_export','lab_skills','project_git_state','project_git_commit','project_git_working','engine_packages','engine_package_get','engine_runs','engine_run_get','engine_status','document_status','document_text','local_search','literature_search','archive_inspect','method_catalog','method_get','tasks','task_get']);
const reviewOps=new Set(['evidence_review','record_submit','record_reopen','record_archive','record_restore','lab_skill_publish','roadmap_select','engine_package_review','task_open']);
const fail=(code,message)=>{throw Object.assign(new Error(message),{code});};
export const localAdministrator={id:'local-administrator',username:'本机管理员',admin:true};
export function accessStore(db){
 db.exec(`CREATE TABLE IF NOT EXISTS access_users(id TEXT PRIMARY KEY,username TEXT UNIQUE NOT NULL,body TEXT NOT NULL);
 CREATE TABLE IF NOT EXISTS access_tokens(hash TEXT PRIMARY KEY,userId TEXT NOT NULL,expires INTEGER NOT NULL);
 CREATE TABLE IF NOT EXISTS access_projects(id TEXT PRIMARY KEY,name TEXT NOT NULL);
 CREATE TABLE IF NOT EXISTS access_members(projectId TEXT NOT NULL,userId TEXT NOT NULL,role TEXT NOT NULL,PRIMARY KEY(projectId,userId));
 CREATE TABLE IF NOT EXISTS access_conversations(session TEXT PRIMARY KEY,projectId TEXT NOT NULL,title TEXT NOT NULL);
 CREATE TABLE IF NOT EXISTS access_audit(id INTEGER PRIMARY KEY,at TEXT NOT NULL,userId TEXT NOT NULL,operation TEXT NOT NULL,session TEXT);`);
 const attempts=new Map();
 const user=id=>{const row=db.prepare('SELECT body FROM access_users WHERE id=?').get(id);return row?JSON.parse(row.body):null;};
 const principal=u=>u&&u.enabled?{id:u.id,username:u.username,admin:u.admin}:null;
 const role=(who,session)=>who.admin?'owner':db.prepare('SELECT m.role FROM access_members m JOIN access_conversations c ON c.projectId=m.projectId WHERE c.session=? AND m.userId=?').get(session,who.id)?.role;
 const projectRole=(who,id)=>who.admin?'owner':db.prepare('SELECT role FROM access_members WHERE projectId=? AND userId=?').get(id,who.id)?.role;
 const requireOwner=(who,id)=>{if(projectRole(who,id)!=='owner')fail('FORBIDDEN','只有项目负责人可以管理项目成员和对话。');};
 const audit=(who,op,session=null)=>db.prepare('INSERT INTO access_audit(at,userId,operation,session) VALUES(?,?,?,?)').run(new Date().toISOString(),who.id,op,session);
 const saltHash=async value=>{const salt=randomBytes(16).toString('hex');return {salt,passwordHash:(await scrypt(value,salt,64)).toString('hex')};};
 return {
  authenticate(token){if(!token)return null;const row=db.prepare('SELECT userId FROM access_tokens WHERE hash=? AND expires>?').get(hash(token),Date.now());return row?principal(user(row.userId)):null;},
  canRead(who,session){return Boolean(role(who,session));},role,isRead:op=>readOps.has(op),
  authorize(who,op,session,args={}){
   if(who.admin)return;
   if(op==='state'&&!session)return;
   const level=roles.indexOf(role(who,session));if(level<0)fail('FORBIDDEN','你没有这个项目对话的访问权限。');
   if(['protocol_get','record_create'].includes(op)){
     const state=JSON.parse(db.prepare('SELECT body FROM state WHERE id=1').get().body),id=op==='protocol_get'?args.id:args.protocolId,version=op==='protocol_get'?args.version:args.protocolVersion;
     if(!state.protocols.some(p=>p.id===id&&p.version===version&&p.sessionId===session)&&!state.records.some(r=>r.sessionId===session&&r.protocolId===id&&r.protocolVersion===version))fail('FORBIDDEN','该协议没有分配给此项目对话。');
   }
   if(level===1&&op==='record_update'){
     const state=JSON.parse(db.prepare('SELECT body FROM state WHERE id=1').get().body),record=state.records.find(r=>r.id===args.id&&r.sessionId===session);
     if(record&&JSON.stringify(record.run.checks)!==JSON.stringify(args.run?.checks))fail('FORBIDDEN','复核勾选需要复核员或项目负责人。');
   }
   if(readOps.has(op))return;
   if(op.startsWith('project_git_')||['history_list','history_associate','engine_package_put'].includes(op))fail('FORBIDDEN','本机目录、代码包导入与历史空间由管理员管理。');
   if(level<(reviewOps.has(op)?2:1))fail('FORBIDDEN',reviewOps.has(op)?'此操作需要复核员或项目负责人。':'此操作需要编辑权限。');
  },audit,
  async handle(op,args,who,token,remote){
   if(op==='login'){
    const a=z.object({username:text,password}).strict().parse(args),key=remote+':'+a.username.toLowerCase(),now=Date.now();let attempt=attempts.get(key);
    if(!attempt||attempt.until<now)attempt={count:0,until:now+15*60000};if(attempt.count>=8)fail('FORBIDDEN','登录尝试过多，请稍后再试。');attempt.count++;attempts.set(key,attempt);
    const row=db.prepare('SELECT body FROM access_users WHERE username=?').get(a.username.toLowerCase()),u=row?JSON.parse(row.body):null;
    const actual=await scrypt(a.password,u?.salt||'unknown-account',64),expected=Buffer.from(u?.passwordHash||'00'.repeat(64),'hex');
    if(!u?.enabled||!timingSafeEqual(actual,expected))fail('FORBIDDEN','账号或密码不正确。');
    attempts.delete(key);const sessionToken=randomBytes(32).toString('hex');db.prepare('DELETE FROM access_tokens WHERE expires<?').run(now);db.prepare('INSERT INTO access_tokens VALUES(?,?,?)').run(hash(sessionToken),u.id,now+12*3600000);audit(u,'login');return {result:{user:principal(u)},setToken:sessionToken};
   }
   if(!who)fail('UNAUTHORIZED','请先登录。');
   if(op==='logout'){if(token)db.prepare('DELETE FROM access_tokens WHERE hash=?').run(hash(token));return {result:{loggedOut:true},clearToken:true};}
   if(op==='state'){
    const projects=who.admin?db.prepare('SELECT * FROM access_projects').all():db.prepare('SELECT p.*,m.role FROM access_projects p JOIN access_members m ON m.projectId=p.id WHERE m.userId=?').all(who.id);
    return {result:{user:who,projects:projects.map(p=>({...p,role:projectRole(who,p.id),members:projectRole(who,p.id)==='owner'?db.prepare('SELECT userId,role FROM access_members WHERE projectId=?').all(p.id):[],conversations:db.prepare('SELECT session,title FROM access_conversations WHERE projectId=?').all(p.id)})),users:who.admin?db.prepare('SELECT body FROM access_users').all().map(r=>{const u=JSON.parse(r.body);return {id:u.id,username:u.username,admin:u.admin,enabled:u.enabled};}):[],audit:who.admin?db.prepare('SELECT * FROM access_audit ORDER BY id DESC LIMIT 100').all():[]}};
   }
   let result;
   if(op==='create_user'||op==='update_user'){
    if(!who.admin)fail('FORBIDDEN','账号由管理员管理。');
    if(op==='create_user'){
     const a=z.object({username:z.string().regex(/^[a-zA-Z0-9][a-zA-Z0-9_.-]{2,59}$/),password,admin:z.boolean().default(false)}).strict().parse(args);
     const u={id:randomUUID(),username:a.username.toLowerCase(),admin:a.admin,enabled:true,...await saltHash(a.password)};
     if(db.prepare('SELECT 1 FROM access_users WHERE username=?').get(u.username))fail('CONFLICT','该账号已存在。');
     db.prepare('INSERT INTO access_users VALUES(?,?,?)').run(u.id,u.username,JSON.stringify(u));result={id:u.id,username:u.username};
    }else{
     const a=z.object({id:text,enabled:z.boolean(),password:password.optional()}).strict().parse(args),u=user(a.id);if(!u)fail('NOT_FOUND','账号不存在。');if(u.id===who.id&&!a.enabled)fail('INVALID','不能停用当前管理员。');
     if(a.password)Object.assign(u,await saltHash(a.password));u.enabled=a.enabled;db.prepare('UPDATE access_users SET body=? WHERE id=?').run(JSON.stringify(u),u.id);db.prepare('DELETE FROM access_tokens WHERE userId=?').run(u.id);result={updated:true};
    }
   }else if(op==='create_project'){
    const a=z.object({name:text}).strict().parse(args),id=randomUUID();db.prepare('INSERT INTO access_projects VALUES(?,?)').run(id,a.name);db.prepare('INSERT INTO access_members VALUES(?,?,?)').run(id,who.id,'owner');result={id,name:a.name};
   }else if(op==='set_member'){
    const a=z.object({projectId:text,username:text,role:z.enum(['viewer','editor','reviewer','owner','remove'])}).strict().parse(args);requireOwner(who,a.projectId);
    const row=db.prepare('SELECT id FROM access_users WHERE username=?').get(a.username.toLowerCase());if(!row)fail('NOT_FOUND','请先由管理员创建该账号。');if(row.id===who.id&&a.role!=='owner')fail('INVALID','不能移除自己的项目负责人权限。');
    if(a.role==='remove')db.prepare('DELETE FROM access_members WHERE projectId=? AND userId=?').run(a.projectId,row.id);else db.prepare('INSERT INTO access_members VALUES(?,?,?) ON CONFLICT(projectId,userId) DO UPDATE SET role=excluded.role').run(a.projectId,row.id,a.role);result={updated:true};
   }else if(op==='attach_session'||op==='new_session'){
    const a=z.object({projectId:text,title:text,session:op==='attach_session'?text:z.undefined().optional()}).strict().parse(args);requireOwner(who,a.projectId);
    if(op==='attach_session'&&!who.admin)fail('FORBIDDEN','现有 Harness 对话只能由管理员明确分配。');
    const session=op==='new_session'?'project-'+randomUUID():a.session;
    if(db.prepare('SELECT 1 FROM access_conversations WHERE session=?').get(session))fail('CONFLICT','对话已分配到项目。');
    db.prepare('INSERT INTO access_conversations VALUES(?,?,?)').run(session,a.projectId,a.title);result={session};
   }else fail('INVALID','未知账号管理操作。');
   audit(who,op);return {result};
  }
 };
}
