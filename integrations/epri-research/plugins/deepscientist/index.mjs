import { readFileSync, readdirSync, existsSync } from "node:fs";
import { basename, dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import { parse } from "yaml";
import {createHash} from 'node:crypto';
import {call} from '../../src/server/client.mjs';
import {customerSkillEnabled} from './customer-scope.mjs';
export const name = "deepscientist-research-skills";
export const inject = ["skills"];
const root = fileURLToPath(
  new URL("../../upstream/v2-main/resources/skills/", import.meta.url),
);
const local = fileURLToPath(new URL("./skills/", import.meta.url));
const note = `## Harness compatibility boundary
This customer edition serves power engineering and general research. Specialist life-science skills and services are outside its installed feature set. Resolve tools and skills through the current Harness catalog; do not follow unavailable legacy domain routes.
This is a preserved upstream skill. Read research-science first for current tool mappings. Research routes, evidence, claims, reports, lab skills and Airalogy execution use the installed research_* tools. Electron IPC names are not callable in Harness. Native Harness tools own filesystem, Git and Goal operations. Read local resources relative to resourceBase. A bundled skill does not imply its external service or credentials are configured.

`;
function load(path, active = false) {
  const full = readFileSync(path, "utf8").replace(/\r\n/g, "\n");
  const m = /^---\n([\s\S]*?)\n---\n([\s\S]*)$/.exec(full);
  if (!m) return null;
  const meta = parse(m[1], { strict: false, uniqueKeys: false });
  const name = active
    ? meta.name
    : "v2-" +
      basename(dirname(path))
        .toLowerCase()
        .replace(/[^a-z0-9]+/g, "-")
        .replace(/^-|-$/g, "");
  return {
    name,
    description: String(meta.description || name),
    source: "bundled",
    provider: "deepscientist-suite",
    rank: 600,
    path,
    resourceBase: {
      kind: "directory",
      path:
        active && meta.name === "research-science"
          ? join(root, "science")
          : active && meta.name === "research-protocol"
            ? join(root, "deepscientist-protocol-workflow")
            : active && meta.name === "research-gewu"
              ? join(root, "loop-goal")
            : dirname(path),
    },
    invocation: { modelInvocable: active, userInvocable: true },
    content: (active ? "" : note) + m[2],
    locator: path,
  };
}
export function apply(ctx) {
  const cloud=ctx.get?.('epriResearch',false);
  const entries = [];
  for (const folder of readdirSync(root)) {
    if (!customerSkillEnabled(folder)) continue;
    const path = join(root, folder, "SKILL.md");
    if (existsSync(path)) {
      const item = load(path);
      if (item) entries.push(item);
    }
  }
  for (const folder of readdirSync(local)) {
    const path = join(local, folder, "SKILL.md");
    if (existsSync(path)) entries.push(load(path, true));
  }
  const byPath = new Map(entries.filter(Boolean).map((x) => [x.path, x]));
  const published=async(options)=>{
    if(cloud&&!options?.scope?.session)return [];
    const skills=cloud?await cloud.labSkills(options.scope,options.signal):await call('lab_skills',{},options?.signal);
    return skills.map(skill=>({name:'lab-'+createHash('sha256').update(skill.sessionId+':'+skill.id).digest('hex').slice(0,16),description:skill.title,source:'custom',provider:'deepscientist-suite',rank:550,invocation:{modelInvocable:true,userInvocable:true},resourceBase:{kind:'opaque',description:'Human-published local lab skill; evidence snapshots are embedded. No implicit filesystem or external-service access.'},content:skill.markdown+'\n\n## Reviewed source snapshots\n\n'+JSON.stringify(skill.evidence,null,2),locator:'published:'+skill.sessionId+':'+skill.id}));
  };
  const publicEntry=item=>{
    if(!cloud)return item;
    const {path,resourceBase,...metadata}=item;
    return {...metadata,locator:'bundled:'+item.name,resourceBase:{kind:'opaque',description:'Resources are copied into this account workspace when the skill is loaded.'}};
  };
  const materialize=async(item,options)=>{
    const files=[];
    function collect(directory,prefix='') {
      for(const entry of readdirSync(directory,{withFileTypes:true})) {
        const path=join(directory,entry.name),relativePath=prefix+entry.name;
        if(entry.isDirectory())collect(path,relativePath+'/');
        else if(entry.isFile()){if(relativePath!=='SKILL.md')files.push({relativePath,dataBase64:readFileSync(path).toString('base64')});}
        else throw new Error('Bundled research skill resources cannot contain links.');
      }
    }
    collect(item.resourceBase.path);
    const markdown='---\nname: '+JSON.stringify(item.name)+'\ndescription: '+JSON.stringify(item.description)+'\n---\n'+item.content;
    files.push({relativePath:'SKILL.md',dataBase64:Buffer.from(markdown).toString('base64')});
    const resources=await cloud.materializeSkill({kind:'files',files},options);
    return {...publicEntry(item),...resources};
  };
  ctx.skills.registerProvider(() => ({
    name: "deepscientist-suite",
    list: async (options) => [...[...byPath.values()].map(publicEntry),...await (cloud?published(options):published(options).catch(()=>[]))],
    get: async (candidate,options) => {
      const item=cloud?[...byPath.values()].find(item=>'bundled:'+item.name===candidate.locator):byPath.get(candidate.locator);
      return item?(cloud?materialize(item,options):item):(await published(options)).find(x=>x.locator===candidate.locator);
    },
  }));
}
