import assert from "node:assert/strict";
import { Context } from "../harness-runtime/node_modules/@deepseek-ai/cordis/lib/index.js";
import { SystemPrompt } from "../harness-runtime/node_modules/@deepseek-ai/dsh-system-prompt/lib/index.js";
import { ToolRuntime } from "../harness-runtime/node_modules/@deepseek-ai/dsh-tools/lib/index.js";
import { SkillRegistry } from "../harness-runtime/node_modules/@deepseek-ai/dsh-skill/lib/index.js";
import * as data from "../plugins/airalogy/index.mjs";
import * as skills from "../plugins/deepscientist/index.mjs";
import {excludedSkills} from '../plugins/deepscientist/customer-scope.mjs';
import { contracts } from "../src/server/contracts.mjs";
import { LocalFileSystem } from "../harness-runtime/node_modules/@deepseek-ai/dsh-fs-local/lib/index.js";
import { SessionProjectionRegistry } from "../harness-runtime/node_modules/@deepseek-ai/dsh-session-projection/lib/index.js";
import { WorkingDirectoryService } from "../harness-runtime/node_modules/@deepseek-ai/dsh-working-directory/lib/index.js";
import { Session } from "../harness-runtime/node_modules/@deepseek-ai/dsh-session/lib/index.js";
const ctx = new Context();
await ctx.plugin(SystemPrompt, {});
await ctx.plugin(ToolRuntime);
await ctx.plugin(SkillRegistry);
await ctx.plugin(LocalFileSystem, {});
await ctx.plugin(SessionProjectionRegistry);
await ctx.plugin(WorkingDirectoryService, {});
await ctx.plugin(data);
await ctx.plugin(skills);
console.log("Services", Boolean(ctx.tools), Boolean(ctx.skills));
const result = await ctx.tools.execute({
  callId: "integration-1",
  name: "research_state",
  arguments: {},
  agent: { session: Session.create("runtime-probe"), ctx },
  signal: new AbortController().signal,
});
assert.equal(result.isError, false);
assert.equal(ctx.tools.schemas().length, Object.keys(contracts).length);
const catalog = await ctx.skills.list();
assert.ok(catalog.length > 300);
assert.equal(new Set(catalog.map((s) => s.name)).size, catalog.length);
const adapters=['research-literature','research-science','research-gewu','research-protocol','research-power'];
assert.deepEqual(catalog.filter((s) => s.source==='bundled' && s.invocation.modelInvocable).map(s=>s.name).sort(),[...adapters].sort());
for (const name of excludedSkills) assert.ok(!catalog.some(s=>s.name==='v2-'+name));
for (const name of ["research-literature", "v2-loop-goal", "v2-kdense-pymoo"])
  assert.ok(await ctx.skills.get(name), "Missing preserved skill: " + name);
for (const name of ["research-science", "research-gewu", "research-protocol", "research-power"])
  assert.ok((await ctx.skills.get(name)).content.length > 1000);
console.log(
  `PASS: ${Object.keys(contracts).length} real Harness tools, shared backend query, ${catalog.length} customer skills, ${adapters.length} active adapters`,
);
await ctx.fiber.dispose();
